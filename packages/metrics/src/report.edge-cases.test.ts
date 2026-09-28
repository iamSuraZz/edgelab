import { describe, expect, it } from 'vitest';
import { accountMoney, lots, price } from '@edgelab/shared';
import type { CostedTrade, EquityPoint, EquitySample } from '@edgelab/shared';
import { analyseDrawdown, analyseDrawdownDuration, ulcerIndex } from './drawdown';
import { annualizedRatios, cagrPct, populationStdev, tradingViewRatios } from './risk-ratios';
import { buildMetricsReport } from './report';
import type { MetricsInput, MetricsInstrument } from './types';

/** The edge cases the spec names explicitly. */

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

const INSTRUMENT: MetricsInstrument = {
  symbol: 'EURUSD',
  accountCurrency: 'USD',
  quoteCurrency: 'USD',
  mintick: 0.00001,
  pipSize: 0.0001,
  pointValue: 1,
  contractSize: 100_000,
};

function point(time: number, equity: number, peak: number): EquityPoint {
  const drawdown = Math.max(0, peak - equity);
  return { time, equity, peak, drawdown, drawdownPct: peak > 0 ? (drawdown / peak) * 100 : 0 };
}

/** Build a curve from a list of equities, deriving the running peak. */
function curve(equities: readonly number[], startMs = T0, stepMs = DAY): EquityPoint[] {
  let peak = Number.NEGATIVE_INFINITY;
  return equities.map((e, i) => {
    if (e > peak) peak = e;
    return point(startMs + i * stepMs, e, peak);
  });
}

function samples(equities: readonly number[], startMs = T0, stepMs = DAY): EquitySample[] {
  return equities.map((equity, i) => ({ time: startMs + i * stepMs, equity }));
}

function baseInput(over: Partial<MetricsInput> = {}): MetricsInput {
  return {
    trades: [],
    equityClose: [],
    equityIntrabar: [],
    daily: [],
    monthly: [],
    initialCapital: accountMoney(10_000),
    window: { fromMs: T0, toMs: T0 + 90 * DAY },
    instrument: INSTRUMENT,
    rfAnnual: 0,
    ...over,
  };
}

describe('edge case — zero trades', () => {
  const r = buildMetricsReport(baseInput());

  it('reports zero profit and null ratios rather than NaN', () => {
    expect(r.performance.netProfit).toBe(0);
    expect(r.performance.totalReturnPct).toBe(0);
    expect(r.performance.profitFactor).toBeNull();
    expect(r.performance.recoveryFactor).toBeNull();
    expect(r.trades.all.trades).toBe(0);
    expect(r.trades.all.winRatePct).toBeNull();
  });

  it('explains itself in the notes', () => {
    expect(r.notes.some((n) => n.includes('No closed trades'))).toBe(true);
  });

  it('has no costs and an undefined cost drag', () => {
    expect(r.costs.totalCosts).toBe(0);
    expect(r.costs.breakEvenPerSidePrice).toBeNull();
  });
});

describe('edge case — one day of data', () => {
  const r = buildMetricsReport(
    baseInput({
      window: { fromMs: T0, toMs: T0 + DAY },
      daily: samples([10_000, 10_100]),
      equityClose: curve([10_000, 10_100]),
      equityIntrabar: curve([10_000, 10_100]),
    }),
  );

  it('cannot annualize ratios from a single return', () => {
    expect(r.risk.dailyReturnCount).toBe(1);
    expect(r.risk.sharpe).toBeNull();
    expect(r.risk.sortino).toBeNull();
    expect(r.notes.some((n) => n.includes('Fewer than two daily equity samples'))).toBe(true);
  });

  it('still computes a CAGR, but flags it hard', () => {
    // One day of +1% annualizes to an absurd number; it must be labelled, not hidden.
    expect(r.performance.cagrPct).not.toBeNull();
    expect(r.performance.annualizedFromShortWindow).toBe(true);
  });
});

