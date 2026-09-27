import { Redis } from 'ioredis';
import { jobCancelChannel } from '@edgelab/shared';

/**
 * Cancellation for in-flight jobs.
 *
 * BullMQ has no cancel: `job.remove()` only works while a job is still waiting, and once a
 * processor is running nothing in the queue can reach it. So cancellation travels out of band
 * — the API publishes on a per-job Redis channel, and the worker, which is the only process
 * holding the AbortController, aborts the piscina task. That terminates the thread.
 *
 * One PSUBSCRIBE for every job rather than a subscription per job: a Redis connection in
 * subscriber mode can issue no other commands, so one pattern subscription on one dedicated
 * connection is the cheap way to watch all of them.
 */

const CANCEL_PATTERN = 'edgelab:cancel:*';

export class CancellationWatcher {
  private readonly controllers = new Map<string, AbortController>();
  private readonly subscriber: Redis;
  private ready: Promise<void>;

  constructor(redisUrl: string) {
    this.subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });

    this.subscriber.on('pmessage', (_pattern: string, channel: string) => {
      const jobId = channel.slice('edgelab:cancel:'.length);
      const controller = this.controllers.get(jobId);
      // No controller means the job is not running here — another worker has it, or it already
      // finished. Either way there is nothing to abort and nothing to report.
      controller?.abort(new Error('cancelled by user'));
    });

    this.ready = this.subscriber.psubscribe(CANCEL_PATTERN).then(() => undefined);
  }

  /** Resolves once the pattern subscription is live, so a test can cancel deterministically. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /**
   * Register a job and get the signal its processor should pass down. Always unregister in a
   * `finally`, or the map grows for the life of the process.
   */
  register(jobId: string): AbortController {
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    return controller;
  }

  unregister(jobId: string): void {
    this.controllers.delete(jobId);
  }

  get watching(): number {
    return this.controllers.size;
  }

  async close(): Promise<void> {
    await this.subscriber.quit().catch(() => undefined);
  }
}

/** Publish a cancellation request. Used by the API. */
export async function requestCancel(redis: Redis, jobId: string): Promise<void> {
  await redis.publish(jobCancelChannel(jobId), '1');
}
