import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type Bar,
  type Candle,
  TIMEFRAME_CODES,
  type Timeframe,
  divisorsOf,
} from '@edgelab/shared';
import { bucketStart, resample, resampleCandles } from './resampler';

const M1 = 60_000;

/**
 * Property tests for the resampler. These are the invariants the whole backtester rests
 * on: if resampling is wrong, every metric downstream is wrong in a way no unit test
 * would obviously catch.
 */

interface Step {
  gap: number;
  a: number;
  b: number;
  hi: number;
  lo: number;
  volume: number;
  spread: number | null;
}

const stepArb: fc.Arbitrary<Step> = fc.record({
  /** Minutes to advance; > 1 creates the gaps a real feed has. */
  gap: fc.integer({ min: 1, max: 9 }),
  a: fc.double({ min: 0.5, max: 2, noNaN: true, noDefaultInfinity: true }),
  b: fc.double({ min: 0.5, max: 2, noNaN: true, noDefaultInfinity: true }),
  hi: fc.double({ min: 0, max: 0.05, noNaN: true, noDefaultInfinity: true }),
  lo: fc.double({ min: 0, max: 0.05, noNaN: true, noDefaultInfinity: true }),
  volume: fc.integer({ min: 0, max: 5_000 }),
  spread: fc.option(fc.double({ min: 0, max: 0.01, noNaN: true, noDefaultInfinity: true }), {
    nil: null,
  }),
});

/** A minute-aligned start somewhere in 2021..2025. */
const startArb = fc
  .integer({ min: 0, max: 5 * 365 * 24 * 60 })
  .map((m) => Date.UTC(2021, 0, 1) + m * M1);

const seriesArb = fc
  .tuple(startArb, fc.array(stepArb, { minLength: 1, maxLength: 400 }))
  .map(([start, steps]) => {
    const bars: Bar[] = [];
    let t = start;
    for (const s of steps) {
      const open = s.a;
      const close = s.b;
      bars.push({
        time: t,
        open,
        close,
        high: Math.max(open, close) + s.hi,
        low: Math.min(open, close) - s.lo,
        volume: s.volume,
        spread: s.spread,
      });
      t += s.gap * M1;
    }
    return bars;
  });

/** Group the source bars by the bucket they belong to, independently of resample(). */
function groupByBucket(
  bars: readonly Bar[],
  tf: Timeframe,
  opts?: Parameters<typeof resample>[2],
): Map<number, Bar[]> {
  const groups = new Map<number, Bar[]>();
  for (const bar of bars) {
    const key = bucketStart(bar.time, tf, opts);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [bar]);
    else list.push(bar);
  }
  return groups;
}

const ALL: readonly Timeframe[] = TIMEFRAME_CODES;

describe('property: volume is conserved', () => {
  it('total volume is identical at every timeframe', () => {
    fc.assert(
      fc.property(seriesArb, (bars) => {
        const total = bars.reduce((s, b) => s + b.volume, 0);
        for (const tf of ALL) {
          const sum = resample(bars, tf).reduce((s, c) => s + c.volume, 0);
          expect(sum, tf).toBe(total);
        }
      }),
      { numRuns: 60 },
    );
  });
});

describe('property: high/low bounds hold', () => {
  it('each candle brackets every contributing bar, and OHLC stays coherent', () => {
    fc.assert(
      fc.property(seriesArb, fc.constantFrom(...ALL), (bars, tf) => {
        const groups = groupByBucket(bars, tf);
        for (const candle of resample(bars, tf)) {
          const members = groups.get(candle.time);
          expect(members, `bucket ${candle.time} has no members`).toBeDefined();
          if (members === undefined) continue;

          expect(candle.high).toBe(Math.max(...members.map((m) => m.high)));
          expect(candle.low).toBe(Math.min(...members.map((m) => m.low)));
          expect(candle.open).toBe(members[0]?.open);
          expect(candle.close).toBe(members[members.length - 1]?.close);

          // OHLC coherence: the body must sit inside the wick.
          expect(candle.high).toBeGreaterThanOrEqual(Math.max(candle.open, candle.close));
          expect(candle.low).toBeLessThanOrEqual(Math.min(candle.open, candle.close));
          expect(candle.high).toBeGreaterThanOrEqual(candle.low);
        }
      }),
      { numRuns: 80 },
    );
  });
});

