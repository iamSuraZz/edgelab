import type { Job } from 'bullmq';

import { completeValidation, failValidation, setValidationState, type DbClient } from '@edgelab/db';

import { validateRun } from '../validation/validate-run';
import type { CancellationWatcher } from './cancellation';
import type { JobEventPublisher } from './events';

/**
 * The `validation` job: the seventeen-check suite over a stored run.
 *
 * Runs in the worker process rather than a piscina thread, unlike a backtest. That looks
 * inconsistent and is deliberate: `validateRun` performs about thirty engine runs of its own and
 * the timeframe matrix dispatches further work, so putting it inside a pool thread would have a
 * pool task spawning pool tasks. Its CPU cost is already bounded by the pool those inner runs use.
 *
 * The row is created `queued` by the API so a client has an id before the job is picked up. The
 * contract matches the backtest job's: leave the row in exactly one terminal state, whatever
 * happens, because a row stuck in `running` is indistinguishable from one still working.
 */

export const VALIDATION_JOB = 'validation';

export interface ValidationJobData {
  readonly validationId: string;
  readonly runId: string;
}

export interface ValidationJobResult {
  readonly validationId: string;
  readonly verdict: string;
}

export interface ValidationJobDeps {
  readonly db: DbClient;
  readonly events: JobEventPublisher;
  readonly cancellation: CancellationWatcher;
}

export async function processValidationJob(
  job: Job<ValidationJobData>,
  deps: ValidationJobDeps,
): Promise<ValidationJobResult> {
  const jobId = String(job.id);
  const { validationId, runId } = job.data;
  const base = { jobId, queue: 'validation', runId };

  const controller = deps.cancellation.register(jobId);
  const progress = deps.events.throttled(base);

  await deps.events.emit({
    ...base,
    state: 'running',
    percent: 1,
    message: 'starting',
    updatedAt: Date.now(),
  });
  await setValidationState(deps.db, validationId, 'running');

  try {
    const report = await validateRun({
      db: deps.db,
      runId,
      onProgress: (percent, message) => {
        // Checked on every tick rather than between checks: one check can be several engine runs,
        // so a cancel honoured only at check boundaries would look ignored for seconds.
        if (controller.signal.aborted) {
          throw controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error('cancelled by user');
        }
        progress.report(percent, message);
      },
    });

    await progress.flush();

    await completeValidation(deps.db, {
      id: validationId,
      verdict: report.verdict,
      report,
      // Reported BY the run (A40 and the holdout rules): which feed it resolved, the seal's view
      // count at that moment, and the effective range. Reconstructing them here could disagree.
      context: report.context,
      elapsedMs: report.elapsedMs,
    });

    await deps.events.emit({
      ...base,
      state: 'completed',
      percent: 100,
      message: report.headline,
      updatedAt: Date.now(),
    });

    return { validationId, verdict: report.verdict };
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

    // Same reasoning as the backtest job: a cancelled job must not be retried, and returning
    // rather than throwing is how that is expressed without coupling to bullmq's error classes.
    if (cancelled) return { validationId, verdict: 'cancelled' };
    throw error instanceof Error ? error : new Error(message);
  } finally {
    deps.cancellation.unregister(jobId);
  }
}
