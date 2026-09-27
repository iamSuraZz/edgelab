import { findSymbolByCode, listSymbols, readM1, readRun, type DbClient } from '@edgelab/db';
import { PineTsEngine, orchestrateRun } from '@edgelab/engine';
import {
  BUILT_IN_CHECKS,
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
  type PrefixInvarianceResult,
  type SameBarBiasEstimate,
  type Verdict,
} from '@edgelab/validation';
import { CostConfigSchema, DEFAULT_COSTS, timeframeMs, type Timeframe } from '@edgelab/shared';

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

/** How much of the future the splice test replaces. See the note at the call site. */
const SPLICE_WINDOW_MS = 7 * 24 * 60 * 60_000;

export interface ValidationReport {
  readonly runId: string;
  readonly verdict: Verdict;
  readonly headline: string;
  readonly results: readonly CheckResult[];
  readonly lint: LintResult;
  readonly prefix: PrefixInvarianceResult | null;
  readonly sameBar: SameBarBiasEstimate | null;
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

  await assertSingleFeed({
    db: params.db,
    symbolId: symbolRow.id,
    symbolCode: run.symbol,
    fromMs: run.fromMs,
    toMs: run.toMs,
  });

  const m1 = await readM1(params.db, symbolRow.id, barsFromMs, run.toMs);
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
    initialCapital: run.initialCapital,
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
        return readM1(params.db, row.id, fromMs, toMs);
      },
    },
  };

  report(10, 'running the full range');
  const full = await orchestrateRun(shared);

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
             * Replace ONE WEEK of minutes after the cutoff, not the whole remainder.
             *
             * A week covers a D1 bucket and most of a W1 one, which bounds the horizon of the leak
             * this test targets: `lookahead_on` on timeframe X sees at most to the end of the
             * current X bucket. Splicing the entire remainder instead needs a disjoint donor as
             * long as the run, which no early cutoff can supply — measured: the clean fixture
             * reported `n/a` for want of 104,809 donor bars.
             */
            const needed = m1.filter(
              (b) => b.time > cutoffMs && b.time <= cutoffMs + SPLICE_WINDOW_MS,
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
              windowMs: SPLICE_WINDOW_MS,
            });
            const spliced = await orchestrateRun({
              ...shared,
              engine: engineOver(grafted.bars),
            });
            return { trades: spliced.engineResult.trades.map(toComparable) };
          },
        });

  /* --------------------------------------------------------- the checks */

  report(90, 'judging');

  const results: CheckResult[] = [
    lintResult(lint),
    prefixResult(prefix, cutoffs.length),
    spliceResult(splice, cutoffs.length, spliceSkipped),
    ...runChecks(BUILT_IN_CHECKS, {
      bars: full.engineResult.bars,
      timeframe,
      trades: full.trades,
      equity: full.equityClose,
      initialCapital: run.initialCapital,
    }),
  ];

  const sameBar = estimateSameBarBias({
    fills: marketFillsFromTrades(
      full.trades.map((t, i) => ({
        seq: i + 1,
        side: t.side,
        qty: t.qty,
        entryBar: t.entryBar,
        entryPrice: t.entryPrice,
        exitBar: t.exitBar,
        exitPrice: t.exitPrice,
      })),
    ),
    bars: full.engineResult.bars,
    pointValue: symbolRow.pointValue,
    rateAt: () => 1,
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
      'cutoffs when only the future was replaced, with no comparison margin. Unlike the truncation ' +
      'test, this does rule out a bounded look-ahead such as request.security with lookahead_on.',
    evidence: { cutoffs: cutoffCount, usableCutoffs: splice.usableCutoffs, margin: 0 },
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
