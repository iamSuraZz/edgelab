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
 *
 * The override arrives as an ALREADY-VALIDATED number from `@edgelab/shared/config`, not by reading
 * `process.env` here — only the zod loader reads the environment (PROJECT.md).
 */

export interface PoolSizing {
  readonly threads: number;
  /** Where the number came from, so the worker can say so at boot. */
  readonly source: 'configured' | 'available-parallelism';
  readonly available: number;
}

export function resolvePoolSize(configured?: number): PoolSizing {
  const available = availableCpus();

  if (configured !== undefined) {
    return { threads: configured, source: 'configured', available };
  }

  // `max(1, …)` because `available - 1` is 0 on a single-CPU container, and a pool of zero threads
  // accepts work and never runs it.
  return { threads: Math.max(1, available - 1), source: 'available-parallelism', available };
}

function availableCpus(): number {
  // `availableParallelism` is Node 19+. Guarded rather than assumed so this module stays usable if
  // the runtime is ever older than the Dockerfile's pin.
  const fn = (os as { availableParallelism?: () => number }).availableParallelism;
  return typeof fn === 'function' ? fn.call(os) : os.cpus().length;
}

export function describePoolSizing(sizing: PoolSizing): string {
  return sizing.source === 'configured'
    ? `worker pool: ${String(sizing.threads)} thread(s) from WORKER_POOL_SIZE ` +
        `(${String(sizing.available)} CPU(s) available)`
    : `worker pool: ${String(sizing.threads)} thread(s), from ${String(sizing.available)} CPU(s) ` +
        `available to this container`;
}
