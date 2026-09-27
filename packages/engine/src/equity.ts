import type {
  Bar,
  ClosedTrade,
  CostedTrade,
  EquityPoint,
  EquitySample,
  SymbolSpec,
} from '@edgelab/shared';

import { IDENTITY_RATE, priceDeltaToQuote, type QuoteToAccount } from './costs';
import type { EngineTrade } from './pine-engine';

/**
 * Equity reconstruction (spec 04). Pure: bars + costed trades in, curves out.
 *
 * Two curves, because they answer different questions:
 *
 *  - **close-to-close** marks open positions at each bar's CLOSE. This is the curve returns
 *    and Sharpe are computed from, because a return series has to be sampled at a consistent
 *    point in each bar.
 *  - **intrabar-worst** marks longs at the bar LOW and shorts at the HIGH. This is the
 *    headline drawdown, because it is the drawdown that would actually have shown on the
 *    account and triggered a margin call. A close-only curve systematically understates it.
 *
 * Realized P&L lands on the bar a trade EXITS. Unrealised P&L is marked from the entry bar
 * onward. A trade contributes to exactly one of the two on any given bar, never both.
 */

export type { ClosedTrade, EquityPoint };

export interface ReconstructParams {
  /** The bars the run executed on, ascending. */
  readonly bars: readonly Bar[];
  /** Closed trades WITH costs applied. */
  readonly trades: readonly CostedTrade[];
  /** Positions still open at the end of the run, from the engine. */
  readonly openTrades?: readonly EngineTrade[];
  readonly initialCapital: number;
  readonly symbol: SymbolSpec;
  /** D6. Identity for a quote currency matching the account currency. */
  readonly quoteToAccount?: QuoteToAccount;
}

export interface ReconstructedEquity {
  /** Mark-to-market at each bar close. */
  readonly close: EquityPoint[];
  /** Longs marked at the bar low, shorts at the high. */
  readonly intrabar: EquityPoint[];
  /** Last close-curve equity of each UTC day. */
  readonly daily: EquitySample[];
  /** Last close-curve equity of each UTC month. */
  readonly monthly: EquitySample[];
  /** Realized P&L summed over all closed trades, after costs. */
  readonly realizedPnl: number;
  /** Unrealised P&L of still-open positions at the final bar's close. */
  readonly openPnl: number;
  /** Bars on which any position was open, for exposure. */
  readonly barsInMarket: number;
  readonly finalEquity: number;
}

