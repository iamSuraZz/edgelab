import { getHistoricalRates, instrumentMetaData } from 'dukascopy-node';
import type { Bar, SymbolSpec } from '@edgelab/shared';
import { isMarketOpen } from '../sessions';
import { joinBidAsk, normalizeBars } from './normalize';
import {
  ProviderError,
  UnsupportedSymbolError,
  type FetchProgress,
  type MarketDataProvider,
  type ProviderCapabilities,
  type ProgressFn,
} from './types';

/**
 * Dukascopy adapter. No API key, M1 back to 2003 for most fx, and it is the only free
 * source here that gives a real spread.
 *
 * Every non-obvious decision below is forced by dukascopy-node's actual behaviour, which
 * was read out of the installed source rather than assumed:
 *
 *  - `ignoreFlats` defaults to TRUE and drops flat candles INDEPENDENTLY per price side,
 *    so the bid and ask arrays can differ in length. We set it false AND join by
 *    timestamp; a positional zip would misassign every spread after the first divergence.
 *  - `dates.to` is EXCLUSIVE.
 *  - Timestamps are already UTC epoch milliseconds.
 *  - An empty range returns [] — it never throws — and a non-200 response ALSO returns []
 *    when retryCount is 0. Transient failures are therefore indistinguishable from
 *    "no data existed", which would silently punch holes in history. Mitigated by
 *    verifying each month against the trading calendar and retrying at this level.
 *  - Invalid config throws a BARE OBJECT `{ validationErrors }`, not an Error.
 *  - `normaliseDates` silently CLAMPS the request to the instrument's availability window
 *    and to now(), so we clamp explicitly and report it instead of quietly returning less.
 *  - Cache options are `useCache` + `cacheFolderPath`; there is no `cacheFolder`.
 */

/**
 * The server is still refusing after the full backoff ladder.
 *
 * Its own type so a caller can tell "come back later" apart from a real failure. Carries the
 * cursor it reached, which is what makes a resumable nightly job possible.
 */
export class RateLimitExhaustedError extends Error {
  readonly code = 'rate-limit-exhausted';

  constructor(
    message: string,
    readonly reachedMs: number,
  ) {
    super(message);
    this.name = 'RateLimitExhaustedError';
  }
}

export interface DukascopyOptions {
  /** Absolute path for the on-disk cache, i.e. DATA_CACHE_DIR. */
  readonly cacheDir: string;
  /** Retries inside dukascopy-node for network errors. */
  readonly retryCount?: number;
  readonly pauseBetweenRetriesMs?: number;
  /** URLs fetched per batch, and the pause between batches. */
  readonly batchSize?: number;
  readonly pauseBetweenBatchesMs?: number;
  /** Our own retries when a month comes back implausibly empty. */
  readonly emptyMonthRetries?: number;
  /** Backoff attempts when the server rate-limits us (HTTP 429). */
  readonly rateLimitRetries?: number;
  /**
   * Pause between MONTHS, separate from the intra-call batch pause.
   *
   * The knob a nightly backfill turns up. Backoff reacts after the limit is already hit and the
   * connection is already being throttled; pacing below the limit means never arriving there.
   * Three sessions of the two-year backfill died on 429 through all six backoff attempts, so the
   * default is generous and the nightly job is more generous still.
   */
  readonly pauseBetweenMonthsMs?: number;
  /** Injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const PROVIDER = 'dukascopy';

/** Array row for a non-tick timeframe: [timestamp, open, high, low, close, volume?]. */
type DukaRow = readonly number[];

export class DukascopyProvider implements MarketDataProvider {
  public readonly id = 'dukascopy' as const;

  constructor(private readonly options: DukascopyOptions) {}

  capabilities(): ProviderCapabilities {
    return {
      id: 'dukascopy',
      label: 'Dukascopy',
      enabled: true,
      requiresKey: false,
      providesSpread: true,
      assetClasses: ['fx', 'metal', 'index', 'energy', 'crypto'],
      historyNote: 'M1 from 2003 for most fx; per-instrument start dates vary',
    };
  }

