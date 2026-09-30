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

import { HoldoutTestRefused, testOnHoldout } from '../validation/test-on-holdout';
import type { CancellationWatcher } from './cancellation';
import type { JobEventPublisher } from './events';

/**
 * The `holdout` job: one strategy, once, on data it has never seen.
 *
 * On the SAME queue as validation and optimisation at concurrency 1 (A50), because it runs the
 * engine like they do and would otherwise contend for the same pool.
 *
 * It is not cancellable partway in any useful sense — the view is recorded the moment the read
 * starts, so aborting after that point saves nothing that matters and leaves a spent holdout with
 * no result to show for it. The watcher is still registered so a cancel before the read is honoured,
 * and the job reports plainly when it is too late for one.
 */

export const HOLDOUT_JOB = 'holdout';

export interface HoldoutJobData {
  readonly validationId: string;
  readonly runId: string;
}

export interface HoldoutJobResult {
  readonly validationId: string;
  readonly verdict: string;
}

export interface HoldoutJobDeps {
  readonly db: DbClient;
  readonly events: JobEventPublisher;
  readonly cancellation: CancellationWatcher;
  readonly databaseUrl: string;
}

export async function processHoldoutJob(
  job: Job<HoldoutJobData>,
  deps: HoldoutJobDeps,
): Promise<HoldoutJobResult> {
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
    if (controller.signal.aborted) {
      // Before the read, so nothing has been spent. After it there is no such exit.
      await deps.events.emit({
        ...base,
        state: 'cancelled',
        percent: 100,
        message: 'cancelled before the holdout was read',
        updatedAt: Date.now(),
      });
      await setValidationState(deps.db, validationId, 'cancelled');
      return { validationId, verdict: 'n/a' };
    }

    const report = await testOnHoldout({
      db: deps.db,
      runId,
      databaseUrl: deps.databaseUrl,
      onProgress: (percent, message) => {
        progress.report(percent, message);
      },
    });

    await progress.flush();

    await completeValidation(deps.db, {
      id: validationId,
      verdict: report.result.verdict,
      report,
      context: await contextFor(deps.db, runId, report.holdoutId, report.viewCountAfter),
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

    /*
     * A refusal is a FAILED job with a usable message, not a crash.
     *
     * "No holdout is sealed" is an answer to the question asked, and the distinction matters here
     * more than elsewhere: the user pressed a button whose whole point was that it costs something,
     * so they need to know whether it cost anything. Both refusals happen before any read.
     */
    const message =
      error instanceof HoldoutTestRefused
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);

    await failValidation(deps.db, validationId, message);
    await deps.events.emit({
      ...base,
      state: 'failed',
      percent: 100,
      message,
      error: message,
      updatedAt: Date.now(),
    });

    throw error instanceof Error ? error : new Error(message);
  }
}

/**
 * The context this verdict was obtained under.
 *
 * `holdoutViewCount` is the count AFTER the test, which is the number that qualifies this result —
 * recording the count it started from would describe a holdout that no longer exists.
 */
async function contextFor(
  db: DbClient,
  runId: string,
  holdoutId: string,
  viewCountAfter: number,
): Promise<ValidationContext> {
  const run = await readRun(db.db, runId);
  const symbolRow = run === null ? null : await findSymbolByCode(db, run.symbol);
  const seal = symbolRow === null ? null : await readHoldoutFresh(db, symbolRow.id);

  return {
    feed: null,
    dataVersion: run?.dataVersion ?? null,
    engineId: run?.engineId ?? null,
    engineVersion: run?.engineVersion ?? null,
    holdoutId,
    holdoutViewCount: viewCountAfter,
    rangeFromMs: seal?.sealedFromMs ?? null,
    rangeToMs: null,
    requestedRangeToMs: null,
  };
}
