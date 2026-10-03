import type { Job, Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { createDbClient, type DbClient } from '@edgelab/db';
import type { Env } from '@edgelab/shared/config';

import { buildProviderRegistry } from './ingest/providers';
import { processBacktestJob, type BacktestJobData } from './jobs/backtest-job';
import { CancellationWatcher } from './jobs/cancellation';
import { JobEventPublisher } from './jobs/events';
import { BACKFILL_JOB, processBackfillJob, type BackfillJobData } from './jobs/backfill-job';
import { HOLDOUT_JOB, processHoldoutJob, type HoldoutJobData } from './jobs/holdout-job';
import { IngestCancelled, processIngestJob, type IngestJobData } from './jobs/ingest-job';
import {
  OPTIMIZATION_JOB,
  processOptimizationJob,
  type OptimizationJobData,
} from './jobs/optimization-job';
import { processValidationJob, type ValidationJobData } from './jobs/validation-job';
import { TaskPool } from './pool/pool';
import { parseBackfillTargets } from './ingest/backfill';
import { resolvePoolSize } from './pool/sizing';
import { QUEUE_NAMES, createQueue, createWorker } from './queues';

/**
 * Boot the workers and hand back a handle that can shut them down.
 *
 * Separate from `main.ts` so the end-to-end test can run real workers in its own process: the
 * entrypoint installs signal handlers and calls `process.exit`, which would take the test
 * runner with it. Sharing this function means the test exercises the SAME wiring that ships,
 * rather than a simplified copy that could drift from it.
 */

export interface WorkerHandle {
  readonly db: DbClient;
  readonly pool: TaskPool;
  readonly events: JobEventPublisher;
  readonly cancellation: CancellationWatcher;
  /** What the nightly scheduler registered, for the boot banner. Empty when none is configured. */
  readonly scheduledBackfills: readonly string[];
  /** Resolves once both workers are consuming, so a test can enqueue without racing. */
  ready(): Promise<void>;
  close(): Promise<void>;
}

export interface StartWorkersOptions {
  /** Threads for the piscina pool. The test uses 1 to keep memory predictable. */
  readonly maxThreads?: number;
  readonly taskTimeoutMs?: number;
}

export function startWorkers(env: Env, options: StartWorkersOptions = {}): WorkerHandle {
  const db = createDbClient(env.DATABASE_URL, { max: 8, statementTimeoutMs: 600_000 });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const pool = new TaskPool({
    // The pool size comes from validated config, falling back to the container's CPU quota (A67).
    maxThreads: options.maxThreads ?? resolvePoolSize(env.WORKER_POOL_SIZE).threads,
    taskTimeoutMs: options.taskTimeoutMs ?? env.TASK_TIMEOUT_MS,
    // The SAME limit the pre-flight check estimates against (A73): refusing against one figure and
    // dying against another would be worse than not checking.
    memoryLimitMb: env.TASK_MEMORY_LIMIT_MB,
  });
  const events = new JobEventPublisher(redis);
  const cancellation = new CancellationWatcher(env.REDIS_URL);
  const registry = buildProviderRegistry(env, redis);

  const backtestWorker = createWorker(
    QUEUE_NAMES.backtest,
    env.REDIS_URL,
    (job: Job) =>
      processBacktestJob(job as Job<BacktestJobData>, {
        db,
        pool,
        events,
        cancellation,
        databaseUrl: env.DATABASE_URL,
        redis,
      }),
    { concurrency: 1 },
  );

  const ingestWorker = createWorker(
    QUEUE_NAMES.ingest,
    env.REDIS_URL,
    (job: Job) =>
      processIngestJob(job as Job<IngestJobData>, { db, registry, events, cancellation }),
    { concurrency: 2 },
  );

  /*
   * Concurrency 1, and lower than the backtest worker's for a reason: one validation is already
   * about thirty engine runs plus a timeframe matrix, so two at once would contend for the same
   * piscina pool the inner runs use and make both slower than running them in sequence.
   */
  const validationWorker = createWorker(
    QUEUE_NAMES.validation,
    env.REDIS_URL,
    // One queue, two job kinds (A50). Sharing the queue is what makes the concurrency of 1 apply
    // ACROSS them rather than per kind — both saturate the same piscina pool, so one of each at
    // once would compete for the same threads and finish slower than running them in sequence.
    (job: Job) => {
      if (job.name === OPTIMIZATION_JOB) {
        return processOptimizationJob(job as Job<OptimizationJobData>, {
          db,
          events,
          cancellation,
          databaseUrl: env.DATABASE_URL,
        });
      }
      if (job.name === HOLDOUT_JOB) {
        return processHoldoutJob(job as Job<HoldoutJobData>, {
          db,
          events,
          cancellation,
          databaseUrl: env.DATABASE_URL,
        });
      }
      return processValidationJob(job as Job<ValidationJobData>, { db, events, cancellation });
    },
    { concurrency: 1 },
  );

  /*
   * The nightly backfill: one worker, concurrency 1, plus a job scheduler per target.
   *
   * `upsertJobScheduler` is keyed by id, so a redeploy re-registers the same schedule rather than
   * accumulating a duplicate every boot — which is what `queue.add({ repeat })` would do.
   */
  const backfillWorker = createWorker(
    QUEUE_NAMES.backfill,
    env.REDIS_URL,
    (job: Job) => processBackfillJob(job as Job<BackfillJobData>, { db, redis, env }),
    { concurrency: 1 },
  );

  const backfillQueue = createQueue(QUEUE_NAMES.backfill, env.REDIS_URL);
  const scheduled = scheduleBackfills(backfillQueue, env);

  const workers = [backtestWorker, ingestWorker, validationWorker, backfillWorker];

  for (const worker of workers) {
    worker.on('failed', (job, err) => {
      const cancelled = err instanceof IngestCancelled || err.name === 'IngestCancelled';
      const line = `[${worker.name}] ${job?.name ?? 'job'} #${String(job?.id)}`;
      if (cancelled) console.log(`${line} cancelled`);
      else console.error(`${line} failed:`, err.message);
    });
    worker.on('stalled', (jobId) => {
      console.warn(`[${worker.name}] job #${jobId} stalled — event loop was blocked`);
    });
    worker.on('error', (err) => {
      console.error(`[${worker.name}] worker error:`, err.message);
    });
  }

  return {
    db,
    pool,
    events,
    cancellation,
    async ready(): Promise<void> {
      await Promise.all([cancellation.whenReady(), ...workers.map((w) => w.waitUntilReady())]);
    },
    scheduledBackfills: scheduled,

    async close(): Promise<void> {
      await backfillQueue.close().catch(() => undefined);
      // Workers first, so in-flight jobs are not cut off from the resources they are using.
      await Promise.allSettled(workers.map((w) => w.close()));
      await Promise.allSettled([cancellation.close(), pool.close(), db.close(), redis.quit()]);
    },
  };
}

/**
 * Register a repeatable job per backfill target, and report what was registered.
 *
 * Returns the descriptions rather than logging them, so `main.ts` owns the output and a test can
 * assert on the result. An empty list is the DEFAULT and is not an error: a server that silently
 * began hitting a provider because it was deployed would be worse than one that needs a variable.
 */
function scheduleBackfills(queue: Queue, env: Env): string[] {
  const targets = parseBackfillTargets(env.BACKFILL_TARGETS);
  if (targets.length === 0) return [];

  // Default 03:17 UTC: off the hour, because every other scheduled thing in the world runs at :00.
  const pattern = env.BACKFILL_CRON;

  return targets.map((target) => {
    const id = `backfill:${target.symbolCode}:${target.provider}`;
    void queue.upsertJobScheduler(
      id,
      { pattern, tz: 'UTC' },
      { name: BACKFILL_JOB, data: { target } },
    );
    return `${id} at "${pattern}" UTC`;
  });
}
