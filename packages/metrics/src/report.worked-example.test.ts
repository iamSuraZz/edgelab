import { describe, expect, it } from 'vitest';
import { accountMoney, lots, price } from '@edgelab/shared';
import type { CostedTrade, EquityPoint, EquitySample } from '@edgelab/shared';
import { buildMetricsReport } from './report';
import { expectancyFromRates } from './trade-stats';
import type { MetricsInput, MetricsInstrument } from './types';

/**
 * THE WORKED EXAMPLE from docs/spec/05-metrics.md.
 *
 * Every number asserted here is hand-computed in that document. This test is what stops the
 * document and the implementation from drifting apart: change a formula and this fails.
 */

const DAY = 86_400_000;
const FROM = Date.UTC(2024, 0, 1); // 2024-01-01
const TO = Date.UTC(2024, 2, 31); // 2024-03-31 -> exactly 90 calendar days

const INSTRUMENT: MetricsInstrument = {
  symbol: 'EURUSD',
  accountCurrency: 'USD',
  quoteCurrency: 'USD',
  mintick: 0.00001,
  pipSize: 0.0001,
  pointValue: 1,
  contractSize: 100_000,
};

interface Spec {
  seq: number;
  side: 'long' | 'short';
  exit: number;
  gross: number;
  net: number;
}

/** The five trades from the worked example. Costs are 7 + 3 + 10 = 20 on every trade. */
const SPECS: readonly Spec[] = [
  { seq: 1, side: 'long', exit: Date.UTC(2024, 0, 10), gross: 520, net: 500 },
  { seq: 2, side: 'short', exit: Date.UTC(2024, 0, 25), gross: -180, net: -200 },
  { seq: 3, side: 'long', exit: Date.UTC(2024, 1, 12), gross: 320, net: 300 },
  { seq: 4, side: 'long', exit: Date.UTC(2024, 1, 28), gross: -280, net: -300 },
  { seq: 5, side: 'short', exit: Date.UTC(2024, 2, 15), gross: 420, net: 400 },
];

const TRADES: CostedTrade[] = SPECS.map((s, i) => ({
  seq: s.seq,
  side: s.side,
  qty: lots(1), // 1 lot each
  entryTime: s.exit - 2 * DAY,
  exitTime: s.exit,
  entryBar: i * 10,
  exitBar: i * 10 + 5,
  entryPrice: price(1.1),
  exitPrice: price(1.1 + s.net / 100_000),
  grossPnl: accountMoney(s.gross),
  commission: accountMoney(7),
  slippageCost: accountMoney(3),
  slippageRefund: accountMoney(0),
  spreadCost: accountMoney(10),
  financingCost: accountMoney(0),
  netPnl: accountMoney(s.net),
  mae: accountMoney(-50),
  mfe: accountMoney(80),
  barsHeld: 5,
  exitReason: 'signal',
}));

const INITIAL = 10_000;

/** Equity marked at each trade exit: 10000 -> 10500 -> 10300 -> 10600 -> 10300 -> 10700. */
function tradeMarkedEquity(): EquityPoint[] {
  const points: EquityPoint[] = [
    { time: FROM, equity: INITIAL, peak: INITIAL, drawdown: 0, drawdownPct: 0 },
  ];
  let equity = INITIAL;
  let peak = INITIAL;
  for (const t of TRADES) {
    equity += t.netPnl;
    if (equity > peak) peak = equity;
    const drawdown = Math.max(0, peak - equity);
    points.push({
      time: t.exitTime,
      equity,
      peak,
      drawdown,
      drawdownPct: peak > 0 ? (drawdown / peak) * 100 : 0,
    });
  }
  return points;
}

/** One daily sample per calendar day, stepping equity at each trade exit. */
function dailySamples(): EquitySample[] {
  const out: EquitySample[] = [];
  let equity = INITIAL;
  for (let t = FROM; t <= TO; t += DAY) {
    const closed = TRADES.find((x) => x.exitTime === t);
    if (closed !== undefined) equity += closed.netPnl;
    out.push({ time: t, equity });
  }
  return out;
}