describe('property: no bar crosses a bucket boundary', () => {
  it('every contributing bar lies inside [time, closeTime), and candles never overlap', () => {
    fc.assert(
      fc.property(seriesArb, fc.constantFrom(...ALL), (bars, tf) => {
        const groups = groupByBucket(bars, tf);
        const candles = resample(bars, tf);

        for (const candle of candles) {
          expect(candle.closeTime).toBeGreaterThan(candle.time);
          for (const member of groups.get(candle.time) ?? []) {
            expect(member.time).toBeGreaterThanOrEqual(candle.time);
            expect(member.time).toBeLessThan(candle.closeTime);
          }
        }

        // Strictly ascending and non-overlapping.
        for (let i = 1; i < candles.length; i += 1) {
          const prev = candles[i - 1];
          const cur = candles[i];
          if (prev === undefined || cur === undefined) continue;
          expect(cur.time).toBeGreaterThan(prev.time);
          expect(cur.time).toBeGreaterThanOrEqual(prev.closeTime);
        }
      }),
      { numRuns: 80 },
    );
  });
});

describe('property: resampling chains are associative', () => {
  it('M1 -> M5 -> M15 equals M1 -> M15', () => {
    fc.assert(
      fc.property(seriesArb, (bars) => {
        const direct = resample(bars, 'M15');
        const chained = resampleCandles(resample(bars, 'M5'), 'M15');
        expectCandlesEqual(chained, direct);
      }),
      { numRuns: 80 },
    );
  });

  it('holds for every divisor of every timeframe', () => {
    fc.assert(
      fc.property(seriesArb, fc.constantFrom(...ALL), (bars, tf) => {
        const direct = resample(bars, tf);
        for (const via of divisorsOf(tf)) {
          const chained = resampleCandles(resample(bars, via), tf);
          expectCandlesEqual(chained, direct, `${via} -> ${tf}`);
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe('property: bucket count never exceeds the source bar count', () => {
  it('aggregation only ever reduces', () => {
    fc.assert(
      fc.property(seriesArb, fc.constantFrom(...ALL), (bars, tf) => {
        expect(resample(bars, tf).length).toBeLessThanOrEqual(bars.length);
      }),
      { numRuns: 60 },
    );
  });
});

describe('property: alternative anchoring stays self-consistent', () => {
  const optsArb = fc.record({
    dayStartOffsetMinutes: fc.constantFrom(0, 60, 21 * 60, 22 * 60),
    weekStartDay: fc.constantFrom(0 as const, 1 as const, 6 as const),
  });

  it('conserves volume and keeps buckets disjoint for D1/W1/MN1 under any offset', () => {
    fc.assert(
      fc.property(
        seriesArb,
        optsArb,
        fc.constantFrom('D1' as const, 'W1' as const, 'MN1' as const),
        (bars, opts, tf) => {
          const total = bars.reduce((s, b) => s + b.volume, 0);
          const candles = resample(bars, tf, opts);
          expect(candles.reduce((s, c) => s + c.volume, 0)).toBe(total);

          const groups = groupByBucket(bars, tf, opts);
          for (const candle of candles) {
            for (const member of groups.get(candle.time) ?? []) {
              expect(member.time).toBeGreaterThanOrEqual(candle.time);
              expect(member.time).toBeLessThan(candle.closeTime);
            }
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it('D1 nests inside MN1 whenever both use the same day offset', () => {
    fc.assert(
      fc.property(seriesArb, fc.constantFrom(0, 22 * 60), (bars, dayStartOffsetMinutes) => {
        const opts = { dayStartOffsetMinutes };
        const direct = resample(bars, 'MN1', opts);
        const chained = resampleCandles(resample(bars, 'D1', opts), 'MN1', opts);
        expectCandlesEqual(chained, direct);
      }),
      { numRuns: 40 },
    );
  });
});

function expectCandlesEqual(actual: readonly Candle[], expected: readonly Candle[], label = '') {
  expect(actual.length, `${label} length`).toBe(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    const a = actual[i];
    const e = expected[i];
    if (a === undefined || e === undefined) throw new Error('index out of range');
    expect(a.time, `${label} [${i}].time`).toBe(e.time);
    expect(a.closeTime, `${label} [${i}].closeTime`).toBe(e.closeTime);
    expect(a.open, `${label} [${i}].open`).toBe(e.open);
    expect(a.high, `${label} [${i}].high`).toBe(e.high);
    expect(a.low, `${label} [${i}].low`).toBe(e.low);
    expect(a.close, `${label} [${i}].close`).toBe(e.close);
    expect(a.volume, `${label} [${i}].volume`).toBe(e.volume);
    expect(a.spreadSamples, `${label} [${i}].spreadSamples`).toBe(e.spreadSamples);
    if (e.spread === null) {
      expect(a.spread, `${label} [${i}].spread`).toBeNull();
    } else {
      // Weighted recombination is exact in theory but reassociates the additions.
      expect(a.spread ?? Number.NaN).toBeCloseTo(e.spread, 10);
    }
  }
}
