import { effectiveWindow, type Bar } from '@edgelab/shared';
import type { DbClient } from './client';
import { getHoldout, recordHoldoutView } from './holdout-repo';
import { fromDbTime, toDbTime } from './time';

/**
 * Read-side queries for stored M1 bars, plus the coverage summary the Data page needs.
 *
 * Every timestamp crossing this boundary is converted in ./time.ts — callers only ever see
 * UTC epoch milliseconds.
 */

export interface SymbolCoverage {
  readonly symbolId: string;
  readonly symbol: string;
  readonly firstBar: number | null;
  readonly lastBar: number | null;
  readonly barCount: number;
  readonly dataVersion: number;
  /** Distinct sources that contributed, for provenance in the UI. */
  readonly sources: readonly string[];
}

export interface DayCount {
  /** UTC midnight of the day. */
  readonly day: number;
  readonly bars: number;
}

/** Row shape as pg hands it back: timestamptz -> Date, double precision -> number. */
interface CandleRow {
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  spread: number | null;
}

/**
 * Bars for a window, with any SEALED HOLDOUT withheld.
 *
 * The seal is applied here because this is the one function every reader goes through — the Studio's
 * date presets, the backtest job, the validation runner, walk-forward, the optimiser. Enforcing it
 * anywhere higher would leave the others handing over the holdout without comment (A24).
 *
 * A request overlapping the seal is TRUNCATED, not refused: a backtest should still run on the data
 * it is allowed, because refusing would push people towards unsealing for ordinary work — the exact
 * habit the seal exists to prevent. What it must never do is return sealed bars while reporting the
 * requested range.
 *
 * To read sealed data deliberately, call `readM1Unsealed`, which records the view first.
 */
export interface SealTruncation {
  readonly sealId: string;
  /** The instant the data was cut at. */
  readonly cutAtMs: number;
  readonly requestedToMs: number;
  /** Bars the request would have received had nothing been sealed. */
  readonly barsWithheld: number;
}

/**
 * Bars, and whether a seal cut them short.
 *
 * The truncation is part of the RETURN TYPE rather than a side channel, so a caller cannot obtain
 * bars without also being handed the fact that they are incomplete. An optional callback or a
 * queryable "last truncation" would both rely on remembering to look, which is the same failure the
 * seal's placement at this function was chosen to avoid.
 */
export async function readM1(
  client: DbClient,
  symbolId: string,
  fromMs: number,
  toMs: number,
): Promise<M1Read> {
  const holdout = await getHoldout(client, symbolId);
  const window = effectiveWindow(fromMs, toMs, holdout);

  const bars = window.empty ? [] : await queryM1(client, symbolId, window.fromMs, window.toMs);

  if (!window.truncated || holdout === null) return { bars, truncation: null };

  // Counted rather than estimated from the withheld duration: bars are not evenly spaced, and a
  // figure derived from a weekend would overstate the loss badly.
  const withheld = await countM1(client, symbolId, window.toMs, toMs);

  return {
    bars,
    truncation: {
      sealId: holdout.id,
      cutAtMs: holdout.sealedFromMs,
      requestedToMs: toMs,
      barsWithheld: withheld,
    },
  };
}

/**
 * Page through a window's M1 bars, handing each to a callback, holding only one page.
 *
 * The reason this exists: reading a multi-year M1 range into an array costs ~170 bytes a bar, so BTC
 * over nine years is 800MB on the heap before the engine runs one bar, and the worker's 1024MB task
 * limit killed the run (A71). A caller that only needs an AGGREGATE — resampled candles, a count, a
 * scan — can fold the stream instead of materialising it.
 *
 * It deliberately knows nothing about resampling. `packages/data` owns the resampler and does not
 * depend on this package; importing it here to return candles would add a storage-to-aggregation edge
 * that nothing else needs. The consumer composes the two.
 *
 * The SEAL is applied through the same `effectiveWindow` as `readM1`, because this is a second way
 * into the bars and a reader that forgot the holdout would be a worse bug than the one it fixes. The
 * truncation comes back in the return value for the same reason it does there.
 *
 * Keyed paging on `ts`, not `LIMIT`/`OFFSET`: offset paging re-scans from the start of the range on
 * every page, turning a linear read into a quadratic one over millions of rows. Keyed paging is a
 * range scan per page and can neither skip nor repeat a row, since `(symbol_id, ts)` is the key.
 */
