import {
  type Bar,
  type SymbolSpec,
  type Candle,
  type Timeframe,
  MS_PER_MINUTE,
  timeframeMs,
} from '@edgelab/shared';
import { resample, type ResampleOptions } from '@edgelab/data';
import { toPineSymbolInfo, type PineSymbolInfo } from './symbol-info';
import { parsePineTimeframe, splitTicker } from './timeframe';

/**
 * PineTS market-data provider backed by our own M1 store and resampler.
 *
 * This is the spec's "DbProvider", but it takes an injected M1Source rather than importing
 * @edgelab/db: packages/engine must not depend on the storage layer (see the dependency
 * rule in PROJECT.md). apps/worker composes it with a DB-backed source; tests pass an
 * in-memory one.
 *
 * It implements IProvider DIRECTLY rather than extending BaseProvider, which is what makes
 * OUR resampler own alignment: the runtime only aggregates inside BaseProvider, and only
 * for timeframes a provider declines to serve. Implementing the interface directly makes
 * that path unreachable, so every timeframe — including the ones request.security asks for
 * — comes back with the same bucket boundaries as the chart.
 */

/** Everything the provider needs from storage. */
export interface M1Source {
  /** M1 bars for [fromMs, toMs), ascending, no duplicates. */
  readM1(symbol: string, fromMs: number, toMs: number): Promise<Bar[]>;
  /**
   * Candles already aggregated to `tf`, when the source can produce them without materialising M1.
   *
   * OPTIONAL, and the reason it exists is memory rather than speed (A72). `readM1` hands over the
   * whole range as JS objects — ~170 bytes a bar, so 800MB for nine years of BTC — and the array is
   * then pinned for the run's lifetime by whoever supplied it. A source that can page M1 through a
   * `ResampleStream` returns only the aggregate, and the M1 never exists all at once.
   *
   * It must produce EXACTLY what `resample(await readM1(...), tf)` produces, including each bucket's
   * mean spread: the cost overlay reads that spread, and a source that dropped it would silently fall
   * back to `defaultSpreadPoints` and overstate costs — the A20 bug, reintroduced from a new angle.
   */
  readResampled?(symbol: string, tf: Timeframe, fromMs: number, toMs: number): Promise<Candle[]>;
}

/** PineTS Kline. All 12 fields are required; unused ones must be 0, not undefined. */
export interface Kline {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteAssetVolume: number;
  numberOfTrades: number;
  takerBuyBaseAssetVolume: number;
  takerBuyQuoteAssetVolume: number;
  ignore: number;
}

export interface ResamplingProviderOptions {
  readonly m1: M1Source;
  /** Resolve a canonical symbol code to its spec. */
  readonly lookupSymbol: (code: string) => SymbolSpec | undefined;
  /**
   * No returned bar on ANY timeframe may contain M1 data at or after this time. Used by
   * look-ahead tests: a bar is dropped entirely if its bucket extends past the cutoff,
   * because a partially-filled bucket would leak future information into its close.
   */
  readonly dataCutoffTs?: number;
  readonly resampleOptions?: ResampleOptions;
  /** Hard floor on how far back an unbounded request may scan. Default 3 years. */
  readonly maxLookbackMs?: number;
}

export class UnsupportedTimeframeError extends Error {
  constructor(raw: string) {
    super(`Script requested timeframe "${raw}", which EdgeLab does not store or resample.`);
    this.name = 'UnsupportedTimeframeError';
  }
}

export class UnknownSymbolError extends Error {
  constructor(tickerId: string) {
    super(`Script requested symbol "${tickerId}", which is not in the registry.`);
    this.name = 'UnknownSymbolError';
  }
}

export class UnsupportedTickerModifierError extends Error {
  constructor(modifier: string) {
    super(
      `Ticker modifier ";${modifier}" is not supported. Refusing rather than silently ` +
        `running on standard candles, which is what PineTS's own providers do.`,
    );
    this.name = 'UnsupportedTickerModifierError';
  }
}

