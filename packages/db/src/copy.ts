import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import type { PoolClient } from 'pg';
import type { DbClient } from './client';

/**
 * Bulk loader for M1 bars.
 *
 * COPY is the only way to get millions of rows in at a reasonable speed, but it cannot
 * express ON CONFLICT. So: COPY into an UNLOGGED per-session TEMP table, then
 * INSERT ... SELECT ... ON CONFLICT DO NOTHING into the hypertable. Both steps run on a
 * single dedicated connection inside one transaction, because TEMP tables are
 * session-scoped and a pooled connection would not see them.
 */

export interface CopyBar {
  /** UTC epoch milliseconds, bar OPEN time. */
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly spread?: number | null;
}

export interface CopyBarsInput {
  readonly symbolId: string;
  /** Adapter that produced these bars, stored for provenance. */
  readonly source: string;
  readonly bars: readonly CopyBar[];
}

export interface CopyBarsResult {
  /** Rows handed to COPY after in-batch de-duplication. */
  readonly staged: number;
  /** Rows that were genuinely new. */
  readonly inserted: number;
  /** Rows skipped because that (symbol, ts) already existed. */
  readonly duplicates: number;
}

const COLUMNS = '(symbol_id, ts, open, high, low, close, volume, spread, source)';

/** Guard against a malformed adapter poisoning the COPY stream with a delimiter. */
const SAFE_SOURCE = /^[a-z0-9][a-z0-9_-]{0,30}$/;

export async function copyBarsIgnoreDuplicates(
  client: DbClient,
  input: CopyBarsInput,
): Promise<CopyBarsResult> {
  if (!SAFE_SOURCE.test(input.source)) {
    throw new Error(`Unsafe source identifier: ${JSON.stringify(input.source)}`);
  }
  if (input.bars.length === 0) {
    return { staged: 0, inserted: 0, duplicates: 0 };
  }

  // De-duplicate within the batch before COPY. Providers do return overlapping pages,
  // and the last write for a timestamp wins here so a re-fetch corrects a bad bar.
  const byTime = new Map<number, CopyBar>();
  for (const bar of input.bars) {
    assertFinite(bar);
    byTime.set(bar.time, bar);
  }
  const rows = [...byTime.values()].sort((a, b) => a.time - b.time);

  return client.withConnection(async (conn) => {
    await conn.query('BEGIN');
    try {
      // Explicit column list rather than LIKE candles_m1: the target is a hypertable and
      // we want a plain, unlogged, index-free staging table for maximum COPY speed.
      await conn.query(`
        CREATE TEMP TABLE edgelab_staging_candles (
          symbol_id uuid NOT NULL,
          ts timestamptz NOT NULL,
          open double precision NOT NULL,
          high double precision NOT NULL,
          low double precision NOT NULL,
          close double precision NOT NULL,
          volume double precision NOT NULL,
          spread double precision,
          source text NOT NULL
        ) ON COMMIT DROP
      `);

      const copySql = `COPY edgelab_staging_candles ${COLUMNS} FROM STDIN`;
      const ingest = conn.query(copyFrom(copySql));
      await pipeline(Readable.from(textRows(rows, input.symbolId, input.source)), ingest);

      // DISTINCT ON is belt-and-braces after the Map above, and makes the winner
      // deterministic if a future caller skips de-duplication.
      const inserted = await conn.query(`
        INSERT INTO candles_m1 ${COLUMNS}
        SELECT DISTINCT ON (symbol_id, ts)
               symbol_id, ts, open, high, low, close, volume, spread, source
        FROM edgelab_staging_candles
        ORDER BY symbol_id, ts
        ON CONFLICT (symbol_id, ts) DO NOTHING
      `);

      await conn.query('COMMIT');

      const insertedCount = inserted.rowCount ?? 0;
      return {
        staged: rows.length,
        inserted: insertedCount,
        duplicates: rows.length - insertedCount,
      };
    } catch (err) {
      await safeRollback(conn);
      throw err;
    }
  });
}

/**
 * Serialise rows in PostgreSQL COPY text format: tab-separated, newline-terminated,
 * `\N` for NULL. Numbers and ISO timestamps never contain a delimiter, and `source` is
 * validated above, so no escaping is required.
 *
 * A generator, so a multi-million-bar batch never materialises as one string.
 */
function* textRows(rows: readonly CopyBar[], symbolId: string, source: string): Generator<string> {
  for (const bar of rows) {
    const spread = bar.spread == null ? '\\N' : String(bar.spread);
    yield `${symbolId}\t${new Date(bar.time).toISOString()}\t` +
      `${bar.open}\t${bar.high}\t${bar.low}\t${bar.close}\t${bar.volume}\t${spread}\t${source}\n`;
  }
}

function assertFinite(bar: CopyBar): void {
  if (
    !Number.isInteger(bar.time) ||
    !Number.isFinite(bar.open) ||
    !Number.isFinite(bar.high) ||
    !Number.isFinite(bar.low) ||
    !Number.isFinite(bar.close) ||
    !Number.isFinite(bar.volume)
  ) {
    throw new Error(`Refusing to store a non-finite bar at ${String(bar.time)}`);
  }
  if (bar.spread != null && !Number.isFinite(bar.spread)) {
    throw new Error(`Refusing to store a non-finite spread at ${String(bar.time)}`);
  }
}

async function safeRollback(conn: PoolClient): Promise<void> {
  try {
    await conn.query('ROLLBACK');
  } catch {
    // The connection may already be unusable; the pool will discard it.
  }
}
