import { describe, expect, it } from 'vitest';
import type { EquityPoint } from '@edgelab/shared';

import { buyAndHoldCurve, downsampleEquity } from './series';

/** A curve with a running peak, the way `reconstructEquity` builds one. */
function curve(equities: readonly number[], initialCapital = 10_000): EquityPoint[] {
  let peak = initialCapital;
  return equities.map((equity, i) => {
    if (equity > peak) peak = equity;
    const drawdown = Math.max(0, peak - equity);
    return {
      time: Date.UTC(2024, 0, 2) + i * 3_600_000,
      equity,
      peak,
      drawdown,
      drawdownPct: peak > 0 ? (drawdown / peak) * 100 : 0,
    };
  });
}

describe('downsampleEquity', () => {
  it('passes a short curve through untouched', () => {
    const original = curve([10_100, 10_200, 10_150]);
    const result = downsampleEquity(original, 100);
    expect(result.downsampled).toBe(false);
    expect(result.points).toBe(original);
    expect(result.originalCount).toBe(3);
  });

  it('reduces a long curve to roughly the target', () => {
    const result = downsampleEquity(
      curve(Array.from({ length: 10_000 }, (_, i) => 10_000 + i)),
      200,
    );
    expect(result.downsampled).toBe(true);
    expect(result.originalCount).toBe(10_000);
    // Two points per bucket plus the anchors, so a little over the target is expected.
    expect(result.points.length).toBeLessThanOrEqual(220);
    expect(result.points.length).toBeGreaterThan(100);
  });

  it('KEEPS an isolated crash — the thing a stride would walk straight past', () => {
    // This is the whole reason for min/max bucketing. A flat curve with one deep spike: every
    // Nth point has a high chance of missing the spike entirely, and the chart would then show
    // a drawdown that never happened to be shallower than the real one.
    const equities = Array.from({ length: 5_000 }, () => 10_000);
    equities[2_500] = 4_000;

    const result = downsampleEquity(curve(equities), 100);
    const lowest = Math.min(...result.points.map((p) => p.equity));
    expect(lowest).toBe(4_000);
  });

  it('keeps an isolated spike upward too', () => {
    const equities = Array.from({ length: 5_000 }, () => 10_000);
    equities[1_234] = 19_000;

    const result = downsampleEquity(curve(equities), 100);
    expect(Math.max(...result.points.map((p) => p.equity))).toBe(19_000);
  });

  it('preserves the first and last points, which anchor the chart', () => {
    const original = curve(Array.from({ length: 3_000 }, (_, i) => 10_000 + Math.sin(i) * 100));
    const result = downsampleEquity(original, 100);
    expect(result.points[0]!.time).toBe(original[0]!.time);
    expect(result.points.at(-1)!.time).toBe(original.at(-1)!.time);
  });

  it('returns points in ascending time order', () => {
    // A bucket whose max precedes its min must still be emitted chronologically, or the client
    // draws a zig-zag.
    const original = curve(Array.from({ length: 4_000 }, (_, i) => 10_000 + Math.sin(i / 7) * 500));
    const times = downsampleEquity(original, 150).points.map((p) => p.time);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('emits no duplicate timestamps', () => {
    const original = curve(Array.from({ length: 1_000 }, (_, i) => 10_000 + i));
    const times = downsampleEquity(original, 60).points.map((p) => p.time);
    expect(new Set(times).size).toBe(times.length);
  });

  it('handles an empty curve and a single point', () => {
    expect(downsampleEquity([], 100).points).toEqual([]);
    expect(downsampleEquity(curve([9_000]), 100).points).toHaveLength(1);
  });

  it('survives a tiny target without dropping the extremes', () => {
    const equities = Array.from({ length: 1_000 }, () => 10_000);
    equities[500] = 1_000;
    const result = downsampleEquity(curve(equities), 50);
    expect(Math.min(...result.points.map((p) => p.equity))).toBe(1_000);
  });
});

describe('buyAndHoldCurve', () => {
  const bars = [
    { time: 1, close: 1.1 },
    { time: 2, close: 1.11 },
    { time: 3, close: 1.089 },
  ];

  it('rebases to the strategy’s starting capital so both curves share an axis', () => {
    const result = buyAndHoldCurve(bars, 10_000, 1.1);
    // Bought at 1.1000: the first bar closes flat, so equity is the starting capital.
    expect(result[0]!.equity).toBeCloseTo(10_000, 9);
    // 1.1100 / 1.1000 = +0.909…%
    expect(result[1]!.equity).toBeCloseTo(10_000 * (1.11 / 1.1), 9);
  });

  it('tracks its own peak and drawdown', () => {
    const result = buyAndHoldCurve(bars, 10_000, 1.1);
    expect(result[1]!.drawdown).toBe(0);
    // Peak was at bar 1; bar 2 falls below it.
    expect(result[2]!.peak).toBeCloseTo(result[1]!.equity, 9);
    expect(result[2]!.drawdown).toBeGreaterThan(0);
    expect(result[2]!.drawdownPct).toBeGreaterThan(0);
  });

  it('is empty rather than Infinity when the opening price is zero', () => {
    expect(buyAndHoldCurve(bars, 10_000, 0)).toEqual([]);
  });

  it('is empty for no bars', () => {
    expect(buyAndHoldCurve([], 10_000, 1.1)).toEqual([]);
  });
});
