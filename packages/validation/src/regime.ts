import type { Bar } from '@edgelab/shared';

/**
 * Market regime, computed from a daily series and attached to each trade (spec 06 §3).
 *
 * The question a regime breakdown answers is "where did this edge actually come from" — a strategy
 * that makes all its money in one trending quarter and gives it back in chop is a different
 * proposition from one that earns steadily, and the headline metrics cannot tell them apart.
 *
 * THREE RULES, each of which the obvious implementation gets wrong:
 *
 *   1. **D1 bars close at the NEW YORK close, not midnight UTC (A41).** The Exness-style day splits
 *      an FX week into six bars, one of them a two-hour Sunday stub — which makes SMA(200) span 33
 *      weeks instead of 40 and drags ATR and ADX below what a day of movement really is.
 *   2. **Labels need their FULL lookback or none (A40).** 200 D1 bars for direction, 252 for the
 *      volatility percentile. Days without that history are `unclassified`, never computed from an
 *      expanding window: a 30-bar direction and a 200-bar direction are different measurements, and
 *      calling both "trending" makes the breakdown compare incomparable things.
 *   3. **A trade is labelled by the regime known at its ENTRY (A24)**, from daily values up to the
 *      PREVIOUS day's close. Classifying a trade by the regime of the day it ran in uses that day's
 *      close to describe a decision taken before it — look-ahead inside the very report meant to
 *      detect look-ahead.
 *
 * Pure. The caller supplies M1 bars and the daily boundary instants.
 */

export type Regime = 'trending-up' | 'trending-down' | 'ranging' | 'unclassified';
export type VolatilityBand = 'low' | 'normal' | 'high' | 'unclassified';

/** Bars needed before a direction label means what it says. */
export const DIRECTION_LOOKBACK = 200;
/** Bars needed before a volatility percentile means what it says. */
export const VOLATILITY_LOOKBACK = 252;

export interface DailyBar {
  /** The instant this session CLOSED. Labels for the next session may use it. */
  readonly closeMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

/**
 * Aggregate M1 bars into daily sessions bounded by `boundaries`.
 *
 * `boundaries` are the session-close instants, ascending — from `dailyLocalInstants` at 17:00
 * America/New_York. A session is the half-open span `(previous, boundary]`: a bar exactly AT the
 * close belongs to the session ending there, which is what makes the boundary unambiguous.
 *
 * Sessions with no bars are dropped rather than emitted flat. A weekend produces no trading, and a
 * flat placeholder would add a zero-range bar to every ATR window — the same distortion the New York
 * anchor exists to remove.
 */
export function dailySessions(m1: readonly Bar[], boundaries: readonly number[]): DailyBar[] {
  if (m1.length === 0 || boundaries.length === 0) return [];

  const out: DailyBar[] = [];
  let index = 0;
  let previous = -Infinity;

  for (const boundary of boundaries) {
    let open = NaN;
    let high = -Infinity;
    let low = Infinity;
    let close = NaN;
    let seen = 0;

    while (index < m1.length && m1[index]!.time <= boundary) {
      const bar = m1[index]!;
      if (bar.time > previous) {
        if (seen === 0) open = bar.open;
        high = Math.max(high, bar.high);
        low = Math.min(low, bar.low);
        close = bar.close;
        seen += 1;
      }
      index += 1;
    }

    if (seen > 0) out.push({ closeMs: boundary, open, high, low, close });
    previous = boundary;
  }

  return out;
}

/**
 * Drop session boundaries that fall on a SUNDAY, so the FX week has five sessions and not six.
 *
 * MEASURED, because the New York anchor alone does not achieve this. Over one year of
 * EURUSD.twelvedata the feed carries 8,708 Sunday bars — the market opens Sunday evening — and the
 * 17:00 New York boundary sits at 21:00 UTC in summer and 22:00 in winter. In winter that lands
 * exactly on the Sunday opening bars, producing 41 sessions of a single bar each and 5.81 sessions
 * per week rather than 5.
 *
 * The FX convention is that the week's first session runs from the Sunday open to Monday's close, so
 * those Sunday evening bars belong to MONDAY. Removing the Sunday boundary is what actually delivers
 * five equal sessions; the New York anchor on its own only moves the stub, it does not remove it.
 *
 * `dayOfWeekAt` is injected so this stays pure — the caller supplies the DST-aware lookup.
 */
export function fxSessionBoundaries(
  boundaries: readonly number[],
  dayOfWeekAt: (atMs: number) => number,
): number[] {
  return boundaries.filter((b) => dayOfWeekAt(b) !== 0);
}

/* ------------------------------------------------------------- indicators */

/** Simple moving average of closes, aligned so `out[i]` uses bars `[i-period+1 .. i]`. */
function sma(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;

  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

/**
 * Wilder's ATR over daily bars.
 *
 * True range needs the previous close, so the first bar has none and the series starts at index 1.
 * Wilder smoothing rather than a simple mean because that is what ADX uses below, and two different
 * smoothings of the same quantity in one classifier would be a trap for whoever reads it next.
 */
export function atr(bars: readonly DailyBar[], period: number): (number | null)[] {
  const out: (number | null)[] = [null];
  if (bars.length < 2) return out;

  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const b = bars[i]!;
    const prevClose = bars[i - 1]!.close;
    trueRanges.push(
      Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose)),
    );
  }

  let smoothed: number | null = null;
  for (let i = 0; i < trueRanges.length; i += 1) {
    if (i === period - 1) {
      smoothed = trueRanges.slice(0, period).reduce((s, v) => s + v, 0) / period;
    } else if (i >= period) {
      smoothed = ((smoothed as number) * (period - 1) + trueRanges[i]!) / period;
    }
    out.push(smoothed);
  }
  return out;
}

