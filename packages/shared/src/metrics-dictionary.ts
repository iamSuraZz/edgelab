/**
 * The metric dictionary. Every number EdgeLab reports is declared here once so the
 * API, the report UI and the docs all describe it identically.
 *
 * `formula` is human-readable prose, not executable code — the implementations live
 * in @edgelab/metrics and are unit-tested against it.
 */

export type MetricUnit =
  | 'currency'
  | 'percent'
  | 'ratio'
  | 'count'
  | 'bars'
  | 'days'
  | 'factor'
  /** Price distance in pips, used by the break-even cost metric. */
  | 'pips';

/** Grouping used to lay out the report. */
export type MetricGroup = 'performance' | 'risk' | 'trades' | 'streaks' | 'costs';

export interface MetricDef {
  readonly key: string;
  readonly label: string;
  readonly unit: MetricUnit;
  readonly group: MetricGroup;
  readonly formula: string;
  /**
   * Direction of "better". `null` means neutral/descriptive, where ranking makes
   * no sense (e.g. number of trades).
   */
  readonly higherIsBetter: boolean | null;
}

export const METRICS: readonly MetricDef[] = [
  /* ---- performance ---- */
  {
    key: 'netProfit',
    label: 'Net Profit',
    unit: 'currency',
    group: 'performance',
    formula: 'grossProfit - grossLoss - totalCosts',
    higherIsBetter: true,
  },
  {
    key: 'netProfitPct',
    label: 'Net Profit %',
    unit: 'percent',
    group: 'performance',
    formula: 'netProfit / initialCapital * 100',
    higherIsBetter: true,
  },
  {
    key: 'grossProfit',
    label: 'Gross Profit',
    unit: 'currency',
    group: 'performance',
    formula: 'sum of P&L of all winning trades',
    higherIsBetter: true,
  },
  {
    key: 'grossLoss',
    label: 'Gross Loss',
    unit: 'currency',
    group: 'performance',
    formula: 'absolute sum of P&L of all losing trades',
    higherIsBetter: false,
  },
  {
    key: 'profitFactor',
    label: 'Profit Factor',
    unit: 'factor',
    group: 'performance',
    formula: 'grossProfit / grossLoss',
    higherIsBetter: true,
  },
  {
    key: 'cagr',
    label: 'CAGR',
    unit: 'percent',
    group: 'performance',
    formula: '((finalEquity / initialCapital) ^ (365 / daysInTest) - 1) * 100',
    higherIsBetter: true,
  },
  {
    key: 'expectancy',
    label: 'Expectancy',
    unit: 'currency',
    group: 'performance',
    formula: 'winRate * avgWin - lossRate * avgLoss',
    higherIsBetter: true,
  },

  /* ---- risk ---- */
  {
    key: 'maxDrawdown',
    label: 'Max Drawdown',
    unit: 'currency',
    group: 'risk',
    formula: 'largest peak-to-trough decline of the equity curve',
    higherIsBetter: false,
  },
  {
    key: 'maxDrawdownPct',
    label: 'Max Drawdown %',
    unit: 'percent',
    group: 'risk',
    formula: 'max((peakEquity - troughEquity) / peakEquity) * 100',
    higherIsBetter: false,
  },
  {
    key: 'sharpe',
    label: 'Sharpe Ratio',
    unit: 'ratio',
    group: 'risk',
    formula: 'mean(excessReturns) / stdev(excessReturns) * sqrt(periodsPerYear)',
    higherIsBetter: true,
  },
  {
    key: 'sortino',
    label: 'Sortino Ratio',
    unit: 'ratio',
    group: 'risk',
    formula: 'mean(excessReturns) / stdev(negativeReturns) * sqrt(periodsPerYear)',
    higherIsBetter: true,
  },
  {
    key: 'calmar',
    label: 'Calmar Ratio',
    unit: 'ratio',
    group: 'risk',
    formula: 'cagr / maxDrawdownPct',
    higherIsBetter: true,
  },
  {
    key: 'recoveryFactor',
    label: 'Recovery Factor',
    unit: 'factor',
    group: 'risk',
    formula: 'netProfit / maxDrawdown',
    higherIsBetter: true,
  },
  {
    key: 'ulcerIndex',
    label: 'Ulcer Index',
    unit: 'percent',
    group: 'risk',
    formula: 'sqrt(mean(drawdownPct^2)) over the equity curve',
    higherIsBetter: false,
  },
  {
    key: 'timeInMarketPct',
    label: 'Time in Market',
    unit: 'percent',
    group: 'risk',
    formula: 'barsWithOpenPosition / totalBars * 100',
    higherIsBetter: null,
  },

  /* ---- trades ---- */
  {
    key: 'totalTrades',
    label: 'Total Trades',
    unit: 'count',
    group: 'trades',
    formula: 'count of closed trades',
    higherIsBetter: null,
  },
  {
    key: 'winRate',
    label: 'Win Rate',
    unit: 'percent',
    group: 'trades',
    formula: 'winningTrades / totalTrades * 100',
    higherIsBetter: true,
  },
  {
    key: 'avgTrade',
    label: 'Avg Trade',
    unit: 'currency',
    group: 'trades',
    formula: 'netProfit / totalTrades',
    higherIsBetter: true,
  },
  {
    key: 'avgWin',
    label: 'Avg Winning Trade',
    unit: 'currency',
    group: 'trades',
    formula: 'grossProfit / winningTrades',
    higherIsBetter: true,
  },
  {
    key: 'avgLoss',
    label: 'Avg Losing Trade',
    unit: 'currency',
    group: 'trades',
    formula: 'grossLoss / losingTrades',
    higherIsBetter: false,
  },
  {
    key: 'payoffRatio',
    label: 'Payoff Ratio',
    unit: 'ratio',
    group: 'trades',
    formula: 'avgWin / avgLoss',
    higherIsBetter: true,
  },
  {
    key: 'largestWin',
    label: 'Largest Win',
    unit: 'currency',
    group: 'trades',
    formula: 'max P&L across trades',
    higherIsBetter: true,
  },
  {
    key: 'largestLoss',
    label: 'Largest Loss',
    unit: 'currency',
    group: 'trades',
    formula: 'min P&L across trades',
    higherIsBetter: false,
  },
  {
    key: 'avgBarsInTrade',
    label: 'Avg Bars in Trade',
    unit: 'bars',
    group: 'trades',
    formula: 'sum(barsHeld) / totalTrades',
    higherIsBetter: null,
  },

  /* ---- streaks ---- */
  {
    key: 'maxConsecWins',
    label: 'Max Consecutive Wins',
    unit: 'count',
    group: 'streaks',
    formula: 'longest run of consecutive winning trades',
    higherIsBetter: true,
  },
  {
    key: 'maxConsecLosses',
    label: 'Max Consecutive Losses',
    unit: 'count',
    group: 'streaks',
    formula: 'longest run of consecutive losing trades',
    higherIsBetter: false,
  },
  {
    key: 'maxDrawdownDuration',
    label: 'Max Drawdown Duration',
    unit: 'days',
    group: 'streaks',
    formula: 'longest span between an equity peak and its recovery',
    higherIsBetter: false,
  },

  /* ---- costs ---- */
  {
    key: 'commissionPaid',
    label: 'Commission Paid',
    unit: 'currency',
    group: 'costs',
    formula: 'sum of per-trade commission',
    higherIsBetter: false,
  },
  {
    key: 'slippageCost',
    label: 'Slippage Cost',
    unit: 'currency',
    group: 'costs',
    formula: 'sum of ticks slipped * mintick * qty, per market/stop fill',
    higherIsBetter: false,
  },
  {
    key: 'costDragPct',
    label: 'Cost Drag',
    unit: 'percent',
    group: 'costs',
    formula: 'totalCosts / (netProfit + totalCosts) * 100',
    higherIsBetter: false,
  },
  {
    key: 'breakEvenPerSidePips',
    label: 'Break-even Extra Cost / Side',
    unit: 'pips',
    group: 'costs',
    formula: 'netProfit / (2 * totalUnits * pointValue), expressed in pips',
    higherIsBetter: true,
  },

  /* ---- added in the metrics phase ---- */
  {
    key: 'totalReturnPct',
    label: 'Total Return',
    unit: 'percent',
    group: 'performance',
    formula: 'netProfit / initialCapital * 100',
    higherIsBetter: true,
  },
  {
    key: 'openPnl',
    label: 'Open P&L',
    unit: 'currency',
    group: 'performance',
    formula: 'unrealised P&L of positions still open at the end of the test',
    higherIsBetter: true,
  },
  {
    key: 'vsBuyAndHoldPct',
    label: 'vs Buy & Hold',
    unit: 'percent',
    group: 'performance',
    formula: 'totalReturnPct - buyAndHoldReturnPct',
    higherIsBetter: true,
  },
  {
    key: 'maxDrawdownIntrabarPct',
    label: 'Max Drawdown (intrabar)',
    unit: 'percent',
    group: 'risk',
    formula:
      'largest peak-to-trough decline on the intrabar-worst curve (longs marked at the bar low, shorts at the high), as % of the peak',
    higherIsBetter: false,
  },
  {
    key: 'drawdownDurationDays',
    label: 'Max Drawdown Duration',
    unit: 'days',
    group: 'streaks',
    formula:
      'longest span from an equity peak until equity first regains it; measured to the end and labelled unrecovered if never regained',
    higherIsBetter: false,
  },
  {
    key: 'percentOfTimeUnderwater',
    label: 'Time Underwater',
    unit: 'percent',
    group: 'risk',
    formula: 'bars below the running equity peak / total bars * 100',
    higherIsBetter: false,
  },
  {
    key: 'sharpeTradingView',
    label: 'Sharpe (TradingView style)',
    unit: 'ratio',
    group: 'risk',
    formula:
      'monthly returns, risk-free 2%/12, POPULATION stdev, not annualized — for comparison against TradingView only',
    higherIsBetter: true,
  },
  {
    key: 'sortinoTradingView',
    label: 'Sortino (TradingView style)',
    unit: 'ratio',
    group: 'risk',
    formula: 'as sharpeTradingView, but divided by downside deviation',
    higherIsBetter: true,
  },
  {
    key: 'ulcerPerformanceIndex',
    label: 'Ulcer Performance Index',
    unit: 'ratio',
    group: 'risk',
    formula: '(CAGR% - riskFree%) / Ulcer Index',
    higherIsBetter: true,
  },
  {
    key: 'winLossRatio',
    label: 'Win/Loss Ratio',
    unit: 'ratio',
    group: 'trades',
    formula: 'avgWin / |avgLoss| (payoff ratio)',
    higherIsBetter: true,
  },
  {
    key: 'currentStreak',
    label: 'Current Streak',
    unit: 'count',
    group: 'streaks',
    formula: 'consecutive wins (positive) or losses (negative) at the end of the run',
    higherIsBetter: null,
  },
  {
    key: 'avgMae',
    label: 'Avg MAE',
    unit: 'currency',
    group: 'trades',
    formula: 'mean maximum adverse excursion while a trade was open',
    higherIsBetter: true,
  },
  {
    key: 'avgMfe',
    label: 'Avg MFE',
    unit: 'currency',
    group: 'trades',
    formula: 'mean maximum favourable excursion while a trade was open',
    higherIsBetter: true,
  },
  {
    key: 'exposurePct',
    label: 'Exposure',
    unit: 'percent',
    group: 'risk',
    formula: 'barsWithOpenPosition / totalBars * 100',
    higherIsBetter: null,
  },
  {
    key: 'tradesPerMonth',
    label: 'Trades per Month',
    unit: 'count',
    group: 'trades',
    formula: 'closedTrades / (windowDays / 30.44)',
    higherIsBetter: null,
  },
  {
    key: 'buyAndHoldReturnPct',
    label: 'Buy & Hold Return',
    unit: 'percent',
    group: 'performance',
    formula: 'return from holding the instrument over the same window',
    higherIsBetter: null,
  },
  {
    key: 'spreadCost',
    label: 'Spread Cost',
    unit: 'currency',
    group: 'costs',
    formula: 'sum of spread charged on entry and exit',
    higherIsBetter: false,
  },
  {
    key: 'swapCost',
    label: 'Swap / Financing',
    unit: 'currency',
    group: 'costs',
    formula: 'sum of overnight financing across held positions',
    higherIsBetter: false,
  },
];

export type MetricKey = string;

const BY_KEY: ReadonlyMap<string, MetricDef> = new Map(METRICS.map((m) => [m.key, m]));

export function getMetric(key: string): MetricDef {
  const def = BY_KEY.get(key);
  if (def === undefined) {
    throw new Error(`Unknown metric: ${key}`);
  }
  return def;
}

export function hasMetric(key: string): boolean {
  return BY_KEY.has(key);
}

export function metricsInGroup(group: MetricGroup): readonly MetricDef[] {
  return METRICS.filter((m) => m.group === group);
}