const DEFAULT_MAX_LOOKBACK_MS = 3 * 365 * 24 * 60 * 60_000;

function spreadKey(tf: Timeframe, openTime: number): string {
  return `${tf}|${String(openTime)}`;
}

export class ResamplingPineProvider {
  /**
   * Measured spread per (timeframe, bucket open), captured during resampling.
   *
   * Keyed by timeframe as well as time because a script can request several timeframes and
   * two of them can share a bucket start — an H1 and a D1 bar both open at midnight.
   */
  private readonly spreadByBucket = new Map<string, number | null>();

  /** The resampled spread for a bucket, or null if none was measured. */
  spreadAt(tf: Timeframe, openTime: number): number | null {
    return this.spreadByBucket.get(spreadKey(tf, openTime)) ?? null;
  }

  private readonly options: ResamplingProviderOptions;

  /** Per-run cache: request.security re-asks for the same (symbol, tf) repeatedly. */
  private readonly cache = new Map<string, Kline[]>();

  /**
   * Errors encountered while serving data.
   *
   * The provider must NOT throw. PineTS calls it from inside `request.security` during bar
   * execution, and a rejection there escapes as an UNHANDLED REJECTION — it never reaches
   * the `run()` promise, so the run appears to succeed (or the process dies) instead of the
   * job failing. Verified by test. So we record and return empty, and the adapter raises
   * these after the run completes.
   */
  public readonly errors: Error[] = [];

  constructor(options: ResamplingProviderOptions) {
    this.options = options;
  }

  /** First recorded failure, if any. */
  firstError(): Error | undefined {
    return this.errors[0];
  }

  configure(): void {
    // Nothing to configure; the source is injected.
  }

  async getSymbolInfo(tickerId: string): Promise<PineSymbolInfo> {
    const { symbol } = splitTicker(tickerId);
    const spec = this.options.lookupSymbol(symbol);
    if (spec === undefined) throw new UnknownSymbolError(tickerId);
    return toPineSymbolInfo(spec);
  }

  async getMarketData(
    tickerId: string,
    timeframe: string,
    limit?: number,
    sDate?: number,
    eDate?: number,
  ): Promise<Kline[]> {
    try {
      return await this.serve(tickerId, timeframe, limit, sDate, eDate);
    } catch (err: unknown) {
      // Record, never throw — see the `errors` field for why.
      this.errors.push(err instanceof Error ? err : new Error(String(err)));
      return [];
    }
  }

