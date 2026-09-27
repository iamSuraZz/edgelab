import { describe, expect, it } from 'vitest';
import type { Bar } from '@edgelab/shared';
import { bucketEnd, bucketStart, resample, resampleCandles } from './resampler';

const M1 = 60_000;

/** Consecutive M1 bars; close walks upward so open/close are distinguishable. */
function m1Series(startMs: number, count: number, firstClose = 100): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const close = firstClose + i;
    return {
      time: startMs + i * M1,
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 10,
    };
  });
}

describe('bucketStart — intraday is always UTC-aligned', () => {
  it('floors to the timeframe grid', () => {
    const t = Date.UTC(2024, 0, 15, 9, 37);
    expect(bucketStart(t, 'M5')).toBe(Date.UTC(2024, 0, 15, 9, 35));
    expect(bucketStart(t, 'M15')).toBe(Date.UTC(2024, 0, 15, 9, 30));
    expect(bucketStart(t, 'M20')).toBe(Date.UTC(2024, 0, 15, 9, 20));
    expect(bucketStart(t, 'H1')).toBe(Date.UTC(2024, 0, 15, 9, 0));
    expect(bucketStart(t, 'H3')).toBe(Date.UTC(2024, 0, 15, 9, 0));
    expect(bucketStart(t, 'H4')).toBe(Date.UTC(2024, 0, 15, 8, 0));
    expect(bucketStart(t, 'H8')).toBe(Date.UTC(2024, 0, 15, 8, 0));
    expect(bucketStart(t, 'H12')).toBe(Date.UTC(2024, 0, 15, 0, 0));
  });

  it('ignores dayStartOffsetMinutes, so H4 means the same for every broker', () => {
    const t = Date.UTC(2024, 0, 15, 9, 37);
    expect(bucketStart(t, 'H4', { dayStartOffsetMinutes: 1320 })).toBe(
      bucketStart(t, 'H4', { dayStartOffsetMinutes: 0 }),
    );
  });

  it('is idempotent on a boundary', () => {
    for (const tf of ['M1', 'M5', 'M12', 'H2', 'H6'] as const) {
      const b = bucketStart(Date.UTC(2024, 5, 12, 7, 23), tf);
      expect(bucketStart(b, tf)).toBe(b);
    }
  });
});

