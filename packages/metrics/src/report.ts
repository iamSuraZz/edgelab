import { computeCostMetrics } from './cost-drag';
import {
  analyseDrawdown,
  analyseDrawdownDuration,
  emptyDrawdownStats,
  ulcerIndex,
} from './drawdown';
import { computeMonthlyReturns } from './monthly';
import { annualizedRatios, cagrPct, tradingViewRatios, ulcerPerformanceIndex } from './risk-ratios';
import { safeDivide, sum } from './stats';
import { computeSideStats, filterSide } from './trade-stats';
import type {
  MetricsInput,
  MetricsReport,
  PerformanceMetrics,
  RiskMetrics,
  TradeMetrics,
} from './types';

const MS_PER_DAY = 86_400_000;

/**
 * Compose the full report. Pure — no I/O, no clock, no randomness, so the same input always
 * produces the same output and the whole thing is snapshot-testable.
 *
 * Every metric that cannot be defined for the given input is `null`, and a human-readable
 * reason is pushed onto `notes` so the UI can explain the dash rather than just showing one.
 */
export function buildMetricsReport(input: MetricsInput): MetricsReport {
  const notes: string[] = [];
  const rfAnnual = input.rfAnnual ?? 0;
  const { initialCapital } = input;

  const windowDays = Math.max(0, (input.window.toMs - input.window.fromMs) / MS_PER_DAY);

  /* ------------------------------------------------------------ trades */

  const all = computeSideStats(input.trades, initialCapital);
  const long = computeSideStats(filterSide(input.trades, 'long'), initialCapital);
  const short = computeSideStats(filterSide(input.trades, 'short'), initialCapital);

  if (all.trades === 0) notes.push('No closed trades, so trade statistics are undefined.');
  if (all.losses === 0 && all.trades > 0) {
    notes.push('No losing trades, so profit factor and win/loss ratio are undefined.');
  }

  const monthsInWindow = windowDays / (365.25 / 12);
  const tradesPerMonth = monthsInWindow > 0 ? all.trades / monthsInWindow : null;

  const exposurePct =
    input.totalBars !== undefined && input.totalBars > 0 && input.barsInMarket !== undefined
      ? (input.barsInMarket / input.totalBars) * 100
      : null;

  const trades: TradeMetrics = {
    all,
    long,
    short,
    openAtEnd: input.openPnl !== undefined && input.openPnl !== 0 ? 1 : 0,
    exposurePct,
    tradesPerMonth,
  };

  /* ------------------------------------------------------- performance */

  const netProfit = all.netProfit;
  const openPnl = input.openPnl ?? 0;
  const finalEquity = lastEquity(input) ?? initialCapital + netProfit;

  const cagr = cagrPct(initialCapital, finalEquity, windowDays);
  const annualizedFromShortWindow = windowDays > 0 && windowDays < 365.25;
  if (annualizedFromShortWindow && cagr !== null) {
    notes.push(
      `CAGR is annualized from a short window (${windowDays.toFixed(0)} days) and will ` +
        `overstate a sustainable rate.`,
    );
  }
  if (windowDays <= 0) notes.push('Window has zero length, so CAGR is undefined.');

  // Headline drawdown is the INTRABAR curve: it is what the account actually experienced.
  const intrabar =
    input.equityIntrabar.length > 0 ? analyseDrawdown(input.equityIntrabar) : emptyDrawdownStats();
  const closeToClose =
    input.equityClose.length > 0 ? analyseDrawdown(input.equityClose) : emptyDrawdownStats();

  const totalReturnPct = initialCapital > 0 ? (netProfit / initialCapital) * 100 : null;
  const buyAndHoldReturnPct = input.buyAndHoldReturnPct ?? null;

  const performance: PerformanceMetrics = {
    netProfit,
    totalReturnPct,
    openPnl,
    finalEquity,
    grossProfit: all.grossProfit,
    grossLoss: all.grossLoss,
    profitFactor: all.profitFactor,
    cagrPct: cagr,
    annualizedFromShortWindow,
    windowDays,
    // Against the INTRABAR drawdown, per the spec.
    recoveryFactor: safeDivide(netProfit, intrabar.maxDrawdown),
    buyAndHoldReturnPct,
    vsBuyAndHoldPct:
      totalReturnPct === null || buyAndHoldReturnPct === null
        ? null
        : totalReturnPct - buyAndHoldReturnPct,
  };

  /* --------------------------------------------------------------- risk */

  const dailyEquity = input.daily.map((d) => d.equity);
  const monthlyEquity = input.monthly.map((m) => m.equity);

  const ours = annualizedRatios(dailyEquity, windowDays, rfAnnual);
  const tv = tradingViewRatios(monthlyEquity);
  const ulcer = ulcerIndex(dailyEquity);

  if (ours.returnCount < 2) {
    notes.push(
      'Fewer than two daily equity samples, so Sharpe, Sortino and the Ulcer Index are undefined.',
    );
  }
  if (ours.sharpe === null && ours.returnCount >= 2) {
    notes.push('Daily returns have zero variance (flat equity), so Sharpe is undefined.');
  }
  if (ours.sortino === null && ours.returnCount >= 2) {
    notes.push('No downside deviation in daily returns, so Sortino is undefined.');
  }

  const risk: RiskMetrics = {
    intrabar,
    closeToClose,
    duration: analyseDrawdownDuration(
      input.equityIntrabar.length > 0 ? input.equityIntrabar : input.equityClose,
    ),
    sharpe: ours.sharpe,
    sortino: ours.sortino,
    periodsPerYear: ours.periodsPerYear,
    dailyReturnCount: ours.returnCount,
    sharpeTradingView: tv.sharpe,
    sortinoTradingView: tv.sortino,
    ulcerIndex: ulcer,
    ulcerPerformanceIndex: ulcerPerformanceIndex(cagr, ulcer, rfAnnual),
  };

  if (risk.duration.unrecovered) {
    notes.push(
      'The longest drawdown was never recovered; its duration is measured to the end of the test.',
    );
  }

  /* -------------------------------------------------------------- costs */

  const costs = computeCostMetrics(input.trades, input.instrument, input.chargeableSides);
  if (costs.costDragPct === null && input.trades.length > 0) {
    notes.push('Gross profit before costs is zero, so cost drag is undefined.');
  }

  return {
    performance,
    risk,
    trades,
    costs,
    monthlyReturns: computeMonthlyReturns(input.monthly, initialCapital),
    notes,
    accountCurrency: input.instrument.accountCurrency,
  };
}

/** Prefer the close-to-close curve for final equity; fall back to daily, then nothing. */
function lastEquity(input: MetricsInput): number | null {
  const close = input.equityClose[input.equityClose.length - 1];
  if (close !== undefined) return close.equity;
  const daily = input.daily[input.daily.length - 1];
  if (daily !== undefined) return daily.equity;
  return null;
}

/** Total of every cost bucket across the trades, for callers that only need the number. */
export function totalCostsOf(
  trades: readonly {
    commission: number;
    slippageCost: number;
    spreadCost: number;
    financingCost: number;
  }[],
): number {
  return sum(trades.map((t) => t.commission + t.slippageCost + t.spreadCost + t.financingCost));
}
