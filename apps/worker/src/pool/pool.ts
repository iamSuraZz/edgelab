import { MessageChannel } from 'node:worker_threads';
import path from 'node:path';

import { IsolatedPool, type IsolatedPoolOptions } from './isolated-pool';
import type { BacktestTaskInput, BacktestTaskOutput } from './tasks/backtest';
import type { PingInput, PingOutput } from './tasks/ping';

/**
 * CPU-heavy work runs in a piscina thread pool so a long backtest never blocks the
 * BullMQ event loop (which must keep heartbeating or Redis marks jobs as stalled).
 *
 * Every pool here is an {@link IsolatedPool}: a wall-clock timeout and a heap cap, with a
 * crashing task failing its own job and nothing else. See `isolated-pool.ts` for why piscina
 * 5's missing `taskTimeout` makes that less obvious than it sounds.
 */

/**
 * Resolve a task file next to this module, matching our own extension: `.ts` when
 * running under tsx in dev, `.js` when running the compiled output. Hard-coding
 * either one breaks the other.
 */
export function taskPath(name: string): string {
  return path.resolve(__dirname, 'tasks', `${name}${path.extname(__filename)}`);
}

export interface PoolOptions {
  maxThreads?: number;
  /** Wall-clock budget per task. Defaults to 120s. */
  taskTimeoutMs?: number;
  /** Per-thread heap cap in MB. Defaults to 512. */
  memoryLimitMb?: number;
}

export class TaskPool {
  private readonly pingPool: IsolatedPool<PingInput, PingOutput>;
  private readonly backtestPool: IsolatedPool<BacktestTaskInput, BacktestTaskOutput>;

  constructor(options: PoolOptions = {}) {
    const shared: Omit<IsolatedPoolOptions, 'filename'> = {
      ...(options.maxThreads !== undefined ? { maxThreads: options.maxThreads } : {}),
      ...(options.taskTimeoutMs !== undefined ? { taskTimeoutMs: options.taskTimeoutMs } : {}),
      ...(options.memoryLimitMb !== undefined ? { memoryLimitMb: options.memoryLimitMb } : {}),
    };

    this.pingPool = new IsolatedPool<PingInput, PingOutput>({
      ...shared,
      filename: taskPath('ping'),
    });

    this.backtestPool = new IsolatedPool<BacktestTaskInput, BacktestTaskOutput>({
      ...shared,
      filename: taskPath('backtest'),
      // A Pine run holds bars, plots and an order log; 512 MB is generous for a month of H1
      // and tight enough that a runaway `var array` is stopped rather than swapping the box.
      memoryLimitMb: options.memoryLimitMb ?? 1_024,
    });
  }

  ping(input: PingInput, opts: { signal?: AbortSignal } = {}): Promise<PingOutput> {
    return this.pingPool.run(input, opts);
  }

  /**
   * Run a backtest in a worker thread.
   *
   * `onProgress` is wired through a MessageChannel: the thread has no other way to report
   * back, and a cloned port would silently swallow every message, so the port is transferred.
   * The channel is closed in `finally` — a port left open keeps the event loop alive and the
   * process never exits.
   */
  async backtest(
    input: Omit<BacktestTaskInput, 'progressPort'>,
    opts: { signal?: AbortSignal; onProgress?: (percent: number, message: string) => void } = {},
  ): Promise<BacktestTaskOutput> {
    const channel = new MessageChannel();

    channel.port2.on('message', (raw: unknown) => {
      const event = raw as { percent?: unknown; message?: unknown };
      if (typeof event.percent === 'number') {
        opts.onProgress?.(event.percent, typeof event.message === 'string' ? event.message : '');
      }
    });
    // Do not hold the process open for progress messages.
    channel.port2.unref();

    try {
      return await this.backtestPool.run(
        { ...input, progressPort: channel.port1 },
        {
          ...(opts.signal === undefined ? {} : { signal: opts.signal }),
          transferList: [channel.port1],
        },
      );
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  }

  get stats(): {
    queueSize: number;
    threads: number;
    timeoutMs: number;
    memoryLimitMb: number;
    backtestThreads: number;
  } {
    const { queueSize, threads, timeoutMs, memoryLimitMb } = this.pingPool.stats;
    return {
      queueSize,
      threads,
      timeoutMs,
      memoryLimitMb,
      backtestThreads: this.backtestPool.stats.threads,
    };
  }

  async close(): Promise<void> {
    await Promise.all([this.pingPool.close(), this.backtestPool.close()]);
  }
}
