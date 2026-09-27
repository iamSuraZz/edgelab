import type { DbClient } from './client';
import { fromDbTime, toDbTime } from './time';

/**
 * Ingest attempt history, in the `ingest_jobs` table.
 *
 * The table has existed since migration 0000 and nothing read or wrote it. It matters now because a
 * nightly backfill has to be answerable about itself: how far did last night get, did it stop
 * because the range was finished or because the server said no, and is tonight's run resuming or
 * starting over. Coverage alone cannot say — it shows which bars exist, not why the rest do not.
 */

export type IngestAttemptState = 'running' | 'completed' | 'rate-limited' | 'failed';

export interface IngestAttempt {
  readonly id: string;
  readonly symbolId: string;
  readonly provider: string;
  readonly rangeFromMs: number;
  readonly rangeToMs: number;
  readonly state: string;
  readonly barsWritten: number;
  readonly percent: number;
  readonly message: string;
  readonly error: string | null;
  readonly createdAtMs: number;
  readonly completedAtMs: number | null;
}

export async function startIngestAttempt(
  client: DbClient,
  params: {
    readonly symbolId: string;
    readonly provider: string;
    readonly fromMs: number;
    readonly toMs: number;
    readonly queueJobId?: string;
  },
): Promise<string> {
  const result = await client.pool.query<{ id: string }>(
    `INSERT INTO ingest_jobs (symbol_id, provider, range_from, range_to, state, message, queue_job_id)
     VALUES ($1, $2, $3, $4, 'running', 'started', $5)
     RETURNING id`,
    [
      params.symbolId,
      params.provider,
      toDbTime(params.fromMs),
      toDbTime(params.toMs),
      params.queueJobId ?? null,
    ],
  );
  return result.rows[0]!.id;
}

/**
 * Close out an attempt.
 *
 * `rate-limited` is its own terminal state, deliberately distinct from `failed`. "The server was
 * throttling us" and "something is broken" call for different responses — the first means run again
 * tomorrow, the second means look at it — and collapsing them into `failed` is how a nightly job
 * trains its owner to ignore red.
 */
export async function finishIngestAttempt(
  client: DbClient,
  id: string,
  params: {
    readonly state: IngestAttemptState;
    readonly barsWritten: number;
    readonly message: string;
    readonly error?: string | null;
  },
): Promise<void> {
  await client.pool.query(
    `UPDATE ingest_jobs
        SET state = $2, bars_written = $3, message = $4, error = $5,
            percent = CASE WHEN $2 = 'completed' THEN 100 ELSE percent END,
            completed_at = now()
      WHERE id = $1`,
    [id, params.state, params.barsWritten, params.message, params.error ?? null],
  );
}

export async function updateIngestAttempt(
  client: DbClient,
  id: string,
  params: { readonly percent: number; readonly message: string; readonly barsWritten: number },
): Promise<void> {
  await client.pool.query(
    `UPDATE ingest_jobs SET percent = $2, message = $3, bars_written = $4 WHERE id = $1`,
    [id, Math.round(params.percent), params.message, params.barsWritten],
  );
}

/** Recent attempts for a symbol, newest first — what the Data page and an operator both want. */
export async function recentIngestAttempts(
  client: DbClient,
  symbolId: string,
  limit = 10,
): Promise<IngestAttempt[]> {
  const result = await client.pool.query<{
    id: string;
    symbol_id: string;
    provider: string;
    range_from: Date;
    range_to: Date;
    state: string;
    bars_written: number;
    percent: number;
    message: string;
    error: string | null;
    created_at: Date;
    completed_at: Date | null;
  }>(
    `SELECT id, symbol_id, provider, range_from, range_to, state, bars_written,
            percent, message, error, created_at, completed_at
       FROM ingest_jobs WHERE symbol_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [symbolId, limit],
  );

  return result.rows.map((r) => ({
    id: r.id,
    symbolId: r.symbol_id,
    provider: r.provider,
    rangeFromMs: fromDbTime(r.range_from),
    rangeToMs: fromDbTime(r.range_to),
    state: r.state,
    barsWritten: r.bars_written,
    percent: r.percent,
    message: r.message,
    error: r.error,
    createdAtMs: fromDbTime(r.created_at),
    completedAtMs: r.completed_at === null ? null : fromDbTime(r.completed_at),
  }));
}
