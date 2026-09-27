import type { Job } from 'bullmq';
import { Redis } from 'ioredis';

import { createDbClient, type DbClient } from '@edgelab/db';
import type { Env } from '@edgelab/shared/config';

import { buildProviderRegistry } from './ingest/providers';
import { processBacktestJob, type BacktestJobData } from './jobs/backtest-job';
import { CancellationWatcher } from './jobs/cancellation';
import { JobEventPublisher } from './jobs/events';
import { IngestCancelled, processIngestJob, type IngestJobData } from './jobs/ingest-job';
import { TaskPool } from './pool/pool';
import { QUEUE_NAMES, createWorker } from './queues';

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
    ...(options.maxThreads === undefined ? {} : { maxThreads: options.maxThreads }),
    ...(options.taskTimeoutMs === undefined ? {} : { taskTimeoutMs: options.taskTimeoutMs }),
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

  const workers = [backtestWorker, ingestWorker];

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
    async close(): Promise<void> {
      // Workers first, so in-flight jobs are not cut off from the resources they are using.
      await Promise.allSettled(workers.map((w) => w.close()));
      await Promise.allSettled([cancellation.close(), pool.close(), db.close(), redis.quit()]);
    },
  };
}