/**
 * Where a value sits within the trailing window, as a fraction in [0, 1].
 *
 * Rank rather than a z-score: volatility is not normally distributed and a z-score would put a
 * once-a-decade spike at four standard deviations and a merely busy week at one, which says nothing
 * a trader can act on. "Higher than 90% of the last year" is directly meaningful.
 */
export function trailingPercentile(
  values: readonly (number | null)[],
  index: number,
  lookback: number,
): number | null {
  const current = values[index];
  if (current == null) return null;
  if (index + 1 < lookback) return null;

  const window = values.slice(index + 1 - lookback, index + 1);
  const usable = window.filter((v): v is number => v != null);
  // A window that is mostly holes cannot support a percentile, however many slots it spans.
  if (usable.length < lookback / 2) return null;

  const below = usable.filter((v) => v < current).length;
  return below / usable.length;
}

/* --------------------------------------------------------------- labelling */

export interface DayLabel {
  readonly closeMs: number;
  readonly regime: Regime;
  readonly volatility: VolatilityBand;
  /** Null until the direction lookback is satisfied. */
  readonly smaDistancePct: number | null;
  readonly atrPercentile: number | null;
}

export interface RegimeThresholds {
  /**
   * Distance from the SMA, as a fraction of price, beyond which a market counts as trending.
   *
   * Distance rather than slope because slope has units of price per bar and is therefore not
   * comparable between EURUSD at 1.08 and XAUUSD at 2400, while a percentage is.
   */
  readonly trendDistancePct: number;
  /** Percentile boundaries for the volatility band. */
  readonly lowVolatilityBelow: number;
  readonly highVolatilityAbove: number;
}

export const DEFAULT_THRESHOLDS: RegimeThresholds = {
  trendDistancePct: 0.01,
  lowVolatilityBelow: 0.25,
  highVolatilityAbove: 0.75,
};

/**
 * Label every daily session.
 *
 * A label describes the session it sits on, computed from that session's close and the history
 * behind it. Attaching it to a TRADE is a separate step (`regimeAtEntry`), which deliberately looks
 * one session back.
 */
export function labelDays(
  bars: readonly DailyBar[],
  thresholds: RegimeThresholds = DEFAULT_THRESHOLDS,
): DayLabel[] {
  const closes = bars.map((b) => b.close);
  const trend = sma(closes, DIRECTION_LOOKBACK);
  const atrSeries = atr(bars, 14);

  return bars.map((bar, i) => {
    const mean = trend[i];
    const distance = mean == null || mean === 0 ? null : (bar.close - mean) / mean;
    const percentile = trailingPercentile(atrSeries, i, VOLATILITY_LOOKBACK);

    return {
      closeMs: bar.closeMs,
      regime: regimeFrom(distance, thresholds),
      volatility: bandFrom(percentile, thresholds),
      smaDistancePct: distance,
      atrPercentile: percentile,
    };
  });
}

