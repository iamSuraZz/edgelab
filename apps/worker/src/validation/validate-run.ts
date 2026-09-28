import {
  findSymbolByCode,
  getHoldout,
  holdoutHistory,
  listSymbols,
  readM1,
  readM1Bars,
  readRun,
  type DbClient,
  type SealTruncation,
} from '@edgelab/db';
import { PineTsEngine, orchestrateRun, parsePineTimeframe, spreadPriceAt } from '@edgelab/engine';
import type { SecurityCall } from '@edgelab/engine';
import { resample } from '@edgelab/data';
import {
  BUILT_IN_CHECKS,
  bucketsFromCandles,
  checkCausality,
  auditFills,
  analyseCostStress,
  analyseOosSplit,
  analyseRollingOos,
  foldWindows,
  splitInstant,
  type RollingOosResult,
  type OosSplitResult,
  type SegmentMetrics,
  checkBidAskAsymmetry,
  describePerFill,
  type CostStressResult,
  type StressPoint,
  replayIntrabar,
  type IntrabarReplayResult,
  levelExitIdsFromSource,
  type AsymmetryResult,
  cutoffsFor,
  estimateSameBarBias,
  pickDonor,
  spliceFuture,
  lintLookahead,
  marketFillsFromTrades,
  overallVerdict,
  runChecks,
  runPrefixInvariance,
  verdictHeadline,
  type CheckResult,
  type LintResult,
  type CausalityResult,
  type FillAuditResult,
  type PrefixInvarianceResult,
  type SameBarBiasEstimate,
  type Verdict,
} from '@edgelab/validation';
import {
  accountMoney,
  describeBasis,
  describeHoldout,
  ExitLevelIndex,
  priceBasisForSource,
  CostConfigSchema,
  DEFAULT_COSTS,
  timeframeMs,
  type Bar,
  type Timeframe,
} from '@edgelab/shared';

import { assertSingleFeed } from '../ingest/feed-guard';

/**
 * The validation engine: everything spec 06 can currently establish about one stored run.
 *
 * Lives in the worker rather than in `packages/validation` because it needs BOTH the engine (to
 * re-execute the strategy under truncated data) and the checks (to judge the result), and those
 * two packages are siblings that may not import each other. An app is the only place they meet.
 *
 * Two look-ahead layers run here, and they are complementary rather than redundant:
 *
 *   1. The STATIC lint reads the source. Instant, and catches the common mistakes with a line
 *      number, but it can only recognise patterns it knows.
 *   2. PREFIX INVARIANCE re-runs the strategy with the data truncated at six points and checks
 *      that earlier decisions did not change. Expensive — seven engine runs — but it does not
 *      care how the leak was written.
 *
 *   3. FUTURE SPLICE (A1b) replaces a bounded window of the future with a different real segment,
 *      rescaled to continue from the cutoff price, and compares with NO margin. This is the layer
 *      that actually catches a bounded leak, and the only one whose pass is a real statement.
 *
 * Measured, which is why all three exist: prefix invariance passes the leaky fixture 6 of 6, because
 * a bounded look-ahead perturbs only the bucket the cutoff sits in — exactly the region its margin
 * has to exclude to avoid failing every honest HTF strategy. Future splice fails the same fixture at
 * the first cutoff.
 *
 * A fourth layer, the `request.security` causality log, is built
 * (`packages/engine/src/pinets/security-log.ts`) but not wired: it needs the adapter to expose the
 * instrumentation seam per run.
 */

/** Cutoffs for the dynamic test. Spec 06 says six. */
const CUTOFF_COUNT = 6;

/**
 * Floor for the splice window. The real width is derived per run — see `spliceWindowFor`.
 */
const SPLICE_WINDOW_FLOOR_MS = 7 * 24 * 60 * 60_000;

/**
 * Cost multipliers to re-run at, besides the baseline.
 *
 * Zero is included deliberately: it is the only point that separates "the costs killed this" from
 * "this never made money in the first place", and a strategy that loses with execution switched off
 * has no break-even to find at all.
 */
const COST_STRESS_MULTIPLIERS = [0, 0.5, 2, 3] as const;

/**
 * Extra multipliers tried, in order, while the strategy is still profitable at the top of the
 * ladder.
 *
 * Adaptive rather than a fixed long ladder so the common case stays cheap: most strategies die
 * within 3x, and only one that survives pays for the extra runs. The cap is a statement in itself —
 * "survives 20x its own costs" is as much as this check needs to say.
 */
const COST_STRESS_EXTENSIONS = [5, 10, 20] as const;

/**
 * Share of the window kept for fitting. The rest is the honesty test.
 *
 * 70/30 rather than 50/50 because the out-of-sample half only has to be long enough to produce a
 * usable number of trades, and every bar given to it is a bar the in-sample half cannot use to
 * establish there was an edge at all.
 */
const OOS_SPLIT_FRACTION = 0.7;

/**
 * Rolling walk-forward layout: 4 folds, each training on 3 blocks and testing on 1.
 *
 * Four rather than ten because each fold is two engine runs and, more importantly, because a finer
 * layout produces test windows too small to hold enough trades — at which point the check reports
 * `n/a` and has told you nothing. The fold count is a statement about trade frequency, not about
 * statistical power.
 */
const ROLLING_OOS_FOLDS = 4;
const ROLLING_OOS_IS_RATIO = 3;

/**
 * How much of the future to replace, sized to the longest timeframe the script actually requests.
 *
 * A fixed week was the first cut and it is not enough. The leak horizon is one bucket of whatever
 * timeframe was asked for, so a script reading MN1 with `lookahead_on` sees up to a month ahead —
 * and a one-week splice leaves most of that month untouched, letting the leak outlast the
 * perturbation and the check pass a leaking run.
 *
 * Now that the causality seam records every `request.security` call, the requested timeframes are
 * known rather than guessed: take the longest, and keep a week as the floor so a script that reads
 * no higher timeframe at all still gets a meaningful splice.
 */
function spliceWindowFor(calls: readonly SecurityCall[] | null): number {
  let longest = 0;
  for (const call of calls ?? []) {
    const tf = parsePineTimeframe(call.timeframe);
    if (tf === null) continue;
    // MN1 has no fixed length; 31 days is the longest a calendar month can be, and erring long is
    // the safe direction — an over-wide splice costs donor history, an under-wide one misses leaks.
    longest = Math.max(longest, timeframeMs(tf) ?? 31 * 24 * 60 * 60_000);
  }
  return Math.max(SPLICE_WINDOW_FLOOR_MS, longest);
}

export interface ValidationReport {
  readonly runId: string;
  readonly verdict: Verdict;
  readonly headline: string;
  readonly results: readonly CheckResult[];
  readonly lint: LintResult;
  readonly prefix: PrefixInvarianceResult | null;
  readonly sameBar: SameBarBiasEstimate | null;
  readonly asymmetry: AsymmetryResult | null;
  readonly replay: IntrabarReplayResult | null;
  readonly stress: CostStressResult | null;
  readonly oos: OosSplitResult | null;
  readonly rollingOos: RollingOosResult | null;
  readonly elapsedMs: number;
}

export interface ValidateRunParams {
  readonly db: DbClient;
  readonly runId: string;
  readonly onProgress?: (percent: number, message: string) => void;
}