  /** Earliest M1 the instrument actually has, straight from the library's metadata. */
  earliestM1(spec: SymbolSpec): number | null {
    const id = spec.providerSymbols.dukascopy;
    if (id === undefined) return null;
    const meta = (instrumentMetaData as Record<string, { startDayForMinuteCandles?: string }>)[id];
    const raw = meta?.startDayForMinuteCandles;
    if (raw === undefined) return null;
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? null : ms;
  }

  async *fetchM1(
    spec: SymbolSpec,
    fromMs: number,
    toMs: number,
    onProgress?: ProgressFn,
  ): AsyncIterable<Bar[]> {
    const instrument = spec.providerSymbols.dukascopy;
    if (instrument === undefined) throw new UnsupportedSymbolError(PROVIDER, spec.symbol);

    const sleep = this.options.sleep ?? defaultSleep;
    const emptyRetries = this.options.emptyMonthRetries ?? 2;

    // Clamp loudly rather than letting normaliseDates do it silently.
    const earliest = this.earliestM1(spec);
    let start = fromMs;
    if (earliest !== null && start < earliest) start = earliest;
    const end = Math.min(toMs, Date.now());

    if (end <= start) return;

    const months = monthChunks(start, end);
    let barsEmitted = 0;

    for (let i = 0; i < months.length; i += 1) {
      const chunk = months[i];
      if (chunk === undefined) continue;

      const report = (message: string): void => {
        if (onProgress === undefined) return;
        const progress: FetchProgress = {
          percent: Math.min(100, Math.round((i / months.length) * 100)),
          message,
          barsEmitted,
          cursorMs: chunk.from,
        };
        onProgress(progress);
      };

      report(`${spec.symbol} ${monthLabel(chunk.from)}`);

      const bars = await this.fetchMonthWithSanityRetry(
        instrument,
        spec,
        chunk,
        emptyRetries,
        sleep,
        report,
      );

      if (bars.length > 0) {
        barsEmitted += bars.length;
        yield bars;
      }

      // Pace between months. The library only paces within a single call, and a long backfill is
      // mostly the gaps between calls.
      if (i < months.length - 1) {
        await sleep(
          this.options.pauseBetweenMonthsMs ?? this.options.pauseBetweenBatchesMs ?? 1_000,
        );
      }
    }

    onProgress?.({
      percent: 100,
      message: `${spec.symbol} complete`,
      barsEmitted,
      cursorMs: end,
    });
  }

  /**
   * Fetch one month, and distrust an empty answer.
   *
   * A month that overlaps open market hours but returns nothing is far more likely to be
   * a swallowed 429/500 than a genuine hole, so retry before accepting it. This is the
   * only defence against the library reporting transport failures as empty arrays.
   */
  private async fetchMonthWithSanityRetry(
    instrument: string,
    spec: SymbolSpec,
    chunk: { from: number; to: number },
    retries: number,
    sleep: (ms: number) => Promise<void>,
    report: (message: string) => void,
  ): Promise<Bar[]> {
    const plausiblyEmpty = !rangeHasOpenMarket(chunk.from, chunk.to, spec);

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const bars = await this.fetchMonth(instrument, chunk, report);
      if (bars.length > 0 || plausiblyEmpty) return bars;

      if (attempt < retries) {
        const backoff = 2_000 * (attempt + 1);
        report(
          `${spec.symbol} ${monthLabel(chunk.from)} returned no bars despite open market ` +
            `hours — retrying in ${String(backoff)}ms`,
        );
        await sleep(backoff);
      }
    }

    throw new ProviderError(
      PROVIDER,
      `${spec.symbol} ${monthLabel(chunk.from)} returned no bars after ${String(retries + 1)} ` +
        `attempts, but the range contains open market hours. Treating this as a transport ` +
        `failure rather than storing a gap.`,
      { retryable: true },
    );
  }