export interface M1Stream {
  readonly truncation: SealTruncation | null;
  /** M1 rows actually handed to the callback. */
  readonly barsRead: number;
}

/** Rows per page. 100k M1 objects is ~17MB resident — a tolerable floor for peak memory. */
export const M1_PAGE_ROWS = 100_000;

export async function streamM1(
  client: DbClient,
  symbolId: string,
  fromMs: number,
  toMs: number,
  onBar: (bar: Bar) => void,
  opts: { readonly unsealed?: boolean } = {},
): Promise<M1Stream> {
  /*
   * `unsealed` counts the view BEFORE a single page is read, exactly as `readM1Unsealed` does.
   *
   * The counting lives here rather than in the caller for the reason A59 recorded: there must be no
   * path that returns sealed bars and then fails to record that it did, and a flag the caller passes
   * is only safe if the recording is on this side of it.
   */
  if (opts.unsealed === true) {
    await recordHoldoutView(client, symbolId);
  }

  const holdout = opts.unsealed === true ? null : await getHoldout(client, symbolId);
  const window = effectiveWindow(fromMs, toMs, holdout);

  let barsRead = 0;

  if (!window.empty) {
    let cursorMs = window.fromMs;
    let inclusive = true;

    for (;;) {
      const page = await client.pool.query<CandleRow>(
        `SELECT ts, open, high, low, close, volume, spread
           FROM candles_m1
          WHERE symbol_id = $1 AND ts ${inclusive ? '>=' : '>'} $2 AND ts < $3
          ORDER BY ts
          LIMIT ${String(M1_PAGE_ROWS)}`,
        [symbolId, toDbTime(cursorMs), toDbTime(window.toMs)],
      );

      if (page.rows.length === 0) break;

      for (const row of page.rows) onBar(rowToBar(row));

      barsRead += page.rows.length;
      cursorMs = fromDbTime(page.rows[page.rows.length - 1]!.ts);
      inclusive = false;

      // A short page is the last page; checking saves a round trip per read.
      if (page.rows.length < M1_PAGE_ROWS) break;
    }
  }

  if (!window.truncated || holdout === null) return { truncation: null, barsRead };

  const withheld = await countM1(client, symbolId, window.toMs, toMs);

  return {
    truncation: {
      sealId: holdout.id,
      cutAtMs: holdout.sealedFromMs,
      requestedToMs: toMs,
      barsWithheld: withheld,
    },
    barsRead,
  };
}

/**
 * How many M1 rows a window holds, without reading them. Used by the pre-flight estimate.
 *
 * `unsealed` counts THROUGH a seal without recording a view, and the asymmetry with `streamM1` is
 * deliberate. A59's rule is about returning sealed BARS; a count reveals how many minutes exist, not
 * what they contain, and the read that follows records the view before a single one comes back.
 * Charging a view for the count would mean the holdout test spent two looks per run.
 *
 * Without this option the holdout test counts zero — its range IS the sealed range — and the caller
 * reports "no data" for a window full of it. That was a real regression, caught by the e2e that
 * asserts the view count rises by exactly one.
 */
export async function countM1InWindow(
  client: DbClient,
  symbolId: string,
  fromMs: number,
  toMs: number,
  opts: { readonly unsealed?: boolean } = {},
): Promise<{ bars: number; truncatedAtMs: number | null }> {
  const holdout = opts.unsealed === true ? null : await getHoldout(client, symbolId);
  const window = effectiveWindow(fromMs, toMs, holdout);

  if (window.empty) return { bars: 0, truncatedAtMs: window.truncated ? window.toMs : null };

  const bars = await countM1(client, symbolId, window.fromMs, window.toMs);
  return { bars, truncatedAtMs: window.truncated ? window.toMs : null };
}