describe('bucketStart — D1 honours dayStartOffsetMinutes', () => {
  it('defaults to midnight UTC', () => {
    expect(bucketStart(Date.UTC(2024, 0, 15, 23, 59), 'D1')).toBe(Date.UTC(2024, 0, 15));
    expect(bucketStart(Date.UTC(2024, 0, 15, 0, 0), 'D1')).toBe(Date.UTC(2024, 0, 15));
  });

  it('rolls the day at 22:00 UTC for a NY-close broker', () => {
    const opts = { dayStartOffsetMinutes: 22 * 60 };
    // 21:59 still belongs to the day that opened at 22:00 the PREVIOUS date.
    expect(bucketStart(Date.UTC(2024, 0, 15, 21, 59), 'D1', opts)).toBe(
      Date.UTC(2024, 0, 14, 22, 0),
    );
    // 22:00 opens a new day.
    expect(bucketStart(Date.UTC(2024, 0, 15, 22, 0), 'D1', opts)).toBe(
      Date.UTC(2024, 0, 15, 22, 0),
    );
    expect(bucketStart(Date.UTC(2024, 0, 16, 3, 0), 'D1', opts)).toBe(Date.UTC(2024, 0, 15, 22, 0));
  });

  it('normalises an out-of-range or negative offset into a day', () => {
    const a = bucketStart(Date.UTC(2024, 0, 15, 5, 0), 'D1', { dayStartOffsetMinutes: 60 });
    const b = bucketStart(Date.UTC(2024, 0, 15, 5, 0), 'D1', { dayStartOffsetMinutes: 1440 + 60 });
    const c = bucketStart(Date.UTC(2024, 0, 15, 5, 0), 'D1', { dayStartOffsetMinutes: -1380 });
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('rejects a non-integer offset or bad weekStartDay', () => {
    expect(() => bucketStart(0, 'D1', { dayStartOffsetMinutes: 1.5 })).toThrow(RangeError);
    // @ts-expect-error exercising the runtime guard
    expect(() => bucketStart(0, 'W1', { weekStartDay: 9 })).toThrow(RangeError);
  });
});

describe('bucketStart — W1', () => {
  // D2: the default is SUNDAY, matching Exness MT5 weekly bars for every symbol.
  it('defaults to Sunday 00:00 UTC', () => {
    const sunday = Date.UTC(2024, 0, 14);
    for (let d = 0; d < 7; d += 1) {
      expect(bucketStart(Date.UTC(2024, 0, 14 + d, 12, 0), 'W1')).toBe(sunday);
    }
    expect(bucketStart(Date.UTC(2024, 0, 21), 'W1')).toBe(Date.UTC(2024, 0, 21));
  });

  it('puts the Monday-to-Friday trading week in the bar that opened the Sunday before', () => {
    // The practical consequence of D2: Friday's bars belong to the week stamped Sunday,
    // so a W1 bar spans the whole Sunday-open-to-Friday-close fx week rather than
    // splitting the Sunday evening session off into the previous bar.
    const sunday = Date.UTC(2024, 0, 14);
    expect(bucketStart(Date.UTC(2024, 0, 14, 22, 30), 'W1')).toBe(sunday);
    expect(bucketStart(Date.UTC(2024, 0, 19, 21, 59), 'W1')).toBe(sunday);
  });

  it('handles the epoch week, which began on a Thursday', () => {
    // Sunday before 1970-01-01 (a Thursday) is 1969-12-28.
    expect(bucketStart(0, 'W1')).toBe(Date.UTC(1969, 11, 28));
  });

  it('still supports a Monday week start for brokers that roll the week differently', () => {
    const opts = { weekStartDay: 1 } as const;
    const monday = Date.UTC(2024, 0, 15);
    expect(bucketStart(Date.UTC(2024, 0, 15, 12), 'W1', opts)).toBe(monday);
    expect(bucketStart(Date.UTC(2024, 0, 21, 23), 'W1', opts)).toBe(monday);
    expect(bucketStart(Date.UTC(2024, 0, 14, 23), 'W1', opts)).toBe(Date.UTC(2024, 0, 8));
  });

  it('combines week start with the day offset', () => {
    const opts = { weekStartDay: 0, dayStartOffsetMinutes: 22 * 60 } as const;
    // The week opens Sunday 22:00 UTC.
    expect(bucketStart(Date.UTC(2024, 0, 15, 3, 0), 'W1', opts)).toBe(Date.UTC(2024, 0, 14, 22, 0));
    expect(bucketStart(Date.UTC(2024, 0, 14, 21, 59), 'W1', opts)).toBe(
      Date.UTC(2024, 0, 7, 22, 0),
    );
  });
});

describe('bucketStart / bucketEnd — MN1 is calendar-based', () => {
  it('floors to the 1st', () => {
    expect(bucketStart(Date.UTC(2024, 1, 29, 18, 30), 'MN1')).toBe(Date.UTC(2024, 1, 1));
    expect(bucketStart(Date.UTC(2024, 11, 31, 23, 59), 'MN1')).toBe(Date.UTC(2024, 11, 1));
  });

  it('closes at the next month, rolling the year in December', () => {
    expect(bucketEnd(Date.UTC(2024, 11, 1), 'MN1')).toBe(Date.UTC(2025, 0, 1));
  });

  it('gets February right in a leap year and a common year', () => {
    expect(bucketEnd(Date.UTC(2024, 1, 1), 'MN1') - Date.UTC(2024, 1, 1)).toBe(29 * 86_400_000);
    expect(bucketEnd(Date.UTC(2023, 1, 1), 'MN1') - Date.UTC(2023, 1, 1)).toBe(28 * 86_400_000);
  });

  it('respects the day offset so D1 bars nest inside MN1 bars', () => {
    const opts = { dayStartOffsetMinutes: 22 * 60 };
    // 2024-01-01T10:00 is before the month opened at 2024-01-01T22:00, so it belongs
    // to December.
    expect(bucketStart(Date.UTC(2024, 0, 1, 10, 0), 'MN1', opts)).toBe(
      Date.UTC(2023, 11, 1, 22, 0),
    );
    expect(bucketStart(Date.UTC(2024, 0, 1, 23, 0), 'MN1', opts)).toBe(Date.UTC(2024, 0, 1, 22, 0));
  });
});

describe('bucketEnd', () => {
  it('is the exclusive end, i.e. the next bucket open', () => {
    const t = Date.UTC(2024, 0, 15, 8, 0);
    expect(bucketEnd(t, 'H4')).toBe(Date.UTC(2024, 0, 15, 12, 0));
    expect(bucketEnd(Date.UTC(2024, 0, 15), 'D1')).toBe(Date.UTC(2024, 0, 16));
    expect(bucketEnd(Date.UTC(2024, 0, 15), 'W1')).toBe(Date.UTC(2024, 0, 22));
  });
});

describe('resample', () => {
  it('handles an empty series', () => {
    expect(resample([], 'H1')).toEqual([]);
  });

  it('passes M1 through but adds closeTime', () => {
    const bars = m1Series(Date.UTC(2024, 0, 15), 3);
    const out = resample(bars, 'M1');
    expect(out).toHaveLength(3);
    expect(out[0]?.time).toBe(bars[0]?.time);
    expect(out[0]?.closeTime).toBe((bars[0]?.time ?? 0) + M1);
    expect(out[0]?.open).toBe(bars[0]?.open);
  });

  it('aggregates OHLCV correctly', () => {
    const bars = m1Series(Date.UTC(2024, 0, 15, 9, 0), 5, 100);
    const [bar, ...rest] = resample(bars, 'M5');
    expect(rest).toHaveLength(0);
    expect(bar).toMatchObject({
      time: Date.UTC(2024, 0, 15, 9, 0),
      closeTime: Date.UTC(2024, 0, 15, 9, 5),
      open: 99.5,
      high: 105,
      low: 99,
      close: 104,
      volume: 50,
    });
  });

  it('splits one full UTC day into the expected bucket counts', () => {
    const bars = m1Series(Date.UTC(2024, 0, 15, 0, 0), 1440);
    const expected = [
      ['M1', 1440],
      ['M2', 720],
      ['M3', 480],
      ['M4', 360],
      ['M5', 288],
      ['M6', 240],
      ['M10', 144],
      ['M12', 120],
      ['M15', 96],
      ['M20', 72],
      ['M30', 48],
      ['H1', 24],
      ['H2', 12],
      ['H3', 8],
      ['H4', 6],
      ['H6', 4],
      ['H8', 3],
      ['H12', 2],
      ['D1', 1],
    ] as const;

    for (const [tf, n] of expected) {
      expect(resample(bars, tf), tf).toHaveLength(n);
    }
  });

  it('never emits a bar for an empty bucket', () => {
    const bars: Bar[] = [
      { time: Date.UTC(2024, 0, 15, 9, 0), open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
      { time: Date.UTC(2024, 0, 15, 12, 0), open: 3, high: 4, low: 2.5, close: 3.5, volume: 1 },
    ];
    const out = resample(bars, 'H1');
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.time)).toEqual([
      Date.UTC(2024, 0, 15, 9, 0),
      Date.UTC(2024, 0, 15, 12, 0),
    ]);
  });

  it('opens a partially-filled bucket at the boundary, not at the first bar', () => {
    const bars = m1Series(Date.UTC(2024, 0, 15, 9, 3), 10);
    const first = resample(bars, 'H1')[0];
    expect(first?.time).toBe(Date.UTC(2024, 0, 15, 9, 0));
    expect(first?.closeTime).toBe(Date.UTC(2024, 0, 15, 10, 0));
  });

  it('rejects unsorted or duplicated input', () => {
    const bars = m1Series(Date.UTC(2024, 0, 15), 3);
    expect(() => resample([...bars].reverse(), 'M5')).toThrow(/sorted ascending/);
    const last = bars[bars.length - 1];
    if (last === undefined) throw new Error('fixture');
    expect(() => resample([...bars, { ...last }], 'M5')).toThrow(/Duplicate bar timestamp/);
  });
});

describe('resample — spread', () => {
  function withSpread(startMs: number, spreads: readonly (number | null)[]): Bar[] {
    return spreads.map((spread, i) => ({
      time: startMs + i * M1,
      open: 1,
      high: 1.5,
      low: 0.5,
      close: 1.2,
      volume: 1,
      spread,
    }));
  }

  it('averages the contributing spreads', () => {
    const bars = withSpread(Date.UTC(2024, 0, 15, 9, 0), [0.0001, 0.0002, 0.0003]);
    const [c] = resample(bars, 'M5');
    expect(c?.spread).toBeCloseTo(0.0002, 12);
    expect(c?.spreadSamples).toBe(3);
  });

  it('ignores null spreads in the mean but still emits the bar', () => {
    const bars = withSpread(Date.UTC(2024, 0, 15, 9, 0), [0.0002, null, 0.0004]);
    const [c] = resample(bars, 'M5');
    expect(c?.spread).toBeCloseTo(0.0003, 12);
    expect(c?.spreadSamples).toBe(2);
  });

  it('reports null when no contributing bar had a spread', () => {
    const bars = withSpread(Date.UTC(2024, 0, 15, 9, 0), [null, null]);
    const [c] = resample(bars, 'M5');
    expect(c?.spread).toBeNull();
    expect(c?.spreadSamples).toBe(0);
  });

  it('recombines means by weight when chaining, so uneven sample counts still agree', () => {
    // M15 bucket where the first M5 has 1 spread sample and the second has 3.
    const base = Date.UTC(2024, 0, 15, 9, 0);
    const bars: Bar[] = [
      { time: base, open: 1, high: 1, low: 1, close: 1, volume: 1, spread: 0.001 },
      { time: base + 5 * M1, open: 1, high: 1, low: 1, close: 1, volume: 1, spread: 0.002 },
      { time: base + 6 * M1, open: 1, high: 1, low: 1, close: 1, volume: 1, spread: 0.002 },
      { time: base + 7 * M1, open: 1, high: 1, low: 1, close: 1, volume: 1, spread: 0.002 },
    ];
    const direct = resample(bars, 'M15');
    const chained = resampleCandles(resample(bars, 'M5'), 'M15');
    // Unweighted averaging of the two M5 means would give 0.0015; the correct answer is
    // the mean of all four samples.
    expect(direct[0]?.spread).toBeCloseTo(0.00175, 12);
    expect(chained[0]?.spread).toBeCloseTo(direct[0]?.spread ?? 0, 12);
    expect(chained[0]?.spreadSamples).toBe(4);
  });
});
