/**
 * The single conversion point between the application's UTC epoch milliseconds and
 * the database's `timestamptz`. Nothing else in the codebase should construct Dates
 * from stored values.
 */

export function toDbTime(epochMs: number): Date {
  if (!Number.isFinite(epochMs) || !Number.isInteger(epochMs)) {
    throw new RangeError(`Expected an integer epoch-ms timestamp, received ${String(epochMs)}`);
  }
  return new Date(epochMs);
}

/**
 * What a `timestamptz` column actually arrives as.
 *
 * TWO shapes, not one, and which you get depends on how the row was read — this cost a working
 * runs list (A54). drizzle's node-postgres driver installs its own `getTypeParser` that returns
 * TIMESTAMP, TIMESTAMPTZ, DATE and INTERVAL **unparsed**, so that its per-column mappers can own
 * the conversion. A typed select therefore yields a `Date`, while a raw `db.execute` — which has
 * no column mappers to run — yields the ISO string postgres sent.
 */
export type DbTimestamp = Date | string;

export function fromDbTime(value: DbTimestamp): number {
  const ms = typeof value === 'string' ? Date.parse(value) : value.getTime();
  if (Number.isNaN(ms)) {
    throw new RangeError(`Received an unreadable timestamp from the database: ${String(value)}`);
  }
  return ms;
}

/** Convenience for nullable columns such as `runs.completed_at`. */
export function toDbTimeOrNull(epochMs: number | null | undefined): Date | null {
  return epochMs == null ? null : toDbTime(epochMs);
}

export function fromDbTimeOrNull(value: DbTimestamp | null | undefined): number | null {
  return value == null ? null : fromDbTime(value);
}
