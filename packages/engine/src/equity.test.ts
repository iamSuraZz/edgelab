import { describe, expect, it } from 'vitest';
import { accountMoney, lots, price } from '@edgelab/shared';
import { getSeedSymbol, type Bar, type CostedTrade } from '@edgelab/shared';

import {
  buyAndHoldReturnPct,
  crossCheckZeroCost,
  reconstructEquity,
  sampleBy,
  summariseDrawdown,
  utcDayStart,
  utcMonthStart,
} from './equity';
import type { EngineTrade } from './pine-engine';

const H1 = 3_600_000;
const eurusd = getSeedSymbol('EURUSD');

/**
 * A six-bar table with hand-computable marks. EURUSD: contractSize 100,000, pointValue 1, so
 * one whole price unit on 1.00 lot is $100,000 and 0.0010 is $100.
 *
 *  #  time (UTC)        open     high     low      close
 *  0  2024-01-02 10:00  1.1000   1.1020   1.0990   1.1010
 *  1  2024-01-02 11:00  1.1010   1.1050   1.1000   1.1040
 *  2  2024-01-02 12:00  1.1040   1.1060   1.0980   1.1000   <- deep low
 *  3  2024-01-02 13:00  1.1000   1.1030   1.0995   1.1020
 *  4  2024-01-03 10:00  1.1020   1.1080   1.1010   1.1070   <- next UTC day
 *  5  2024-02-01 10:00  1.1070   1.1090   1.1050   1.1060   <- next UTC month
 */
const T0 = Date.UTC(2024, 0, 2, 10);

const BARS: Bar[] = [
  { time: T0, open: 1.1, high: 1.102, low: 1.099, close: 1.101, volume: 1 },
  { time: T0 + H1, open: 1.101, high: 1.105, low: 1.1, close: 1.104, volume: 1 },
  { time: T0 + 2 * H1, open: 1.104, high: 1.106, low: 1.098, close: 1.1, volume: 1 },
  { time: T0 + 3 * H1, open: 1.1, high: 1.103, low: 1.0995, close: 1.102, volume: 1 },
  { time: Date.UTC(2024, 0, 3, 10), open: 1.102, high: 1.108, low: 1.101, close: 1.107, volume: 1 },
  { time: Date.UTC(2024, 1, 1, 10), open: 1.107, high: 1.109, low: 1.105, close: 1.106, volume: 1 },
];

const CAPITAL = 10_000;

/**
 * Overrides as PLAIN numbers, branded by the factory.
 *
 * `CostedTrade`'s money, price and size fields are branded so the compiler can catch the unit
 * mix-ups that have shipped four times. A fixture should still read `netPnl: 200` rather than
 * `netPnl: accountMoney(200)`, so the branding happens here, once.
 */
type TradeOverrides = Omit<
  Partial<CostedTrade>,
  'qty' | 'entryPrice' | 'exitPrice' | 'grossPnl' | 'netPnl' | 'mae' | 'mfe'
> & {
  qty?: number;
  entryPrice?: number;
  exitPrice?: number;
  grossPnl?: number;
  netPnl?: number;
  mae?: number | null;
  mfe?: number | null;
};

function costed(over: TradeOverrides = {}): CostedTrade {
  const { qty, entryPrice, exitPrice, grossPnl, netPnl, mae, mfe, ...rest } = over;

  return {
    seq: 1,
    side: 'long',
    qty: lots(qty ?? 1),
    entryTime: BARS[0]!.time,
    exitTime: BARS[2]!.time,
    entryBar: 0,
    exitBar: 2,
    entryPrice: price(entryPrice ?? 1.1),
    exitPrice: price(exitPrice ?? 1.104),
    grossPnl: accountMoney(grossPnl ?? 400),
    commission: accountMoney(0),
    slippageCost: accountMoney(0),
    slippageRefund: accountMoney(0),
    spreadCost: accountMoney(0),
    financingCost: accountMoney(0),
    netPnl: accountMoney(netPnl ?? 400),
    mae: mae === undefined || mae === null ? null : accountMoney(mae),
    mfe: mfe === undefined || mfe === null ? null : accountMoney(mfe),
    barsHeld: 2,
    exitReason: null,
    ...rest,
  };
}