  private async fetchMonth(
    instrument: string,
    chunk: { from: number; to: number },
    report: (message: string) => void,
  ): Promise<Bar[]> {
    const sleep = this.options.sleep ?? defaultSleep;

    // SEQUENTIAL, not Promise.all. dukascopy-node paces batches within a single call, so
    // running the bid and ask fetches concurrently doubles the in-flight request rate and
    // earns an HTTP 429 within a couple of months of history.
    const bidRows = await this.getRatesWithBackoff(instrument, chunk, 'bid', report);
    await sleep(this.options.pauseBetweenBatchesMs ?? 1_500);
    const askRows = await this.getRatesWithBackoff(instrument, chunk, 'ask', report);

    // ignoreFlats:false (needed for bid/ask alignment) makes Dukascopy emit synthetic flat
    // filler bars — a full 24h for every Sunday, and quieter runs across holidays and dead
    // midweek minutes. normalizeBars drops them by the D4 rule (flat AND zero volume), which
    // supersedes the Sunday-only session filter this used to apply: the volume rule catches
    // the holiday and midweek filler that a session window structurally cannot see.
    //
    // The ASK side keeps its filler (`dropFillerBars: false`). A flat zero-volume ask bar is
    // still the best available ask quote for that minute, and dropping it would lose the
    // spread on real bid bars whose ask side happened to be quiet.
    const bid = normalizeBars(rowsToBars(bidRows), { fromMs: chunk.from, toMs: chunk.to }).bars;
    const ask = normalizeBars(rowsToBars(askRows), {
      fromMs: chunk.from,
      toMs: chunk.to,
      dropFillerBars: false,
    }).bars;

    // Join on timestamp — see the note in normalize.ts on why this cannot be a zip.
    return joinBidAsk(bid, ask);
  }

  /**
   * getRates with backoff on retryable failures.
   *
   * dukascopy-node's own retryCount covers thrown network errors, but a 429 arrives as a
   * rejected request that it re-throws, so the backoff has to live here. Dukascopy's limit
   * is generous but not unlimited over a long backfill.
   */
  private async getRatesWithBackoff(
    instrument: string,
    chunk: { from: number; to: number },
    priceType: 'bid' | 'ask',
    report: (message: string) => void,
  ): Promise<DukaRow[]> {
    const sleep = this.options.sleep ?? defaultSleep;
    // 6 attempts is ~5 minutes of cumulative backoff (5,10,20,40,80,160s). Dukascopy's
    // 429 blocks outlast a short ladder, and failing a multi-month backfill an hour in
    // because we gave up after 75 seconds is the worse outcome.
    const attempts = this.options.rateLimitRetries ?? 6;

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.getRates(instrument, chunk, priceType);
      } catch (err) {
        const retryable = err instanceof ProviderError && err.retryable;
        if (!retryable) throw err;

        /*
         * Out of attempts: stop CLEANLY rather than failing.
         *
         * A persistent 429 is not a bug and not a corrupt range — it is the server saying "not
         * tonight". Raising a distinguishable error lets the nightly job record how far it reached
         * and exit zero, so the next run resumes instead of an operator seeing a red failure and
         * re-triggering into the same wall.
         */
        if (attempt >= attempts) {
          throw new RateLimitExhaustedError(
            `Dukascopy is still rate-limiting after ${String(attempts)} attempts ` +
              `(${monthLabel(chunk.from)}, ${priceType}). Stopping here; the next run resumes.`,
            chunk.from,
          );
        }

        // Dukascopy returns no Retry-After, so back off geometrically from 5s.
        const waitMs = 5_000 * 2 ** attempt;
        report(
          `rate limited on ${priceType} ${monthLabel(chunk.from)}; waiting ` +
            `${String(Math.round(waitMs / 1000))}s (attempt ${String(attempt + 1)}/${String(attempts)})`,
        );
        await sleep(waitMs);
      }
    }
  }

  private async getRates(
    instrument: string,
    chunk: { from: number; to: number },
    priceType: 'bid' | 'ask',
  ): Promise<DukaRow[]> {
    try {
      const result = await getHistoricalRates({
        instrument: instrument as Parameters<typeof getHistoricalRates>[0]['instrument'],
        dates: { from: new Date(chunk.from), to: new Date(chunk.to) },
        timeframe: 'm1',
        priceType,
        format: 'array',
        // Keep volumes so the row arity is stable at 6.
        volumes: true,
        // False so flat candles are NOT dropped per-side; combined with the timestamp
        // join this keeps bid/ask alignment intact.
        ignoreFlats: false,
        // Leave at 0: utcOffset only shifts the requested window and mutates the Dates.
        utcOffset: 0,
        useCache: true,
        cacheFolderPath: this.options.cacheDir,
        retryCount: this.options.retryCount ?? 3,
        pauseBetweenRetriesMs: this.options.pauseBetweenRetriesMs ?? 750,
        // Must stay false: it applies per-URL, so legitimately empty weekend hours would
        // retry and then throw. Emptiness is judged per MONTH in the caller instead.
        retryOnEmpty: false,
        failAfterRetryCount: true,
        // Gentler than the library's defaults (10 / 1000ms): a three-month M1 backfill
        // fetches hundreds of hourly URLs and Dukascopy starts returning 429 well before
        // the end of it.
        batchSize: this.options.batchSize ?? 5,
        pauseBetweenBatchesMs: this.options.pauseBetweenBatchesMs ?? 1_500,
      });

      return Array.isArray(result) ? (result as DukaRow[]) : [];
    } catch (err: unknown) {
      throw toProviderError(err, instrument, priceType);
    }
  }
}