function monthlySamples(): EquitySample[] {
  // End-of-month equity: Jan 10500-200=10300, Feb 10300+300-300=10300, Mar +400=10700
  return [
    { time: Date.UTC(2024, 0, 1), equity: 10_300 },
    { time: Date.UTC(2024, 1, 1), equity: 10_300 },
    { time: Date.UTC(2024, 2, 1), equity: 10_700 },
  ];
}

const INPUT: MetricsInput = {
  trades: TRADES,
  equityClose: tradeMarkedEquity(),
  equityIntrabar: tradeMarkedEquity(),
  daily: dailySamples(),
  monthly: monthlySamples(),
  initialCapital: accountMoney(INITIAL),
  window: { fromMs: FROM, toMs: TO },
  instrument: INSTRUMENT,
  rfAnnual: 0,
};

describe('worked example — performance', () => {
  const r = buildMetricsReport(INPUT);

  it('window is exactly 90 calendar days', () => {
    expect(r.performance.windowDays).toBe(90);
  });

  it('Net Profit = 700', () => {
    expect(r.performance.netProfit).toBeCloseTo(700, 10);
  });

  it('Total Return % = 7.00', () => {
    expect(r.performance.totalReturnPct).toBeCloseTo(7, 10);
  });

  it('Gross Profit = 1200 and Gross Loss = 500', () => {
    expect(r.performance.grossProfit).toBeCloseTo(1200, 10);
    expect(r.performance.grossLoss).toBeCloseTo(500, 10);
  });

  it('Profit Factor = 2.40', () => {
    expect(r.performance.profitFactor).toBeCloseTo(2.4, 10);
  });

  it('final equity = 10,700', () => {
    expect(r.performance.finalEquity).toBeCloseTo(10_700, 10);
  });

  it('CAGR = 31.60 % — (10700/10000)^(365.25/90) - 1', () => {
    // Hand check: ln(1.07) = 0.06765865, x 4.0583333 = 0.27458, exp = 1.31598
    expect(r.performance.cagrPct).toBeCloseTo(31.5979, 3);
  });

  it('flags the short window, because 90 days is not a year', () => {
    expect(r.performance.annualizedFromShortWindow).toBe(true);
    expect(r.notes.some((n) => n.includes('annualized from a short window'))).toBe(true);
  });

  it('Recovery Factor = 700 / 300 = 2.333', () => {
    expect(r.performance.recoveryFactor).toBeCloseTo(700 / 300, 10);
  });
});

describe('worked example — trade statistics (All)', () => {
  const { all } = buildMetricsReport(INPUT).trades;

  it('counts 5 closed: 3 wins, 2 losses, 0 breakeven', () => {
    expect(all.trades).toBe(5);
    expect(all.wins).toBe(3);
    expect(all.losses).toBe(2);
    expect(all.breakEven).toBe(0);
  });

  it('Win Rate = 60 %', () => {
    expect(all.winRatePct).toBeCloseTo(60, 10);
  });

  it('Avg Win = 400 and Avg Loss = -250', () => {
    expect(all.avgWin).toBeCloseTo(400, 10);
    expect(all.avgLoss).toBeCloseTo(-250, 10);
  });

  it('Expectancy = 140, and the WinRate*AvgWin - LossRate*|AvgLoss| identity holds', () => {
    expect(all.expectancy).toBeCloseTo(140, 10);
    // 0.6 * 400 - 0.4 * 250 = 240 - 100 = 140
    expect(expectancyFromRates(all)).toBeCloseTo(140, 10);
    expect(expectancyFromRates(all)).toBeCloseTo(all.expectancy ?? Number.NaN, 8);
  });

  it('Win/Loss (payoff) = 400 / 250 = 1.60', () => {
    expect(all.winLossRatio).toBeCloseTo(1.6, 10);
  });

  it('largest win 500, largest loss -300', () => {
    expect(all.largestWin).toBeCloseTo(500, 10);
    expect(all.largestLoss).toBeCloseTo(-300, 10);
  });

  it('sequence is W L W L W, so both max streaks are 1 and the current streak is +1', () => {
    expect(all.maxConsecutiveWins).toBe(1);
    expect(all.maxConsecutiveLosses).toBe(1);
    expect(all.currentStreak).toBe(1);
  });

  it('expectancy % is the same quantity against starting capital', () => {
    expect(all.expectancyPct).toBeCloseTo((140 / 10_000) * 100, 10);
  });
});

