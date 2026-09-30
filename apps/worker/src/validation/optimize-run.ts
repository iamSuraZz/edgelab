import { findSymbolByCode, readRun, type DbClient } from '@edgelab/db';
import {
  analyseWfOptimization,
  combinations,
  foldWindows,
  gridSize,
  pickWinner,
  type CandidateResult,
  type OptimizationSpec,
  type SegmentMetrics,
  type WfOptimizationResult,
} from '@edgelab/validation';
import { CostConfigSchema, DEFAULT_COSTS, timeframeMs, type Timeframe } from '@edgelab/shared';

import { IsolatedPool } from '../pool/isolated-pool';
import { taskPath } from '../pool/pool';
import type { OptimizeTaskInput, OptimizeTaskOutput } from '../pool/tasks/optimize';

/**
 * Walk-forward optimization, driven across the worker pool.
 *
 * OPT-IN, and the ETA is why. Every fold runs `combinations` in-sample candidates plus one
 * out-of-sample run for the winner, so four folds at the 300 cap is 1,204 engine runs. The
 * per-run cost is known rather than guessed (A33) — about `53ms + 0.042ms x bars` — so the estimate
 * below is arithmetic on a measurement, not a shrug.
 *
 * Candidates go through the piscina pool because they are CPU-bound, independent and numerous: the
 * exact shape a thread pool exists for. They are dispatched in waves the width of the pool so a
 * slow candidate cannot leave the other threads idle while the wave drains.
 */

export interface OptimizeRunParams {
  readonly db: DbClient;
  readonly runId: string;
  readonly spec: OptimizationSpec;
  /** Folds and the in-sample:out-of-sample block ratio. Defaults match the rolling check. */
  readonly folds?: number;
  readonly isRatio?: number;
  readonly databaseUrl: string;
  readonly maxThreads?: number;
  readonly onProgress?: (done: number, total: number, message: string) => void;
}

export interface OptimizeEstimate {
  readonly totalRuns: number;
  readonly barsPerInSampleFold: number;
  readonly estimatedMs: number;
  readonly threads: number;
  /** The in-sample fold size `estimatedMs` was calibrated at. */
  readonly calibratedBarsPerFold: number;
  /** True when this run's folds are far larger than the calibration, so the figure is a floor. */
  readonly isLowerBound: boolean;
}

/**
 * Cost constants, MEASURED for this check rather than borrowed from A33.
 *
 * A33 timed the engine alone — 53ms setup plus 0.042ms per bar — and using that here predicted 3.8s
 * for a run that took 79.9s. Two things it does not contain:
 *
 *   - the M1 READ in front of every candidate, which dominates. Caching bars per thread per window
 *     cut the same run to 24.2s;
 *   - POOL STARTUP, seven threads each loading the module graph, which is a flat ~11s and is most
 *     of the cost of a small optimization.
 *
 * So these are fitted to two real runs on this machine at 7 threads — 40 runs in 13.8s and 204 in
 * 24.2s — which reproduce as 13.5s and 23.9s. They are machine-specific and deliberately labelled
 * as an estimate; the point is to be within a factor of two rather than out by twenty.
 */
const POOL_STARTUP_MS = 11_000;
const PER_RUN_THREAD_MS = 444;

/**
 * The fold size those constants were fitted at.
 *
 * Both calibration runs were six months of H1, and `barsPerFold` was accepted by this function and
 * then never used — so the estimate is a constant per run whatever window it is asked about. On the
 * two-year acceptance run (8,760-bar in-sample folds) it predicted 14.2s against **84.6s** actual
 * (A56). The likely dominant term is the M1 read behind each candidate, which scales with the M1
 * span rather than with the number of runs, and none of it is modelled here.
 *
 * Rather than re-fit a two-parameter model from one new point — inventing a coefficient is exactly
 * what the check this belongs to exists to catch — the estimate now says what it was calibrated on
 * and flags a run well outside it.
 */
const CALIBRATED_BARS_PER_FOLD = 3_100;
/** Beyond this ratio the estimate is reported as a lower bound, not a prediction. */
const OUT_OF_CALIBRATION_RATIO = 1.5;

export function estimateOptimization(params: {
  readonly combinations: number;
  readonly folds: number;
  readonly barsPerFold: number;
  readonly threads: number;
}): OptimizeEstimate {
  const totalRuns = params.folds * (params.combinations + 1);
  const ratio = params.barsPerFold / CALIBRATED_BARS_PER_FOLD;

  return {
    totalRuns,
    barsPerInSampleFold: params.barsPerFold,
    // Startup is paid once; the rest divides by threads because candidates are independent, and
    // that division is the only thing making this check tolerable at all.
    estimatedMs: Math.round(
      POOL_STARTUP_MS + (totalRuns * PER_RUN_THREAD_MS) / Math.max(1, params.threads),
    ),
    threads: params.threads,
    calibratedBarsPerFold: CALIBRATED_BARS_PER_FOLD,
    /**
     * A lower bound rather than a prediction, and said so, because a figure known to be low is
     * worse than no figure when the reader is deciding whether to wait for it.
     */
    isLowerBound: ratio > OUT_OF_CALIBRATION_RATIO,
  };
}

