import { findSymbolByCode, listSymbols, readM1, readRun, type DbClient } from '@edgelab/db';
import { PineTsEngine, orchestrateRun } from '@edgelab/engine';
import {
  BUILT_IN_CHECKS,
  cutoffsFor,
  estimateSameBarBias,
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
 * A third layer, the `request.security` causality log, is built
 * (`packages/engine/src/pinets/security-log.ts`) but not wired: it needs the adapter to expose the
 * instrumentation seam per run, which is engine surgery this step did not take on.
 *
 * KNOWN GAP, measured rather than assumed: prefix invariance does NOT catch the leaky fixture. A
 * bounded look-ahead only perturbs decisions within one HTF bucket of the cutoff, which is the
 * region the A1 margin has to exclude to avoid failing every honest HTF strategy. The leak is
 * currently caught by the static lint alone. Amendment A1b — splice different future data instead
 * of truncating — is the fix, and is the first thing the next step should build.
 */

/** Cutoffs for the dynamic test. Spec 06 says six. */
const CUTOFF_COUNT = 6;

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

  const engine = new PineTsEngine({
    m1: {
      readM1: (_symbol, fromMs, toMs) =>
        Promise.resolve(m1.filter((b) => b.time >= fromMs && b.time < toMs)),
    },
    lookupSymbol: (code) => (code === symbolRow.symbol ? toSpec(symbolRow) : undefined),
  });

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

  /* --------------------------------------------------------- the checks */

  report(90, 'judging');

  const results: CheckResult[] = [
    lintResult(lint),
    prefixResult(prefix, cutoffs.length),
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
      `${String(cutoffCount)} truncation cutoffs. Does NOT rule out a bounded look-ahead such as ` +
      'request.security with lookahead_on — that hides inside the comparison margin, and the ' +
      'static lint is what catches it until the future-splice test (A1b) lands.',
    evidence: { cutoffs: cutoffCount, usableCutoffs: prefix.usableCutoffs },
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