export interface M1Read {
  readonly bars: Bar[];
  /** Present when a seal cut the request short. Null when the full range was returned. */
  readonly truncation: SealTruncation | null;
}

async function countM1(
  client: DbClient,
  symbolId: string,
  fromMs: number,
  toMs: number,
): Promise<number> {
  const result = await client.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM candles_m1 WHERE symbol_id = $1 AND ts >= $2 AND ts < $3`,
    [symbolId, toDbTime(fromMs), toDbTime(toMs)],
  );
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * Bars including the holdout, counting the view.
 *
 * Every call increments the symbol's view count before any data is returned, so there is no path to
 * sealed bars that leaves no trace. That counter is the only thing that distinguishes a holdout from
 * ordinary data: looked at often enough, it IS ordinary data.
 */
export async function readM1Unsealed(
  client: DbClient,
  symbolId: string,
  fromMs: number,
  toMs: number,
): Promise<Bar[]> {
  await recordHoldoutView(client, symbolId);
  return queryM1(client, symbolId, fromMs, toMs);
}

/** Bars only, for the many callers that cannot be truncated or have already reported it. */
export async function readM1Bars(
  client: DbClient,
  symbolId: string,
  fromMs: number,
  toMs: number,
): Promise<Bar[]> {
  return (await readM1(client, symbolId, fromMs, toMs)).bars;
}

async function queryM1(
  client: DbClient,
  symbolId: string,
  fromMs: number,
  toMs: number,
): Promise<Bar[]> {
  const result = await client.pool.query<CandleRow>(
    `SELECT ts, open, high, low, close, volume, spread
     FROM candles_m1
     WHERE symbol_id = $1 AND ts >= $2 AND ts < $3
     ORDER BY ts`,
    [symbolId, toDbTime(fromMs), toDbTime(toMs)],
  );

  return result.rows.map(rowToBar);
}

/** One row -> one `Bar`, shared by the array reader and the streaming one so they cannot diverge. */
function rowToBar(r: CandleRow): Bar {
  return {
    time: fromDbTime(r.ts),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    spread: r.spread,
  };
}

/** Newest stored bar, which is where a resumable ingest picks up. */
export async function lastStoredBar(client: DbClient, symbolId: string): Promise<number | null> {
  const result = await client.pool.query<{ ts: Date | null }>(
    // ORDER BY ts DESC LIMIT 1 rather than max(ts): it uses the index and stays cheap on
    // a compressed hypertable.
    `SELECT ts FROM candles_m1 WHERE symbol_id = $1 ORDER BY ts DESC LIMIT 1`,
    [symbolId],
  );
  const ts = result.rows[0]?.ts;
  return ts == null ? null : fromDbTime(ts);
}

/**
 * Where uninterrupted stored coverage of a window ends — the only safe place to resume from.
 *
 * A resume cursor must never be `max(ts)`. Two ways that loses data silently, both of which
 * this repo hit on real data:
 *
 *   1. Stored data starts AFTER the window. Backfilling 2022 with only January 2024 present
 *      resolves the cursor to 2024-02-01, trips the "nothing left to do" early return, and
 *      reports success having downloaded nothing.
 *   2. Stored data has a HOLE. After 2022-01..06 and 2024-01 are stored, `max(ts)` is still
 *      2024-01-31, so resuming skips the eighteen missing months.
 *
 * So the question is where the run that STARTS at `fromMs` stops. Contiguity is judged per day
 * with a tolerance, because M1 forex data is legitimately missing every weekend and holiday —
 * minute-level contiguity would report a gap every Saturday.
 *
 * Returns null when nothing is stored at the start of the window, which means "fetch it all".
 */
export async function contiguousEndWithin(
  client: DbClient,
  symbolId: string,
  fromMs: number,
  toMs: number,
  maxGapMs: number,
): Promise<{ first: number; last: number } | null> {
  const result = await client.pool.query<{ first: Date | null; last: Date | null }>(
    `WITH days AS (
       SELECT DISTINCT date_trunc('day', ts) AS d
         FROM candles_m1
        WHERE symbol_id = $1 AND ts >= $2 AND ts < $3
     ),
     stepped AS (
       SELECT d, LAG(d) OVER (ORDER BY d) AS prev FROM days
     ),
     first_gap AS (
       SELECT min(prev) AS before_gap FROM stepped WHERE d - prev > $4::interval
     )
     SELECT
       (SELECT min(d) FROM days) AS first,
       (SELECT max(ts) FROM candles_m1
         WHERE symbol_id = $1 AND ts >= $2 AND ts < $3
           AND ts < COALESCE(
             (SELECT before_gap + $4::interval FROM first_gap),
             $3::timestamptz
           )
       ) AS last`,
    [symbolId, toDbTime(fromMs), toDbTime(toMs), `${String(Math.round(maxGapMs / 1000))} seconds`],
  );

  const row = result.rows[0];
  if (row?.first == null || row.last == null) return null;
  return { first: fromDbTime(row.first), last: fromDbTime(row.last) };
}

export async function firstStoredBar(client: DbClient, symbolId: string): Promise<number | null> {
  const result = await client.pool.query<{ ts: Date | null }>(
    `SELECT ts FROM candles_m1 WHERE symbol_id = $1 ORDER BY ts ASC LIMIT 1`,
    [symbolId],
  );
  const ts = result.rows[0]?.ts;
  return ts == null ? null : fromDbTime(ts);
}

/** Coverage for every symbol, for the Data page table. */
export async function coverageForAll(client: DbClient): Promise<SymbolCoverage[]> {
  const result = await client.pool.query<{
    id: string;
    symbol: string;
    data_version: number;
    first_bar: Date | null;
    last_bar: Date | null;
    bar_count: string;
    sources: string[] | null;
  }>(
    `SELECT s.id,
            s.symbol,
            s.data_version,
            c.first_bar,
            c.last_bar,
            COALESCE(c.bar_count, 0)::text AS bar_count,
            c.sources
     FROM symbols s
     LEFT JOIN (
       SELECT symbol_id,
              min(ts) AS first_bar,
              max(ts) AS last_bar,
              count(*) AS bar_count,
              array_agg(DISTINCT source) AS sources
       FROM candles_m1
       GROUP BY symbol_id
     ) c ON c.symbol_id = s.id
     ORDER BY s.symbol`,
  );

  return result.rows.map((r) => ({
    symbolId: r.id,
    symbol: r.symbol,
    firstBar: r.first_bar == null ? null : fromDbTime(r.first_bar),
    lastBar: r.last_bar == null ? null : fromDbTime(r.last_bar),
    barCount: Number(r.bar_count),
    dataVersion: r.data_version,
    sources: r.sources ?? [],
  }));
}

/**
 * Bars per UTC day, for the calendar heatmap.
 *
 * time_bucket needs an explicit range in the WHERE clause to get chunk exclusion; without
 * it this would scan every chunk of history.
 */
export async function dailyBarCounts(
  client: DbClient,
  symbolId: string,
  fromMs: number,
  toMs: number,
): Promise<DayCount[]> {
  const result = await client.pool.query<{ day: Date; bars: string }>(
    `SELECT time_bucket(INTERVAL '1 day', ts) AS day, count(*)::text AS bars
     FROM candles_m1
     WHERE symbol_id = $1 AND ts >= $2 AND ts < $3
     GROUP BY day
     ORDER BY day`,
    [symbolId, toDbTime(fromMs), toDbTime(toMs)],
  );

  return result.rows.map((r) => ({ day: fromDbTime(r.day), bars: Number(r.bars) }));
}

/**
 * Bump the symbol's data version.
 *
 * The candle cache keys on (symbol, timeframe, range, dataVersion), so bumping this is
 * what invalidates every cached resample for the symbol after an ingest or import —
 * without needing to enumerate or flush cache entries.
 */
export async function bumpDataVersion(client: DbClient, symbolId: string): Promise<number> {
  const result = await client.pool.query<{ data_version: number }>(
    `UPDATE symbols
     SET data_version = data_version + 1, updated_at = now()
     WHERE id = $1
     RETURNING data_version`,
    [symbolId],
  );
  return result.rows[0]?.data_version ?? 0;
}