export async function validateRun(params: ValidateRunParams): Promise<ValidationReport> {
  const startedAt = Date.now();
  const report = params.onProgress ?? ((): void => undefined);

  const run = await readRun(params.db.db, params.runId);
  if (run === null) throw new Error(`No backtest run with id ${params.runId}.`);

  const symbolRow = await findSymbolByCode(params.db, run.symbol);
  if (symbolRow === null) throw new Error(`Run ${params.runId} references unknown ${run.symbol}.`);

  const timeframe = run.timeframe as Timeframe;
  // MN1 has no fixed length, so `timeframeMs` returns null; a 30-day stand-in is close enough for
  // the warmup window and the invariance margin, neither of which needs calendar precision.
  const tfMs = timeframeMs(timeframe) ?? 30 * 24 * 60 * 60_000;

  /* ------------------------------------------------------------- static lint */

  report(5, 'linting the source');
  const lint = lintLookahead(run.pineSource);

  /* --------------------------------------------------------------- the runs */

  // Warmup bars are loaded before `fromMs`, so the M1 window has to start earlier than the
  // trading window or every run here would warm up on nothing.
  const warmupMs = run.warmupBars * tfMs;
  const barsFromMs = run.fromMs - warmupMs;

  // The single feed is also what decides the price basis — what a stored number MEANS, and so
  // which side of the book a resting order really triggers on.
  const feedSource = await assertSingleFeed({
    db: params.db,
    symbolId: symbolRow.id,
    symbolCode: run.symbol,
    fromMs: run.fromMs,
    toMs: run.toMs,
  });
  // `assertSingleFeed` returns null only when the range holds no bars at all, which later
  // checks refuse on their own terms. Bid is the conservative basis to assume meanwhile.
  const feed = feedSource ?? 'unknown';
  const basis = priceBasisForSource(feed);

  // A seal cutting the range short is ANNOUNCED, never silent: a run that covers less than it
  // appears to is worse than one that refuses, because its numbers look like an answer.
  const m1Read = await readM1(params.db, symbolRow.id, barsFromMs, run.toMs);
  const m1 = m1Read.bars;
  const knownSymbols = new Set((await listSymbols(params.db)).map((r) => r.symbol.toUpperCase()));

  /**
   * An engine reading one specific bar array.
   *
   * A factory rather than a single instance because the splice test runs the SAME strategy over a
   * different series per cutoff, and the series is the only thing that changes.
   */
  const engineOver = (bars: readonly (typeof m1)[number][]): PineTsEngine =>
    new PineTsEngine({
      m1: {
        readM1: (_symbol, fromMs, toMs) =>
          Promise.resolve(bars.filter((b) => b.time >= fromMs && b.time < toMs)),
      },
      lookupSymbol: (code) => (code === symbolRow.symbol ? toSpec(symbolRow) : undefined),
    });

  const engine = engineOver(m1);

  const costs = CostConfigSchema.safeParse(run.costs);
  const shared = {
    engine,
    source: run.pineSource,
    symbol: toSpec(symbolRow),
    timeframe,
    fromMs: run.fromMs,
    toMs: run.toMs,
    initialCapital: accountMoney(run.initialCapital),
    accountCurrency: run.accountCurrency,
    costs: costs.success ? costs.data : DEFAULT_COSTS,
    inputs: asRecord(run.inputs),
    overrides: asRecord(run.props),
    warmupBars: run.warmupBars,
    conversion: {
      known: (code: string) => knownSymbols.has(code.toUpperCase()),
      loadBars: async (code: string, fromMs: number, toMs: number) => {
        const row = await findSymbolByCode(params.db, code);
        if (row === null) return [];
        return readM1Bars(params.db, row.id, fromMs, toMs);
      },
    },
  };

  report(10, 'running the full range');
  // Recording is on for THIS run only. The truncated and spliced runs below re-execute the same
  // strategy many times over and have no use for the log, so they should not pay for it.
  const full = await orchestrateRun({ ...shared, recordSecurityCalls: true });

  /* --------------------------------------------------- prefix invariance */

  const cutoffs = cutoffsFor(run.fromMs, run.toMs, CUTOFF_COUNT);
  let completed = 0;

  const prefix =
    cutoffs.length === 0
      ? null
      : await runPrefixInvariance({
          full: { trades: full.engineResult.trades.map(toComparable) },
          cutoffs,
          /*
           * One bucket of the HIGHEST timeframe the script could be reading.
           *
           * The chart timeframe is a floor, not the answer: a script on H1 that reads H4 has a
           * four-hour bucket straddling each cutoff. Without knowing which timeframes the source
           * requests, the honest margin is generous — a margin that is too small reports leaks on
           * clean strategies, which is the failure that makes a check get switched off. Six
           * buckets of the chart timeframe covers the usual H1-reads-H4 and D1 cases.
           */
          marginMs: tfMs * 6,
          runAt: async (cutoffMs) => {
            completed += 1;
            report(
              10 + (completed / cutoffs.length) * 75,
              `truncated run ${String(completed)}/${String(cutoffs.length)}`,
            );
            const truncated = await orchestrateRun({ ...shared, dataCutoffTs: cutoffMs });
            return { trades: truncated.engineResult.trades.map(toComparable) };
          },
        });

  /* ------------------------------------------------- future splice (A1b) */

  /*
   * The same comparison as above with the margin set to ZERO, which is the entire point.
   *
   * Truncation needs a margin because it deletes the bucket straddling the cutoff, and an honest
   * HTF strategy legitimately behaves differently when that bucket is gone. Splicing deletes
   * nothing — every bar and timestamp survives, only the prices after the cutoff differ — so a
   * causal strategy read byte-identical data before the cutoff and MUST decide identically. Any
   * difference at all is a leak, so no margin is needed and no margin means no blind spot.
   */
  let spliceCompleted = 0;
  let spliceSkipped: string | null = null;
  const spliceWindowMs = spliceWindowFor(full.engineResult.securityCalls);

  const splice =
    cutoffs.length === 0
      ? null
      : await runPrefixInvariance({
          full: { trades: full.engineResult.trades.map(toComparable) },
          cutoffs,
          marginMs: 0,
          runAt: async (cutoffMs) => {
            spliceCompleted += 1;
            report(
              85 + (spliceCompleted / cutoffs.length) * 5,
              `spliced run ${String(spliceCompleted)}/${String(cutoffs.length)}`,
            );

            /*
             * Replace one SPLICE WINDOW of minutes after the cutoff, not the whole remainder.
             *
             * The width is the longest timeframe this script requests, floored at a week — see
             * `spliceWindowFor`. Splicing the entire remainder instead needs a disjoint donor as
             * long as the run, which no early cutoff can supply: measured, the clean fixture
             * reported `n/a` for want of 104,809 donor bars.
             */
            const needed = m1.filter(
              (b) => b.time > cutoffMs && b.time <= cutoffMs + spliceWindowMs,
            ).length;
            const donor = needed === 0 ? [] : pickDonor(m1, cutoffMs, needed);

            if (donor === null) {
              // Not enough history before the cutoff to spare a DISJOINT donor. Splicing with
              // overlapping data would make the test quietly vacuous, so refuse and report n/a.
              spliceSkipped =
                `Not enough history before ${new Date(cutoffMs).toISOString().slice(0, 10)} to ` +
                `supply a donor segment disjoint from the ${String(needed)} minutes after it.`;
              return { trades: full.engineResult.trades.map(toComparable) };
            }

            const grafted = spliceFuture({
              bars: m1,
              cutoffMs,
              donor,
              windowMs: spliceWindowMs,
            });
            const spliced = await orchestrateRun({
              ...shared,
              engine: engineOver(grafted.bars),
            });
            return { trades: spliced.engineResult.trades.map(toComparable) };
          },
        });

  /* ------------------------------------------------- causality (A1a) */

  const causality = judgeCausality({
    calls: full.engineResult.securityCalls,
    m1,
    chartBarMs: tfMs,
  });

  /* ----------------------------------------------- fill audit (spec 06 §2) */

  const fills = auditFills({
    trades: full.trades.map((t, i) => ({
      seq: i + 1,
      side: t.side,
      qty: t.qty,
      entryBar: t.entryBar,
      entryPrice: t.entryPrice,
      exitBar: t.exitBar,
      exitPrice: t.exitPrice,
      netPnl: t.netPnl,
    })),
    bars: full.engineResult.bars,
    mintick: symbolRow.mintick,
    pipSize: symbolRow.pipSize,
    // qty on a costed trade is in LOTS, so the per-tick value must be per lot: one tick moved on
    // one lot. Passing a bare mintick here reported the penetration cost as 0.00.
    valuePerTickPerLot: symbolRow.mintick * symbolRow.contractSize * symbolRow.pointValue,
  });

  // Levels come from the ORDER LOG, which records every strategy.exit call with its arguments
  // already resolved at that bar — so an ATR stop arrives as a number. Clustering exit prices only
  // ever worked for a fixed bracket, and would report n/a on exactly the strategies whose stops are
  // worth checking.
  const exitLevels = new ExitLevelIndex(full.engineResult.orderLog);

  // Chart-bar index for an instant, so a level set at one bar's close applies from the next.
  const chartBars = full.engineResult.bars;
  const barIndexAt = (atMs: number): number => {
    let lo = 0;
    let hi = chartBars.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (chartBars[mid]!.time <= atMs) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  };

  /* ------------------------------------------ bid/ask asymmetry (spec 06 §2) */

  // Which exits rested in the book, read from the SOURCE rather than guessed from prices: a
  // reversal closes with the opposing entry's id, a bracket with its own.
  const levelExitIds = levelExitIdsFromSource(run.pineSource);
  const isLevelExit = (seq: number): boolean => {
    const reason = full.trades[seq - 1]?.exitReason;
    return reason != null && levelExitIds.has(reason);
  };
  const costConfig = CostConfigSchema.parse(run.costs ?? DEFAULT_COSTS);

  const asymmetry = checkBidAskAsymmetry({
    trades: full.trades.map((t, i) => ({
      seq: i + 1,
      side: t.side,
      qty: t.qty,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      exitBar: t.exitBar,
      netPnl: t.netPnl,
    })),
    bars: full.engineResult.bars,
    basis,
    spreadAt: (barIndex) => spreadPriceAt(full.engineResult.bars[barIndex], symbolRow, costConfig),
    // One price unit on one LOT, in the account currency.
    valuePerPricePerLot: symbolRow.contractSize * symbolRow.pointValue,
    scale: { mintick: symbolRow.mintick, pipSize: symbolRow.pipSize },
    isLevelExit,
    // Which level the exit was, from the order log rather than from the sign of the P&L: a
    // trailing stop exits in profit and is still a stop.
    kindOf: (seq) => {
      const t = full.trades[seq - 1];
      if (t === undefined || exitLevels.size === 0) return null;
      const lv = exitLevels.levelsOnBar(
        t.exitBar,
        { side: t.side, entryPrice: t.entryPrice, mintick: symbolRow.mintick },
        t.entryBar,
        t.exitReason,
      );
      if (lv === null || lv.ambiguous) return null;
      const dStop = lv.stop === null ? Infinity : Math.abs(t.exitPrice - lv.stop);
      const dTarget = lv.target === null ? Infinity : Math.abs(t.exitPrice - lv.target);
      if (!Number.isFinite(dStop) && !Number.isFinite(dTarget)) return null;
      return dStop <= dTarget ? 'stop' : 'target';
    },
  });

  /* --------------------------------------- M1 intrabar replay (spec 06 §2) */

  // Runs on the raw M1 series, not the chart bars: the whole point is to see inside a chart bar.
  const replay = replayIntrabar({
    trades: full.trades.map((t, i) => ({
      seq: i + 1,
      side: t.side,
      qty: t.qty,
      entryPrice: t.entryPrice,
      entryMs: t.entryTime,
      exitPrice: t.exitPrice,
      exitMs: t.exitTime,
      entryBar: t.entryBar,
      exitId: t.exitReason,
      netPnl: t.netPnl,
    })),
    m1,
    basis,
    spreadAt: (bar) => spreadPriceAt(bar, symbolRow, costConfig),
    valuePerPricePerLot: symbolRow.contractSize * symbolRow.pointValue,
    scale: { mintick: symbolRow.mintick, pipSize: symbolRow.pipSize },
    // A trade's exitMs is its exit BAR's open, so the replay walks to that bar's close.
    chartBarMs: tfMs,
    levelsAt:
      exitLevels.size === 0
        ? undefined
        : (trade, atMs) =>
            exitLevels.levelsOnBar(
              barIndexAt(atMs),
              {
                side: trade.side,
                entryPrice: trade.entryPrice,
                mintick: symbolRow.mintick,
              },
              // Never inherit the previous position's levels: an absolute stop is derived from
              // strategy.position_avg_price and means nothing for a different trade.
              trade.entryBar,
              // A trade records the id of the order that closed it, which is what pairs a fill with
              // its own bracket when several are active.
              trade.exitId,
            ),
    isLevelExit,
  });

  /* ------------------------------------------ cost stress (spec 06 §2) */

  report(92, 'stressing costs');

  // Scale spread, slippage and financing together. Slippage has to go through the ENGINE, because
  // it moves a fill price and so changes which orders survive a margin check — which is exactly the
  // non-linearity the cross-check below is looking for.
  //
  // Slippage is QUANTISED to whole ticks, because Pine's `slippage` property is an int and the
  // engine refuses a fractional one. At fractional multipliers the effective scaling therefore
  // differs slightly from the nominal — 0.5x of 15 ticks is 8, not 7.5. The analysis reads each
  // run's OWN reported costs rather than assuming the nominal multiplier, so the rounding shows up
  // in the numbers instead of being silently absorbed.
  const scaleCosts = (m: number): typeof costConfig => ({
    ...costConfig,
    spread: { ...costConfig.spread, multiplier: costConfig.spread.multiplier * m },
    slippagePoints: Math.max(0, Math.round(costConfig.slippagePoints * m)),
  });

  const stressPoints: StressPoint[] = [
    {
      multiplier: 1,
      netProfit: full.metrics.performance.netProfit,
      totalCosts: full.metrics.costs.totalCosts,
      trades: full.trades.length,
    },
  ];

  const runAt = async (m: number): Promise<StressPoint> => {
    const stressed = await orchestrateRun({ ...shared, costs: scaleCosts(m) });
    return {
      multiplier: m,
      netProfit: stressed.metrics.performance.netProfit,
      totalCosts: stressed.metrics.costs.totalCosts,
      trades: stressed.trades.length,
    };
  };

  for (const m of COST_STRESS_MULTIPLIERS) {
    stressPoints.push(await runAt(m));
  }

  // Keep climbing only while the edge is still alive at the top of the ladder.
  for (const m of COST_STRESS_EXTENSIONS) {
    const highest = stressPoints.reduce((a, b) => (a.multiplier > b.multiplier ? a : b));
    if (highest.netProfit <= 0) break;
    stressPoints.push(await runAt(m));
  }

  // MEASURED, not assumed: PineTS charges slippage on BOTH legs, including a bracket exit that
  // rests at its own level. Switching slippage from 0 to 15 ticks on the 89-trade rsi fixture moved
  // net profit by $3,088 = $34.7 per trade against $15 per fill — 2.3 fills' worth, the excess being
  // trades whose outcome changed once their fill prices moved. TradingView documents the opposite
  // for limit orders, so this is an engine difference worth knowing; either way the analytical
  // "both sides of every trade" assumption holds here, and claiming a fill-mix discrepancy would be
  // a plausible explanation for a cause that is not real.
  const slippageFills = full.trades.length * 2;

  const stress = analyseCostStress({
    points: stressPoints,
    // The same denominator the metrics report uses, passed rather than recomputed so a different
    // lots-versus-units reading cannot make the two disagree for a spurious reason.
    twoSidedUnitValue:
      full.trades.reduce(
        (u, t, i) =>
          u + (full.chargeableSidesPerTrade[i] ?? 2) * Math.abs(t.qty) * symbolRow.contractSize,
        0,
      ) * symbolRow.pointValue,
    analyticalPerSidePrice: full.metrics.costs.breakEvenPerSidePrice,
    scale: { mintick: symbolRow.mintick, pipSize: symbolRow.pipSize },
    slippageFills,
    totalFills: full.trades.length * 2,
  });

  /* --------------------------------------------- OOS split (spec 06 §3) */

  report(95, 'out-of-sample split');

  const splitMs = splitInstant(run.fromMs, run.toMs, OOS_SPLIT_FRACTION);

  // Each segment is its OWN run from the SAME starting capital (A24). Slicing the full run's trades
  // in two would hand the out-of-sample half position sizes grown by in-sample profits under any
  // equity-proportional sizing, so a strategy would look better out of sample precisely when it did
  // well in sample. Warmup needs no special handling: the engine loads bars before `fromMs` and its
  // gate suppresses orders on them, so the second segment starts warm without trading early.
  const segment = async (fromMs: number, toMs: number): Promise<SegmentMetrics> => {
    const r = await orchestrateRun({ ...shared, fromMs, toMs });
    return {
      fromMs,
      toMs,
      trades: r.trades.length,
      netProfit: r.metrics.performance.netProfit,
      returnPct: r.metrics.performance.totalReturnPct,
      profitFactor: r.metrics.performance.profitFactor,
      sharpe: r.metrics.risk.sharpe,
      winRatePct: r.metrics.trades.all.winRatePct,
      maxDrawdownPct: r.metrics.risk.intrabar.maxDrawdownPct,
      expectancy: r.metrics.trades.all.expectancy,
    };
  };

  const oos = analyseOosSplit({
    inSample: await segment(run.fromMs, splitMs),
    outOfSample: await segment(splitMs, run.toMs),
    splitMs,
    splitFraction: OOS_SPLIT_FRACTION,
  });

  /* ----------------------------------------- walk-forward (spec 06 §3) */

  report(97, 'rolling out-of-sample');

  // Rolling folds, each half its own run from the same starting capital — the same A24 reasoning as
  // the OOS split, applied repeatedly. Cost is known rather than guessed (A3): setup is a flat
  // ~14ms and execution ~39ms + 0.042ms/bar, so these 2N runs are affordable at this fold count.
  const windows = foldWindows(run.fromMs, run.toMs, ROLLING_OOS_FOLDS, ROLLING_OOS_IS_RATIO);

  const foldMetrics = [];
  for (const w of windows) {
    foldMetrics.push({
      inSample: await segment(w.isFromMs, w.isToMs),
      outOfSample: await segment(w.oosFromMs, w.oosToMs),
    });
  }

  const rollingOos = analyseRollingOos({ folds: foldMetrics });

  /* --------------------------------------------------------- the checks */

  report(90, 'judging');

  const results: CheckResult[] = [
    holdoutResult(
      await getHoldout(params.db, symbolRow.id),
      await holdoutHistory(params.db, symbolRow.id),
      // From the RUN RECORD, not from this validation's own read. The stored range is already the
      // effective one (A40), so re-reading it is never truncated — the fact that the original
      // request was cut survives only in `requestedToMs`.
      run.requestedToMs === null
        ? null
        : { sealId: '', cutAtMs: run.toMs, requestedToMs: run.requestedToMs, barsWithheld: 0 },
    ),
    lintResult(lint),
    prefixResult(prefix, cutoffs.length),
    spliceResult(splice, cutoffs.length, spliceSkipped, spliceWindowMs),
    causality,
    fillAuditResult(fills, symbolRow.mintick),
    asymmetryResult(asymmetry, feed),
    replayResult(replay),
    costStressResult(stress),
    oosResult(oos),
    rollingOosResult(rollingOos),
    ...runChecks(BUILT_IN_CHECKS, {
      bars: full.engineResult.bars,
      timeframe,
      trades: full.trades,
      equity: full.equityClose,
      initialCapital: accountMoney(run.initialCapital),
    }),
  ];

  const sameBar = estimateSameBarBias({
    // contractSize converts LOTS to UNITS. It was missing, and `pointValue` below is per UNIT, so
    // every estimate came out 100,000x too small and the report read "-0.00" over 176 fills. The
    // `Units` brand on MarketFill.qty is what finally surfaced it.
    fills: marketFillsFromTrades(
      symbolRow.contractSize,
      full.trades.map((t, i) => ({
        seq: i + 1,
        side: t.side,
        qty: t.qty,
        entryBar: t.entryBar,
        entryPrice: t.entryPrice,
        exitBar: t.exitBar,
        exitPrice: t.exitPrice,
      })),
      // ONLY market fills are comparable against the previous bar's close. A bracket exit fills at
      // its own LEVEL somewhere inside the bar, so scoring it here measures the distance from the
      // previous close to the stop or target — which on a losing run is systematically adverse and
      // has nothing to do with same-bar execution. Leaving this out inflated the estimate from
      // 0.09 to 1.26 pips per fill, and the pips figure is what made it visible.
      (seq, leg) => leg === 'entry' || !isLevelExit(seq),
    ),
    bars: full.engineResult.bars,
    pointValue: symbolRow.pointValue,
    rateAt: () => 1,
    scale: { mintick: symbolRow.mintick, pipSize: symbolRow.pipSize },
    timeframeMs: tfMs,
  });

  const verdict = overallVerdict(results);
  report(100, `verdict: ${verdict}`);

  return {
    runId: params.runId,
    verdict,
    headline: verdictHeadline(verdict),
    results,
    lint,
    prefix,
    sameBar,
    asymmetry,
    replay,
    stress,
    oos,
    rollingOos,
    elapsedMs: Date.now() - startedAt,
  };
}

