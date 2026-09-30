import type { Job } from 'bullmq';

import {
  completeValidation,
  failValidation,
  findSymbolByCode,
  readHoldoutFresh,
  readRun,
  setValidationState,
  type DbClient,
  type ValidationContext,
} from '@edgelab/db';
import { PINETS_VERSION } from '@edgelab/engine';
import type { OptimizationSpec } from '@edgelab/validation';

import { optimizeRun } from '../validation/optimize-run';
import type { CancellationWatcher } from './cancellation';
import type { JobEventPublisher } from './events';

/**
 * The `optimization` job: walk-forward optimisation over a stored run.
 *
 * On the SAME queue as validation, at concurrency 1 across both (A50). Both saturate the piscina
 * pool — a validation dispatches its timeframe matrix there, an optimisation dispatches 1,204
 * candidate runs — so one of each at once would compete for the same threads and finish slower than
 * in sequence, while appearing to make progress on two fronts.
 *
 * Progress carries the MEASURED ETA rather than a spinner, because 1,204 runs is minutes and a
 * progress bar with no horizon is indistinguishable from a hang.
 */

export const OPTIMIZATION_JOB = 'optimization';

export interface OptimizationJobData {
  readonly validationId: string;
  readonly runId: string;
  readonly spec: OptimizationSpec;
  readonly folds?: number;
}

export interface OptimizationJobResult {
  readonly validationId: string;
  readonly verdict: string;
}

export interface OptimizationJobDeps {
  readonly db: DbClient;
  readonly events: JobEventPublisher;
  readonly cancellation: CancellationWatcher;
  readonly databaseUrl: string;
}

export async function processOptimizationJob(
  job: Job<OptimizationJobData>,
  deps: OptimizationJobDeps,
): Promise<OptimizationJobResult> {
  const jobId = String(job.id);
  const { validationId, runId, spec } = job.data;
  const base = { jobId, queue: 'validation', runId };

  const controller = deps.cancellation.register(jobId);
  const progress = deps.events.throttled(base);

  await deps.events.emit({
    ...base,
    state: 'running',
    percent: 1,
    message: 'planning',
    updatedAt: Date.now(),
  });
  await setValidationState(deps.db, validationId, 'running');

  try {
    const report = await optimizeRun({
      db: deps.db,
      runId,
      spec,
      databaseUrl: deps.databaseUrl,
      ...(job.data.folds === undefined ? {} : { folds: job.data.folds }),
      onProgress: (done, total) => {
        if (controller.signal.aborted) {
          throw controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error('cancelled by user');
        }
        // Scaled to 1..99: the estimate is fitted, not exact (A35), so a bar that reached 100
        // before the work finished would be worse than one that arrives slightly late.
        const percent =
          total === 0 ? 1 : Math.min(99, Math.max(1, Math.round((done / total) * 98)));
        progress.report(percent, `${String(done)}/${String(total)} runs`);
      },
    });

    await progress.flush();

    await completeValidation(deps.db, {
      id: validationId,
      verdict: report.result.verdict,
      report,
      context: await contextFor(deps.db, runId),
      elapsedMs: report.elapsedMs,
    });

    await deps.events.emit({
      ...base,
      state: 'completed',
      percent: 100,
      message: report.result.explanation,
      updatedAt: Date.now(),
    });

    return { validationId, verdict: report.result.verdict };
  } catch (error: unknown) {
    await progress.flush();

    const cancelled = controller.signal.aborted;
    const message = error instanceof Error ? error.message : String(error);

    await failValidation(deps.db, validationId, message, cancelled ? 'cancelled' : 'failed');

    await deps.events.emit({
      ...base,
      state: cancelled ? 'cancelled' : 'failed',
      percent: 100,
      message: cancelled ? 'cancelled' : 'failed',
      updatedAt: Date.now(),
      error: message,
    });

    if (cancelled) return { validationId, verdict: 'cancelled' };
    throw error instanceof Error ? error : new Error(message);
  } finally {
    deps.cancellation.unregister(jobId);
  }
}

/**
 * The context an optimisation ran under.
 *
 * Assembled here rather than reported by the driver, unlike a validation (A49), because the driver
 * dispatches every run to the pool and never resolves a feed itself. The fields still come from the
 * same sources the validation records, so the two are comparable in the tab.
 */
async function contextFor(db: DbClient, runId: string): Promise<ValidationContext> {
  const run = await readRun(db.db, runId);
  const symbol = run === null ? null : await findSymbolByCode(db, run.symbol);
  const holdout = symbol === null ? null : await readHoldoutFresh(db, symbol.id);

  return {
    feed: null,
    dataVersion: symbol?.dataVersion ?? null,
    engineId: 'pinets',
    engineVersion: PINETS_VERSION,
    holdoutId: holdout?.id ?? null,
    holdoutViewCount: holdout?.viewCount ?? null,
    rangeFromMs: run?.fromMs ?? null,
    rangeToMs: run?.toMs ?? null,
    requestedRangeToMs: run?.requestedToMs ?? null,
  };
}