describe('reconstructEquity — close-to-close marking', () => {
  it('marks an open long at each bar’s close', () => {
    const { close } = reconstructEquity({
      bars: BARS,
      trades: [costed()],
      initialCapital: CAPITAL,
      symbol: eurusd,
    });

    // Entry at 1.1000 on bar 0. Marked at each close until it exits on bar 2.
    // bar 0: (1.1010 - 1.1000) x 100,000 = +100
    expect(close[0]!.equity).toBeCloseTo(10_100, 6);
    // bar 1: (1.1040 - 1.1000) x 100,000 = +400
    expect(close[1]!.equity).toBeCloseTo(10_400, 6);
    // bar 2: realized +400, nothing open
    expect(close[2]!.equity).toBeCloseTo(10_400, 6);
    // flat thereafter
    expect(close[3]!.equity).toBeCloseTo(10_400, 6);
    expect(close[5]!.equity).toBeCloseTo(10_400, 6);
  });

  it('gives one point per bar, aligned to bar open times', () => {
    const { close, intrabar } = reconstructEquity({
      bars: BARS,
      trades: [costed()],
      initialCapital: CAPITAL,
      symbol: eurusd,
    });
    expect(close).toHaveLength(BARS.length);
    expect(intrabar).toHaveLength(BARS.length);
    expect(close.map((p) => p.time)).toEqual(BARS.map((b) => b.time));
  });

  it('does not double-count a trade on its exit bar', () => {
    // The exit bar realizes the P&L; marking the position open as well would count it twice.
    const { close } = reconstructEquity({
      bars: BARS,
      trades: [costed()],
      initialCapital: CAPITAL,
      symbol: eurusd,
    });
    expect(close[2]!.equity).toBeCloseTo(10_400, 6);
    expect(close[2]!.equity).not.toBeCloseTo(10_400 + 400, 6);
  });

  it('starts from the initial capital when nothing has happened yet', () => {
    const { close } = reconstructEquity({
      bars: BARS,
      trades: [
        costed({ entryBar: 3, exitBar: 4, entryTime: BARS[3]!.time, exitTime: BARS[4]!.time }),
      ],
      initialCapital: CAPITAL,
      symbol: eurusd,
    });
    expect(close[0]!.equity).toBe(CAPITAL);
    expect(close[1]!.equity).toBe(CAPITAL);
  });

  it('rejects a non-positive initial capital rather than producing nonsense', () => {
    expect(() =>
      reconstructEquity({ bars: BARS, trades: [], initialCapital: 0, symbol: eurusd }),
    ).toThrow(RangeError);
  });

  it('handles an empty bar list', () => {
    const result = reconstructEquity({
      bars: [],
      trades: [],
      initialCapital: CAPITAL,
      symbol: eurusd,
    });
    expect(result.close).toEqual([]);
    expect(result.finalEquity).toBe(CAPITAL);
  });
});

