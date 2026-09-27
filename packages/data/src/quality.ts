import { MS_PER_MINUTE, type Bar, type SessionType } from '@edgelab/shared';

import { openMinutesBetween, sessionFor, type SessionWindow } from './sessions';

/**
 * Data quality report for a stored M1 range. Pure: takes bars, returns findings.
 *
 * The point is to catch the silent failures that make a backtest look great and mean
 * nothing — a month of missing bars, a duplicated timestamp, a 500-pip spike from a bad
 * tick, or a spread column that is garbage.
 *
 * Session boundaries live in `./sessions.ts` and are expressed in America/New_York via the
 * tz database (decision D3). The earlier fixed 22:00-UTC fx boundary was empirically right
 * for winter and an hour wrong all summer.
 */

export interface QualityOptions {
  readonly sessionType: SessionType;
  readonly session?: SessionWindow;
  /** A bar whose true range exceeds this multiple of the rolling median is a spike. */
  readonly spikeMultiple?: number;
  /** Same idea for the spread column. */
  readonly spreadOutlierMultiple?: number;
  /** Rolling window, in bars, used for both medians. */
  readonly rollingWindow?: number;
  /** Findings are sampled beyond this many entries; counts stay exact. */
  readonly maxSamples?: number;
}

export interface Gap {
  /** Open time of the bar before the gap. */
  readonly after: number;
  /** Open time of the bar after the gap. */
  readonly before: number;
  /** Missing minutes that fall inside open market hours. */
  readonly missingMinutes: number;
}

export interface Spike {
  readonly time: number;
  readonly trueRange: number;
  readonly medianTrueRange: number;
  readonly ratio: number;
}

export interface SpreadOutlier {
  readonly time: number;
  readonly spread: number;
  readonly medianSpread: number;
  readonly ratio: number;
}

export interface QualityFinding<T> {
  readonly count: number;
  readonly samples: readonly T[];
  /** True when `count` exceeds the sample cap, so `samples` is partial. */
  readonly truncated: boolean;
}

export interface QualityReport {
  readonly barCount: number;
  readonly firstBar: number | null;
  readonly lastBar: number | null;
  /** Minutes of open market time with no bar, summed across all gaps. */
  readonly missingMinutes: number;
  /** Fraction of expected open minutes actually present, 0..1. */
  readonly completeness: number;
  readonly gaps: QualityFinding<Gap>;
  readonly duplicateTimestamps: QualityFinding<number>;
  readonly outOfOrderTimestamps: QualityFinding<number>;
  /** Bars where high === low, which usually means a stalled or synthetic feed. */
  readonly zeroRangeBars: QualityFinding<number>;
  /**
   * Flat AND zero-volume bars: provider filler, which MetaTrader would never have formed
   * (decision D4). Normalization drops these, so a non-zero count here means filler reached
   * storage from somewhere that bypassed it.
   */
  readonly fillerBars: QualityFinding<number>;
  readonly spikes: QualityFinding<Spike>;
  readonly spreadOutliers: QualityFinding<SpreadOutlier>;
  /** Bars whose OHLC is internally incoherent. Always a hard error. */
  readonly invalidBars: QualityFinding<number>;
}

/**
 * Median of the trailing `window` values ending at each index.
 *
 * Maintains a sorted window with binary-search insert/remove. That is O(window) per step
 * because of the array splice, but the moves are contiguous and fast; an exact rolling
 * median via two heaps is not worth the complexity here.
 */
export function rollingMedian(values: readonly number[], window: number): (number | null)[] {
  if (window < 1) throw new RangeError(`window must be >= 1, received ${String(window)}`);

  const out: (number | null)[] = new Array(values.length).fill(null);
  const sorted: number[] = [];

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === undefined) continue;

    insertSorted(sorted, value);

    if (i >= window) {
      const leaving = values[i - window];
      if (leaving !== undefined) removeSorted(sorted, leaving);
    }

    // Only report once the window is meaningfully populated, so the first few bars of a
    // series are not compared against a median of one.
    if (sorted.length >= Math.min(window, 20)) {
      const mid = sorted.length >> 1;
      out[i] =
        sorted.length % 2 === 1
          ? (sorted[mid] as number)
          : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
    }
  }

  return out;
}

