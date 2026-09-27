import { describe, expect, it } from 'vitest';
import { ImportFormatError } from './detect';
import { M1TickAggregator, detectExnessColumns, parseTickTimestamp } from './exness-ticks';

const M1 = 60_000;
const T0 = Date.UTC(2024, 0, 2, 0, 0);

describe('parseTickTimestamp', () => {
  it('reads epoch milliseconds', () => {
    expect(parseTickTimestamp(String(T0))).toBe(T0);
  });

  it('reads epoch seconds', () => {
    expect(parseTickTimestamp(String(Math.floor(T0 / 1000)))).toBe(T0);
  });

  it('reads a space-separated datetime as UTC, not local time', () => {
    expect(parseTickTimestamp('2024-01-02 00:00:00')).toBe(T0);
  });

  it('keeps sub-second precision', () => {
    expect(parseTickTimestamp('2024-01-02 00:00:00.123')).toBe(T0 + 123);
  });

  it('reads ISO 8601 with and without a zone', () => {
    expect(parseTickTimestamp('2024-01-02T00:00:00Z')).toBe(T0);
    expect(parseTickTimestamp('2024-01-02T00:00:00')).toBe(T0);
  });

  it('reads the compact yyyymmdd form', () => {
    expect(parseTickTimestamp('20240102 00:00:00.500')).toBe(T0 + 500);
  });

  it('returns null for junk', () => {
    expect(parseTickTimestamp('')).toBeNull();
    expect(parseTickTimestamp('not a time')).toBeNull();
  });
});

describe('detectExnessColumns', () => {
  it('finds columns by name in any order', () => {
    const map = detectExnessColumns(['Ask', 'Bid', 'Timestamp']);
    expect(map.ask).toBe(0);
    expect(map.bid).toBe(1);
    expect(map.time).toBe(2);
  });

  it('accepts common aliases', () => {
    expect(detectExnessColumns(['DateTime', 'BidPrice', 'AskPrice']).time).toBe(0);
    expect(detectExnessColumns(['GMT Time', 'Bid', 'Ask']).time).toBe(0);
  });

  it('tolerates a missing ask column', () => {
    expect(detectExnessColumns(['Timestamp', 'Bid']).ask).toBe(-1);
  });

  it('names the columns it found when it cannot identify the file', () => {
    expect(() => detectExnessColumns(['foo', 'bar'])).toThrow(ImportFormatError);
    expect(() => detectExnessColumns(['foo', 'bar'])).toThrow(/foo, bar/);
  });
});

describe('M1TickAggregator', () => {
  it('builds a bar from the BID side with tick count as volume', () => {
    const agg = new M1TickAggregator();
    expect(agg.add({ time: T0, bid: 1.1, ask: 1.1002 })).toBeNull();
    expect(agg.add({ time: T0 + 10_000, bid: 1.105, ask: 1.1052 })).toBeNull();
    expect(agg.add({ time: T0 + 20_000, bid: 1.095, ask: 1.0952 })).toBeNull();

    const bar = agg.flush();
    expect(bar).toEqual({
      time: T0,
      open: 1.1,
      high: 1.105,
      low: 1.095,
      close: 1.095,
      volume: 3, // tick count
      spread: expect.closeTo(0.0002, 10) as unknown as number,
    });
  });

  it('emits the previous bar as soon as the minute rolls', () => {
    const agg = new M1TickAggregator();
    agg.add({ time: T0, bid: 1.1, ask: 1.1002 });
    const emitted = agg.add({ time: T0 + M1, bid: 1.2, ask: 1.2002 });

    expect(emitted?.time).toBe(T0);
    expect(emitted?.close).toBe(1.1);
    expect(agg.flush()?.time).toBe(T0 + M1);
  });

  it('averages the spread across the minute', () => {
    const agg = new M1TickAggregator();
    agg.add({ time: T0, bid: 1.1, ask: 1.1001 }); // 0.0001
    agg.add({ time: T0 + 1_000, bid: 1.1, ask: 1.1003 }); // 0.0003
    expect(agg.flush()?.spread).toBeCloseTo(0.0002, 10);
  });

  it('ignores a crossed quote in the spread mean but still counts the tick', () => {
    const agg = new M1TickAggregator();
    agg.add({ time: T0, bid: 1.1, ask: 1.1002 });
    agg.add({ time: T0 + 1_000, bid: 1.1, ask: 1.0 }); // crossed
    const bar = agg.flush();
    expect(bar?.spread).toBeCloseTo(0.0002, 10);
    expect(bar?.volume).toBe(2);
  });

  it('reports a null spread when no tick had an ask', () => {
    const agg = new M1TickAggregator();
    agg.add({ time: T0, bid: 1.1, ask: null });
    expect(agg.flush()?.spread).toBeNull();
  });

  it('skips minutes with no ticks rather than emitting flat bars', () => {
    const agg = new M1TickAggregator();
    const bars = [];
    agg.add({ time: T0, bid: 1.1, ask: null });
    const a = agg.add({ time: T0 + 5 * M1, bid: 1.2, ask: null });
    if (a) bars.push(a);
    const b = agg.flush();
    if (b) bars.push(b);

    expect(bars.map((x) => x.time)).toEqual([T0, T0 + 5 * M1]);
  });

  it('counts an out-of-order tick instead of corrupting a closed bar', () => {
    const agg = new M1TickAggregator();
    agg.add({ time: T0 + M1, bid: 1.2, ask: null });
    // Arrives late, belonging to an earlier minute.
    expect(agg.add({ time: T0, bid: 9.9, ask: null })).toBeNull();
    expect(agg.outOfOrder).toBe(1);

    const bar = agg.flush();
    expect(bar?.time).toBe(T0 + M1);
    expect(bar?.high).toBe(1.2); // the 9.9 did not leak in
  });

  it('returns null from flush when nothing was added', () => {
    expect(new M1TickAggregator().flush()).toBeNull();
  });

  it('is O(1): a long run only ever holds one open bar', () => {
    const agg = new M1TickAggregator();
    let emitted = 0;
    for (let i = 0; i < 10_000; i += 1) {
      if (agg.add({ time: T0 + i * 1_000, bid: 1 + (i % 7) / 1000, ask: null }) !== null) {
        emitted += 1;
      }
    }
    if (agg.flush() !== null) emitted += 1;
    // 10,000 ticks one second apart spans ~167 minutes.
    expect(emitted).toBe(167);
  });
});