describe('edge case — flat equity', () => {
  const flat = new Array<number>(30).fill(10_000);
  const r = buildMetricsReport(
    baseInput({
      daily: samples(flat),
      equityClose: curve(flat),
      equityIntrabar: curve(flat),
      window: { fromMs: T0, toMs: T0 + 30 * DAY },
    }),
  );

  it('has zero drawdown and zero Ulcer', () => {
    expect(r.risk.intrabar.maxDrawdown).toBe(0);
    expect(r.risk.ulcerIndex).toBe(0);
  });

  it('leaves Sharpe undefined because the deviation is zero, not infinite', () => {
    expect(r.risk.sharpe).toBeNull();
    expect(r.notes.some((n) => n.includes('zero variance'))).toBe(true);
  });

  it('leaves the Ulcer Performance Index undefined rather than dividing by zero', () => {
    expect(r.risk.ulcerPerformanceIndex).toBeNull();
  });
});

describe('edge case — unrecovered drawdown', () => {
  // Rises to 11,000 then falls away and never returns.
  const equities = [10_000, 10_500, 11_000, 10_800, 10_400, 10_100, 9_900, 9_800];
  const r = buildMetricsReport(
    baseInput({
      daily: samples(equities),
      equityClose: curve(equities),
      equityIntrabar: curve(equities),
      window: { fromMs: T0, toMs: T0 + equities.length * DAY },
    }),
  );

  it('measures the final drawdown to the end and labels it unrecovered', () => {
    expect(r.risk.duration.unrecovered).toBe(true);
    expect(r.risk.duration.longestBars).toBeGreaterThan(0);
    expect(r.notes.some((n) => n.includes('never recovered'))).toBe(true);
  });

  it('reports the drawdown from the real peak', () => {
    expect(r.risk.intrabar.peakEquity).toBeCloseTo(11_000, 10);
    expect(r.risk.intrabar.troughEquity).toBeCloseTo(9_800, 10);
    expect(r.risk.intrabar.maxDrawdown).toBeCloseTo(1_200, 10);
    expect(r.risk.intrabar.maxDrawdownPct).toBeCloseTo((1200 / 11000) * 100, 8);
  });

  it('spends most of the window underwater', () => {
    expect(r.risk.duration.percentOfTimeUnderwater).toBeGreaterThan(50);
  });
});

describe('drawdown duration', () => {
  it('measures a recovered episode from peak to first regain', () => {
    // peak at index 1 (105), dips, regains 105 at index 4
    const d = analyseDrawdownDuration(curve([100, 105, 100, 102, 105, 110]));
    expect(d.unrecovered).toBe(false);
    expect(d.longestBars).toBe(3);
    expect(d.longestDays).toBeCloseTo(3, 8);
  });

  it('is zero for a monotonically rising curve', () => {
    const d = analyseDrawdownDuration(curve([100, 101, 102, 103]));
    expect(d.longestBars).toBe(0);
    expect(d.percentOfTimeUnderwater).toBe(0);
  });

  it('is safe on an empty or single-point curve', () => {
    expect(analyseDrawdownDuration([]).longestBars).toBe(0);
    expect(analyseDrawdownDuration([]).percentOfTimeUnderwater).toBeNull();
    expect(analyseDrawdownDuration(curve([100])).longestBars).toBe(0);
  });
});

describe('analyseDrawdown', () => {
  it('reports the percentage against the PEAK it fell from, not initial capital', () => {
    // Peak 200, trough 150 -> 25 % of the peak, even though it started at 100.
    const d = analyseDrawdown(curve([100, 200, 150, 260]));
    expect(d.maxDrawdown).toBeCloseTo(50, 10);
    expect(d.maxDrawdownPct).toBeCloseTo(25, 10);
    expect(d.peakEquity).toBeCloseTo(200, 10);
  });

  it('is empty-safe', () => {
    expect(analyseDrawdown([]).maxDrawdown).toBe(0);
    expect(analyseDrawdown([]).maxDrawdownPct).toBeNull();
  });
});

