import process from 'node:process';

import { loadDotEnvFile, loadEnv } from '@edgelab/shared/config';

import { startWorkers } from './boot';
import { QUEUE_NAMES } from './queues';

/**
 * Worker entrypoint. One BullMQ worker per queue, sharing one piscina pool and one
 * cancellation watcher.
 *
 * The invariant this file exists to hold: **nothing a job does can take the worker down.**
 * A Pine script that spins forever, a script that exhausts its heap, a provider returning 429,
 * a malformed CSV — each fails its own job and the worker keeps consuming. That is enforced in
 * three places: the piscina pool isolates CPU work in a killable thread, each processor catches
 * and reports, and the handlers at the bottom of this file catch what is left.
 */

async function main(): Promise<void> {
  loadDotEnvFile();
  const env = loadEnv(process.env);

  const handle = startWorkers(env);
  await handle.ready();

  console.log(
    `worker: listening on ${QUEUE_NAMES.backtest}, ${QUEUE_NAMES.ingest}, ` +
      `${QUEUE_NAMES.validation}`,
  );
  console.log(
    `worker: piscina threads=${String(handle.pool.stats.threads)} ` +
      `timeout=${String(handle.pool.stats.timeoutMs / 1000)}s ` +
      `memory=${String(handle.pool.stats.memoryLimitMb)}MB`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`worker: ${signal} received, draining…`);
    await handle.close();
    console.log('worker: stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Last line of defence. A rejection reaching here means a processor's own error handling has a
  // hole; log it and keep running rather than letting Node's default kill the worker and strand
  // every queued job.
  process.on('unhandledRejection', (reason: unknown) => {
    console.error('worker: unhandled rejection (job error handling has a hole):', reason);
  });
}

main().catch((err: unknown) => {
  console.error('worker failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