/* ------------------------------------------------------------------ helpers */

/**
 * The static lint as a check result.
 *
 * `critical` severity, because an error here is a specific, named leak at a known line. But a
 * clean lint is only ever reported as "nothing obvious" — it has read the source, not the
 * behaviour, and claiming more would be the most dangerous thing this check could say.
 */
function lintResult(lint: LintResult): CheckResult {
  const base = {
    id: 'lookahead-static',
    label: 'Look-ahead (static lint)',
    severity: 'critical' as const,
  };

  if (lint.errorCount > 0) {
    const first = lint.findings.find((f) => f.severity === 'error')!;
    return {
      ...base,
      status: 'fail',
      detail: `Line ${String(first.line)}: ${first.message}`,
      evidence: {
        errors: lint.errorCount,
        warnings: lint.warningCount,
        firstLine: first.line,
        rule: first.rule,
        snippet: first.snippet,
      },
    };
  }

  if (lint.warningCount > 0) {
    const first = lint.findings[0]!;
    return {
      ...base,
      status: 'warn',
      detail: `Line ${String(first.line)}: ${first.message}`,
      evidence: { warnings: lint.warningCount, firstLine: first.line },
    };
  }

  return {
    ...base,
    status: 'pass',
    detail: 'No look-ahead pattern found in the source.',
    evidence: { errors: 0, warnings: 0 },
  };
}

