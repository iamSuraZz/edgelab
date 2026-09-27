import type { EquityPoint } from '@edgelab/shared';

/**
 * Downsampling for chart transport.
 *
 * A one-year M5 run is ~75,000 points per curve. Sending that to a browser to draw on a
 * 1,200-pixel-wide canvas ships ~2 MB to render 1,200 columns, and the client then throws 98%
 * of it away. But a naive "every Nth point" stride is worse than useless on an equity curve:
 * it can walk straight past the spike that IS the drawdown, so the chart would show a smoother,
 * shallower history than actually happened.
 *
 * This uses min/max bucketing instead: each output bucket keeps its extremes, so every peak and
 * trough survives at full amplitude and the visible drawdown is the real one. Cost is up to
 * 2 points per bucket, which is why `points` is a target rather than a cap.
 */

export interface DownsampledSeries {
  readonly points: readonly EquityPoint[];
  readonly originalCount: number;
  readonly downsampled: boolean;
}

export function downsampleEquity(
  curve: readonly EquityPoint[],
  targetPoints: number,
): DownsampledSeries {
  if (curve.length <= targetPoints) {
    return { points: curve, originalCount: curve.length, downsampled: false };
  }

  // Two points per bucket, so the bucket count is half the budget.
  const bucketCount = Math.max(1, Math.floor(targetPoints / 2));
  const bucketSize = curve.length / bucketCount;

  const out: EquityPoint[] = [];
  // The first point anchors the curve's start, which a bucket's extremes might not include.
  out.push(curve[0]!);

  for (let b = 0; b < bucketCount; b += 1) {
    const start = Math.floor(b * bucketSize);
    const end = Math.min(curve.length, Math.floor((b + 1) * bucketSize));
    if (end <= start) continue;

    let lowest = curve[start]!;
    let highest = curve[start]!;
    for (let i = start + 1; i < end; i += 1) {
      const p = curve[i]!;
      if (p.equity < lowest.equity) lowest = p;
      if (p.equity > highest.equity) highest = p;
    }

    // Chronological within the bucket, so the series stays monotonic in time — a chart that
    // receives points out of order draws a zig-zag.
    if (lowest.time <= highest.time) {
      out.push(lowest);
      if (highest !== lowest) out.push(highest);
    } else {
      out.push(highest);
      out.push(lowest);
    }
  }

  const last = curve[curve.length - 1]!;
  if (out[out.length - 1]?.time !== last.time) out.push(last);

  // Buckets can repeat a boundary point; de-duplicate by time so the client gets a clean series.
  const deduped: EquityPoint[] = [];
  for (const p of out) {
    if (deduped[deduped.length - 1]?.time !== p.time) deduped.push(p);
  }

  return { points: deduped, originalCount: curve.length, downsampled: true };
}

/**
 * Buy & hold rebased to the same starting capital as the strategy, so the two can be drawn on
 * one axis.
 *
 * Rebased rather than shown as a percentage because the comparison a reader actually makes is
 * "would I have more money", and two curves in the same units answer that without arithmetic.
 */
export function buyAndHoldCurve(
  bars: readonly { time: number; close: number }[],
  initialCapital: number,
  firstOpen: number,
): EquityPoint[] {
  if (firstOpen <= 0) return [];

  let peak = initialCapital;
  return bars.map((bar) => {
    const equity = initialCapital * (bar.close / firstOpen);
    if (equity > peak) peak = equity;
    const drawdown = Math.max(0, peak - equity);
    return {
      time: bar.time,
      equity,
      peak,
      drawdown,
      drawdownPct: peak > 0 ? (drawdown / peak) * 100 : 0,
    };
  });
}
