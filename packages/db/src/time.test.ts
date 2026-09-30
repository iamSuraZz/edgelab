import { describe, expect, it } from 'vitest';
import { fromDbTime, fromDbTimeOrNull, toDbTime, toDbTimeOrNull } from './time';

describe('db time boundary', () => {
  it('round-trips epoch ms', () => {
    const ms = Date.UTC(2024, 0, 15, 13, 37, 0, 0);
    expect(fromDbTime(toDbTime(ms))).toBe(ms);
  });

  it('treats the value as UTC', () => {
    const ms = Date.UTC(2024, 5, 1, 0, 0, 0, 0);
    expect(toDbTime(ms).toISOString()).toBe('2024-06-01T00:00:00.000Z');
  });

  it('accepts the epoch itself', () => {
    expect(fromDbTime(toDbTime(0))).toBe(0);
  });

  it('rejects non-integer and non-finite input', () => {
    expect(() => toDbTime(1.5)).toThrow(RangeError);
    expect(() => toDbTime(Number.NaN)).toThrow(RangeError);
    expect(() => toDbTime(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('rejects an Invalid Date coming back', () => {
    expect(() => fromDbTime(new Date('nonsense'))).toThrow(RangeError);
  });

  it('passes null and undefined through the nullable helpers', () => {
    expect(toDbTimeOrNull(null)).toBeNull();
    expect(toDbTimeOrNull(undefined)).toBeNull();
    expect(fromDbTimeOrNull(null)).toBeNull();
    expect(fromDbTimeOrNull(undefined)).toBeNull();
    expect(toDbTimeOrNull(1000)?.getTime()).toBe(1000);
    expect(fromDbTimeOrNull(new Date(1000))).toBe(1000);
  });
});

describe('the two shapes a timestamptz arrives in (A54)', () => {
  // drizzle's node-postgres driver leaves timestamps unparsed so its own column mappers can run.
  // Typed selects therefore hand back a Date and raw `db.execute` hands back postgres's string —
  // and the runs list, the repo's only raw query, threw on every row until this was handled.
  it('reads the ISO string a raw query returns', () => {
    expect(fromDbTime('2022-01-03 00:00:00+00')).toBe(Date.UTC(2022, 0, 3));
  });

  it('reads it identically to the Date a typed select returns', () => {
    const ms = Date.UTC(2022, 5, 30, 14, 30);
    expect(fromDbTime(new Date(ms))).toBe(fromDbTime(new Date(ms).toISOString()));
  });

  it('keeps the offset rather than assuming the machine is UTC', () => {
    expect(fromDbTime('2022-01-03 02:00:00+02')).toBe(Date.UTC(2022, 0, 3));
  });

  it('throws on a string that is not a timestamp at all', () => {
    expect(() => fromDbTime('not a timestamp')).toThrow(RangeError);
  });

  it('still passes null through', () => {
    expect(fromDbTimeOrNull(null)).toBeNull();
  });
});