function prefixResult(prefix: PrefixInvarianceResult | null, cutoffCount: number): CheckResult {
  const base = {
    id: 'lookahead-prefix-invariance',
    label: 'Look-ahead (prefix invariance)',
    severity: 'critical' as const,
  };

  if (prefix === null) {
    const reason = 'The run window was too short to place any truncation cutoff inside it.';
    return { ...base, status: 'n/a', detail: reason, inconclusiveReason: reason };
  }

  if (prefix.firstDivergence !== null) {
    const d = prefix.firstDivergence;
    return {
      ...base,
      status: 'fail',
      detail:
        `Trade ${String(d.tradeSeq)} changed when later data was hidden: ${d.field} was ` +
        `${String(d.fullValue)} on the full range and ${String(d.truncatedValue)} with data cut ` +
        `at ${new Date(d.cutoffMs).toISOString()}. A decision that depends on later data is a leak.`,
      evidence: {
        field: d.field,
        tradeSeq: d.tradeSeq,
        bar: d.bar,
        time: new Date(d.time).toISOString(),
        cutoff: new Date(d.cutoffMs).toISOString(),
        fullValue: d.fullValue,
        truncatedValue: d.truncatedValue,
      },
    };
  }

  // No divergence is only meaningful if something was actually compared. Zero comparable trades
  // at every cutoff means the test ran and learned nothing, which is `n/a`, not a pass.
  if (prefix.usableCutoffs === 0) {
    const reason =
      'No trade was decided early enough to compare at any cutoff, so invariance was never tested.';
    return {
      ...base,
      status: 'n/a',
      detail: reason,
      inconclusiveReason: reason,
      evidence: { cutoffs: cutoffCount, usableCutoffs: 0 },
    };
  }

  /*
   * Passing, but say exactly WHAT passed — this is narrower than it looks, and observed to be so.
   *
   * Truncation only removes data at the END, so a leak with a BOUNDED horizon — `request.security`
   * with `lookahead_on`, which sees at most to the end of the current HTF bucket — only changes
   * decisions inside that bucket of the cutoff. That is precisely the region the A1 margin
   * excludes, so this test cannot see it. Verified against the leaky fixture: it passes 6 of 6
   * cutoffs while the static lint fails it at line 8.
   *
   * What it does catch is leaks with an UNBOUNDED horizon — `last_bar_index`, `barstate.islast`,
   * anything normalised over the whole series — because those change decisions everywhere, well
   * outside the margin. So this is a real check with a stated blind spot, not a formality.
   *
   * Amendment A1b closes the gap: splice DIFFERENT future data in rather than truncating, so
   * nothing is removed, no margin is needed, and an intra-bucket leak diverges immediately.
   */
  return {
    ...base,
    status: 'pass',
    detail:
      `No length-dependent divergence across ${String(prefix.usableCutoffs)} of ` +
      `${String(cutoffCount)} truncation cutoffs. Covers UNBOUNDED leaks — last_bar_index, ` +
      'barstate.islast, whole-series normalisation. A bounded look-ahead hides inside the ' +
      'comparison margin here and is covered by the future-splice check instead.',
    evidence: { cutoffs: cutoffCount, usableCutoffs: prefix.usableCutoffs },
  };
}