  private async serve(
    tickerId: string,
    timeframe: string,
    limit?: number,
    sDate?: number,
    eDate?: number,
  ): Promise<Kline[]> {
    const { symbol, modifier } = splitTicker(tickerId);

    if (modifier !== null) {
      // PineTS's own providers silently strip this, so "the chart reports Heikin Ashi but
      // runs on standard data". Refusing is better than lying about what was tested.
      throw new UnsupportedTickerModifierError(modifier);
    }

    const spec = this.options.lookupSymbol(symbol);
    if (spec === undefined) throw new UnknownSymbolError(tickerId);

    const tf = parsePineTimeframe(timeframe);
    if (tf === null) throw new UnsupportedTimeframeError(timeframe);

    const key = `${symbol}|${tf}|${String(limit)}|${String(sDate)}|${String(eDate)}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const window = this.resolveWindow(tf, limit, sDate, eDate);

    /*
     * Prefer the aggregated read when the source offers one: it never materialises the M1 series,
     * which is the single largest term in a long-range run's memory (A71/A72). The fallback is the
     * original path, so every existing source and every test keeps working unchanged.
     */
    let candles =
      this.options.m1.readResampled !== undefined
        ? await this.options.m1.readResampled(symbol, tf, window.fromMs, window.toMs)
        : resample(
            await this.options.m1.readM1(symbol, window.fromMs, window.toMs),
            tf,
            this.options.resampleOptions,
          );

    // Cutoff: drop any bucket that would contain M1 at or after the cutoff. Checking
    // closeTime (the exclusive bucket end) is what makes this airtight — a bucket whose
    // end is past the cutoff had future minutes folded into its high/low/close.
    const cutoff = this.options.dataCutoffTs;
    if (cutoff !== undefined) {
      candles = candles.filter((c) => c.closeTime <= cutoff);
    }

    /*
     * Remember each bucket's measured spread before dropping into PineTS's Kline shape.
     *
     * Kline has no spread field, so this is the only place the figure still exists. Losing it
     * made the cost overlay fall back to `symbol.defaultSpreadPoints` on EVERY trade — 8 points
     * on EURUSD where the stored data measures ~3.5 — so spec 04's "use the per-bar spread from
     * the data" silently did not hold, and costs came out ~2x too high.
     */
    for (const c of candles) {
      this.spreadByBucket.set(spreadKey(tf, c.time), c.spread);
    }

    let klines = candles.map((c) => toKline(c.time, c.closeTime, c));

    // `limit` means the LAST N bars ending at eDate.
    if (limit !== undefined && limit > 0 && klines.length > limit) {
      klines = klines.slice(-limit);
    }

    this.cache.set(key, klines);
    return klines;
  }

  /**
   * Which M1 range to read.
   *
   * request.security asks with sDate = firstChartBar - 30 days and, when calc_bars_count
   * is set, can pass sDate undefined entirely — which against a large hypertable would be
   * an unbounded scan. maxLookbackMs is the floor that prevents that.
   */
  private resolveWindow(
    tf: Timeframe,
    limit: number | undefined,
    sDate: number | undefined,
    eDate: number | undefined,
  ): { fromMs: number; toMs: number } {
    const cutoff = this.options.dataCutoffTs;
    const maxLookback = this.options.maxLookbackMs ?? DEFAULT_MAX_LOOKBACK_MS;

    let toMs = eDate ?? Date.now();
    if (cutoff !== undefined && cutoff < toMs) toMs = cutoff;

    if (sDate !== undefined) {
      // Inclusive lower bound, so the forming bar is re-served on tail requests.
      return { fromMs: Math.max(0, Math.min(sDate, toMs)), toMs };
    }

    if (limit !== undefined && limit > 0) {
      // Enough M1 to build `limit` buckets, with slack for weekends and holidays.
      const bucketMs = timeframeMs(tf) ?? 31 * 24 * 60 * 60_000;
      const span = bucketMs * limit * 3 + 7 * 24 * 60 * 60_000;
      return { fromMs: Math.max(0, toMs - Math.min(span, maxLookback)), toMs };
    }

    return { fromMs: Math.max(0, toMs - maxLookback), toMs };
  }
}

function toKline(
  openTime: number,
  closeTime: number,
  c: { open: number; high: number; low: number; close: number; volume: number },
): Kline {
  return {
    openTime,
    // NOTE: openTime + duration, i.e. the 24/7 convention, matching the 24x7 session we
    // report in symbol-info.ts. See the note there for why we do not compute a real
    // session close.
    closeTime,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    // Required by the Kline type; 0 rather than undefined.
    quoteAssetVolume: 0,
    numberOfTrades: 0,
    takerBuyBaseAssetVolume: 0,
    takerBuyQuoteAssetVolume: 0,
    ignore: 0,
  };
}

/** Bars actually executed, for equity reconstruction. Mirrors the provider's mapping. */
export function klinesToBars(
  klines: readonly Kline[],
  /** Recovers the measured spread Kline cannot carry. Omit and every bar reports none. */
  spreadAt?: (openTime: number) => number | null,
): Bar[] {
  return klines.map((k) => ({
    time: k.openTime,
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
    volume: k.volume,
    spread: spreadAt?.(k.openTime) ?? null,
  }));
}

/** Minutes of M1 in one bucket of `tf`, for progress estimates. */
export function m1PerBucket(tf: Timeframe): number {
  const ms = timeframeMs(tf);
  return ms === null ? 43_200 : ms / MS_PER_MINUTE;
}
