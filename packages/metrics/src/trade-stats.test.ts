import { describe, expect, it } from 'vitest';
import { accountMoney, lots, price } from '@edgelab/shared';
import type { CostedTrade } from '@edgelab/shared';
import {
  computeSideStats,
  currentStreak,
  emptySideStats,
  expectancyFromRates,
  filterSide,
  longestStreak,
} from './trade-stats';

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

function trade(seq: number, netPnl: number, side: 'long' | 'short' = 'long'): CostedTrade {
  return {
    seq,
    side,
    qty: lots(1),
    entryTime: T0 + seq * DAY,
    exitTime: T0 + seq * DAY + 3_600_000,
    entryBar: seq * 10,
    exitBar: seq * 10 + 4,
    entryPrice: price(1.1),
    exitPrice: price(1.1),
    grossPnl: accountMoney(netPnl + 20),
    commission: accountMoney(7),
    slippageCost: accountMoney(3),
    slippageRefund: accountMoney(0),
    spreadCost: accountMoney(10),
    financingCost: accountMoney(0),
    netPnl: accountMoney(netPnl),
    mae: accountMoney(-30),
    mfe: accountMoney(40),
    barsHeld: 4,
    exitReason: 'signal',
  };
}

const CAPITAL = 10_000;

describe('computeSideStats — empty', () => {
  it('is all zero/null for no trades', () => {
    const s = computeSideStats([], CAPITAL);
    expect(s).toEqual(emptySideStats());
    expect(s.trades).toBe(0);
    expect(s.winRatePct).toBeNull();
    expect(s.profitFactor).toBeNull();
    expect(s.expectancy).toBeNull();
    expect(s.largestWin).toBeNull();
    expect(s.maxConsecutiveWins).toBe(0);
    expect(s.currentStreak).toBe(0);
  });
});

describe('computeSideStats — classification', () => {
  it('treats > 0 as a win, < 0 as a loss and exactly 0 as breakeven', () => {
    const s = computeSideStats([trade(1, 100), trade(2, -50), trade(3, 0)], CAPITAL);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.breakEven).toBe(1);
    // Breakeven is in the denominator of the win rate but is not a win.
    expect(s.winRatePct).toBeCloseTo((1 / 3) * 100, 8);
  });

  it('reports gross loss as a positive magnitude and keeps avgLoss negative', () => {
    const s = computeSideStats([trade(1, 100), trade(2, -40), trade(3, -60)], CAPITAL);
    expect(s.grossProfit).toBe(100);
    expect(s.grossLoss).toBe(100);
    expect(s.netProfit).toBe(0);
    expect(s.avgLoss).toBe(-50);
  });
});

describe('computeSideStats — no losing trades (edge case)', () => {
  const s = computeSideStats([trade(1, 100), trade(2, 50)], CAPITAL);

  it('leaves profit factor undefined rather than Infinity', () => {
    expect(s.grossLoss).toBe(0);
    expect(s.profitFactor).toBeNull();
  });

  it('leaves win/loss ratio undefined because there is no average loss', () => {
    expect(s.avgLoss).toBeNull();
    expect(s.winLossRatio).toBeNull();
  });

  it('still reports a 100 % win rate and a real expectancy', () => {
    expect(s.winRatePct).toBe(100);
    expect(s.expectancy).toBeCloseTo(75, 10);
  });

  it('cannot check the rate identity, so it reports null', () => {
    expect(expectancyFromRates(s)).toBeNull();
  });
});

describe('computeSideStats — all losing (edge case)', () => {
  const s = computeSideStats([trade(1, -10), trade(2, -20)], CAPITAL);

  it('has a zero win rate and a zero profit factor', () => {
    expect(s.winRatePct).toBe(0);
    expect(s.profitFactor).toBe(0);
    expect(s.netProfit).toBe(-30);
    expect(s.expectancy).toBeCloseTo(-15, 10);
  });
});

