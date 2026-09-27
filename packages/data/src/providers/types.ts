import type { AssetClass, Bar, ProviderId, SymbolSpec } from '@edgelab/shared';

/**
 * One interface for every market-data source.
 *
 * `fetchM1` takes the full SymbolSpec rather than a bare symbol string because every
 * adapter needs `providerSymbols` to translate EURUSD -> eurusd / EUR/USD / BTCUSDT.
 * Keeping the registry as the single source of that mapping stops adapters from growing
 * their own hardcoded tables that drift from the database.
 */

export interface ProviderCapabilities {
  readonly id: ProviderId;
  readonly label: string;
  /** False when a required credential is absent — the adapter is disabled, not broken. */
  readonly enabled: boolean;
  /** Why it is disabled, shown on the provider card. Never contains the key itself. */
  readonly disabledReason?: string;
  readonly requiresKey: boolean;
  /** Whether bars carry a real spread, or only the symbol's defaultSpreadPoints. */
  readonly providesSpread: boolean;
  readonly assetClasses: readonly AssetClass[];
  /** Free-form note for the UI, e.g. 'M1 from 2003'. */
  readonly historyNote?: string;
  readonly rateLimit?: {
    readonly perMinute?: number;
    readonly perDay?: number;
  };
}

export interface FetchProgress {
  /** 0..100 */
  readonly percent: number;
  readonly message: string;
  /** Bars yielded so far across the whole fetch. */
  readonly barsEmitted: number;
  /** Cursor reached, so a cancelled job can resume from here. */
  readonly cursorMs: number;
}

export type ProgressFn = (progress: FetchProgress) => void;

export interface MarketDataProvider {
  readonly id: ProviderId;
  capabilities(): ProviderCapabilities;
  /**
   * Yield M1 bars in ascending batches for [fromMs, toMs).
   *
   * Every batch is already normalized: UTC epoch ms, strictly ascending, de-duplicated
   * and validated. Empty ranges yield nothing rather than throwing — markets close.
   */
  fetchM1(
    spec: SymbolSpec,
    fromMs: number,
    toMs: number,
    onProgress?: ProgressFn,
  ): AsyncIterable<Bar[]>;
}

/** A provider failure, tagged with whether retrying could plausibly help. */
export class ProviderError extends Error {
  public readonly provider: string;
  public readonly retryable: boolean;
  /** Set when the provider told us to back off for a specific duration. */
  public readonly retryAfterMs?: number;

  constructor(
    provider: string,
    message: string,
    options: { retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(`[${provider}] ${message}`, options.cause === undefined ? {} : { cause: options.cause });
    this.name = 'ProviderError';
    this.provider = provider;
    this.retryable = options.retryable ?? false;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

/** Thrown when the adapter cannot serve this symbol at all — a configuration problem. */
export class UnsupportedSymbolError extends ProviderError {
  constructor(provider: string, symbol: string) {
    super(provider, `No ${provider} identifier configured for ${symbol}`, { retryable: false });
    this.name = 'UnsupportedSymbolError';
  }
}

/** Local persistence for downloaded bars, so a re-run does not re-download. */
export interface BarStore {
  read(symbol: string, fromMs: number, toMs: number): Promise<Bar[]>;
  write(symbol: string, bars: readonly Bar[]): Promise<void>;
  coverage(symbol: string): Promise<{ from: number; to: number } | null>;
}
