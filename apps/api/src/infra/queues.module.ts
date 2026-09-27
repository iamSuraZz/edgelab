import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import { ConfigService } from '../config/config.service';
import { REDIS_CLIENT } from './infra.module';

/**
 * The queues the API writes to. It only ever ENQUEUES — the worker owns execution — so these
 * are `Queue` instances, never `Worker`s.
 *
 * Queue names come from `@edgelab/worker`'s own constants in spirit, but are duplicated as
 * literals here rather than imported: the API must not depend on the worker package, or
 * deploying the API would drag piscina, pinets and the provider SDKs into its image.
 */

export const BACKTEST_QUEUE = Symbol('BACKTEST_QUEUE');
export const INGEST_QUEUE = Symbol('INGEST_QUEUE');

export const QUEUE_NAME = {
  backtest: 'backtest',
  ingest: 'ingest',
} as const;

/** Mirrors the worker's DEFAULT_JOB_OPTIONS. */
const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
} as const;

function makeQueue(name: string, redisUrl: string): Queue {
  return new Queue(name, {
    // BullMQ blocks on this connection, so ioredis must not abort long BRPOPLPUSH calls.
    connection: { url: redisUrl, maxRetriesPerRequest: null },
    defaultJobOptions: JOB_OPTIONS,
  });
}

@Injectable()
export class QueuesLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(BACKTEST_QUEUE) private readonly backtest: Queue,
    @Inject(INGEST_QUEUE) private readonly ingest: Queue,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.backtest.close(), this.ingest.close()]);
  }
}

/**
 * A second Redis connection, in SUBSCRIBER mode, for the SSE endpoint.
 *
 * Separate from `REDIS_CLIENT` because a connection that has subscribed can issue no other
 * command — sharing one would break every other Redis call the API makes the moment someone
 * opened a progress stream.
 */
export const REDIS_SUBSCRIBER_FACTORY = Symbol('REDIS_SUBSCRIBER_FACTORY');
export type RedisSubscriberFactory = () => Redis;

@Global()
@Module({
  providers: [
    {
      provide: BACKTEST_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Queue => makeQueue(QUEUE_NAME.backtest, config.redisUrl),
    },
    {
      provide: INGEST_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Queue => makeQueue(QUEUE_NAME.ingest, config.redisUrl),
    },
    {
      provide: REDIS_SUBSCRIBER_FACTORY,
      inject: [REDIS_CLIENT],
      // Duplicating the configured client rather than building a new one from the url keeps
      // TLS and auth settings identical without re-reading config.
      //
      // But the two OVERRIDES matter, because duplicate() inherits everything and the main
      // client is tuned for health checks — fail fast, never queue:
      //
      //   enableOfflineQueue  a fresh duplicate has not connected yet, so its very first
      //                       SUBSCRIBE is issued on a socket that is not writeable. With the
      //                       inherited `false` ioredis throws instead of waiting, which
      //                       rejects inside the SSE handler AFTER the headers are sent — so
      //                       the client gets one `queued` frame and a dead stream, and every
      //                       job looks like it never ran.
      //   maxRetriesPerRequest  a subscriber lives for the length of a job, not a request.
      //                       Giving up after 2 retries turns a brief reconnect into a
      //                       silently truncated progress stream.
      useFactory:
        (redis: Redis): RedisSubscriberFactory =>
        () =>
          redis.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null }),
    },
    QueuesLifecycle,
  ],
  exports: [BACKTEST_QUEUE, INGEST_QUEUE, REDIS_SUBSCRIBER_FACTORY],
})
export class QueuesModule {}