export function reconstructEquity(params: ReconstructParams): ReconstructedEquity {
  const { bars, trades, initialCapital, symbol } = params;
  const rate = params.quoteToAccount ?? IDENTITY_RATE;
  const openTrades = params.openTrades ?? [];

  if (!Number.isFinite(initialCapital) || initialCapital <= 0) {
    throw new RangeError(`initialCapital must be positive, received ${String(initialCapital)}`);
  }

  // Index trades by the bar they land on, so the walk below is O(bars + trades) rather than
  // O(bars × trades) — at a million bars and ten thousand trades that distinction matters.
  const realizedAtBar = new Map<number, number>();
  for (const trade of trades) {
    realizedAtBar.set(trade.exitBar, (realizedAtBar.get(trade.exitBar) ?? 0) + trade.netPnl);
  }

  interface OpenLeg {
    readonly side: 'long' | 'short';
    readonly units: number;
    readonly entryPrice: number;
    readonly entryBar: number;
    readonly exitBar: number;
  }

  const legsByEntryBar = new Map<number, OpenLeg[]>();
  const pushLeg = (leg: OpenLeg): void => {
    const existing = legsByEntryBar.get(leg.entryBar);
    if (existing === undefined) legsByEntryBar.set(leg.entryBar, [leg]);
    else existing.push(leg);
  };

  for (const trade of trades) {
    pushLeg({
      side: trade.side,
      units: Math.abs(trade.qty) * symbol.contractSize,
      entryPrice: trade.entryPrice,
      entryBar: trade.entryBar,
      exitBar: trade.exitBar,
    });
  }
  for (const trade of openTrades) {
    pushLeg({
      side: trade.side,
      units: Math.abs(trade.qty),
      entryPrice: trade.entryPrice,
      entryBar: trade.entryBar,
      // Never closes, so it is marked to the end of the run.
      exitBar: Number.POSITIVE_INFINITY,
    });
  }

  const close: EquityPoint[] = [];
  const intrabar: EquityPoint[] = [];

  let realized = 0;
  let closePeak = initialCapital;
  let intrabarPeak = initialCapital;
  let barsInMarket = 0;
  let live: OpenLeg[] = [];
  let lastOpenPnl = 0;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;

    // Legs that entered on this bar become live; the entry bar itself is marked, since the
    // fill happened at its open and the position was exposed for the rest of it.
    const entering = legsByEntryBar.get(i);
    if (entering !== undefined) live.push(...entering);

    realized += realizedAtBar.get(i) ?? 0;

    // A leg exiting on this bar is realized above, so it must not also be marked open.
    live = live.filter((leg) => leg.exitBar > i);

    if (live.length > 0) barsInMarket += 1;

    const conversion = rate(bar.time);
    let openAtClose = 0;
    let openAtWorst = 0;

    for (const leg of live) {
      const direction = leg.side === 'long' ? 1 : -1;
      // Worst case for a long is the low, for a short the high.
      const worstPrice = leg.side === 'long' ? bar.low : bar.high;
      openAtClose +=
        priceDeltaToQuote(direction * (bar.close - leg.entryPrice), leg.units, symbol) * conversion;
      openAtWorst +=
        priceDeltaToQuote(direction * (worstPrice - leg.entryPrice), leg.units, symbol) *
        conversion;
    }

    lastOpenPnl = openAtClose;

    const closeEquity = initialCapital + realized + openAtClose;
    // The intrabar curve uses the same realized base: what varies is only the mark.
    const worstEquity = initialCapital + realized + openAtWorst;

    if (closeEquity > closePeak) closePeak = closeEquity;
    if (worstEquity > intrabarPeak) intrabarPeak = worstEquity;

    close.push(point(bar.time, closeEquity, closePeak));
    intrabar.push(point(bar.time, worstEquity, intrabarPeak));
  }

  return {
    close,
    intrabar,
    daily: sampleBy(close, utcDayStart),
    monthly: sampleBy(close, utcMonthStart),
    realizedPnl: realized,
    openPnl: lastOpenPnl,
    barsInMarket,
    finalEquity: close[close.length - 1]?.equity ?? initialCapital,
  };
}

function point(time: number, equity: number, peak: number): EquityPoint {
  const drawdown = Math.max(0, peak - equity);
  return {
    time,
    equity,
    peak,
    drawdown,
    drawdownPct: peak > 0 ? (drawdown / peak) * 100 : 0,
  };
}

/* ---------------------------------------------------------------- sampling */

const MS_PER_DAY = 86_400_000;

export function utcDayStart(timeMs: number): number {
  return Math.floor(timeMs / MS_PER_DAY) * MS_PER_DAY;
}

