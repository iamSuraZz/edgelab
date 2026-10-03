import type { MessagePort } from 'node:worker_threads';
import Piscina from 'piscina';

import { classifyTaskFailure } from './errors';
import { resolvePoolSize } from './sizing';

/**
 * A piscina pool with the two limits a user-supplied script needs: a wall-clock timeout and a
 * heap cap. A bad script must fail its own job and nothing else.
 *
 * Two things about piscina 5 that the obvious implementation gets wrong:
 *
 *  1. **There is no `taskTimeout` option.** It existed in piscina 4 and was removed in 5, and
 *     passing it is silently ignored — which is worse than an error, because the pool looks
 *     configured and isn't. Timeouts have to come from `RunOptions.signal`.
 *
 *  2. **An AbortSignal really does stop a synchronous infinite loop.** `signal` cannot
 *     interrupt running JS by itself, but piscina's abort handler calls `_removeWorker`, which
 *     terminates the thread outright, then `_ensureMinimumWorkers` to replace it. That is why
 *     `while (true) {}` in a Pine script is survivable.
 */

export interface IsolatedPoolOptions {
  /** Absolute path of the task module. Must default-export one function. */
  readonly filename: string;
  readonly maxThreads?: number;
  /** Wall-clock budget per task. Default 120s, per spec 03. */
  readonly taskTimeoutMs?: number;
  /** Per-thread old-generation heap cap in MB. Default 512. */
  readonly memoryLimitMb?: number;
  readonly idleTimeoutMs?: number;
}

export const DEFAULT_TASK_TIMEOUT_MS = 120_000;
export const DEFAULT_MEMORY_LIMIT_MB = 512;

export class IsolatedPool<TInput, TOutput> {
  private readonly pool: Piscina;
  private readonly timeoutMs: number;
  private readonly memoryLimitMb: number;

  constructor(options: IsolatedPoolOptions) {
    this.timeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    this.memoryLimitMb = options.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB;

    this.pool = new Piscina({
      filename: options.filename,
      maxThreads: options.maxThreads ?? resolvePoolSize().threads,
      idleTimeout: options.idleTimeoutMs ?? 30_000,
      resourceLimits: {
        maxOldGenerationSizeMb: this.memoryLimitMb,
        // The young generation is scratch space for short-lived objects; capping it keeps a
        // tight allocation loop from ballooning before the old-generation limit notices.
        maxYoungGenerationSizeMb: Math.max(16, Math.floor(this.memoryLimitMb / 8)),
      },
    });

    // A worker that dies between tasks emits here with nothing to reject. Without a listener
    // this is an unhandled 'error' event on an EventEmitter, which takes the whole PROCESS
    // down — the exact failure this class exists to prevent.
    this.pool.on('error', (error: unknown) => {
      console.error('pool: worker thread error with no owning task:', describe(error));
    });
  }

  /**
   * Run one task. Rejects with a `TaskFailure` subclass, never with a raw piscina error,
   * so a caller can branch on `.code` instead of matching message text.
   *
   * `signal` is the caller's own cancellation (a user pressing Cancel); it composes with the
   * timeout rather than replacing it.
   */
  async run(
    input: TInput,
    opts: {
      signal?: AbortSignal;
      /**
       * Objects to TRANSFER rather than clone — a `MessagePort` for progress, principally.
       * A port that is cloned instead of transferred arrives detached and silently drops
       * every message, so anything port-shaped in the input must be listed here.
       */
      transferList?: readonly MessagePort[];
      /**
       * The last stage the task reported, read AT FAILURE TIME.
       *
       * A getter rather than a value, because the point is to know where the task had got to when it
       * died — which is only knowable after the fact (A73). The caller owns the progress channel, so
       * it owns the answer.
       */
      lastStage?: () => { stage: string | null; chartBars: number | null };
    } = {},
  ): Promise<TOutput> {
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new Error('task timeout'));
    }, this.timeoutMs);
    // Node keeps the process alive for a pending timer; a fast task must not hold it open.
    timer.unref?.();

    const forwardCancel = (): void => {
      timeout.abort(opts.signal?.reason);
    };
    opts.signal?.addEventListener('abort', forwardCancel, { once: true });

    try {
      return (await this.pool.run(input, {
        signal: timeout.signal,
        // The cast is piscina's typing, not ours. Its `TransferList` is a conditional type
        // over `MessagePort.postMessage`'s second parameter, and against this @types/node
        // that resolves to the DOM overload's `StructuredSerializeOptions` rather than an
        // array. At runtime piscina wants an array, which is exactly what we pass.
        ...(opts.transferList === undefined
          ? {}
          : { transferList: [...opts.transferList] as unknown as never }),
      })) as TOutput;
    } catch (error: unknown) {
      throw classifyTaskFailure(error, {
        // Only a timeout we raised counts as a timeout. If the CALLER aborted, the task was
        // cancelled, which is not a failure of the script.
        timedOut: timeout.signal.aborted && opts.signal?.aborted !== true,
        timeoutMs: this.timeoutMs,
        memoryLimitMb: this.memoryLimitMb,
        ...(opts.lastStage === undefined
          ? {}
          : { lastStage: opts.lastStage().stage, chartBars: opts.lastStage().chartBars }),
      });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', forwardCancel);
    }
  }

  get stats(): {
    queueSize: number;
    threads: number;
    completed: number;
    timeoutMs: number;
    memoryLimitMb: number;
  } {
    return {
      queueSize: this.pool.queueSize,
      threads: this.pool.threads.length,
      completed: this.pool.completed,
      timeoutMs: this.timeoutMs,
      memoryLimitMb: this.memoryLimitMb,
    };
  }

  async close(): Promise<void> {
    await this.pool.destroy();
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
