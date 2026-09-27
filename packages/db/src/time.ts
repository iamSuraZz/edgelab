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

export function fromDbTime(value: Date): number {
  const ms = value.getTime();
  if (Number.isNaN(ms)) {
    throw new RangeError('Received an Invalid Date from the database');
  }
  return ms;
}

/** Convenience for nullable columns such as `runs.completed_at`. */
export function toDbTimeOrNull(epochMs: number | null | undefined): Date | null {
  return epochMs == null ? null : toDbTime(epochMs);
}

export function fromDbTimeOrNull(value: Date | null | undefined): number | null {
  return value == null ? null : fromDbTime(value);
}