describe('reconstructEquity — intrabar-worst marking', () => {
  it('marks an open LONG at the bar LOW', () => {
    const { intrabar } = reconstructEquity({
      bars: BARS,
      trades: [costed()],
      initialCapital: CAPITAL,
      symbol: eurusd,
    });
    // bar 0 low 1.0990: (1.0990 - 1.1000) x 100,000 = -100
    expect(intrabar[0]!.equity).toBeCloseTo(9_900, 6);
    // bar 1 low 1.1000: flat
    expect(intrabar[1]!.equity).toBeCloseTo(10_000, 6);
  });

  it('marks an open SHORT at the bar HIGH', () => {
    const short = costed({ side: 'short', entryPrice: 1.1, exitPrice: 1.098, netPnl: 200 });
    const { intrabar } = reconstructEquity({
      bars: BARS,
      trades: [short],
      initialCapital: CAPITAL,
      symbol: eurusd,
    });
    // bar 0 high 1.1020, short from 1.1000: -(1.1020 - 1.1000) x 100,000 = -200
    expect(intrabar[0]!.equity).toBeCloseTo(9_800, 6);
  });

  it('is the headline drawdown because it is always at least as deep as close-to-close', () => {
    const { close, intrabar } = reconstructEquity({
      bars: BARS,
      trades: [costed()],
      initialCapital: CAPITAL,
      symbol: eurusd,
    });
    const closeDd = summariseDrawdown(close);
    const intrabarDd = summariseDrawdown(intrabar);
    expect(intrabarDd.maxDrawdown).toBeGreaterThanOrEqual(closeDd.maxDrawdown);
    // Concretely: the close curve never dips below 10,000 here, the intrabar curve hits 9,900.
    expect(closeDd.maxDrawdown).toBeCloseTo(0, 6);
    expect(intrabarDd.maxDrawdown).toBeCloseTo(100, 6);
  });

  it('shares the realized base with the close curve, differing only in the mark', () => {
    const { close, intrabar } = reconstructEquity({
      bars: BARS,
      trades: [costed()],
      initialCapital: CAPITAL,
      symbol: eurusd,
    });
    // Once flat, the two curves must coincide exactly.
    expect(intrabar[3]!.equity).toBeCloseTo(close[3]!.equity, 9);
    expect(intrabar[5]!.equity).toBeCloseTo(close[5]!.equity, 9);
  });
});

describe('reconstructEquity — open positions and exposure', () => {
  const openLeg: EngineTrade = {
    id: 't2',
    engineId: 'trade_1',
    entryId: 'S',
    side: 'short',
    qty: 100_000, // engine units
    entryTime: BARS[4]!.time,
    entryBar: 4,
    entryPrice: 1.102,
    exitTime: null,
    exitBar: null,
    exitPrice: null,
    exitId: null,
    exitComment: null,
    commission: 0,
    netPnl: null,
    maxRunup: null,
    maxDrawdown: null,
    status: 'open',
  };

  it('marks a still-open position to the end of the run', () => {
    const { close, openPnl } = reconstructEquity({
      bars: BARS,
      trades: [],
      openTrades: [openLeg],
      initialCapital: CAPITAL,
      symbol: eurusd,
    });
    // Short from 1.1020; bar 5 closes 1.1060, so -(1.1060 - 1.1020) x 100,000 = -400.
    expect(openPnl).toBeCloseTo(-400, 6);
    expect(close[5]!.equity).toBeCloseTo(9_600, 6);
  });

  it('counts bars in market, including the entry and excluding the exit bar', () => {
    const { barsInMarket } = reconstructEquity({
      bars: BARS,
      trades: [costed()], // entry bar 0, exit bar 2
      initialCapital: CAPITAL,
      symbol: eurusd,
    });
    // Exposed on bars 0 and 1; bar 2 realized it.
    expect(barsInMarket).toBe(2);
  });

  it('keeps realized and unrealised separate', () => {
    const { realizedPnl, openPnl, finalEquity } = reconstructEquity({
      bars: BARS,
      trades: [costed()],
      openTrades: [openLeg],
      initialCapital: CAPITAL,
      symbol: eurusd,
    });
    expect(realizedPnl).toBeCloseTo(400, 6);
    expect(openPnl).toBeCloseTo(-400, 6);
    expect(finalEquity).toBeCloseTo(CAPITAL + 400 - 400, 6);
  });

  it('adds several concurrent legs together', () => {
    const { close } = reconstructEquity({
      bars: BARS,
      trades: [
        costed({ entryBar: 0, exitBar: 3, exitTime: BARS[3]!.time, netPnl: 200 }),
        costed({ seq: 2, entryBar: 0, exitBar: 3, exitTime: BARS[3]!.time, netPnl: 200 }),
      ],
      initialCapital: CAPITAL,
      symbol: eurusd,
    });
    // Two identical 1-lot longs: bar 0 marks +100 each.
    expect(close[0]!.equity).toBeCloseTo(10_200, 6);
  });
});