/**
 * The future-splice verdict (A1b).
 *
 * The one look-ahead layer whose PASS is worth something. The static lint can only report that it
 * recognised nothing; prefix invariance is structurally blind to a bounded leak. This compares a run
 * against one where only the future differs, with no margin, so a clean result means the strategy
 * demonstrably read nothing it should not have — at these cutoffs, on this data.
 */
function spliceResult(
  splice: PrefixInvarianceResult | null,
  cutoffCount: number,
  skipped: string | null,
  windowMs: number,
): CheckResult {
  const base = {
    id: 'lookahead-future-splice',
    label: 'Look-ahead (future splice)',
    severity: 'critical' as const,
  };

  if (splice === null) {
    const reason = 'The run window was too short to place a cutoff inside it.';
    return { ...base, status: 'n/a', detail: reason, inconclusiveReason: reason };
  }

  if (splice.firstDivergence !== null) {
    const d = splice.firstDivergence;
    return {
      ...base,
      status: 'fail',
      detail:
        `Trade ${String(d.tradeSeq)} changed when only the FUTURE was replaced: ${d.field} was ` +
        `${String(d.fullValue)} on the real series and ${String(d.truncatedValue)} once data after ` +
        `${new Date(d.cutoffMs).toISOString()} was swapped for a different real segment. Every bar ` +
        'up to that instant was byte-identical, so the decision depended on data the strategy ' +
        'could not legitimately have seen. This is a look-ahead leak.',
      evidence: {
        field: d.field,
        tradeSeq: d.tradeSeq,
        bar: d.bar,
        firstAffectedBarTime: new Date(d.time).toISOString(),
        cutoff: new Date(d.cutoffMs).toISOString(),
        realValue: d.fullValue,
        splicedValue: d.truncatedValue,
      },
    };
  }

  // A donor could not be found for at least one cutoff, so coverage is incomplete and a pass would
  // overstate what was tested.
  if (skipped !== null) {
    return { ...base, status: 'n/a', detail: skipped, inconclusiveReason: skipped };
  }

  if (splice.usableCutoffs === 0) {
    const reason =
      'No trade was decided before any cutoff, so no decision was ever compared. The check ran and ' +
      'learned nothing.';
    return {
      ...base,
      status: 'n/a',
      detail: reason,
      inconclusiveReason: reason,
      evidence: { cutoffs: cutoffCount, usableCutoffs: 0 },
    };
  }

  return {
    ...base,
    status: 'pass',
    detail:
      `Decisions were identical across ${String(splice.usableCutoffs)} of ${String(cutoffCount)} ` +
      `cutoffs when only the future was replaced — ${String(Number((windowMs / 86_400_000).toFixed(1)))} ` +
      'days of it, with no comparison margin. Unlike the truncation test, this does rule out a ' +
      'bounded look-ahead such as request.security with lookahead_on.',
    evidence: {
      cutoffs: cutoffCount,
      usableCutoffs: splice.usableCutoffs,
      margin: 0,
      // Reported because the window is derived per run (A16), so a reader can tell how far ahead
      // the perturbation actually reached.
      spliceWindowDays: Number((windowMs / 86_400_000).toFixed(2)),
    },
  };
}

