import type { AccountMoney, CostedTrade, EquityPoint, EquitySample } from '@edgelab/shared';

/**
 * The metrics engine is PURE: this input in, a MetricsReport out. No I/O, no clock.
 *
 * Undefined metrics are `null`, never NaN or Infinity — a ratio with a zero denominator is
 * genuinely undefined and the UI must be able to say so rather than printing "Infinity".
 */

export interface MetricsWindow {
  /** Inclusive start of the trading window, UTC epoch ms. */
  readonly fromMs: number;
  /** Exclusive end. */
  readonly toMs: number;
}

/** Contract details needed to express the break-even cost in price units. */
export interface MetricsInstrument {
  readonly symbol: string;
  readonly accountCurrency: string;
  readonly quoteCurrency: string;
  readonly mintick: number;
  readonly pipSize: number;
  readonly pointValue: number;
  readonly contractSize: number;
}

export interface MetricsInput {
  readonly trades: readonly CostedTrade[];
  /** Mark-to-market equity at each bar close. */
  readonly equityClose: readonly EquityPoint[];
  /** Intrabar-worst equity (longs at the bar low, shorts at the high). Headline drawdown. */
  readonly equityIntrabar: readonly EquityPoint[];
  /** Last equity of each UTC day. Drives Sharpe/Sortino/Ulcer. */
  readonly daily: readonly EquitySample[];
  /** Last equity of each UTC month. Drives the TradingView-style ratios. */
  readonly monthly: readonly EquitySample[];
  readonly initialCapital: AccountMoney;
  readonly window: MetricsWindow;
  readonly instrument: MetricsInstrument;
  /** Annual risk-free rate as a fraction, e.g. 0.02. Default 0. */
  readonly rfAnnual?: number;
  /** Unrealised P&L of positions still open at the end, after costs. */
  readonly openPnl?: AccountMoney;
  /** Return of buying and holding the instrument over the same window, in percent. */
  readonly buyAndHoldReturnPct?: number | null;
  /**
   * How many of each trade's fills a real broker would slip, aligned with `trades`.
   *
   * Drives the break-even denominator. Two per trade is the old assumption and stays the default;
   * a bracket exit filled by a LIMIT is not chargeable, so those trades contribute one side, and
   * counting two would understate how far execution can degrade before the edge dies.
   */
  readonly chargeableSides?: readonly number[];
  /** Bars where a position was open, for exposure. */
  readonly barsInMarket?: number;
  readonly totalBars?: number;
}

/* --------------------------------------------------------------- sections */

export interface PerformanceMetrics {
  readonly netProfit: number;
  readonly totalReturnPct: number | null;
  readonly openPnl: number;
  readonly finalEquity: number;
  readonly grossProfit: number;
  readonly grossLoss: number;
  readonly profitFactor: number | null;
  readonly cagrPct: number | null;
  /** True when the window is under a year, so the CAGR is an extrapolation. */
  readonly annualizedFromShortWindow: boolean;
  readonly windowDays: number;
  readonly recoveryFactor: number | null;
  readonly buyAndHoldReturnPct: number | null;
  /** totalReturnPct - buyAndHoldReturnPct, for the KPI strip delta. */
  readonly vsBuyAndHoldPct: number | null;
}

export interface DrawdownStats {
  /** Currency, always >= 0. */
  readonly maxDrawdown: number;
  /** Percent of the peak it fell from. */
  readonly maxDrawdownPct: number | null;
  readonly peakEquity: number | null;
  readonly troughEquity: number | null;
  readonly peakTime: number | null;
  readonly troughTime: number | null;
}

export interface DrawdownDuration {
  /** Longest peak-to-recovery span. */
  readonly longestBars: number;
  readonly longestDays: number;
  /** True when equity never regained that peak, so the span runs to the end. */
  readonly unrecovered: boolean;
  readonly averageBars: number | null;
  readonly averageDays: number | null;
  readonly percentOfTimeUnderwater: number | null;
}

export interface RiskMetrics {
  /** Headline figure, from the intrabar-worst curve. */
  readonly intrabar: DrawdownStats;
  readonly closeToClose: DrawdownStats;
  readonly duration: DrawdownDuration;
  /** Annualized, sample stdev, P observed from the data. */
  readonly sharpe: number | null;
  readonly sortino: number | null;
  /** Daily returns actually observed per year — ~260 fx, ~365 crypto. */
  readonly periodsPerYear: number | null;
  readonly dailyReturnCount: number;
  /** Monthly returns, rf 2%/12, POPULATION stdev, NOT annualized. For TV comparison. */
  readonly sharpeTradingView: number | null;
  readonly sortinoTradingView: number | null;
  readonly ulcerIndex: number | null;
  readonly ulcerPerformanceIndex: number | null;
}

export interface SideStats {
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakEven: number;
  readonly netProfit: number;
  readonly grossProfit: number;
  readonly grossLoss: number;
  readonly winRatePct: number | null;
  readonly profitFactor: number | null;
  readonly avgTrade: number | null;
  readonly avgWin: number | null;
  /** Negative, as a loss. */
  readonly avgLoss: number | null;
  /** Avg Win / |Avg Loss|. */
  readonly winLossRatio: number | null;
  readonly expectancy: number | null;
  readonly expectancyPct: number | null;
  readonly largestWin: number | null;
  readonly largestLoss: number | null;
  readonly maxConsecutiveWins: number;
  readonly maxConsecutiveLosses: number;
  /** Positive = n consecutive wins, negative = n consecutive losses, 0 = none. */
  readonly currentStreak: number;
  readonly avgBarsHeld: number | null;
  readonly avgBarsHeldWins: number | null;
  readonly avgBarsHeldLosses: number | null;
  readonly avgMae: number | null;
  readonly avgMfe: number | null;
}

export interface TradeMetrics {
  readonly all: SideStats;
  readonly long: SideStats;
  readonly short: SideStats;
  readonly openAtEnd: number;
  readonly exposurePct: number | null;
  readonly tradesPerMonth: number | null;
}

export interface CostBucket {
  readonly total: number;
  readonly perTrade: number | null;
}

export interface CostMetrics {
  readonly commission: CostBucket;
  readonly slippage: CostBucket;
  /**
   * Slippage the engine applied to LIMIT fills and this platform credited back.
   *
   * Not part of `totalCosts` — it was never a cost, it is a correction for an engine divergence
   * (A28/A29). Shown as its own waterfall line so the adjustment is visible.
   */
  readonly slippageRefunded: CostBucket;
  readonly spread: CostBucket;
  readonly financing: CostBucket;
  readonly totalCosts: number;
  /** totalCosts / (netProfit + totalCosts). Null when that denominator is 0. */
  readonly costDragPct: number | null;
  /** Gross P&L before our overlay, for the waterfall. */
  readonly grossBeforeCosts: number;
  /** How much worse execution can get, per side, before the edge vanishes. */
  readonly breakEvenPerSidePrice: number | null;
  readonly breakEvenPerSideTicks: number | null;
  readonly breakEvenPerSidePips: number | null;
}

export interface MonthlyReturn {
  readonly year: number;
  /** 1-12. */
  readonly month: number;
  readonly returnPct: number | null;
  readonly startEquity: number;
  readonly endEquity: number;
}

export interface MetricsReport {
  readonly performance: PerformanceMetrics;
  readonly risk: RiskMetrics;
  readonly trades: TradeMetrics;
  readonly costs: CostMetrics;
  readonly monthlyReturns: readonly MonthlyReturn[];
  /** Non-fatal notes for the UI, e.g. why a metric is null. */
  readonly notes: readonly string[];
  readonly accountCurrency: string;
}