describe('reconstructEquity — currency conversion (D6)', () => {
  it('scales every mark by quoteToAccount', () => {
    const at1 = reconstructEquity({
      bars: BARS,
      trades: [costed()],
      initialCapital: CAPITAL,
      symbol: eurusd,
    });
    const at2 = reconstructEquity({
      bars: BARS,
      trades: [costed()],
      initialCapital: CAPITAL,
      symbol: eurusd,
      quoteToAccount: () => 2,
    });
    // Only the OPEN mark is converted here; realized P&L arrives already converted by the
    // cost overlay, which is where a trade's currency is settled.
    expect(at2.close[0]!.equity - CAPITAL).toBeCloseTo((at1.close[0]!.equity - CAPITAL) * 2, 6);
  });

  it('can use a time-varying rate', () => {
    const { close } = reconstructEquity({
      bars: BARS,
      trades: [costed()],
      initialCapital: CAPITAL,
      symbol: eurusd,
      quoteToAccount: (ts) => (ts === BARS[0]!.time ? 1 : 3),
    });
    expect(close[0]!.equity).toBeCloseTo(10_100, 6);
    expect(close[1]!.equity).toBeCloseTo(10_000 + 400 * 3, 6);
  });
});

describe('sampling', () => {
  it('takes the LAST equity of each UTC day', () => {
    const { daily } = reconstructEquity({
      bars: BARS,
      trades: [costed()],
      initialCapital: CAPITAL,
      symbol: eurusd,
    });
    // Bars 0-3 are 2024-01-02, bar 4 is 01-03, bar 5 is 02-01.
    expect(daily.map((s) => new Date(s.time).toISOString().slice(0, 10))).toEqual([
      '2024-01-02',
      '2024-01-03',
      '2024-02-01',
    ]);
    // 2024-01-02's sample is bar 3's equity, the last of that day.
    expect(daily[0]!.equity).toBeCloseTo(10_400, 6);
  });

  it('takes the LAST equity of each UTC month', () => {
    const { monthly } = reconstructEquity({
      bars: BARS,
      trades: [costed()],
      initialCapital: CAPITAL,
      symbol: eurusd,
    });
    expect(monthly.map((s) => new Date(s.time).toISOString().slice(0, 10))).toEqual([
      '2024-01-01',
      '2024-02-01',
    ]);
  });

  it('skips a bucket with no bars rather than carrying equity forward', () => {
    // A weekend is not a flat day, it is a day that did not happen. Inventing a zero return
    // for it would deflate every volatility figure computed from the series.
    const { daily } = reconstructEquity({
      bars: BARS,
      trades: [],
      initialCapital: CAPITAL,
      symbol: eurusd,
    });
    // 2024-01-04 through 2024-01-31 have no bars and produce no samples.
    expect(daily).toHaveLength(3);
  });

  it('buckets by the boundary functions it is given', () => {
    const curve = [
      { time: Date.UTC(2024, 0, 2, 23), equity: 1, peak: 1, drawdown: 0, drawdownPct: 0 },
      { time: Date.UTC(2024, 0, 3, 0), equity: 2, peak: 2, drawdown: 0, drawdownPct: 0 },
    ];
    expect(sampleBy(curve, utcDayStart).map((s) => s.equity)).toEqual([1, 2]);
    expect(sampleBy(curve, utcMonthStart).map((s) => s.equity)).toEqual([2]);
    expect(utcDayStart(Date.UTC(2024, 0, 2, 23, 59))).toBe(Date.UTC(2024, 0, 2));
    expect(utcMonthStart(Date.UTC(2024, 0, 31, 23))).toBe(Date.UTC(2024, 0, 1));
  });

  it('is empty for an empty curve', () => {
    expect(sampleBy([], utcDayStart)).toEqual([]);
  });
});