/**
 * The causality verdict (A1a).
 *
 * Where the other look-ahead layers establish THAT a leak exists, this one says WHICH read caused
 * it: for each `request.security` call it attributes the returned value to a higher-timeframe
 * bucket and asks whether that bucket had closed by the chart bar's own close. A value that could
 * only have come from a bucket still forming is the leak, pinpointed at a bar and a call site.
 *
 * Judged at the bar's CLOSE, not its open: `lookahead_off` legitimately returns a bucket's value on
 * the chart bar where that bucket closes, and judging at the open would report every honest HTF
 * strategy as leaky.
 */
function judgeCausality(params: {
  readonly calls: readonly SecurityCall[] | null;
  readonly m1: readonly Bar[];
  readonly chartBarMs: number;
}): CheckResult {
  const base = {
    id: 'lookahead-causality',
    label: 'Look-ahead (request.security causality)',
    severity: 'critical' as const,
  };

  if (params.calls === null) {
    const reason =
      'The instrumentation seam was not installed, so no request.security call was observed. This ' +
      'is "we were not watching", not "nothing was wrong".';
    return { ...base, status: 'n/a', detail: reason, inconclusiveReason: reason };
  }

  if (params.calls.length === 0) {
    return {
      ...base,
      status: 'pass',
      detail:
        'The script makes no request.security calls, so it has no higher-timeframe read to leak through.',
      evidence: { calls: 0 },
    };
  }

  /*
   * One verdict per requested timeframe, because attribution needs that timeframe's buckets. A
   * script reading both H4 and D1 gets each judged against its own series; merging them would make
   * every value ambiguous against the other's buckets.
   */
  const byTimeframe = new Map<string, SecurityCall[]>();
  for (const call of params.calls) {
    const list = byTimeframe.get(call.timeframe) ?? [];
    list.push(call);
    byTimeframe.set(call.timeframe, list);
  }

  const results: { tf: string; result: CausalityResult }[] = [];
  const unparsed: string[] = [];

  for (const [pineTf, calls] of byTimeframe) {
    const tf = parsePineTimeframe(pineTf);
    if (tf === null) {
      unparsed.push(pineTf);
      continue;
    }
    const buckets = bucketsFromCandles(resample(params.m1, tf));
    results.push({
      tf: pineTf,
      result: checkCausality(calls, buckets, { chartBarMs: params.chartBarMs }),
    });
  }

  const leaky = results.filter((r) => r.result.verdict === 'leaky');
  if (leaky.length > 0) {
    const worst = leaky[0]!;
    const first = worst.result.leaks[0]!;
    return {
      ...base,
      status: 'fail',
      detail:
        `On bar ${String(first.bar)} a request.security("${worst.tf}") call returned ` +
        `${String(first.value)}, which matches only the bucket closing at ` +
        `${new Date(first.bucketCloseTime).toISOString()} — ` +
        `${String(Math.round(first.aheadByMs / 60_000))} minutes after that chart bar closed. The ` +
        'value could not have been known yet.',
      evidence: {
        timeframe: worst.tf,
        bar: first.bar,
        barCloseTime: new Date(first.barCloseTime).toISOString(),
        bucketCloseTime: new Date(first.bucketCloseTime).toISOString(),
        aheadByMinutes: Math.round(first.aheadByMs / 60_000),
        leakingBars: worst.result.leaks.length,
        barsJudged: worst.result.barsJudged,
      },
    };
  }

  if (unparsed.length > 0 || results.length === 0) {
    const reason =
      `Could not attribute calls for timeframe(s) ${unparsed.join(', ') || '(none parsed)'}, so ` +
      'causality was not established for them.';
    return { ...base, status: 'n/a', detail: reason, inconclusiveReason: reason };
  }

  const inconclusive = results.filter((r) => r.result.verdict === 'inconclusive');
  if (inconclusive.length > 0) {
    const worst = inconclusive[0]!;
    const reason =
      `Values from request.security("${worst.tf}") matched too many buckets to attribute — ` +
      `${String(worst.result.barsAmbiguous)} of ${String(worst.result.barsJudged)} judged bars were ` +
      'ambiguous. A boolean or flat series matches half the chart, so this says nothing either way.';
    return {
      ...base,
      status: 'n/a',
      detail: reason,
      inconclusiveReason: reason,
      evidence: {
        timeframe: worst.tf,
        barsAmbiguous: worst.result.barsAmbiguous,
        barsJudged: worst.result.barsJudged,
      },
    };
  }

  const judged = results.reduce((n, r) => n + r.result.barsJudged, 0);
  return {
    ...base,
    status: 'pass',
    detail:
      `Every attributable request.security value came from a bucket that had already closed — ` +
      `${String(judged)} bars judged across ${String(results.length)} timeframe(s).`,
    evidence: {
      calls: params.calls.length,
      barsJudged: judged,
      timeframes: results.map((r) => r.tf).join(', '),
    },
  };
}

/**
 * The fill-audit verdict (spec 06 §2).
 *
 * Only ONE condition fails here: a fill outside its bar's range. That is not a modelling choice or a
 * pessimistic assumption, it is an engine or data bug, and every number computed downstream of it is
 * meaningless — so it is critical.
 *
 * Touch fills are a WARNING, not a failure. A limit or stop at a level the bar only grazed is
 * recorded as filled, but in life the level has to be traded through and a wick may fill nobody.
 * That makes the result optimistic rather than wrong, and the honest thing is to quantify it: the
 * report carries what the P&L would be if every touch had required a tick of penetration.
 */
