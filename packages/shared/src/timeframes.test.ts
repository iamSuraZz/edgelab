import { describe, expect, it } from 'vitest';
import {
  BASE_TIMEFRAME,
  MS_PER_MINUTE,
  TIMEFRAMES,
  TIMEFRAME_CODES,
  getTimeframe,
  isCalendarBased,
  isTimeframe,
  m1BarsPer,
  timeframeMs,
} from './timeframes';

describe('timeframe registry', () => {
  it('contains exactly the MT5 set', () => {
    expect(TIMEFRAME_CODES).toEqual([
      'M1',
      'M2',
      'M3',
      'M4',
      'M5',
      'M6',
      'M10',
      'M12',
      'M15',
      'M20',
      'M30',
      'H1',
      'H2',
      'H3',
      'H4',
      'H6',
      'H8',
      'H12',
      'D1',
      'W1',
      'MN1',
    ]);
    expect(TIMEFRAMES).toHaveLength(21);
  });

  it('stores data at M1', () => {
    expect(BASE_TIMEFRAME).toBe('M1');
    expect(m1BarsPer('M1')).toBe(1);
  });

  it('has a definition for every code, with no duplicates', () => {
    const codes = TIMEFRAMES.map((t) => t.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of TIMEFRAME_CODES) {
      expect(getTimeframe(code).code).toBe(code);
    }
  });

  it('is ordered strictly ascending by bar length', () => {
    const fixed = TIMEFRAMES.filter((t) => t.minutes !== null).map((t) => t.minutes as number);
    for (let i = 1; i < fixed.length; i += 1) {
      expect(fixed[i]).toBeGreaterThan(fixed[i - 1] as number);
    }
  });

  it('every fixed timeframe is a whole multiple of M1 so it can be resampled', () => {
    for (const tf of TIMEFRAMES) {
      if (tf.minutes === null) continue;
      expect(Number.isInteger(tf.minutes)).toBe(true);
      expect(tf.minutes % 1).toBe(0);
      expect(tf.minutes).toBeGreaterThan(0);
    }
  });

  it('treats only MN1 as calendar-based', () => {
    const calendar = TIMEFRAME_CODES.filter((c) => isCalendarBased(c));
    expect(calendar).toEqual(['MN1']);
    expect(timeframeMs('MN1')).toBeNull();
  });

  it('converts to milliseconds', () => {
    expect(timeframeMs('M1')).toBe(MS_PER_MINUTE);
    expect(timeframeMs('H4')).toBe(240 * MS_PER_MINUTE);
    expect(timeframeMs('D1')).toBe(1440 * MS_PER_MINUTE);
    expect(timeframeMs('W1')).toBe(10080 * MS_PER_MINUTE);
  });

  it('narrows unknown values', () => {
    expect(isTimeframe('H4')).toBe(true);
    expect(isTimeframe('M7')).toBe(false);
    expect(isTimeframe(240)).toBe(false);
    expect(isTimeframe(undefined)).toBe(false);
  });

  it('throws on an unknown code', () => {
    // @ts-expect-error exercising the runtime guard with an invalid code
    expect(() => getTimeframe('M7')).toThrow(/Unknown timeframe/);
  });
});