function regimeFrom(distance: number | null, t: RegimeThresholds): Regime {
  if (distance === null) return 'unclassified';
  if (distance > t.trendDistancePct) return 'trending-up';
  if (distance < -t.trendDistancePct) return 'trending-down';
  return 'ranging';
}

function bandFrom(percentile: number | null, t: RegimeThresholds): VolatilityBand {
  if (percentile === null) return 'unclassified';
  if (percentile < t.lowVolatilityBelow) return 'low';
  if (percentile > t.highVolatilityAbove) return 'high';
  return 'normal';
}

/**
 * The regime in force when a trade opened.
 *
 * Takes the latest label whose session closed STRICTLY BEFORE the entry. A trade entered at 09:00 is
 * described by yesterday's close, because today's is not yet known to it — labelling by the running
 * day would use its close to characterise a decision taken hours earlier (A24).
 */
export function regimeAtEntry(labels: readonly DayLabel[], entryMs: number): DayLabel | null {
  let found: DayLabel | null = null;
  for (const label of labels) {
    if (label.closeMs >= entryMs) break;
    found = label;
  }
  return found;
}

/* ------------------------------------------------------------- breakdown */

export interface RegimeBucket {
  readonly regime: Regime;
  readonly trades: number;
  readonly netProfit: number;
  readonly winRatePct: number | null;
  readonly sharePct: number;
}

export interface RegimeBreakdown {
  readonly buckets: readonly RegimeBucket[];
  readonly totalTrades: number;
  /** Trades whose regime could not be established, as a share of all trades. */
  readonly unclassifiedPct: number;
  /** Daily sessions without a full lookback, as a share of all sessions. */
  readonly unclassifiedDaysPct: number;
  readonly explanation: string;
}

export interface LabelledTrade {
  readonly entryMs: number;
  readonly netPnl: number;
}

/**
 * Net profit by regime.
 *
 * The unclassified share is reported rather than hidden, because a breakdown that silently covers
 * half the run reads as a complete account of it. With a 252-bar volatility lookback a six-month
 * test is almost entirely unclassified, and that is the honest answer — not a reason to shorten the
 * lookback until numbers appear.
 */
export function breakdownByRegime(
  trades: readonly LabelledTrade[],
  labels: readonly DayLabel[],
): RegimeBreakdown {
  const order: Regime[] = ['trending-up', 'trending-down', 'ranging', 'unclassified'];

  const assigned = trades.map((t) => ({
    trade: t,
    regime: regimeAtEntry(labels, t.entryMs)?.regime ?? 'unclassified',
  }));

  const total = trades.length;
  const buckets = order
    .map((regime) => {
      const mine = assigned.filter((a) => a.regime === regime);
      const netProfit = mine.reduce((s, a) => s + a.trade.netPnl, 0);
      const wins = mine.filter((a) => a.trade.netPnl > 0).length;

      return {
        regime,
        trades: mine.length,
        netProfit,
        winRatePct: mine.length === 0 ? null : (wins / mine.length) * 100,
        sharePct: total === 0 ? 0 : (mine.length / total) * 100,
      };
    })
    .filter((b) => b.trades > 0);

  const unclassifiedTrades = assigned.filter((a) => a.regime === 'unclassified').length;
  const unclassifiedDays = labels.filter((l) => l.regime === 'unclassified').length;

  const unclassifiedPct = total === 0 ? 0 : (unclassifiedTrades / total) * 100;
  const unclassifiedDaysPct = labels.length === 0 ? 0 : (unclassifiedDays / labels.length) * 100;

  return {
    buckets,
    totalTrades: total,
    unclassifiedPct,
    unclassifiedDaysPct,
    explanation:
      `${unclassifiedDaysPct.toFixed(0)}% of daily sessions lack the full lookback ` +
      `(${String(DIRECTION_LOOKBACK)} bars for direction, ${String(VOLATILITY_LOOKBACK)} for the ` +
      `volatility percentile), leaving ${unclassifiedPct.toFixed(0)}% of trades unclassified. ` +
      'Those bars are not labelled from a shorter window: a 30-bar direction and a 200-bar ' +
      'direction are different measurements, and calling both "trending" would compare them.',
  };
}
