import { feedSymbolCode, parseSymbolCode } from '@edgelab/shared';

import type { DbClient } from './client';
import { fromDbTime, toDbTime } from './time';
import { findSymbolByCode, type StoredSymbol } from './symbols-repo';

/**
 * Feed-qualified datasets: one series, one feed.
 *
 * See `packages/shared/src/feeds.ts` for why, and A6 in docs/decisions.md. The short version is
 * that `candles_m1`'s primary key is `(symbol_id, ts)` — a second feed writing the same minute is
 * silently dropped on conflict — and that two vendors' idea of a minute is not the same thing.
 */

export interface SourceSpan {
  readonly source: string;
  readonly bars: number;
  readonly firstMs: number;
  readonly lastMs: number;
}

/**
 * Which feeds contributed bars to a window, newest-starting last.
 *
 * The guard that refuses a mixed run is built on this, so it reports per-source counts and spans
 * rather than a bare boolean: the caller has to be able to say WHICH feeds and WHERE they join,
 * or the refusal is not actionable.
 */
export async function sourcesInRange(
  client: DbClient,
  symbolId: string,
  fromMs: number,
  toMs: number,
): Promise<SourceSpan[]> {
  const result = await client.pool.query<{
    source: string;
    bars: string;
    first: Date;
    last: Date;
  }>(
    `SELECT source, count(*)::text AS bars, min(ts) AS first, max(ts) AS last
       FROM candles_m1
      WHERE symbol_id = $1 AND ts >= $2 AND ts < $3
      GROUP BY source
      ORDER BY min(ts)`,
    [symbolId, toDbTime(fromMs), toDbTime(toMs)],
  );

  return result.rows.map((r) => ({
    source: r.source,
    bars: Number(r.bars),
    firstMs: fromDbTime(r.first),
    lastMs: fromDbTime(r.last),
  }));
}

/**
 * Get or create the symbol row for a feed-qualified dataset.
 *
 * Instrument metadata is COPIED from the base symbol — digits, mintick, contract size, session —
 * because a feed does not change what the instrument is. Only the data differs, and `provider_symbols`
 * is narrowed to the one feed so an ingest for this row cannot accidentally pull from another.
 *
 * Idempotent: calling it twice returns the same row, so an importer may call it per file.
 */
export async function ensureFeedSymbol(
  client: DbClient,
  baseCode: string,
  feed: string,
): Promise<StoredSymbol> {
  const code = feedSymbolCode(baseCode, feed);

  const existing = await findSymbolByCode(client, code);
  if (existing !== null) return existing;

  const base = await findSymbolByCode(client, baseCode);
  if (base === null) {
    throw new Error(
      `Cannot create ${code}: no symbol "${baseCode}" to take instrument metadata from.`,
    );
  }

  await client.pool.query(
    `INSERT INTO symbols (
       symbol, asset_class, base_ccy, quote_ccy, digits, mintick, pip_size,
       contract_size, point_value, default_spread_points, provider_symbols,
       session_type, enabled, data_version
     )
     SELECT $2, asset_class, base_ccy, quote_ccy, digits, mintick, pip_size,
            contract_size, point_value, default_spread_points,
            -- Narrowed to the one feed, so an ingest against this row cannot pull from another
            -- vendor and recreate the mixture this dataset exists to prevent. Empty when the base
            -- has no mapping for that feed, which is the honest answer for a file import.
            CASE
              WHEN provider_symbols ? $3
                THEN jsonb_build_object($3::text, provider_symbols -> $3)
              ELSE '{}'::jsonb
            END,
            session_type, enabled, 0
       FROM symbols WHERE symbol = $1`,
    [baseCode, code, feed],
  );

  const created = await findSymbolByCode(client, code);
  if (created === null) throw new Error(`Failed to create feed dataset ${code}.`);
  return created;
}

/**
 * Move one feed's bars out of a symbol and into its own dataset.
 *
 * Moved rather than deleted: the rows are real data that cost API calls, and keeping them makes
 * the two feeds comparable on purpose instead of by accident. Runs inside a transaction — a
 * half-moved series is a worse state than either end.
 */
export async function moveSourceToFeedSymbol(
  client: DbClient,
  params: { readonly baseCode: string; readonly source: string; readonly feed?: string },
): Promise<{ readonly moved: number; readonly targetCode: string; readonly targetId: string }> {
  const feed = params.feed ?? params.source;
  const base = await findSymbolByCode(client, params.baseCode);
  if (base === null) throw new Error(`No symbol "${params.baseCode}".`);

  const target = await ensureFeedSymbol(client, params.baseCode, feed);

  const db = await client.pool.connect();
  try {
    await db.query('BEGIN');

    // INSERT then DELETE rather than UPDATE symbol_id: `ts` is the hypertable's partition key and
    // `(symbol_id, ts)` is the primary key, so an update would rewrite the row anyway, and this
    // way ON CONFLICT covers a partially-completed earlier attempt.
    const inserted = await db.query(
      `INSERT INTO candles_m1 (symbol_id, ts, open, high, low, close, volume, spread, source)
       SELECT $2, ts, open, high, low, close, volume, spread, source
         FROM candles_m1 WHERE symbol_id = $1 AND source = $3
       ON CONFLICT (symbol_id, ts) DO NOTHING`,
      [base.id, target.id, params.source],
    );

    await db.query(`DELETE FROM candles_m1 WHERE symbol_id = $1 AND source = $2`, [
      base.id,
      params.source,
    ]);

    await db.query('COMMIT');
    return { moved: inserted.rowCount ?? 0, targetCode: target.symbol, targetId: target.id };
  } catch (error: unknown) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

/** The base instrument a feed-qualified code belongs to, for metadata lookups. */
export function baseCodeOf(code: string): string {
  return parseSymbolCode(code).base;
}