/** [timestamp, open, high, low, close, volume?] -> Bar, defensively indexed. */
function rowsToBars(rows: readonly DukaRow[]): Bar[] {
  const out: Bar[] = [];
  for (const row of rows) {
    const time = row[0];
    const open = row[1];
    const high = row[2];
    const low = row[3];
    const close = row[4];
    if (
      time === undefined ||
      open === undefined ||
      high === undefined ||
      low === undefined ||
      close === undefined
    ) {
      continue;
    }
    out.push({ time, open, high, low, close, volume: row[5] ?? 0 });
  }
  return out;
}

/**
 * Invalid config throws a bare `{ validationErrors: [...] }` object with no message and
 * no prototype chain, so `instanceof Error` is false. Translate it before it escapes.
 */
function toProviderError(err: unknown, instrument: string, priceType: string): ProviderError {
  if (err !== null && typeof err === 'object' && 'validationErrors' in err) {
    const errors = (err as { validationErrors: unknown }).validationErrors;
    return new ProviderError(
      PROVIDER,
      `Rejected config for ${instrument} (${priceType}): ${JSON.stringify(errors)}`,
      { retryable: false, cause: err },
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ProviderError(PROVIDER, `${instrument} (${priceType}): ${message}`, {
    retryable: true,
    cause: err,
  });
}

export function monthChunks(fromMs: number, toMs: number): { from: number; to: number }[] {
  const chunks: { from: number; to: number }[] = [];
  const first = new Date(fromMs);
  let cursor = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1);

  while (cursor < toMs) {
    const d = new Date(cursor);
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    chunks.push({ from: Math.max(cursor, fromMs), to: Math.min(next, toMs) });
    cursor = next;
  }

  return chunks;
}

function monthLabel(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/** Does this range contain any open market minute? Sampled hourly — enough to decide. */
function rangeHasOpenMarket(fromMs: number, toMs: number, spec: SymbolSpec): boolean {
  if (spec.sessionType === 'crypto24x7') return toMs > fromMs;
  const HOUR = 3_600_000;
  for (let t = fromMs; t < toMs; t += HOUR) {
    if (isMarketOpen(t, spec.sessionType)) return true;
  }
  return false;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
