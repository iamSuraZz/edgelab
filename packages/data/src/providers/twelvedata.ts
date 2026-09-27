import { z } from 'zod';
import type { Bar, SymbolSpec } from '@edgelab/shared';
import { normalizeBars } from './normalize';
import { BudgetExhaustedError, type RedisBudget } from './rate-limit';
import {
  ProviderError,
  UnsupportedSymbolError,
  type MarketDataProvider,
  type ProgressFn,
  type ProviderCapabilities,
} from './types';

/**
 * Twelve Data adapter.
 *
 * Behaviour forced by the real API (verified against the live service, not the docs):
 *
 *  - The default timezone is EXCHANGE-LOCAL, which for forex is Australia/Sydney. Omitting
 *    `timezone=UTC` silently shifts an entire dataset by 10-11 hours and returns HTTP 200.
 *    This is the single most dangerous parameter here.
 *  - `start_date`/`end_date` are naive wall-clock in that same zone. An ISO string with a
 *    trailing `Z` is accepted and the Z is IGNORED, so toISOString() is a latent bug —
 *    we format `yyyy-MM-dd HH:mm:ss`.
 *  - `end_date` is INCLUSIVE, so paging backwards must subtract one interval or the
 *    boundary bar repeats forever.
 *  - An out-of-range request is HTTP 400 with code 400, NOT `values: []`. A weekend would
 *    otherwise kill the backfill.
 *  - `volume` is ABSENT for forex and crypto, and every number is a STRING.
 *  - 429 has no Retry-After and resets on the wall-clock minute.
 */

const PROVIDER = 'twelvedata';
const BASE_URL = 'https://api.twelvedata.com/time_series';
const MAX_OUTPUTSIZE = 5000;
const MS_PER_MINUTE = 60_000;

/** Free plan. Kept here so the UI can show the budget without a second source of truth. */
export const TWELVEDATA_LIMITS = { perMinute: 8, perDay: 800 } as const;

/** Meta is polymorphic across asset classes, so it is modelled loosely on purpose. */
const ValueSchema = z.object({
  datetime: z.string().min(1),
  open: z.coerce.number(),
  high: z.coerce.number(),
  low: z.coerce.number(),
  close: z.coerce.number(),
  // Absent for fx and crypto — not null, not "0". Must be optional.
  volume: z.coerce.number().optional(),
});

const OkSchema = z.object({
  meta: z.looseObject({}).optional(),
  values: z.array(ValueSchema),
  status: z.string().optional(),
});

const ErrSchema = z.object({
  code: z.coerce.number(),
  message: z.string(),
  status: z.string().optional(),
});

export interface TwelveDataOptions {
  /** Absent or empty disables the adapter rather than crashing. */
  readonly apiKey?: string;
  readonly budget?: RedisBudget;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export class TwelveDataProvider implements MarketDataProvider {
  public readonly id = 'twelvedata' as const;

  private readonly apiKey: string;

  constructor(private readonly options: TwelveDataOptions = {}) {
    this.apiKey = options.apiKey ?? '';
  }

  capabilities(): ProviderCapabilities {
    const enabled = this.apiKey.length > 0;
    return {
      id: 'twelvedata',
      label: 'Twelve Data',
      enabled,
      // Never echo the key, only its presence.
      ...(enabled ? {} : { disabledReason: 'TWELVEDATA_API_KEY is not set' }),
      requiresKey: true,
      providesSpread: false,
      assetClasses: ['fx', 'metal', 'index', 'crypto'],
      historyNote: 'Intraday history depth depends on your plan',
      rateLimit: { perMinute: TWELVEDATA_LIMITS.perMinute, perDay: TWELVEDATA_LIMITS.perDay },
    };
  }

  async *fetchM1(
    spec: SymbolSpec,
    fromMs: number,
    toMs: number,
    onProgress?: ProgressFn,
  ): AsyncIterable<Bar[]> {
    if (this.apiKey.length === 0) {
      throw new ProviderError(PROVIDER, 'Adapter is disabled: no API key configured', {
        retryable: false,
      });
    }

    const symbol = spec.providerSymbols.twelvedata;
    if (symbol === undefined) throw new UnsupportedSymbolError(PROVIDER, spec.symbol);

    const sleep = this.options.sleep ?? defaultSleep;
    const totalMs = Math.max(1, toMs - fromMs);
    let barsEmitted = 0;

    // Page BACKWARDS from the newest bar, because end_date is the only cursor that lets
    // us walk a long range deterministically.
    let cursor = toMs - MS_PER_MINUTE;

    while (cursor >= fromMs) {
      if (this.options.budget !== undefined) {
        try {
          await this.options.budget.acquire(sleep);
        } catch (err) {
          if (err instanceof BudgetExhaustedError) {
            // Daily budget spent. Stop cleanly so the job can resume tomorrow from the
            // cursor rather than burning retries.
            throw new ProviderError(
              PROVIDER,
              `Daily credit budget exhausted at ${new Date(cursor).toISOString()}. ` +
                `Resume after the UTC day rolls over.`,
              { retryable: true, retryAfterMs: err.retryAfterMs, cause: err },
            );
          }
          throw err;
        }
      }

      const page = await this.fetchPage(symbol, fromMs, cursor, sleep);

      if (page.length === 0) break;

      /*
       * `volumeIsMeaningful: false` because this API omits volume for forex and crypto (see the
       * note at the top of this file). Without it, D4's "flat AND zero-volume" rule degenerates to
       * "flat" and deletes every quiet minute: measured at 20,464 of 185,008 lost over 2022-01..06,
       * concentrated in the thin hours.
       */
      const { bars } = normalizeBars(page, { fromMs, toMs, volumeIsMeaningful: false });
      if (bars.length > 0) {
        barsEmitted += bars.length;
        yield bars;
      }

      const oldest = bars[0]?.time ?? page[0]?.time;
      if (oldest === undefined || oldest <= fromMs) break;

      // end_date is INCLUSIVE, so step back one interval to avoid repeating this bar.
      const nextCursor = oldest - MS_PER_MINUTE;
      if (nextCursor >= cursor) break; // no forward progress: bail rather than spin
      cursor = nextCursor;

      onProgress?.({
        percent: Math.min(99, Math.round(((toMs - cursor) / totalMs) * 100)),
        message: `${spec.symbol} back to ${new Date(cursor).toISOString().slice(0, 16)}`,
        barsEmitted,
        cursorMs: cursor,
      });
    }

    onProgress?.({
      percent: 100,
      message: `${spec.symbol} complete`,
      barsEmitted,
      cursorMs: fromMs,
    });
  }

  private async fetchPage(
    symbol: string,
    fromMs: number,
    endCursor: number,
    sleep: (ms: number) => Promise<void>,
  ): Promise<Bar[]> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const now = this.options.now ?? (() => Date.now());

    const url = new URL(BASE_URL);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', '1min'); // case-sensitive: '1MIN' is a 400
    url.searchParams.set('outputsize', String(MAX_OUTPUTSIZE));
    url.searchParams.set('timezone', 'UTC'); // NON-NEGOTIABLE, see class docs
    url.searchParams.set('order', 'ASC');
    url.searchParams.set('start_date', formatNaiveUtc(fromMs));
    url.searchParams.set('end_date', formatNaiveUtc(endCursor));
    url.searchParams.set('apikey', this.apiKey);

    const response = await doFetch(url, { headers: { accept: 'application/json' } });
    const text = await response.text();

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ProviderError(PROVIDER, `Non-JSON response (HTTP ${String(response.status)})`, {
        retryable: response.status >= 500,
      });
    }