function lowerBound(arr: readonly number[], value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function insertSorted(arr: number[], value: number): void {
  arr.splice(lowerBound(arr, value), 0, value);
}

function removeSorted(arr: number[], value: number): void {
  const idx = lowerBound(arr, value);
  if (idx < arr.length && arr[idx] === value) arr.splice(idx, 1);
}

function finding<T>(items: readonly T[], cap: number): QualityFinding<T> {
  return {
    count: items.length,
    samples: items.slice(0, cap),
    truncated: items.length > cap,
  };
}

export function analyseQuality(bars: readonly Bar[], opts: QualityOptions): QualityReport {
  const session = opts.session ?? sessionFor(opts.sessionType);
  const spikeMultiple = opts.spikeMultiple ?? 10;
  const spreadMultiple = opts.spreadOutlierMultiple ?? 10;
  const window = opts.rollingWindow ?? 500;
  const cap = opts.maxSamples ?? 200;

  const gaps: Gap[] = [];
  const duplicates: number[] = [];
  const outOfOrder: number[] = [];
  const zeroRange: number[] = [];
  const filler: number[] = [];
  const invalid: number[] = [];

  const trueRanges: number[] = [];
  const spreadValues: number[] = [];
  const spreadTimes: number[] = [];

  let missingMinutes = 0;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (bar === undefined) continue;

    const { open, high, low, close } = bar;

    if (
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      high < low ||
      high < Math.max(open, close) ||
      low > Math.min(open, close)
    ) {
      invalid.push(bar.time);
    } else if (high === low) {
      zeroRange.push(bar.time);
      if (bar.volume === 0) filler.push(bar.time);
    }

    const prev = i > 0 ? bars[i - 1] : undefined;

    if (prev !== undefined) {
      if (bar.time === prev.time) {
        duplicates.push(bar.time);
      } else if (bar.time < prev.time) {
        outOfOrder.push(bar.time);
      } else {
        // Gap = open minutes strictly between the end of prev and the start of bar.
        const expectedNext = prev.time + MS_PER_MINUTE;
        if (bar.time > expectedNext) {
          const missing = openMinutesBetween(expectedNext, bar.time, opts.sessionType, session);
          if (missing > 0) {
            missingMinutes += missing;
            gaps.push({ after: prev.time, before: bar.time, missingMinutes: missing });
          }
        }
      }

      trueRanges.push(
        Math.max(high - low, Math.abs(high - prev.close), Math.abs(low - prev.close)),
      );
    } else {
      trueRanges.push(high - low);
    }

    const spread = bar.spread;
    if (spread != null && Number.isFinite(spread)) {
      spreadValues.push(spread);
      spreadTimes.push(bar.time);
    }
  }

  /* ---- spikes ---- */
  const trMedians = rollingMedian(trueRanges, window);
  const spikes: Spike[] = [];
  for (let i = 0; i < trueRanges.length; i += 1) {
    const tr = trueRanges[i];
    const median = trMedians[i];
    const bar = bars[i];
    if (tr === undefined || median == null || bar === undefined) continue;
    // A zero median means a dead-flat window; a ratio against it is meaningless.
    if (median <= 0) continue;
    const ratio = tr / median;
    if (ratio > spikeMultiple) {
      spikes.push({ time: bar.time, trueRange: tr, medianTrueRange: median, ratio });
    }
  }

  /* ---- spread outliers ---- */
  const spreadMedians = rollingMedian(spreadValues, window);
  const spreadOutliers: SpreadOutlier[] = [];
  for (let i = 0; i < spreadValues.length; i += 1) {
    const spread = spreadValues[i];
    const median = spreadMedians[i];
    const time = spreadTimes[i];
    if (spread === undefined || median == null || time === undefined) continue;
    if (median <= 0) continue;
    const ratio = spread / median;
    if (ratio > spreadMultiple) {
      spreadOutliers.push({ time, spread, medianSpread: median, ratio });
    }
  }

  const first = bars[0]?.time ?? null;
  const last = bars[bars.length - 1]?.time ?? null;

  // Expected minutes spans the observed range, so completeness measures the holes
  // INSIDE what we have rather than penalising a deliberately short range.
  let completeness = 1;
  if (first !== null && last !== null && last > first) {
    const expected = openMinutesBetween(first, last + MS_PER_MINUTE, opts.sessionType, session);
    completeness =
      expected > 0 ? Math.max(0, Math.min(1, (expected - missingMinutes) / expected)) : 1;
  }

  return {
    barCount: bars.length,
    firstBar: first,
    lastBar: last,
    missingMinutes,
    completeness,
    gaps: finding(gaps, cap),
    duplicateTimestamps: finding(duplicates, cap),
    outOfOrderTimestamps: finding(outOfOrder, cap),
    zeroRangeBars: finding(zeroRange, cap),
    fillerBars: finding(filler, cap),
    spikes: finding(spikes, cap),
    spreadOutliers: finding(spreadOutliers, cap),
    invalidBars: finding(invalid, cap),
  };
}