describe('buyAndHoldReturnPct', () => {
  it('is first open to last close, as a percent', () => {
    // 1.1000 -> 1.1060 is +0.545454…%
    expect(buyAndHoldReturnPct(BARS)).toBeCloseTo(((1.106 - 1.1) / 1.1) * 100, 9);
  });

  it('is null with no bars', () => {
    expect(buyAndHoldReturnPct([])).toBeNull();
  });

  it('is null rather than Infinity when the first open is zero', () => {
    expect(buyAndHoldReturnPct([{ ...BARS[0]!, open: 0 }])).toBeNull();
  });

  it('is negative in a falling market', () => {
    expect(buyAndHoldReturnPct([BARS[5]!, BARS[0]!])).toBeLessThan(0);
  });
});

describe('crossCheckZeroCost', () => {
  it('passes when the two figures agree exactly', () => {
    const check = crossCheckZeroCost(1234.56, 1234.56);
    expect(check.ok).toBe(true);
    expect(check.absoluteDelta).toBe(0);
    expect(check.message).toContain('OK');
  });

  it('passes inside 0.01%', () => {
    // 0.005% off.
    expect(crossCheckZeroCost(10_000, 10_000.5).ok).toBe(true);
  });

  it('FAILS outside 0.01% and says what is wrong', () => {
    const check = crossCheckZeroCost(10_000, 10_050);
    expect(check.ok).toBe(false);
    expect(check.deltaPct).toBeCloseTo(0.5, 6);
    expect(check.message).toContain('CROSS-CHECK FAILED');
    expect(check.message).toContain('overlay');
  });

  it('passes on a tiny absolute difference even when the relative one is huge', () => {
    // A strategy that netted almost nothing must not fail on float noise.
    const check = crossCheckZeroCost(1e-12, 2e-12);
    expect(check.ok).toBe(true);
  });

  it('treats a null engine figure as zero', () => {
    expect(crossCheckZeroCost(null, 0).ok).toBe(true);
    expect(crossCheckZeroCost(null, 5).ok).toBe(false);
    expect(crossCheckZeroCost(null, 5).deltaPct).toBeNull();
  });

  it('honours a custom tolerance', () => {
    expect(crossCheckZeroCost(10_000, 10_050, { tolerancePct: 1 }).ok).toBe(true);
  });
});

describe('summariseDrawdown', () => {
  it('finds the deepest decline and how long it lasted', () => {
    const curve = [
      { time: 0, equity: 100, peak: 100, drawdown: 0, drawdownPct: 0 },
      { time: 1_000, equity: 120, peak: 120, drawdown: 0, drawdownPct: 0 },
      { time: 2_000, equity: 90, peak: 120, drawdown: 30, drawdownPct: 25 },
      { time: 3_000, equity: 110, peak: 120, drawdown: 10, drawdownPct: 25 / 3 },
      { time: 4_000, equity: 130, peak: 130, drawdown: 0, drawdownPct: 0 },
    ];
    const summary = summariseDrawdown(curve);
    expect(summary.maxDrawdown).toBe(30);
    expect(summary.maxDrawdownPct).toBe(25);
    expect(summary.maxDrawdownDurationMs).toBe(2_000);
    expect(summary.endedInDrawdown).toBe(false);
  });

  it('reports an unrecovered drawdown at the end', () => {
    const curve = [
      { time: 0, equity: 100, peak: 100, drawdown: 0, drawdownPct: 0 },
      { time: 1_000, equity: 80, peak: 100, drawdown: 20, drawdownPct: 20 },
    ];
    expect(summariseDrawdown(curve).endedInDrawdown).toBe(true);
  });

  it('is zero for an empty or flat curve', () => {
    expect(summariseDrawdown([]).maxDrawdown).toBe(0);
    expect(
      summariseDrawdown([{ time: 0, equity: 100, peak: 100, drawdown: 0, drawdownPct: 0 }])
        .maxDrawdown,
    ).toBe(0);
  });
});
