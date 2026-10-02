import os from 'node:os';

/**
 * How many threads the piscina pools may use.
 *
 * `os.availableParallelism()`, never `os.cpus().length`. The two differ in exactly the case that
 * matters here: inside a container with a CPU quota, `os.cpus()` reports the HOST's cores. A worker
 * limited to 2 CPUs on a 16-core box would size its pool at 15 and spend its time context-switching
 * — slower than one thread, and invisible except as a job that mysteriously takes longer in
 * production than on a laptop. `availableParallelism()` reads the cgroup quota.
 *
 * One thread is left for the worker's own event loop: it serves BullMQ, publishes progress and
 * writes results, and starving it makes a busy pool look stalled from the outside.
 */

/** Explicit override, for a host where the quota is not what you want to spend. */
const ENV_KEY = 'WORKER_POOL_SIZE';

export interface PoolSizing {
  readonly threads: number;
  /** Where the number came from, so the worker can say so at boot. */
  readonly source: 'env' | 'available-parallelism';
  readonly available: number;
}

export function resolvePoolSize(env: NodeJS.ProcessEnv = process.env): PoolSizing {
  const available = availableCpus();
  const raw = env[ENV_KEY];

  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new RangeError(
        `${ENV_KEY} must be a positive integer, received ${JSON.stringify(raw)}. ` +
          'Leave it unset to use the CPUs available to this container.',
      );
    }
    return { threads: parsed, source: 'env', available };
  }

  return {
    threads: Math.max(1, available - 1),
    source: 'available-parallelism',
    available,
  };
}

function availableCpus(): number {
  // `availableParallelism` is Node 19+. Guarded rather than assumed so this module stays usable if
  // the runtime is ever older than the Dockerfile's pin.
  const fn = (os as { availableParallelism?: () => number }).availableParallelism;
  return typeof fn === 'function' ? fn.call(os) : os.cpus().length;
}

export function describePoolSizing(sizing: PoolSizing): string {
  return sizing.source === 'env'
    ? `worker pool: ${String(sizing.threads)} thread(s) from ${ENV_KEY} ` +
        `(${String(sizing.available)} CPU(s) available)`
    : `worker pool: ${String(sizing.threads)} thread(s), from ${String(sizing.available)} CPU(s) ` +
        `available to this container`;
}
