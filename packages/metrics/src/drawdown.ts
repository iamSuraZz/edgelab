import type { EquityPoint } from '@edgelab/shared';
import type { DrawdownDuration, DrawdownStats } from './types';

/**
 * Drawdown analytics over an equity curve. Pure.
 *
 * Runs over whichever curve it is given: the close-to-close curve, or the intrabar-worst
 * curve (longs marked at the bar low, shorts at the high) which is the headline figure
 * because it is what the account would actually have experienced.
 */

const MS_PER_DAY = 86_400_000;

export function emptyDrawdownStats(): DrawdownStats {
  return {
    maxDrawdown: 0,
    maxDrawdownPct: null,
    peakEquity: null,
    troughEquity: null,
    peakTime: null,
    troughTime: null,
  };
}

/**
 * Largest peak-to-trough decline, in currency and as a percentage OF THE PEAK it fell from
 * (not of initial capital).
 */
export function analyseDrawdown(curve: readonly EquityPoint[]): DrawdownStats {
  if (curve.length === 0) return emptyDrawdownStats();

  let peak = Number.NEGATIVE_INFINITY;
  let peakTime: number | null = null;

  let worst = 0;
  let worstPeak: number | null = null;
  let worstTrough: number | null = null;
  let worstPeakTime: number | null = null;
  let worstTroughTime: number | null = null;

  for (const point of curve) {
    if (point.equity > peak) {
      peak = point.equity;
      peakTime = point.time;
    }
    const decline = peak - point.equity;
    if (decline > worst) {
      worst = decline;
      worstPeak = peak;
      worstTrough = point.equity;
      worstPeakTime = peakTime;
      worstTroughTime = point.time;
    }
  }

  return {
    maxDrawdown: worst,
    // Undefined rather than 0 when the peak is non-positive: a percentage of a
    // zero-or-negative peak is meaningless.
    maxDrawdownPct: worstPeak !== null && worstPeak > 0 ? (worst / worstPeak) * 100 : null,
    peakEquity: worstPeak,
    troughEquity: worstTrough,
    peakTime: worstPeakTime,
    troughTime: worstTroughTime,
  };
}

/**
 * How long drawdowns lasted.
 *
 * A drawdown episode starts at an equity peak and ends when equity first REGAINS that peak.
 * If the last episode never recovers, it is measured to the end of the series and flagged
 * `unrecovered` — reporting it as zero-length would flatter the strategy exactly where it
 * matters most.
 */
export function analyseDrawdownDuration(curve: readonly EquityPoint[]): DrawdownDuration {
  if (curve.length < 2) {
    return {
      longestBars: 0,
      longestDays: 0,
      unrecovered: false,
      averageBars: null,
      averageDays: null,
      percentOfTimeUnderwater: curve.length === 0 ? null : 0,
    };
  }

  interface Episode {
    bars: number;
    ms: number;
    recovered: boolean;
  }
  const episodes: Episode[] = [];

  let peak = curve[0]!.equity;
  let peakIndex = 0;
  let underwater = false;
  let barsUnderwater = 0;

  for (let i = 1; i < curve.length; i += 1) {
    const point = curve[i]!;

    if (point.equity < peak) {
      underwater = true;
      barsUnderwater += 1;
      continue;
    }

    // At or above the old peak.
    if (underwater) {
      episodes.push({
        bars: i - peakIndex,
        ms: point.time - curve[peakIndex]!.time,
        recovered: true,
      });
      underwater = false;
    }
    peak = point.equity;
    peakIndex = i;
  }

  // Still underwater at the end — measure to the last bar and mark it unrecovered.
  let unrecovered = false;
  if (underwater) {
    const last = curve[curve.length - 1]!;
    episodes.push({
      bars: curve.length - 1 - peakIndex,
      ms: last.time - curve[peakIndex]!.time,
      recovered: false,
    });
    unrecovered = true;
  }

  if (episodes.length === 0) {
    return {
      longestBars: 0,
      longestDays: 0,
      unrecovered: false,
      averageBars: null,
      averageDays: null,
      percentOfTimeUnderwater: 0,
    };
  }

  const longest = episodes.reduce((a, b) => (b.bars > a.bars ? b : a));
  const totalBars = episodes.reduce((s, e) => s + e.bars, 0);
  const totalMs = episodes.reduce((s, e) => s + e.ms, 0);

  return {
    longestBars: longest.bars,
    longestDays: longest.ms / MS_PER_DAY,
    // Only the FINAL episode can be unrecovered, and only if it is also the longest does
    // the headline number carry the flag.
    unrecovered: unrecovered && longest.recovered === false,
    averageBars: totalBars / episodes.length,
    averageDays: totalMs / MS_PER_DAY / episodes.length,
    percentOfTimeUnderwater: (barsUnderwater / (curve.length - 1)) * 100,
  };
}

/**
 * Ulcer Index over a daily equity series.
 *
 *   D_i = 100 * (E_i - peak_i) / peak_i     (<= 0)
 *   UI  = sqrt(mean(D_i^2))
 */
export function ulcerIndex(equities: readonly number[]): number | null {
  if (equities.length === 0) return null;

  let peak = Number.NEGATIVE_INFINITY;
  let sumSquares = 0;
  let count = 0;

  for (const equity of equities) {
    if (equity > peak) peak = equity;
    if (peak <= 0) continue; // percentage of a non-positive peak is meaningless
    const d = (100 * (equity - peak)) / peak;
    sumSquares += d * d;
    count += 1;
  }

  return count === 0 ? null : Math.sqrt(sumSquares / count);
}