describe('worked example — by side', () => {
  const { long, short } = buildMetricsReport(INPUT).trades;

  it('Long: 3 trades, net 500, win rate 66.67 %', () => {
    expect(long.trades).toBe(3);
    expect(long.netProfit).toBeCloseTo(500, 10);
    expect(long.winRatePct).toBeCloseTo((2 / 3) * 100, 8);
  });

  it('Short: 2 trades, net 200, win rate 50 %', () => {
    expect(short.trades).toBe(2);
    expect(short.netProfit).toBeCloseTo(200, 10);
    expect(short.winRatePct).toBeCloseTo(50, 10);
  });

  it('the sides sum to the whole', () => {
    const { all } = buildMetricsReport(INPUT).trades;
    expect(long.netProfit + short.netProfit).toBeCloseTo(all.netProfit, 8);
    expect(long.trades + short.trades).toBe(all.trades);
  });
});

describe('worked example — drawdown', () => {
  const { risk } = buildMetricsReport(INPUT);

  it('Max DD = 300 from the 10,600 peak, i.e. 2.83 %', () => {
    expect(risk.intrabar.maxDrawdown).toBeCloseTo(300, 10);
    expect(risk.intrabar.peakEquity).toBeCloseTo(10_600, 10);
    expect(risk.intrabar.troughEquity).toBeCloseTo(10_300, 10);
    expect(risk.intrabar.maxDrawdownPct).toBeCloseTo((300 / 10_600) * 100, 8);
    expect(risk.intrabar.maxDrawdownPct).toBeCloseTo(2.8302, 3);
  });
});

describe('worked example — cost drag', () => {
  const { costs } = buildMetricsReport(INPUT);

  it('totals: commission 35, slippage 15, spread 50, funding 0', () => {
    expect(costs.commission.total).toBeCloseTo(35, 10);
    expect(costs.slippage.total).toBeCloseTo(15, 10);
    expect(costs.spread.total).toBeCloseTo(50, 10);
    expect(costs.financing.total).toBeCloseTo(0, 10);
    expect(costs.totalCosts).toBeCloseTo(100, 10);
  });

  it('per-trade averages are the totals over 5 trades', () => {
    expect(costs.commission.perTrade).toBeCloseTo(7, 10);
    expect(costs.spread.perTrade).toBeCloseTo(10, 10);
  });

  it('Cost Drag % = 100 / (700 + 100) = 12.50 %', () => {
    expect(costs.grossBeforeCosts).toBeCloseTo(800, 10);
    expect(costs.costDragPct).toBeCloseTo(12.5, 10);
  });

  it('break-even extra cost per side = 0.0007 price = 70 ticks = 7 pips', () => {
    // 5 lots x 100,000 = 500,000 units; 700 / (2 x 500,000 x 1) = 0.0007
    expect(costs.breakEvenPerSidePrice).toBeCloseTo(0.0007, 12);
    expect(costs.breakEvenPerSideTicks).toBeCloseTo(70, 6);
    expect(costs.breakEvenPerSidePips).toBeCloseTo(7, 8);
  });
});

describe('worked example — monthly returns', () => {
  const { monthlyReturns } = buildMetricsReport(INPUT);

  it('has one row per month, measured from initial capital in month one', () => {
    expect(monthlyReturns).toHaveLength(3);
    expect(monthlyReturns[0]).toMatchObject({ year: 2024, month: 1 });
    // Jan: 10,000 -> 10,300 = +3 %
    expect(monthlyReturns[0]?.returnPct).toBeCloseTo(3, 10);
    // Feb: 10,300 -> 10,300 = 0 %
    expect(monthlyReturns[1]?.returnPct).toBeCloseTo(0, 10);
    // Mar: 10,300 -> 10,700 = +3.883 %
    expect(monthlyReturns[2]?.returnPct).toBeCloseTo((400 / 10_300) * 100, 8);
  });
});

describe('worked example — no metric is ever NaN or Infinity', () => {
  it('every numeric leaf is finite or null', () => {
    const report = buildMetricsReport(INPUT);
    const bad: string[] = [];

    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) bad.push(`${path} = ${String(value)}`);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${path}[${String(i)}]`));
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
      }
    };

    walk(report, 'report');
    expect(bad).toEqual([]);
  });
});
