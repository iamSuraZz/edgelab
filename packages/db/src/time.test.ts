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
