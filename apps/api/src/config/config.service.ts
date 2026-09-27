import { Injectable } from '@nestjs/common';
import type { Env, PublicEnv } from '@edgelab/shared/config';
import { hasProviderKey, toPublicEnv } from '@edgelab/shared/config';

/**
 * Typed access to configuration. The raw Env — which contains secrets — is private to
 * this service; nothing else in the API can reach it.
 *
 * Secrets rule: there is deliberately no getter that returns the provider API key.
 * Only the worker/data layer needs it, and it is passed there explicitly. Controllers
 * can ask whether a key is configured, never what it is.
 */
@Injectable()
export class ConfigService {
  constructor(private readonly env: Env) {}

  get nodeEnv(): Env['NODE_ENV'] {
    return this.env.NODE_ENV;
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get databaseUrl(): string {
    return this.env.DATABASE_URL;
  }

  get redisUrl(): string {
    return this.env.REDIS_URL;
  }

  get apiPort(): number {
    return this.env.API_PORT;
  }

  get webPort(): number {
    return this.env.WEB_PORT;
  }

  get accountCurrency(): string {
    return this.env.ACCOUNT_CURRENCY;
  }

  get dataCacheDir(): string {
    return this.env.DATA_CACHE_DIR;
  }

  /** Whether the market-data provider is usable, without revealing the key. */
  get providerConfigured(): boolean {
    return hasProviderKey(this.env);
  }

  /** Safe to log or serialise — every secret is stripped. */
  publicConfig(): PublicEnv {
    return toPublicEnv(this.env);
  }
}
