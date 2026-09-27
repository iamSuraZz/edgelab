import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { createDbClient, type DbClient } from '@edgelab/db';
import { Redis } from 'ioredis';
import { ConfigService } from '../config/config.service';

export const DB_CLIENT = Symbol('DB_CLIENT');
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Owns the long-lived connections and closes them on shutdown so `pnpm dev` restarts
 * do not leak sockets.
 */
@Injectable()
export class InfraLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.db.close(), this.redis.quit()]);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DB_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): DbClient =>
        // The API only serves reads and enqueues jobs; the worker gets the big pool.
        createDbClient(config.databaseUrl, { max: 5 }),
    },
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis =>
        new Redis(config.redisUrl, {
          maxRetriesPerRequest: 2,
          // Health checks must fail fast rather than queue behind reconnects.
          enableOfflineQueue: false,
          lazyConnect: false,
        }),
    },
    InfraLifecycle,
  ],
  exports: [DB_CLIENT, REDIS_CLIENT],
})
export class InfraModule {}
