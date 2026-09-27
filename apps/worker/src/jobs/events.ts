import type { Redis } from 'ioredis';
import { jobEventChannel, jobStateKey, type JobEvent } from '@edgelab/shared';

/**
 * The worker → API progress bridge.
 *
 * Two writes per event, on purpose:
 *
 *  - **PUBLISH** to a per-job channel, which any connected SSE stream receives immediately.
 *  - **SET** the same event as the job's last-known state, with a TTL.
 *
 * The SET is what makes a late subscriber work. Pub/sub has no history, so a client that
 * connects after the job finished would otherwise wait forever for an event that already
 * happened. The SSE endpoint replays this key first, then switches to live events.
 */

/** Long enough to survive a page reload after a job ends, short enough not to accumulate. */
const STATE_TTL_SECONDS = 3_600;

export class JobEventPublisher {
  constructor(private readonly redis: Redis) {}

  async emit(event: JobEvent): Promise<void> {
    const payload = JSON.stringify(event);
    // Pipelined so a progress tick costs one round trip rather than two.
    await this.redis
      .multi()
      .set(jobStateKey(event.jobId), payload, 'EX', STATE_TTL_SECONDS)
      .publish(jobEventChannel(event.jobId), payload)
      .exec();
  }

  /**
   * Progress emitter that COALESCES: percent is rounded and a repeat of the same rounded
   * percent-and-message pair is dropped.
   *
   * A Pine run reports progress far more often than anything can usefully display, and every
   * event is two Redis writes plus a wakeup for each connected client. Without this, the
   * bridge costs more than the backtest.
   */
  throttled(base: Omit<JobEvent, 'percent' | 'message' | 'updatedAt' | 'state'>): {
    report: (percent: number, message: string) => void;
    flush: () => Promise<void>;
  } {
    let last = '';
    let pending: Promise<void> = Promise.resolve();

    return {
      report: (percent, message) => {
        const rounded = Math.max(0, Math.min(100, Math.round(percent)));
        const key = `${String(rounded)}|${message}`;
        if (key === last) return;
        last = key;

        // Chained rather than fired in parallel so events cannot arrive out of order, and
        // errors are swallowed: losing a progress tick must never fail the job.
        pending = pending.then(() =>
          this.emit({
            ...base,
            state: 'running',
            percent: rounded,
            message,
            updatedAt: Date.now(),
          }).catch(() => undefined),
        );
      },
      flush: () => pending,
    };
  }
}
