import { mean, simpleReturns, stdev } from './stats';

/**
 * Risk-adjusted ratios, in two flavours:
 *
 *   - OURS (headline): daily returns, SAMPLE stdev, annualized by sqrt(P) where P is the
 *     number of daily returns actually OBSERVED per year in this dataset — about 260 for
 *     fx (24x5) and 365 for crypto. Deriving P from the data rather than hardcoding 252
 *     means a crypto strategy is not silently under-annualized by 40%.
 *
 *   - TRADINGVIEW-STYLE (secondary, for comparison only): monthly returns, risk-free
 *     2%/12 per month, POPULATION stdev, and NOT annualized.
 *
 * They answer different questions and will not agree. Both are reported so a number can be
 * checked against TradingView without pretending our definition is theirs.
 */

const DAYS_PER_YEAR = 365.25;

/** TradingView's fixed assumption, not ours. */
export const TRADINGVIEW_RF_ANNUAL = 0.02;
export const TRADINGVIEW_RF_MONTHLY = TRADINGVIEW_RF_ANNUAL / 12;

/** Population standard deviation (divide by N), which is what TradingView uses. */
export function populationStdev(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const m = mean(values);
  if (m === null) return null;
  let acc = 0;
  for (const v of values) {
    const d = v - m;
    acc += d * d;
  }
  return Math.sqrt(acc / values.length);
}

/**
 * Daily returns actually observed per year.
 *
 * ~260 for fx (weekends closed), ~365 for crypto. Returns null for a window too short to
 * extrapolate from honestly.
 */
export function observedPeriodsPerYear(returnCount: number, windowDays: number): number | null {
  if (returnCount < 2 || windowDays <= 0) return null;
  return (returnCount * DAYS_PER_YEAR) / windowDays;
}

/** Per-period risk-free rate from an annual one: (1 + rf)^(1/P) - 1. */
export function periodRiskFree(rfAnnual: number, periodsPerYear: number): number {
  if (periodsPerYear <= 0) return 0;
  return (1 + rfAnnual) ** (1 / periodsPerYear) - 1;
}

/**
 * Downside deviation, Sortino's denominator:
 *
 *   DD = sqrt( sum( min(0, r - rf)^2 ) / N )
 *
 * Divided by N — ALL periods — not by the count of negative ones. Dividing by the negative
 * count would inflate the ratio for a strategy that rarely loses, which is precisely the
 * case the metric exists to judge.
 */
export function downsideDeviation(returns: readonly number[], rfPeriod: number): number | null {
  if (returns.length === 0) return null;
  let acc = 0;
  for (const r of returns) {
    const excess = Math.min(0, r - rfPeriod);
    acc += excess * excess;
  }
  return Math.sqrt(acc / returns.length);
}

export interface RatioResult {
  readonly sharpe: number | null;
  readonly sortino: number | null;
}

/** Our headline ratios: daily returns, sample stdev, annualized by sqrt(P). */
export function annualizedRatios(
  dailyEquity: readonly number[],
  windowDays: number,
  rfAnnual: number,
): RatioResult & { periodsPerYear: number | null; returnCount: number } {
  const returns = simpleReturns(dailyEquity);
  const periodsPerYear = observedPeriodsPerYear(returns.length, windowDays);

  if (periodsPerYear === null || returns.length < 2) {
    return { sharpe: null, sortino: null, periodsPerYear, returnCount: returns.length };
  }

  const rf = periodRiskFree(rfAnnual, periodsPerYear);
  const m = mean(returns);
  const sd = stdev(returns);
  const dd = downsideDeviation(returns, rf);
  const scale = Math.sqrt(periodsPerYear);

  return {
    // A zero denominator means a perfectly flat series — undefined, not infinite.
    sharpe: m === null || sd === null || sd === 0 ? null : ((m - rf) / sd) * scale,
    sortino: m === null || dd === null || dd === 0 ? null : ((m - rf) / dd) * scale,
    periodsPerYear,
    returnCount: returns.length,
  };
}

/**
 * TradingView-style ratios: MONTHLY returns, rf 2%/12, POPULATION stdev, NOT annualized.
 * Provided purely so a value can be compared against TradingView's report.
 */
export function tradingViewRatios(monthlyEquity: readonly number[]): RatioResult {
  const returns = simpleReturns(monthlyEquity);
  if (returns.length < 2) return { sharpe: null, sortino: null };

  const rf = TRADINGVIEW_RF_MONTHLY;
  const m = mean(returns);
  const sd = populationStdev(returns);
  const dd = downsideDeviation(returns, rf);

  return {
    sharpe: m === null || sd === null || sd === 0 ? null : (m - rf) / sd,
    sortino: m === null || dd === null || dd === 0 ? null : (m - rf) / dd,
  };
}

/**
 * Compound annual growth rate, in percent.
 *
 *   CAGR = (final / initial)^(365.25 / days) - 1
 *
 * A wiped-out account has no meaningful growth rate, so it is reported as -100%.
 */
export function cagrPct(
  initialCapital: number,
  finalEquity: number,
  windowDays: number,
): number | null {
  if (initialCapital <= 0 || windowDays <= 0) return null;
  if (finalEquity <= 0) return -100;
  return ((finalEquity / initialCapital) ** (DAYS_PER_YEAR / windowDays) - 1) * 100;
}

/** Ulcer Performance Index = (CAGR% - rf%) / UI. */
export function ulcerPerformanceIndex(
  cagrPercent: number | null,
  ulcer: number | null,
  rfAnnual: number,
): number | null {
  if (cagrPercent === null || ulcer === null || ulcer === 0) return null;
  return (cagrPercent - rfAnnual * 100) / ulcer;
}
