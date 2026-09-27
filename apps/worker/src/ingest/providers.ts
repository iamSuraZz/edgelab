import path from 'node:path';
import {
  BinanceProvider,
  DukascopyProvider,
  type DukascopyOptions,
  RedisBudget,
  TWELVEDATA_LIMITS,
  TwelveDataProvider,
  type MarketDataProvider,
  type ProviderCapabilities,
  type RedisLike,
} from '@edgelab/data';
import type { Env } from '@edgelab/shared/config';
import type { ProviderId } from '@edgelab/shared';

/**
 * Builds the fetch-capable providers from validated config.
 *
 * A missing credential DISABLES an adapter rather than throwing: the Data page shows the
 * card greyed out with a reason, and only an attempt to actually use it errors. That is the
 * spec's "missing key = adapter disabled, not a crash".
 */

export interface ProviderRegistry {
  get(id: ProviderId): MarketDataProvider | undefined;
  capabilities(): ProviderCapabilities[];
  /** Live budget for the keyed providers, for the UI. */
  budget(id: ProviderId): RedisBudget | undefined;
}

/**
 * Per-provider option overrides.
 *
 * Exists for the nightly backfill, which wants pacing an interactive command would not tolerate —
 * twenty seconds between months is right for a scheduled job and intolerable at a prompt.
 */
export interface ProviderOverrides {
  readonly dukascopy?: Partial<DukascopyOptions>;
}

export function buildProviderRegistry(
  env: Env,
  redis: RedisLike,
  overrides: ProviderOverrides = {},
): ProviderRegistry {
  // Absolute so dukascopy-node does not resolve it against whatever cwd the worker has.
  const cacheDir = path.resolve(env.DATA_CACHE_DIR);

  const twelveBudget = new RedisBudget(redis, 'twelvedata', {
    perMinute: TWELVEDATA_LIMITS.perMinute,
    perDay: TWELVEDATA_LIMITS.perDay,
  });

  const providers = new Map<ProviderId, MarketDataProvider>();

  providers.set('dukascopy', new DukascopyProvider({ cacheDir, ...overrides.dukascopy }));
  providers.set('binance', new BinanceProvider());
  providers.set(
    'twelvedata',
    new TwelveDataProvider({
      // Empty string disables it; the adapter reports why via capabilities().
      apiKey: env.TWELVEDATA_API_KEY,
      budget: twelveBudget,
    }),
  );

  const budgets = new Map<ProviderId, RedisBudget>([['twelvedata', twelveBudget]]);

  return {
    get: (id) => providers.get(id),
    capabilities: () => [...providers.values()].map((p) => p.capabilities()),
    budget: (id) => budgets.get(id),
  };
}
