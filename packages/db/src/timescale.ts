import type { PoolClient } from 'pg';
import type { DbClient } from './client';

/**
 * TimescaleDB setup that Drizzle's generated SQL cannot express.
 *
 * Every statement here was validated against the pinned image
 * (timescale/timescaledb:2.17.2-pg17). Notes that matter:
 *
 *  - 2.17.2 accepts BOTH create_hypertable forms and does not warn about the legacy one,
 *    but by_range() is the forward-looking form so we use it. It returns
 *    (hypertable_id, created), NOT the legacy 4-column shape.
 *  - ALTER TABLE ... SET (timescaledb.compress …) is NOT idempotent, so it is guarded by
 *    a lookup in timescaledb_information.compression_settings. Checking
 *    pg_class.reloptions instead would silently never match: 2.17 keeps compression
 *    settings in the Timescale catalog, and reloptions comes back empty.
 *  - A wrong compress_segmentby is only a WARNING, never an error, so it would ship
 *    quietly and make every conflicting insert expensive. segmentby=symbol_id covers both
 *    primary-key columns alongside orderby=ts.
 *  - add_compression_policy(..., if_not_exists => TRUE) returns -1 on the skip path, not
 *    NULL, so the result must not be treated as a job id without checking it is > 0.
 */

export const CANDLES_TABLE = 'candles_m1';

/** 1 month of 1-minute bars keeps chunk count sane (~240 chunks over 20 years). */
export const CHUNK_INTERVAL = '1 month';
export const COMPRESS_AFTER = '30 days';

export interface TimescaleSetupResult {
  readonly hypertableCreated: boolean;
  readonly compressionConfigured: boolean;
  readonly policyJobId: number | null;
}

export async function setupTimescale(client: DbClient): Promise<TimescaleSetupResult> {
  return client.withConnection(async (conn) => {
    await conn.query('CREATE EXTENSION IF NOT EXISTS timescaledb');

    // migrate_data is defensive: if the table already holds rows from an earlier run,
    // create_hypertable fails outright without it.
    const hyper = await conn.query<{ created: boolean }>(`
      SELECT created
      FROM create_hypertable(
        '${CANDLES_TABLE}',
        by_range('ts', INTERVAL '${CHUNK_INTERVAL}'),
        if_not_exists => TRUE,
        migrate_data  => TRUE
      )
    `);

    const compressionConfigured = await ensureCompression(conn);
    const policyJobId = await ensureCompressionPolicy(conn);

    return {
      hypertableCreated: hyper.rows[0]?.created ?? false,
      compressionConfigured,
      policyJobId,
    };
  });
}

async function ensureCompression(conn: PoolClient): Promise<boolean> {
  const existing = await conn.query<{ configured: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM timescaledb_information.compression_settings
       WHERE hypertable_name = $1
     ) AS configured`,
    [CANDLES_TABLE],
  );

  if (existing.rows[0]?.configured === true) return false;

  await conn.query(`
    ALTER TABLE ${CANDLES_TABLE} SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'symbol_id',
      timescaledb.compress_orderby   = 'ts DESC'
    )
  `);
  return true;
}

async function ensureCompressionPolicy(conn: PoolClient): Promise<number | null> {
  const result = await conn.query<{ job_id: number }>(`
    SELECT add_compression_policy(
      '${CANDLES_TABLE}',
      INTERVAL '${COMPRESS_AFTER}',
      if_not_exists => TRUE
    ) AS job_id
  `);
  const jobId = result.rows[0]?.job_id ?? -1;
  return jobId > 0 ? jobId : null;
}

/**
 * Return chunks to fully-compressed state after a historical backfill.
 *
 * Writing into a compressed chunk leaves it "partially compressed" (internal status 9):
 * the new rows sit in an uncompressed heap portion, so storage and scan performance
 * silently regress. `timescaledb_information.chunks.is_compressed` still reports true and
 * has no status column, so this degradation is invisible in the obvious view.
 *
 * Only chunks older than the compression window are touched — the current chunk is
 * deliberately uncompressed and recompressing it would fight the policy.
 */
export async function recompressAfterBackfill(client: DbClient): Promise<number> {
  return client.withConnection(async (conn) => {
    const chunks = await conn.query<{ chunk: string }>(
      `SELECT show_chunks($1, older_than => INTERVAL '${COMPRESS_AFTER}')::text AS chunk`,
      [CANDLES_TABLE],
    );

    let recompressed = 0;
    for (const row of chunks.rows) {
      try {
        await conn.query(`SELECT compress_chunk($1, recompress => true)`, [row.chunk]);
        recompressed += 1;
      } catch (err) {
        // An already-fully-compressed chunk is not an error worth aborting a backfill for.
        console.warn(
          `[timescale] could not recompress ${row.chunk}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return recompressed;
  });
}

export interface CompressionReport {
  readonly segmentBy: string[];
  readonly orderBy: string[];
  readonly policyJobs: number;
  readonly chunkCount: number;
  readonly compressedChunks: number;
}

/** Introspection for the Data page and for migration assertions. */
export async function describeCompression(client: DbClient): Promise<CompressionReport> {
  const settings = await client.pool.query<{
    attname: string;
    segmentby_column_index: number | null;
    orderby_column_index: number | null;
  }>(
    `SELECT attname, segmentby_column_index, orderby_column_index
     FROM timescaledb_information.compression_settings
     WHERE hypertable_name = $1`,
    [CANDLES_TABLE],
  );

  const jobs = await client.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM timescaledb_information.jobs
     WHERE proc_name = 'policy_compression' AND hypertable_name = $1`,
    [CANDLES_TABLE],
  );

  const chunks = await client.pool.query<{ total: string; compressed: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE is_compressed)::text AS compressed
     FROM timescaledb_information.chunks
     WHERE hypertable_name = $1`,
    [CANDLES_TABLE],
  );

  return {
    segmentBy: settings.rows.filter((r) => r.segmentby_column_index !== null).map((r) => r.attname),
    orderBy: settings.rows.filter((r) => r.orderby_column_index !== null).map((r) => r.attname),
    policyJobs: Number(jobs.rows[0]?.count ?? 0),
    chunkCount: Number(chunks.rows[0]?.total ?? 0),
    compressedChunks: Number(chunks.rows[0]?.compressed ?? 0),
  };
}