describe('computeSideStats — the expectancy identity', () => {
  it('holds whenever both averages exist', () => {
    const fixtures: CostedTrade[][] = [
      [trade(1, 100), trade(2, 50), trade(3, -30), trade(4, -20)],
      [trade(1, 500), trade(2, -200), trade(3, 300), trade(4, -300), trade(5, 400)],
      [trade(1, 1), trade(2, -1), trade(3, 7), trade(4, -3)],
      [trade(1, 10), trade(2, -10), trade(3, 0)],
    ];
    for (const trades of fixtures) {
      const s = computeSideStats(trades, CAPITAL);
      const identity = expectancyFromRates(s);
      expect(identity, JSON.stringify(trades.map((t) => t.netPnl))).not.toBeNull();
      expect(identity!).toBeCloseTo(s.expectancy!, 8);
    }
  });
});

describe('streaks', () => {
  it('measures the longest run, and breakeven interrupts it', () => {
    const trades = [trade(1, 1), trade(2, 1), trade(3, -1), trade(4, 1), trade(5, 1), trade(6, 1)];
    expect(longestStreak(trades, (t) => t.netPnl > 0)).toBe(3);
    expect(longestStreak(trades, (t) => t.netPnl < 0)).toBe(1);
    expect(longestStreak([trade(1, 5), trade(2, 0), trade(3, 5)], (t) => t.netPnl > 0)).toBe(1);
  });

  it('orders by EXIT time, not array order', () => {
    // Given out of order: exits are seq 1,2,3,4 -> W W L W
    const shuffled = [trade(3, -1), trade(1, 1), trade(4, 1), trade(2, 1)];
    const s = computeSideStats(shuffled, CAPITAL);
    expect(s.maxConsecutiveWins).toBe(2);
    expect(s.currentStreak).toBe(1);
  });

  it('reports the current streak signed, and 0 after a breakeven', () => {
    expect(currentStreak([trade(1, 1), trade(2, 1), trade(3, 1)])).toBe(3);
    expect(currentStreak([trade(1, 1), trade(2, -1), trade(3, -1)])).toBe(-2);
    expect(currentStreak([trade(1, 1), trade(2, 0)])).toBe(0);
    expect(currentStreak([])).toBe(0);
  });
});

describe('side filtering', () => {
  const trades = [
    trade(1, 100, 'long'),
    trade(2, -50, 'short'),
    trade(3, 30, 'long'),
    trade(4, 70, 'short'),
  ];

  it('splits by side and the parts sum to the whole', () => {
    const all = computeSideStats(trades, CAPITAL);
    const long = computeSideStats(filterSide(trades, 'long'), CAPITAL);
    const short = computeSideStats(filterSide(trades, 'short'), CAPITAL);

    expect(long.trades).toBe(2);
    expect(short.trades).toBe(2);
    expect(long.netProfit + short.netProfit).toBeCloseTo(all.netProfit, 10);
    expect(long.grossProfit + short.grossProfit).toBeCloseTo(all.grossProfit, 10);
    expect(long.grossLoss + short.grossLoss).toBeCloseTo(all.grossLoss, 10);
  });
});

describe('bars held and excursions', () => {
  it('splits average bars held by outcome', () => {
    const winner = { ...trade(1, 100), barsHeld: 10 };
    const loser = { ...trade(2, -50), barsHeld: 2 };
    const s = computeSideStats([winner, loser], CAPITAL);
    expect(s.avgBarsHeld).toBeCloseTo(6, 10);
    expect(s.avgBarsHeldWins).toBeCloseTo(10, 10);
    expect(s.avgBarsHeldLosses).toBeCloseTo(2, 10);
  });

  it('ignores trades with no bar count or excursion instead of treating them as zero', () => {
    const s = computeSideStats(
      [
        { ...trade(1, 100), barsHeld: null, mae: null, mfe: null },
        { ...trade(2, 50), barsHeld: 8, mae: accountMoney(-20), mfe: accountMoney(60) },
      ],
      CAPITAL,
    );
    expect(s.avgBarsHeld).toBeCloseTo(8, 10);
    expect(s.avgMae).toBeCloseTo(-20, 10);
    expect(s.avgMfe).toBeCloseTo(60, 10);
  });

  it('reports null when nothing was measurable', () => {
    const s = computeSideStats(
      [{ ...trade(1, 100), barsHeld: null, mae: null, mfe: null }],
      CAPITAL,
    );
    expect(s.avgBarsHeld).toBeNull();
    expect(s.avgMae).toBeNull();
    expect(s.avgMfe).toBeNull();
  });
});