describe('ulcerIndex', () => {
  it('is zero for a rising series', () => {
    expect(ulcerIndex([100, 101, 102])).toBe(0);
  });

  it('is the RMS of percentage drawdowns', () => {
    // peaks 100,100,100 -> D = 0, -10, -20 -> sqrt((0+100+400)/3)
    expect(ulcerIndex([100, 90, 80])).toBeCloseTo(Math.sqrt(500 / 3), 8);
  });

  it('is null for an empty series', () => {
    expect(ulcerIndex([])).toBeNull();
  });
});

describe('cagrPct', () => {
  it('doubles over a year as 100 %', () => {
    expect(cagrPct(10_000, 20_000, 365.25)).toBeCloseTo(100, 6);
  });

  it('reports a wipeout as -100 %', () => {
    expect(cagrPct(10_000, 0, 365.25)).toBe(-100);
    expect(cagrPct(10_000, -100, 365.25)).toBe(-100);
  });

  it('is null for a degenerate window or capital', () => {
    expect(cagrPct(10_000, 11_000, 0)).toBeNull();
    expect(cagrPct(0, 100, 365)).toBeNull();
  });
});

describe('annualized vs TradingView ratios', () => {
  it('derives P from the data, so fx and crypto annualize differently', () => {
    // 260 daily returns over 365 days -> P ~ 260 (fx); 365 over 365 -> P ~ 365 (crypto).
    const fx = annualizedRatios(
      new Array<number>(261).fill(0).map((_, i) => 10_000 + i),
      365,
      0,
    );
    const crypto = annualizedRatios(
      new Array<number>(366).fill(0).map((_, i) => 10_000 + i),
      365,
      0,
    );
    expect(fx.periodsPerYear).toBeCloseTo(260.18, 1);
    expect(crypto.periodsPerYear).toBeCloseTo(365.25, 1);
  });

  it('uses POPULATION stdev for the TradingView variant', () => {
    const values = [0.01, 0.02, -0.01, 0.03];
    const pop = populationStdev(values);
    expect(pop).not.toBeNull();
    // Population stdev is strictly smaller than the sample one for n > 1.
    expect(pop!).toBeLessThan(0.02);
  });

  it('is null when there are too few monthly returns to judge', () => {
    expect(tradingViewRatios([10_000]).sharpe).toBeNull();
    expect(tradingViewRatios([10_000, 10_100]).sharpe).toBeNull();
  });
});

describe('cost drag edge cases', () => {
  function costedTrade(netPnl: number, costs: number): CostedTrade {
    return {
      seq: 1,
      side: 'long',
      qty: lots(1),
      entryTime: T0,
      exitTime: T0 + DAY,
      entryBar: 0,
      exitBar: 10,
      entryPrice: price(1.1),
      exitPrice: price(1.1),
      grossPnl: accountMoney(netPnl + costs),
      commission: accountMoney(costs),
      slippageCost: accountMoney(0),
      slippageRefund: accountMoney(0),
      spreadCost: accountMoney(0),
      financingCost: accountMoney(0),
      netPnl: accountMoney(netPnl),
      mae: null,
      mfe: null,
      barsHeld: null,
      exitReason: null,
    };
  }

  it('is undefined when costs exactly cancel the gross', () => {
    // net -50 with 50 of costs -> gross before costs is 0
    const r = buildMetricsReport(baseInput({ trades: [costedTrade(-50, 50)] }));
    expect(r.costs.grossBeforeCosts).toBe(0);
    expect(r.costs.costDragPct).toBeNull();
    expect(r.notes.some((n) => n.includes('cost drag is undefined'))).toBe(true);
  });

  it('can exceed 100 % when costs turn a winner into a loser', () => {
    // gross +40, costs 100 -> net -60; drag = 100/40 = 250 %
    const r = buildMetricsReport(baseInput({ trades: [costedTrade(-60, 100)] }));
    expect(r.costs.costDragPct).toBeCloseTo(250, 8);
  });
});
