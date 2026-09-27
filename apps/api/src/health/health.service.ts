import { Inject, Injectable } from '@nestjs/common';
import type { DbClient } from '@edgelab/db';
import type { DependencyHealth, HealthResponse } from '@edgelab/shared';
import { Redis } from 'ioredis';
import { DB_CLIENT, REDIS_CLIENT } from '../infra/infra.module';

/** How long a dependency gets to answer before we call it unhealthy. */
const PROBE_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async check(): Promise<HealthResponse> {
    const [database, redis] = await Promise.all([
      probe(() => this.db.ping()),
      probe(async () => {
        await this.redis.ping();
      }),
    ]);

    return {
      status: database.ok && redis.ok ? 'ok' : 'degraded',
      uptimeMs: Date.now() - this.startedAt,
      checks: { database, redis },
    };
  }
}

/**
 * Run a probe, timing it and converting any failure into a reportable result.
 *
 * Error messages are surfaced because they aid local debugging, but connection URLs
 * (which can embed credentials) are never included — only the driver's message.
 */
async function probe(fn: () => Promise<unknown>): Promise<DependencyHealth> {
  const startedAt = Date.now();
  try {
    await withTimeout(fn(), PROBE_TIMEOUT_MS);
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (err: unknown) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : 'unknown error',
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
