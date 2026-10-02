import type { Job } from 'bullmq';
import type Redis from 'ioredis';

import type { DbClient } from '@edgelab/db';
import type { Env } from '@edgelab/shared/config';

import { runBackfill, type BackfillTarget } from '../ingest/backfill';

/**
 * The nightly backfill, as a REPEATABLE job inside the worker.
 *
 * This reverses what `backfill-cli.ts` used to argue for. Its reasoning was that scheduling belongs
 * outside the process: a cron entry is inspectable, kills cleanly and survives a deploy, whereas an
 * in-process timer needs the worker up all night and hides its own state. That reasoning assumed a
 * laptop. On a server that runs around the clock the premises change: the worker IS up all night, and
 * a cron entry would live outside the compose file — invisible to the repo, lost on a host rebuild,
 * and needing its own copy of the database URL.
 *
 * The objections are answered rather than dismissed:
 *
 *  - **Inspectable**: BullMQ's job scheduler is stored in Redis and every attempt is written to
 *    `ingest_jobs`, so `pnpm backfill --status` and the Data page both show what happened. That is
 *    more legible than a cron log on a host nobody logs into.
 *  - **Kills cleanly**: the worker's existing drain-on-SIGTERM path covers it.
 *  - **Survives a deploy**: `upsertJobScheduler` is keyed by id, so a redeploy re-registers the same
 *    schedule instead of accumulating duplicates — which a `queue.add({repeat})` per boot would.
 *
 * Deliberately NOT on the ingest queue. That queue serves downloads a person is waiting for, and a
 * nightly job that paces itself for twenty minutes between months would sit in front of them.
 */

export const BACKFILL_JOB = 'backfill';

export interface BackfillJobData {
  readonly target: BackfillTarget;
}

export interface BackfillJobResult {
  readonly state: string;
  readonly barsWritten: number;
  readonly message: string;
}

export interface BackfillJobDeps {
  readonly db: DbClient;
  readonly redis: Redis;
  readonly env: Env;
}

export async function processBackfillJob(
  job: Job<BackfillJobData>,
  deps: BackfillJobDeps,
): Promise<BackfillJobResult> {
  const { target } = job.data;
  const label = `${target.symbolCode} ${target.provider}`;

  const lines: string[] = [];
  const log = (line: string): void => {
    lines.push(line);
    // Also to stdout: `docker logs edgelab-worker` is the first place anyone looks, and the job log
    // needs Redis to be readable.
    console.log(`backfill[${label}] ${line}`);
  };

  log(
    `starting ${new Date(target.fromMs).toISOString().slice(0, 10)} → ${new Date(target.toMs).toISOString().slice(0, 10)}`,
  );

  try {
    const outcome = await runBackfill(target, { ...deps, log });

    /*
     * A rate-limited night RESOLVES, it does not fail.
     *
     * BullMQ would retry a failed job, and retrying into a provider that is already refusing is the
     * behaviour the pacing exists to avoid. The attempt is recorded as `rate-limited` in the
     * database either way, so nothing is lost by reporting success to the queue.
     */
    await job.log(lines.join('\n')).catch(() => undefined);
    return { state: outcome.state, barsWritten: outcome.barsWritten, message: outcome.message };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log(`failed: ${message}`);
    await job.log(lines.join('\n')).catch(() => undefined);
    throw error instanceof Error ? error : new Error(message);
  }
}