function fillAuditResult(audit: FillAuditResult, mintick: number): CheckResult {
  const base = {
    id: 'execution-fill-audit',
    label: 'Execution (fill audit)',
    severity: 'critical' as const,
  };

  if (audit.fillsChecked === 0) {
    const reason =
      audit.fillsUnlocatable > 0
        ? `None of the ${String(audit.fillsUnlocatable)} fills could be matched to a bar, so nothing was audited.`
        : 'The run produced no fills to audit.';
    return { ...base, status: 'n/a', detail: reason, inconclusiveReason: reason };
  }

  if (audit.outOfRange.length > 0) {
    const worst = [...audit.outOfRange].sort((a, b) => b.byPrice - a.byPrice)[0]!;
    return {
      ...base,
      status: 'fail',
      detail:
        `${String(audit.outOfRange.length)} fill(s) lie outside the bar they happened on. Worst: ` +
        `trade ${String(worst.tradeSeq)} ${worst.leg} filled at ${String(worst.price)} on bar ` +
        `${String(worst.bar)}, whose range is ${String(worst.low)}..${String(worst.high)} — ` +
        `${String(Math.round(worst.byPrice / mintick))} ticks outside. A price the bar never traded ` +
        'at is an engine or data bug, not a modelling assumption.',
      evidence: {
        outOfRange: audit.outOfRange.length,
        fillsChecked: audit.fillsChecked,
        worstTrade: worst.tradeSeq,
        worstBar: worst.bar,
        ticksOutside: Math.round(worst.byPrice / mintick),
      },
    };
  }

  const drop = audit.netPnlReported - audit.netPnlIfPenetrationRequired;

  if (audit.touches.length > 0) {
    return {
      ...base,
      status: 'warn',
      detail:
        `${String(audit.touches.length)} of ${String(audit.fillsChecked)} fills landed exactly on a ` +
        'bar extreme, so they assume a level the bar only touched was tradeable. Requiring one tick ' +
        `of penetration would move net P&L by ${drop.toFixed(2)} ` +
        `(${audit.netPnlReported.toFixed(2)} -> ${audit.netPnlIfPenetrationRequired.toFixed(2)}).`,
      evidence: {
        touches: audit.touches.length,
        fillsChecked: audit.fillsChecked,
        atOpen: audit.atOpen,
        netPnlReported: Number(audit.netPnlReported.toFixed(2)),
        netPnlIfPenetrationRequired: Number(audit.netPnlIfPenetrationRequired.toFixed(2)),
      },
    };
  }

  return {
    ...base,
    status: 'pass',
    detail:
      `All ${String(audit.fillsChecked)} fills sit inside their bar, and none depends on a level the ` +
      `bar merely touched. ${String(audit.atOpen)} filled at a bar open, consistent with ` +
      'next-bar-open market execution.',
    evidence: { fillsChecked: audit.fillsChecked, atOpen: audit.atOpen, touches: 0 },
  };
}

