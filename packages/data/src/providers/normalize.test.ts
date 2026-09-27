import { describe, expect, it } from 'vitest';
import type { Bar } from '@edgelab/shared';
import { joinBidAsk, normalizeBars } from './normalize';

const M1 = 60_000;
const T0 = Date.UTC(2024, 0, 15, 9, 0);

function bar(over: Partial<Bar> & { time: number }): Bar {
  return { open: 1.1, high: 1.11, low: 1.09, close: 1.105, volume: 3, ...over };
}

describe('normalizeBars', () => {
  it('sorts ascending', () => {
    const out = normalizeBars([bar({ time: T0 + M1 }), bar({ time: T0 })]);
    expect(out.bars.map((b) => b.time)).toEqual([T0, T0 + M1]);
  });

  it('de-duplicates, letting the later bar win so a re-fetch can correct bad data', () => {
    // Both bars must be internally COHERENT, or the first is rejected before the dedupe
    // check ever sees it and there is no duplicate to count.
    const out = normalizeBars([bar({ time: T0, close: 1.1 }), bar({ time: T0, close: 1.105 })]);
    expect(out.bars).toHaveLength(1);
    expect(out.bars[0]?.close).toBe(1.105);
    expect(out.reasons['duplicate-time']).toBe(1);
  });

  it('snaps stray sub-minute timestamps down to the minute', () => {
    const out = normalizeBars([bar({ time: T0 + 37_123 })]);
    expect(out.bars[0]?.time).toBe(T0);
  });

  it('drops incoherent OHLC and says why', () => {
    const out = normalizeBars([
      bar({ time: T0, high: 1.0, low: 1.2 }), // high < low
      bar({ time: T0 + M1, open: 5, high: 1.11, low: 1.09, close: 1.1 }), // open above high
      bar({ time: T0 + 2 * M1 }), // fine
    ]);
    expect(out.bars).toHaveLength(1);
    expect(out.rejected).toBe(2);
    expect(out.reasons['incoherent-ohlc']).toBe(2);
  });

  it('drops non-finite prices', () => {
    const out = normalizeBars([bar({ time: T0, close: Number.NaN })]);
    expect(out.bars).toHaveLength(0);
    expect(out.reasons['non-finite-price']).toBe(1);
  });

  it('drops negative volume but coerces a non-finite one to zero', () => {
    expect(normalizeBars([bar({ time: T0, volume: -1 })]).reasons['negative-volume']).toBe(1);
    expect(normalizeBars([bar({ time: T0, volume: Number.NaN })]).bars[0]?.volume).toBe(0);
  });

  it('nulls a negative or non-finite spread instead of storing it', () => {
    expect(normalizeBars([bar({ time: T0, spread: -0.0001 })]).bars[0]?.spread).toBeNull();
    expect(normalizeBars([bar({ time: T0, spread: Number.NaN })]).bars[0]?.spread).toBeNull();
    expect(normalizeBars([bar({ time: T0, spread: 0.0002 })]).bars[0]?.spread).toBeCloseTo(
      0.0002,
      12,
    );
  });

  it('clips to the requested window', () => {
    const out = normalizeBars([bar({ time: T0 - M1 }), bar({ time: T0 }), bar({ time: T0 + M1 })], {
      fromMs: T0,
      toMs: T0 + M1,
    });
    expect(out.bars.map((b) => b.time)).toEqual([T0]);
  });

  it('is empty-safe', () => {
    const out = normalizeBars([]);
    expect(out.bars).toEqual([]);
    expect(out.rejected).toBe(0);
  });
});

