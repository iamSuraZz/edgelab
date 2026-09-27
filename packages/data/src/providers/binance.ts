import type { Bar, SymbolSpec } from '@edgelab/shared';
import { normalizeBars } from './normalize';
import {
  ProviderError,
  UnsupportedSymbolError,
  type MarketDataProvider,
  type ProgressFn,
  type ProviderCapabilities,
} from './types';

/**
 * Binance spot klines. Public, no API key, crypto only.
 *
 * Behaviour forced by the real API:
 *
 *  - BTCUSD EXISTS on api.binance.com but is junk: near-zero-volume flat bars starting
 *    late 2025. The liquid pair is BTCUSDT, which is why the symbol registry maps
 *    BTCUSD -> BTCUSDT rather than probing for existence.
 *  - Minutes with no trades are OMITTED, so the cursor must advance from the last
 *    returned openTime. Striding by limit*60000 would skip real candles.
 *  - Row fields are mixed types: indices 0, 6, 8 are JSON numbers, the other nine are
 *    quoted decimal strings. Index 11 is a meaningless "0".
 *  - The newest kline is still OPEN and mutates, so anything with closeTime >= now is
 *    excluded.
 *  - limit > 1000 silently truncates instead of erroring, so it is clamped client-side.
 *  - 429 Retry-After is in SECONDS. Ignoring a 429 escalates to a 418 IP ban lasting up
 *    to three days, so a 418 aborts the whole fetch rather than retrying.
 *  - Rate limits are per IP, so the weight header is advisory only across processes.
 */

const PROVIDER = 'binance';
const BASE_URL = 'https://api.binance.com/api/v3/klines';
const MAX_LIMIT = 1000;
const MS_PER_MINUTE = 60_000;

export interface BinanceOptions {
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Override for testing or for a regional mirror. */
  readonly baseUrl?: string;
  /** Pause between pages; the public IP budget is 6000 weight/min and shared. */
  readonly pauseBetweenPagesMs?: number;
}

export class BinanceProvider implements MarketDataProvider {
  public readonly id = 'binance' as const;

  constructor(private readonly options: BinanceOptions = {}) {}

  capabilities(): ProviderCapabilities {
    return {
      id: 'binance',
      label: 'Binance',
      enabled: true,
      requiresKey: false,
      providesSpread: false,
      assetClasses: ['crypto'],
      historyNote: 'Spot 1m klines; USD symbols are served by the USDT pair',
    };
  }

  async *fetchM1(
    spec: SymbolSpec,
    fromMs: number,
    toMs: number,
    onProgress?: ProgressFn,
  ): AsyncIterable<Bar[]> {
    const symbol = spec.providerSymbols.binance;
    if (symbol === undefined) throw new UnsupportedSymbolError(PROVIDER, spec.symbol);

    const sleep = this.options.sleep ?? defaultSleep;
    const now = this.options.now ?? (() => Date.now());
    const pause = this.options.pauseBetweenPagesMs ?? 250;

    // Never request into the currently-forming candle.
    const hardEnd = Math.min(toMs, Math.floor(now() / MS_PER_MINUTE) * MS_PER_MINUTE);
    const totalMs = Math.max(1, hardEnd - fromMs);

    let cursor = fromMs;
    let barsEmitted = 0;

    while (cursor < hardEnd) {
      const rows = await this.fetchPage(symbol, cursor, hardEnd, sleep, now);
      if (rows.length === 0) break;

      const raw = rows.map(rowToBar).filter((b): b is Bar => b !== null);
      // Drop the still-open candle defensively as well as via hardEnd.
      const closed = raw.filter((b) => b.time + MS_PER_MINUTE <= hardEnd);

      const { bars } = normalizeBars(closed, { fromMs, toMs: hardEnd });
      if (bars.length > 0) {
        barsEmitted += bars.length;
        yield bars;
      }

      // Advance from the last OPEN TIME actually returned — not by arithmetic stride,
      // because empty minutes are omitted from the response.
      const lastOpen = lastOpenTime(rows);
      if (lastOpen === null) break;
      const nextCursor = lastOpen + MS_PER_MINUTE;
      if (nextCursor <= cursor) break; // no progress; refuse to spin
      cursor = nextCursor;

      onProgress?.({
        percent: Math.min(99, Math.round(((cursor - fromMs) / totalMs) * 100)),
        message: `${spec.symbol} to ${new Date(cursor).toISOString().slice(0, 16)}`,
        barsEmitted,
        cursorMs: cursor,
      });

      if (rows.length < MAX_LIMIT) break; // short page means we reached the end
      await sleep(pause);
    }

    onProgress?.({
      percent: 100,
      message: `${spec.symbol} complete`,
      barsEmitted,
      cursorMs: hardEnd,
    });
  }