export interface OptimizeRunReport {
  readonly runId: string;
  readonly result: WfOptimizationResult;
  readonly estimate: OptimizeEstimate;
  readonly elapsedMs: number;
}

export async function optimizeRun(params: OptimizeRunParams): Promise<OptimizeRunReport> {
  const startedAt = Date.now();
  const report = params.onProgress ?? ((): void => undefined);

  const run = await readRun(params.db.db, params.runId);
  if (run === null) throw new Error(`No backtest run with id ${params.runId}.`);

  const symbolRow = await findSymbolByCode(params.db, run.symbol);
  if (symbolRow === null) throw new Error(`Run ${params.runId} references unknown ${run.symbol}.`);

  const timeframe = run.timeframe as Timeframe;
  const tfMs = timeframeMs(timeframe) ?? 30 * 24 * 60 * 60_000;

  const foldCount = params.folds ?? 4;
  const isRatio = params.isRatio ?? 3;
  const windows = foldWindows(run.fromMs, run.toMs, foldCount, isRatio);

  const sets = combinations(params.spec);
  const grid = gridSize(params.spec);

  const threads = params.maxThreads ?? Math.max(1, (await cpuCount()) - 1);
  const barsPerFold = Math.round((windows[0]!.isToMs - windows[0]!.isFromMs) / tfMs);
  const estimate = estimateOptimization({
    combinations: sets.length,
    folds: foldCount,
    barsPerFold,
    threads,
  });

  const costs = CostConfigSchema.safeParse(run.costs);
  const baseInput = {
    databaseUrl: params.databaseUrl,
    source: run.pineSource,
    symbolCode: run.symbol,
    timeframe,
    initialCapital: run.initialCapital,
    accountCurrency: run.accountCurrency,
    costs: costs.success ? costs.data : DEFAULT_COSTS,
    props: asRecord(run.props),
    warmupBars: run.warmupBars,
  };

  const pool = new IsolatedPool<OptimizeTaskInput, OptimizeTaskOutput>({
    // Same resolver the job pool uses, so this works under tsx (.ts) and compiled (.js) alike.
    filename: taskPath('optimize'),
    maxThreads: threads,
    taskTimeoutMs: 120_000,
  });

  let done = 0;
  const total = estimate.totalRuns;

  const runOne = async (
    fromMs: number,
    toMs: number,
    inputs: Record<string, unknown>,
  ): Promise<SegmentMetrics> => {
    const out = await pool.run({ ...baseInput, fromMs, toMs, inputs });
    done += 1;
    report(done, total, `${String(done)}/${String(total)} runs`);
    return out;
  };

  try {
    const foldResults: {
      winner: Record<string, number> | null;
      inSample: SegmentMetrics | null;
      outOfSample: SegmentMetrics | null;
    }[] = [];

    let sensitivityFold: CandidateResult[] | undefined;

    for (const w of windows) {
      // Waves the width of the pool: a batch narrower than the pool wastes threads, and one
      // wider queues inside piscina where this loop cannot report progress against it.
      const candidates: CandidateResult[] = [];
      for (let i = 0; i < sets.length; i += threads) {
        const wave = sets.slice(i, i + threads);
        const metrics = await Promise.all(
          wave.map((set) => runOne(w.isFromMs, w.isToMs, { ...asRecord(run.inputs), ...set })),
        );
        wave.forEach((set, k) => candidates.push({ parameters: set, metrics: metrics[k]! }));
      }

      // Keep the FIRST fold's surface for the heatmap: it is the one whose out-of-sample period is
      // furthest from the end, so it is the least contaminated by whatever the user already knows
      // about recent performance.
      sensitivityFold ??= candidates;

      const winner = pickWinner(candidates, params.spec);
      if (winner === null) {
        foldResults.push({ winner: null, inSample: null, outOfSample: null });
        done += 1;
        continue;
      }

      const outOfSample = await runOne(w.oosFromMs, w.oosToMs, {
        ...asRecord(run.inputs),
        ...winner.parameters,
      });

      foldResults.push({
        winner: winner.parameters,
        inSample: winner.metrics,
        outOfSample,
      });
    }

    const result = analyseWfOptimization({
      spec: params.spec,
      folds: foldResults,
      combinationsRun: sets.length,
      gridSize: grid,
      ...(sensitivityFold === undefined ? {} : { sensitivityFold }),
    });

    return { runId: params.runId, result, estimate, elapsedMs: Date.now() - startedAt };
  } finally {
    await pool.close();
  }
}

async function cpuCount(): Promise<number> {
  const os = await import('node:os');
  return os.cpus().length;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}