function toComparable(t: {
  side: string;
  qty: number;
  entryBar: number;
  entryTime: number;
  entryPrice: number;
  exitBar: number | null;
  exitTime: number | null;
  exitPrice: number | null;
}): {
  side: string;
  qty: number;
  entryBar: number;
  entryTime: number;
  entryPrice: number;
  exitBar: number | null;
  exitTime: number | null;
  exitPrice: number | null;
} {
  return {
    side: t.side,
    qty: t.qty,
    entryBar: t.entryBar,
    entryTime: t.entryTime,
    entryPrice: t.entryPrice,
    exitBar: t.exitBar,
    exitTime: t.exitTime,
    exitPrice: t.exitPrice,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** The stored symbol row as the engine's `SymbolSpec`. */
function toSpec(
  row: Awaited<ReturnType<typeof findSymbolByCode>>,
): Parameters<typeof orchestrateRun>[0]['symbol'] {
  return row as unknown as Parameters<typeof orchestrateRun>[0]['symbol'];
}

/**
 * The asymmetry check as a verdict.
 *
 * A flipped outcome is a FAIL: the trade did not merely cost a little more than reported, it did
 * not happen. Everything else is a warning at most, because the level error is a modelling
 * limitation of one-price-per-bar data rather than a defect in the run — real, quantified, and not
 * something a different backtest of the same strategy would avoid.
 */
function asymmetryResult(a: AsymmetryResult, source: string): CheckResult {
  const base = {
    id: 'execution-bid-ask-asymmetry',
    label: 'Execution (bid/ask asymmetry)',
    severity: 'warning' as const,
  };

  const basisNote = describeBasis(source);

  if (a.assessed === 0) {
    return {
      ...base,
      status: 'n/a',
      detail: `${a.explanation} Feed basis: ${basisNote}.`,
      inconclusiveReason: a.explanation,
    };
  }

  const evidence = {
    basis: a.basis,
    source,
    levelExitsAssessed: a.assessed,
    skipped: a.skipped,
    totalAccountError: Number(a.totalAccountError.toFixed(2)),
    meanAccountError: Number((a.meanAccountError ?? 0).toFixed(4)),
    outcomeFlips: a.flips,
  };

  if (a.flips > 0) {
    const worst = a.rows.filter((r) => r.outcomeFlips).slice(0, 3);
    return {
      ...base,
      status: 'fail',
      detail:
        `${String(a.flips)} of ${String(a.assessed)} level exits would not have triggered at all ` +
        `on the side of the book they actually fill on (${basisNote}). ` +
        worst
          .map(
            (r) =>
              `trade ${String(r.seq)} ${r.side} ${r.kind} at ${String(r.modelledPrice)} needed the ` +
              `stored price to reach ${r.requiredStoredPrice.toFixed(5)}`,
          )
          .join('; ') +
        `. ${a.explanation}`,
      evidence,
    };
  }

  return {
    ...base,
    status: a.totalAccountError > 0 ? 'warn' : 'pass',
    detail:
      a.totalAccountError > 0
        ? `${String(a.assessed)} level exits are flattered by ${a.totalAccountError.toFixed(2)} in ` +
          `total (${(a.meanAccountError ?? 0).toFixed(2)} per exit): every stop and target fills on ` +
          `the far side of the spread — ${describePerFill(a.perFill)}. No outcome flips. ` +
          `${a.explanation}`
        : `${String(a.assessed)} level exits carry no bid/ask error. ${a.explanation}`,
    evidence,
  };
}

/**
 * The M1 replay as a verdict.
 *
 * Any flip is a FAIL. A phantom target books a win that never happened; a missed stop books a win
 * where a loss really occurred. Both change the sign of a trade, which is a different category of
 * wrong from mispricing one — and a missed stop is invisible in every other report the run produces,
 * because its evidence sits on a bar where nothing appeared to happen.
 */
function replayResult(r: IntrabarReplayResult): CheckResult {
  const base = {
    id: 'execution-intrabar-replay',
    label: 'Execution (M1 intrabar replay)',
    severity: 'critical' as const,
  };

  if (r.assessed === 0) {
    return { ...base, status: 'n/a', detail: r.explanation, inconclusiveReason: r.explanation };
  }

  const evidence = {
    exitsReplayed: r.assessed,
    skipped: r.skipped,
    phantomTargets: r.phantomTargets,
    missedStops: r.missedStops,
    netPnlDelta: Number(r.netPnlDelta.toFixed(2)),
    stopDistance: r.levels?.stopDistance ?? 0,
    targetDistance: r.levels?.targetDistance ?? 0,
  };

  const flips = r.phantomTargets + r.missedStops;
  if (flips === 0) {
    return {
      ...base,
      status: 'pass',
      detail: `No outcome changes. ${r.explanation}`,
      evidence,
    };
  }

  const worst = r.rows
    .filter((row) => row.flip === 'missed-stop')
    .sort((a, b) => a.netPnlCorrected - a.netPnlReported - (b.netPnlCorrected - b.netPnlReported))
    .slice(0, 3);

  return {
    ...base,
    status: 'fail',
    detail:
      `${String(flips)} of ${String(r.assessed)} replayed exits change outcome — ` +
      `${String(r.missedStops)} missed stop(s), ${String(r.phantomTargets)} phantom target(s). ` +
      `Net P&L correction ${r.netPnlDelta.toFixed(2)}` +
      (worst.length > 0
        ? `. Worst: ` +
          worst
            .map(
              (row) =>
                `trade ${String(row.seq)} ${row.side} closed at ${String(row.enginePrice)} but its ` +
                `stop went at ${(row.truePrice ?? 0).toFixed(5)} first ` +
                `(${(row.netPnlCorrected - row.netPnlReported).toFixed(2)})`,
            )
            .join('; ')
        : '') +
      `. ${r.explanation}`,
    evidence,
  };
}

/**
 * Cost stress as a verdict.
 *
 * A warning, not a failure: a thin break-even is a property of the strategy, not a defect in the
 * run. The one thing that would be a defect is the two break-even figures disagreeing for a reason
 * nobody can name, so the detail always states both.
 */
function costStressResult(s: CostStressResult): CheckResult {
  const base = {
    id: 'execution-cost-stress',
    label: 'Execution (cost stress)',
    severity: 'warning' as const,
  };

  const evidence = {
    breakEvenMultiplier:
      s.breakEvenMultiplier === null ? 0 : Number(s.breakEvenMultiplier.toFixed(3)),
    empiricalPerSidePips: Number(((s.perFill.pipsPerFill ?? 0) as number).toFixed(3)),
    analyticalPerSidePrice: s.analyticalPerSidePrice ?? 0,
    deltaPct: s.deltaPct === null ? 0 : Number(s.deltaPct.toFixed(2)),
    tradeSetMoved: s.tradeSetMoved ? 1 : 0,
    points: s.points.map((p) => `${String(p.multiplier)}x:${p.netProfit.toFixed(0)}`).join(' '),
  };

  if (s.breakEvenMultiplier === null) {
    // Two very different things look alike here. Surviving every multiplier tested is a PASS — the
    // strongest result this check can give. Losing money at zero cost is `n/a`, because there is no
    // cost sensitivity to measure on a strategy that never had an edge to lose.
    const survivedEverything = (s.points[0]?.netProfit ?? 0) > 0;
    return survivedEverything
      ? { ...base, status: 'pass', detail: s.explanation, evidence }
      : { ...base, status: 'n/a', detail: s.explanation, inconclusiveReason: s.explanation };
  }

  // Surviving less than 1.5x its own costs means the edge is mostly an execution assumption.
  const thin = s.breakEvenMultiplier < 1.5;

  return {
    ...base,
    status: thin || s.agrees === false ? 'warn' : 'pass',
    detail:
      `${s.explanation} Empirical break-even ${((s.perFill.pipsPerFill ?? 0) as number).toFixed(2)} ` +
      `pips per side; the metrics report says ` +
      `${s.analyticalPerSidePrice === null ? 'n/a' : (s.analyticalPerSidePrice / 0.0001).toFixed(2)} pips.` +
      (thin
        ? ' Surviving under 1.5x its own costs makes this edge largely an execution assumption.'
        : ''),
    evidence,
  };
}

/** The OOS split as a verdict. */
function oosResult(o: OosSplitResult): CheckResult {
  const base = {
    id: 'overfitting-oos-split',
    label: 'Out-of-sample split',
    severity: 'critical' as const,
  };

  const evidence = {
    splitFraction: o.splitFraction,
    inSampleTrades: o.inSample.trades,
    outOfSampleTrades: o.outOfSample.trades,
    inSampleNetProfit: Number(o.inSample.netProfit.toFixed(2)),
    outOfSampleNetProfit: Number(o.outOfSample.netProfit.toFixed(2)),
    returnRatio:
      o.degradation.returnRatio === null ? 0 : Number(o.degradation.returnRatio.toFixed(3)),
    sharpeDelta:
      o.degradation.sharpeDelta === null ? 0 : Number(o.degradation.sharpeDelta.toFixed(3)),
  };

  if (o.verdict === 'n/a') {
    return {
      ...base,
      status: 'n/a',
      detail: o.explanation,
      inconclusiveReason: o.inconclusiveReason ?? o.explanation,
      evidence,
    };
  }

  return { ...base, status: o.verdict, detail: o.explanation, evidence };
}

/** Walk-forward as a verdict. */
function rollingOosResult(w: RollingOosResult): CheckResult {
  const base = {
    id: 'overfitting-rolling-oos',
    label: 'Rolling out-of-sample (fixed parameters)',
    severity: 'critical' as const,
  };

  const evidence = {
    folds: w.folds.length,
    assessableFolds: w.assessableFolds,
    foldsWithEdge: w.foldsWithEdge,
    foldsSurviving: w.foldsSurviving,
    consistencyPct: w.consistency === null ? 0 : Number((w.consistency * 100).toFixed(1)),
    medianRetention: w.medianRetention === null ? 0 : Number(w.medianRetention.toFixed(3)),
    outOfSampleTrades: w.totalOosTrades,
  };

  if (w.verdict === 'n/a') {
    return {
      ...base,
      status: 'n/a',
      detail: w.explanation,
      inconclusiveReason: w.inconclusiveReason ?? w.explanation,
      evidence,
    };
  }

  return { ...base, status: w.verdict, detail: w.explanation, evidence };
}

/**
 * The holdout's standing, as a check.
 *
 * Reported even when nothing is sealed, because "no holdout" is itself a fact about how much this
 * result is worth. A run that was truncated FAILS: its numbers describe a shorter window than the
 * one requested, and a report that quietly covers less than it says is the failure this check
 * exists to make impossible.
 */
function holdoutResult(
  active: Parameters<typeof describeHoldout>[0],
  history: Parameters<typeof describeHoldout>[1],
  truncation: SealTruncation | null,
): CheckResult {
  const base = { id: 'overfitting-holdout', label: 'Sealed holdout', severity: 'warning' as const };
  const description = describeHoldout(active, history);

  const evidence = {
    sealed: active === null ? 0 : 1,
    viewCount: active?.viewCount ?? 0,
    retiredSeals: (history ?? []).filter((h) => h.retiredAtMs !== null).length,
    barsWithheld: truncation?.barsWithheld ?? 0,
  };

  if (truncation !== null) {
    // WARN, not fail (A40). The run's recorded range is the EFFECTIVE one, so its numbers already
    // match the window they claim — nothing here is wrong, it is just a shorter question than the
    // one asked. `fail` stays reserved for a strategy failing a check.
    return {
      ...base,
      status: 'warn',
      detail:
        `A sealed holdout cut this range at ` +
        `${new Date(truncation.cutAtMs).toISOString().slice(0, 10)}, where ` +
        `the range requested ran to ` +
        `${new Date(truncation.requestedToMs).toISOString().slice(0, 10)}. The run is recorded ` +
        `against the shorter window it actually covered, so every figure here matches its stated ` +
        `range. ${description}`,
      evidence,
    };
  }

  if (active === null) {
    return {
      ...base,
      status: 'n/a',
      detail: description,
      inconclusiveReason: description,
      evidence,
    };
  }

  // A viewed holdout is not a failure — it is a weaker claim, and saying so is the whole job.
  return {
    ...base,
    status: active.viewCount === 0 ? 'pass' : 'warn',
    detail: description,
    evidence,
  };
}