  private async fetchPage(
    symbol: string,
    startTime: number,
    endTime: number,
    sleep: (ms: number) => Promise<void>,
    now: () => number,
    attempt = 0,
  ): Promise<unknown[]> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const url = new URL(this.options.baseUrl ?? BASE_URL);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', '1m'); // '1M' would be one MONTH
    url.searchParams.set('startTime', String(startTime));
    url.searchParams.set('endTime', String(endTime - 1));
    url.searchParams.set('limit', String(MAX_LIMIT));

    const response = await doFetch(url, { headers: { accept: 'application/json' } });

    if (response.status === 418) {
      // IP ban. Retrying makes it worse and it affects every symbol in flight.
      throw new ProviderError(
        PROVIDER,
        'HTTP 418: this IP is banned for ignoring rate limits. Stop all Binance ingestion.',
        { retryable: false },
      );
    }

    if (response.status === 429) {
      // Retry-After is in SECONDS.
      const header = response.headers.get('retry-after');
      const waitMs = header === null ? 60_000 : Math.max(1, Number(header)) * 1000;
      if (attempt >= 3) {
        throw new ProviderError(PROVIDER, 'Rate limited repeatedly', {
          retryable: true,
          retryAfterMs: waitMs,
        });
      }
      await sleep(waitMs);
      return this.fetchPage(symbol, startTime, endTime, sleep, now, attempt + 1);
    }

    if (response.status === 451 || response.status === 403) {
      // Regionally blocked. Degrade like a missing key rather than crashing the job.
      throw new ProviderError(
        PROVIDER,
        `HTTP ${String(response.status)}: Binance is not reachable from this host/region`,
        { retryable: false },
      );
    }

    const text = await response.text();

    if (!response.ok) {
      // Business errors are JSON {code, msg} with a 4xx status.
      const parsed = safeJson(text);
      const code =
        parsed !== null && typeof parsed === 'object' && 'code' in parsed
          ? Number((parsed as { code: unknown }).code)
          : undefined;
      const msg =
        parsed !== null && typeof parsed === 'object' && 'msg' in parsed
          ? String((parsed as { msg: unknown }).msg)
          : text.slice(0, 200);

      // -1121 invalid symbol, -1100 illegal chars, -1130 invalid param: configuration
      // problems that no amount of retrying fixes.
      const configError = code === -1121 || code === -1100 || code === -1130;
      throw new ProviderError(
        PROVIDER,
        `HTTP ${String(response.status)}${code === undefined ? '' : ` code ${String(code)}`}: ${msg}`,
        { retryable: !configError && response.status >= 500 },
      );
    }

    const json = safeJson(text);
    if (!Array.isArray(json)) {
      throw new ProviderError(PROVIDER, 'Expected an array of klines', { retryable: false });
    }
    return json;
  }
}

/**
 * Kline row -> Bar.
 *
 * Layout: [0] openTime (number), [1] open, [2] high, [3] low, [4] close, [5] volume
 * (strings), [6] closeTime (number), [7] quoteAssetVolume, [8] trades (number), ...
 *
 * Base-asset volume (index 5) is used, since that is what a backtest's position sizing
 * relates to.
 */
function rowToBar(row: unknown): Bar | null {
  if (!Array.isArray(row) || row.length < 6) return null;

  const time = Number(row[0]);
  const open = Number(row[1]);
  const high = Number(row[2]);
  const low = Number(row[3]);
  const close = Number(row[4]);
  const volume = Number(row[5]);

  if (!Number.isFinite(time) || !Number.isFinite(open)) return null;

  return {
    time,
    open,
    high,
    low,
    close,
    volume: Number.isFinite(volume) ? volume : 0,
    spread: null,
  };
}

function lastOpenTime(rows: readonly unknown[]): number | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (Array.isArray(row)) {
      const t = Number(row[0]);
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