export function utcMonthStart(timeMs: number): number {
  const d = new Date(timeMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * The LAST equity of each bucket — the closing mark, not an average.
 *
 * Returns one sample per bucket that has bars. A bucket with no bars is skipped rather than
 * carried forward: an fx weekend is not a flat day, it is a day that did not happen, and
 * inventing zero returns for it would deflate every volatility figure that follows.
 */
export function sampleBy(
  curve: readonly EquityPoint[],
  bucketOf: (timeMs: number) => number,
): EquitySample[] {
  const out: EquitySample[] = [];
  let currentBucket: number | null = null;

  for (const p of curve) {
    const bucket = bucketOf(p.time);
    if (bucket !== currentBucket) {
      out.push({ time: bucket, equity: p.equity });
      currentBucket = bucket;
    } else {
      out[out.length - 1] = { time: bucket, equity: p.equity };
    }
  }

  return out;
}

/* --------------------------------------------------------------- buy & hold */

/**
 * Return of buying at the first bar's open and holding to the last bar's close, in percent.
 *
 * Deliberately a pure price return with no costs and no position sizing: it is the benchmark
 * the strategy is compared against, and the comparison is only meaningful if the benchmark is
 * the simplest possible thing. Null when there is nothing to measure.
 */
export function buyAndHoldReturnPct(bars: readonly Bar[]): number | null {
  const first = bars[0];
  const last = bars[bars.length - 1];
  if (first === undefined || last === undefined) return null;
  if (!Number.isFinite(first.open) || first.open === 0) return null;
  return ((last.close - first.open) / first.open) * 100;
}

/* ------------------------------------------------------------- cross-check */

export interface CrossCheck {
  readonly ok: boolean;
  /** What the engine said its net profit was, in account currency. */
  readonly engineNetProfit: number;
  /** What reconstruction summed from the trades. */
  readonly reconstructed: number;
  readonly absoluteDelta: number;
  /** Relative to the engine's figure, in percent. Null when the engine made exactly zero. */
  readonly deltaPct: number | null;
  readonly tolerancePct: number;
  readonly message: string;
}

/**
 * With overlay costs set to zero, reconstructed realized P&L must equal the engine's own
 * netprofit (spec 04). Anything else means the overlay, the unit conversions or the trade
 * mapping is wrong — and would be invisible otherwise, because both numbers look plausible.
 *
 * Compared as a fraction of the engine's figure, with an absolute floor so a strategy that
 * happened to net almost nothing does not fail on a rounding difference.
 */
export function crossCheckZeroCost(
  engineNetProfit: number | null,
  reconstructedRealized: number,
  options: { tolerancePct?: number; absoluteFloor?: number } = {},
): CrossCheck {
  const tolerancePct = options.tolerancePct ?? 0.01;
  const floor = options.absoluteFloor ?? 1e-9;
  const engine = engineNetProfit ?? 0;
  const absoluteDelta = Math.abs(engine - reconstructedRealized);

  const deltaPct = engine === 0 ? null : (absoluteDelta / Math.abs(engine)) * 100;
  const ok = absoluteDelta <= floor || (deltaPct !== null && deltaPct <= tolerancePct);

  return {
    ok,
    engineNetProfit: engine,
    reconstructed: reconstructedRealized,
    absoluteDelta,
    deltaPct,
    tolerancePct,
    message: ok
      ? `cross-check OK: engine ${engine.toFixed(6)} vs reconstructed ` +
        `${reconstructedRealized.toFixed(6)}`
      : `CROSS-CHECK FAILED: engine ${engine.toFixed(6)} vs reconstructed ` +
        `${reconstructedRealized.toFixed(6)} (${
          deltaPct === null ? 'n/a' : `${deltaPct.toFixed(4)}%`
        } > ${String(tolerancePct)}%). The cost overlay or the unit conversion is wrong.`,
  };
}

/* ------------------------------------------------- drawdown (kept for reuse) */

export interface DrawdownSummary {
  readonly maxDrawdown: number;
  readonly maxDrawdownPct: number;
  readonly maxDrawdownDurationMs: number;
  readonly endedInDrawdown: boolean;
}

export function summariseDrawdown(curve: readonly EquityPoint[]): DrawdownSummary {
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let maxDuration = 0;

  let peakValue = Number.NEGATIVE_INFINITY;
  let peakTime: number | null = null;

  for (const p of curve) {
    if (p.equity >= peakValue) {
      peakValue = p.equity;
      peakTime = p.time;
    } else if (peakTime !== null) {
      const duration = p.time - peakTime;
      if (duration > maxDuration) maxDuration = duration;
    }

    if (p.drawdown > maxDrawdown) maxDrawdown = p.drawdown;
    if (p.drawdownPct > maxDrawdownPct) maxDrawdownPct = p.drawdownPct;
  }

  const last = curve[curve.length - 1];

  return {
    maxDrawdown,
    maxDrawdownPct,
    maxDrawdownDurationMs: maxDuration,
    endedInDrawdown: last !== undefined && last.drawdown > 0,
  };
}

export function finalEquity(curve: readonly EquityPoint[], initialCapital: number): number {
  return curve[curve.length - 1]?.equity ?? initialCapital;
}