    const err = ErrSchema.safeParse(json);
    if (err.success && err.data.code !== 200) {
      return this.handleApiError(err.data, symbol, fromMs, endCursor, sleep, now);
    }

    const ok = OkSchema.safeParse(json);
    if (!ok.success) {
      throw new ProviderError(
        PROVIDER,
        `Unrecognised response shape: ${JSON.stringify(ok.error.issues.slice(0, 3))}`,
        { retryable: false },
      );
    }

    return ok.data.values.map((v) => ({
      time: parseNaiveUtc(v.datetime),
      open: v.open,
      high: v.high,
      low: v.low,
      close: v.close,
      // fx/crypto omit volume entirely; 0 is the honest value, not a guess.
      volume: v.volume ?? 0,
      spread: null,
    }));
  }

  private async handleApiError(
    error: z.infer<typeof ErrSchema>,
    symbol: string,
    fromMs: number,
    endCursor: number,
    sleep: (ms: number) => Promise<void>,
    now: () => number,
  ): Promise<Bar[]> {
    // 400 + "no data" is a routine weekend/holiday, not a failure.
    if (error.code === 400 && /no data is available/i.test(error.message)) {
      return [];
    }

    if (error.code === 429) {
      // Quota resets on the wall-clock minute and there is no Retry-After header.
      const at = now();
      const waitMs = (Math.floor(at / 60_000) + 1) * 60_000 - at + 50;
      await sleep(waitMs);
      return this.fetchPage(symbol, fromMs, endCursor, sleep);
    }

    if (error.code === 401) {
      throw new ProviderError(PROVIDER, 'API key rejected', { retryable: false });
    }

    if (error.code === 403) {
      // Plan gating: this symbol or this history depth is not on the current plan. Not
      // fatal for the whole ingest — the caller decides.
      throw new ProviderError(
        PROVIDER,
        `Plan does not permit ${symbol} at 1min for this range: ${error.message}`,
        { retryable: false },
      );
    }

    throw new ProviderError(PROVIDER, `code ${String(error.code)}: ${error.message}`, {
      retryable: error.code >= 500,
    });
  }
}

/** `yyyy-MM-dd HH:mm:ss` — a trailing Z would be silently ignored by the API. */
export function formatNaiveUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** The response datetime is naive wall-clock in the requested zone, which we pin to UTC. */
export function parseNaiveUtc(datetime: string): number {
  const normalised = datetime.includes('T') ? datetime : datetime.replace(' ', 'T');
  const withSeconds = /\d{2}:\d{2}:\d{2}/.test(normalised) ? normalised : `${normalised}:00`;
  return Date.parse(`${withSeconds}Z`);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