describe('normalizeBars — filler bars (D4)', () => {
  const flat = (time: number, volume: number): Bar =>
    bar({ time, open: 1.1, high: 1.1, low: 1.1, close: 1.1, volume });

  it('drops a flat zero-volume bar by default', () => {
    const out = normalizeBars([flat(T0, 0), bar({ time: T0 + M1 })]);
    expect(out.bars).toHaveLength(1);
    expect(out.bars[0]?.time).toBe(T0 + M1);
    expect(out.reasons['filler-bar']).toBe(1);
    expect(out.rejected).toBe(1);
  });

  it('KEEPS a flat bar that carries volume — a real tick that did not move the price', () => {
    // 393 of 1,825 flat bars in real Dukascopy EURUSD M1 look like this. Dropping on
    // flatness alone would discard genuine quiet minutes.
    const out = normalizeBars([flat(T0, 1)]);
    expect(out.bars).toHaveLength(1);
    expect(out.rejected).toBe(0);
  });

  it('KEEPS a zero-volume bar that has a real range', () => {
    const out = normalizeBars([bar({ time: T0, volume: 0 })]);
    expect(out.bars).toHaveLength(1);
    expect(out.rejected).toBe(0);
  });

  it('drops filler regardless of the day — holidays and dead midweek minutes too', () => {
    // 2024-01-01 is a Monday holiday; 2024-01-17 12:00 is an ordinary Wednesday midday.
    const holiday = Date.UTC(2024, 0, 1, 12);
    const midweek = Date.UTC(2024, 0, 17, 12);
    const sunday = Date.UTC(2024, 0, 14, 12);
    const out = normalizeBars([flat(holiday, 0), flat(midweek, 0), flat(sunday, 0)]);
    expect(out.bars).toHaveLength(0);
    expect(out.reasons['filler-bar']).toBe(3);
  });

  it('can be switched off, which the ask side relies on to preserve spreads', () => {
    const out = normalizeBars([flat(T0, 0)], { dropFillerBars: false });
    expect(out.bars).toHaveLength(1);
    expect(out.rejected).toBe(0);
  });

  it('counts filler separately from incoherent bars', () => {
    const out = normalizeBars([flat(T0, 0), bar({ time: T0 + M1, high: 1.0, low: 1.2 })]);
    expect(out.reasons).toEqual({ 'filler-bar': 1, 'incoherent-ohlc': 1 });
  });
});

describe('joinBidAsk', () => {
  it('produces bid OHLC with spread = ask.close - bid.close', () => {
    const bid = [bar({ time: T0, close: 1.1 })];
    const ask = [bar({ time: T0, close: 1.1002, high: 1.11, low: 1.09 })];
    const out = joinBidAsk(bid, ask);
    expect(out[0]?.close).toBe(1.1);
    expect(out[0]?.spread).toBeCloseTo(0.0002, 12);
  });

  it('matches on TIMESTAMP, not position — the bug a zip would introduce', () => {
    // The ask series is missing the middle minute, exactly what ignoreFlats does
    // independently per price side.
    const bid = [
      bar({ time: T0, close: 1.1 }),
      bar({ time: T0 + M1, close: 1.2 }),
      bar({ time: T0 + 2 * M1, close: 1.3 }),
    ];
    const ask = [bar({ time: T0, close: 1.1002 }), bar({ time: T0 + 2 * M1, close: 1.3004 })];

    const out = joinBidAsk(bid, ask);
    expect(out).toHaveLength(3);
    expect(out[0]?.spread).toBeCloseTo(0.0002, 12);
    // A positional zip would have paired this bid with the 2nd ask and produced 0.1004.
    expect(out[1]?.spread).toBeNull();
    expect(out[2]?.spread).toBeCloseTo(0.0004, 12);
  });

  it('keeps every bid bar even when the ask series is empty', () => {
    const bid = [bar({ time: T0 }), bar({ time: T0 + M1 })];
    const out = joinBidAsk(bid, []);
    expect(out).toHaveLength(2);
    expect(out.every((b) => b.spread === null)).toBe(true);
  });

  it('drops a crossed (negative) spread rather than storing it', () => {
    const bid = [bar({ time: T0, close: 1.2 })];
    const ask = [bar({ time: T0, close: 1.1 })];
    expect(joinBidAsk(bid, ask)[0]?.spread).toBeNull();
  });

  it('allows a zero spread', () => {
    const bid = [bar({ time: T0, close: 1.1 })];
    const ask = [bar({ time: T0, close: 1.1 })];
    expect(joinBidAsk(bid, ask)[0]?.spread).toBe(0);
  });
});
