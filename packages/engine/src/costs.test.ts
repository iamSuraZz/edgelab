import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COSTS,
  ZERO_COSTS,
  getSeedSymbol,
  type Bar,
  type CostConfig,
  type SymbolSpec,
  units,
} from '@edgelab/shared';

import {
  CurrencyMismatchError,
  applyCosts,
  financingCostQuote,
  fundingIntervalsBetween,
  priceDeltaToQuote,
  resolveQuoteToAccount,
  rolloversBetween,
  spreadPriceAt,
} from './costs';
import type { EngineTrade } from './pine-engine';

const H1 = 3_600_000;
const eurusd = getSeedSymbol('EURUSD');

/**
 * EURUSD for reference, since every hand-computed figure below depends on these:
 * mintick 0.00001, pipSize 0.0001, contractSize 100,000, pointValue 1.
 */
function bar(time: number, over: Partial<Bar> = {}): Bar {
  return { time, open: 1.1, high: 1.1005, low: 1.0995, close: 1.1002, volume: 100, ...over };
}

function trade(over: Partial<EngineTrade> = {}): EngineTrade {
  return {
    id: 't1',
    engineId: 'trade_1',
    entryId: 'L',
    side: 'long',
    // 100,000 units = 1.00 lot.
    qty: 100_000,
    entryTime: Date.UTC(2024, 0, 2, 10, 0),
    entryBar: 0,
    entryPrice: 1.1,
    exitTime: Date.UTC(2024, 0, 2, 11, 0),
    exitBar: 1,
    exitPrice: 1.102,
    exitId: 'close',
    exitComment: null,
    commission: 0,
    netPnl: 200, // 0.0020 x 100,000 x 1
    maxRunup: 250,
    maxDrawdown: 50,
    status: 'closed',
    ...over,
  };
}

const BARS: Bar[] = [
  bar(Date.UTC(2024, 0, 2, 10, 0), { spread: 0.00008 }),
  bar(Date.UTC(2024, 0, 2, 11, 0), { spread: 0.0002 }),
];

describe('resolveQuoteToAccount — D6', () => {
  it('is the identity when the quote currency matches the account', () => {
    const rate = resolveQuoteToAccount(eurusd, 'USD');
    expect(rate(0)).toBe(1);
    expect(rate(Date.now())).toBe(1);
  });

  it('is case-insensitive about the currency code', () => {
    expect(() => resolveQuoteToAccount(eurusd, 'usd')).not.toThrow();
  });

  it('REJECTS a cross-currency run rather than mislabelling the P&L', () => {
    expect(() => resolveQuoteToAccount(eurusd, 'EUR')).toThrow(CurrencyMismatchError);
  });

  it('names both currencies and what to do about it', () => {
    const error = (() => {
      try {
        resolveQuoteToAccount(getSeedSymbol('USDJPY'), 'USD');
        return null;
      } catch (e: unknown) {
        return e as CurrencyMismatchError;
      }
    })();

    expect(error).not.toBeNull();
    expect(error!.code).toBe('currency-mismatch');
    expect(error!.message).toContain('USDJPY');
    expect(error!.message).toContain('JPY');
    expect(error!.message).toContain('USD');
  });
});

describe('spreadPriceAt', () => {
  const withDefault: SymbolSpec = { ...eurusd, defaultSpreadPoints: 12 };

  it('uses the bar’s measured spread under source=data', () => {
    expect(spreadPriceAt(bar(0, { spread: 0.00008 }), eurusd, DEFAULT_COSTS)).toBe(0.00008);
  });

  it('falls back to the symbol’s default when a bar has no spread', () => {
    // 12 points x 0.00001 = 0.00012
    expect(spreadPriceAt(bar(0, { spread: null }), withDefault, DEFAULT_COSTS)).toBeCloseTo(
      0.00012,
      12,
    );
  });

  it('prefers a configured fixedPoints over the symbol default as the fallback', () => {
    const config: CostConfig = {
      ...DEFAULT_COSTS,
      spread: { source: 'data', fixedPoints: 20, multiplier: 1 },
    };
    expect(spreadPriceAt(bar(0, { spread: null }), withDefault, config)).toBeCloseTo(0.0002, 12);
  });

  it('ignores the measured spread entirely under source=fixed', () => {
    const config: CostConfig = {
      ...DEFAULT_COSTS,
      spread: { source: 'fixed', fixedPoints: 30, multiplier: 1 },
    };
    expect(spreadPriceAt(bar(0, { spread: 0.00008 }), eurusd, config)).toBeCloseTo(0.0003, 12);
  });

  it('charges nothing under source=none, which is what the cross-check runs with', () => {
    expect(spreadPriceAt(bar(0, { spread: 0.00008 }), eurusd, ZERO_COSTS)).toBe(0);
  });

  it('applies the stress multiplier', () => {
    const config: CostConfig = {
      ...DEFAULT_COSTS,
      spread: { source: 'data', fixedPoints: 0, multiplier: 2 },
    };
    expect(spreadPriceAt(bar(0, { spread: 0.00008 }), eurusd, config)).toBeCloseTo(0.00016, 12);
  });

  it('treats a missing bar as no measurement, not as zero cost', () => {
    expect(spreadPriceAt(undefined, withDefault, DEFAULT_COSTS)).toBeCloseTo(0.00012, 12);
  });

  it('rejects a negative stored spread and falls back', () => {
    expect(spreadPriceAt(bar(0, { spread: -0.0001 }), withDefault, DEFAULT_COSTS)).toBeCloseTo(
      0.00012,
      12,
    );
  });
});

describe('priceDeltaToQuote', () => {
  it('turns a price delta into money for a position in units', () => {
    // 1 pip on 1 standard lot of EURUSD is $10.
    expect(priceDeltaToQuote(0.0001, units(100_000), eurusd)).toBeCloseTo(10, 9);
  });

  it('is signed by the delta and unsigned by the size', () => {
    expect(priceDeltaToQuote(-0.0001, units(100_000), eurusd)).toBeCloseTo(-10, 9);
    expect(priceDeltaToQuote(-0.0001, units(-100_000), eurusd)).toBeCloseTo(-10, 9);
  });
});

describe('rolloversBetween — D5, 17:00 America/New_York', () => {
  const mt5: CostConfig = {
    ...DEFAULT_COSTS,
    financing: { ...DEFAULT_COSTS.financing, mode: 'mt5Points', swapLongPoints: -7 },
  };

  it('is empty when financing is off', () => {
    const from = Date.UTC(2024, 0, 2);
    expect(rolloversBetween(from, from + 5 * 86_400_000, DEFAULT_COSTS)).toEqual([]);
  });

  it('is empty for a swap-free account even in mt5Points mode', () => {
    const swapFree: CostConfig = {
      ...mt5,
      financing: { ...mt5.financing, swapFree: true },
    };
    const from = Date.UTC(2024, 0, 2);
    expect(rolloversBetween(from, from + 5 * 86_400_000, swapFree)).toEqual([]);
  });

  it('charges nothing for an intraday trade that never crosses 17:00 New York', () => {
    // 2024-01-02 10:00–15:00 UTC is 05:00–10:00 New York.
    const entry = Date.UTC(2024, 0, 2, 10);
    expect(rolloversBetween(entry, entry + 5 * H1, mt5)).toEqual([]);
  });

  it('fires at 22:00 UTC in winter', () => {
    // 2024-01-02 is EST, so 17:00 NY = 22:00 UTC.
    const entry = Date.UTC(2024, 0, 2, 10);
    const rollovers = rolloversBetween(entry, entry + 14 * H1, mt5);
    expect(rollovers).toHaveLength(1);
    expect(rollovers[0]!.atMs).toBe(Date.UTC(2024, 0, 2, 22));
  });

  it('fires at 21:00 UTC in summer — the whole point of D5', () => {
    // 2024-07-02 is EDT, so 17:00 NY = 21:00 UTC. A hardcoded 22:00 would miss a position
    // closed at 21:30 and charge one closed at 22:30 twice.
    const entry = Date.UTC(2024, 6, 2, 10);
    const rollovers = rolloversBetween(entry, entry + 14 * H1, mt5);
    expect(rollovers).toHaveLength(1);
    expect(rollovers[0]!.atMs).toBe(Date.UTC(2024, 6, 2, 21));
  });

  it('counts one rollover per night held', () => {
    const entry = Date.UTC(2024, 0, 2, 10);
    // Mon 10:00 UTC -> Fri 10:00 UTC crosses Tue, Wed, Thu and Fri… no: 2024-01-02 is a
    // Tuesday, so this spans the Tue, Wed, Thu and Fri 22:00 rollovers minus the last.
    const rollovers = rolloversBetween(entry, Date.UTC(2024, 0, 5, 10), mt5);
    expect(rollovers.map((r) => new Date(r.atMs).toISOString())).toEqual([
      '2024-01-02T22:00:00.000Z',
      '2024-01-03T22:00:00.000Z',
      '2024-01-04T22:00:00.000Z',
    ]);
  });

  it('charges Wednesday three times by default', () => {
    // 2024-01-03 is a Wednesday. Its 22:00 UTC rollover is still Wednesday 17:00 in New York.
    const rollovers = rolloversBetween(Date.UTC(2024, 0, 3, 10), Date.UTC(2024, 0, 4, 10), mt5);
    expect(rollovers).toHaveLength(1);
    expect(rollovers[0]!.multiplier).toBe(3);
  });

  it('honours a different triple-charge weekday', () => {
    const friday: CostConfig = {
      ...mt5,
      financing: { ...mt5.financing, tripleChargeWeekday: 5 },
    };
    // 2024-01-05 is a Friday.
    const rollovers = rolloversBetween(Date.UTC(2024, 0, 5, 10), Date.UTC(2024, 0, 6, 10), friday);
    expect(rollovers[0]!.multiplier).toBe(3);
    // And Wednesday is then charged once.
    expect(
      rolloversBetween(Date.UTC(2024, 0, 3, 10), Date.UTC(2024, 0, 4, 10), friday)[0]!.multiplier,
    ).toBe(1);
  });

  it('can disable triple charging entirely', () => {
    const none: CostConfig = {
      ...mt5,
      financing: { ...mt5.financing, tripleChargeWeekday: null },
    };
    const rollovers = rolloversBetween(Date.UTC(2024, 0, 3, 10), Date.UTC(2024, 0, 4, 10), none);
    expect(rollovers[0]!.multiplier).toBe(1);
  });

  it('excludes a rollover exactly at entry and includes one exactly at exit', () => {
    const rollover = Date.UTC(2024, 0, 2, 22);
    // Opened AT the rollover: not held through it.
    expect(rolloversBetween(rollover, rollover + H1, mt5)).toHaveLength(0);
    // Closed AT the rollover: held through it.
    expect(rolloversBetween(rollover - H1, rollover, mt5)).toHaveLength(1);
  });

  it('does not drift an hour across the spring-forward weekend', () => {
    // A fixed 24-hour stride would land on 21:00 UTC for one of these days and 22:00 for the
    // other, double-counting or skipping. Local-calendar iteration cannot.
    const rollovers = rolloversBetween(Date.UTC(2024, 2, 8, 10), Date.UTC(2024, 2, 12, 10), mt5);
    expect(rollovers.map((r) => new Date(r.atMs).toISOString())).toEqual([
      '2024-03-08T22:00:00.000Z', // EST
      '2024-03-09T22:00:00.000Z', // EST
      '2024-03-10T21:00:00.000Z', // EDT — the clocks moved
      '2024-03-11T21:00:00.000Z',
    ]);
  });
});

describe('financingCostQuote', () => {
  const mt5 = (over: Partial<CostConfig['financing']> = {}): CostConfig => ({
    ...DEFAULT_COSTS,
    financing: {
      ...DEFAULT_COSTS.financing,
      mode: 'mt5Points',
      swapLongPoints: -7,
      swapShortPoints: 2,
      ...over,
    },
  });

  it('turns a negative broker swap into a positive cost', () => {
    // -7 points x 0.00001 x 100,000 units x 1 = -$7 per night, so $7 of cost.
    const cost = financingCostQuote(
      'long',
      units(100_000),
      1.1,
      Date.UTC(2024, 0, 2, 10),
      Date.UTC(2024, 0, 2, 23),
      eurusd,
      mt5(),
    );
    expect(cost).toBeCloseTo(7, 9);
  });

  it('turns a positive broker swap into a credit, i.e. a negative cost', () => {
    const cost = financingCostQuote(
      'short',
      units(100_000),
      1.1,
      Date.UTC(2024, 0, 2, 10),
      Date.UTC(2024, 0, 2, 23),
      eurusd,
      mt5(),
    );
    expect(cost).toBeCloseTo(-2, 9);
  });

  it('multiplies by the nights held, counting Wednesday three times', () => {
    // Tue 10:00 -> Thu 10:00 crosses Tue (x1) and Wed (x3) = 4 charges of $7.
    const cost = financingCostQuote(
      'long',
      units(100_000),
      1.1,
      Date.UTC(2024, 0, 2, 10),
      Date.UTC(2024, 0, 4, 10),
      eurusd,
      mt5(),
    );
    expect(cost).toBeCloseTo(28, 9);
  });

  it('is zero for an intraday trade', () => {
    expect(
      financingCostQuote(
        'long',
        units(100_000),
        1.1,
        Date.UTC(2024, 0, 2, 10),
        Date.UTC(2024, 0, 2, 15),
        eurusd,
        mt5(),
      ),
    ).toBe(0);
  });

  it('is zero when swap-free', () => {
    expect(
      financingCostQuote(
        'long',
        units(100_000),
        1.1,
        Date.UTC(2024, 0, 2, 10),
        Date.UTC(2024, 0, 5, 10),
        eurusd,
        mt5({ swapFree: true }),
      ),
    ).toBe(0);
  });

  it('charges annualPct against notional per night', () => {
    const config: CostConfig = {
      ...DEFAULT_COSTS,
      financing: { ...DEFAULT_COSTS.financing, mode: 'annualPct', annualPctLong: -3.65 },
    };
    // Notional 100,000 x 1.1 = 110,000. -3.65%/yr = -0.01%/night = -$11, so $11 of cost.
    const cost = financingCostQuote(
      'long',
      units(100_000),
      1.1,
      Date.UTC(2024, 0, 2, 10),
      Date.UTC(2024, 0, 2, 23),
      eurusd,
      config,
    );
    expect(cost).toBeCloseTo(11, 6);
  });

  it('charges funding every interval, longs paying when the rate is positive', () => {
    const config: CostConfig = {
      ...DEFAULT_COSTS,
      financing: {
        ...DEFAULT_COSTS.financing,
        mode: 'funding',
        fundingRatePct: 0.01,
        fundingIntervalHours: 8,
      },
    };
    // 2024-01-02 07:00 -> 17:00 UTC crosses the 08:00 and 16:00 anchors: 2 intervals.
    // Notional 110,000 x 0.01% = $11 each.
    const entry = Date.UTC(2024, 0, 2, 7);
    const exit = Date.UTC(2024, 0, 2, 17);
    expect(fundingIntervalsBetween(entry, exit, config)).toHaveLength(2);
    expect(
      financingCostQuote('long', units(100_000), 1.1, entry, exit, eurusd, config),
    ).toBeCloseTo(22, 6);
    // A short receives it.
    expect(
      financingCostQuote('short', units(100_000), 1.1, entry, exit, eurusd, config),
    ).toBeCloseTo(-22, 6);
  });

  it('anchors funding intervals to the UTC epoch, as exchanges do', () => {
    const config: CostConfig = {
      ...DEFAULT_COSTS,
      financing: { ...DEFAULT_COSTS.financing, mode: 'funding', fundingIntervalHours: 8 },
    };
    const intervals = fundingIntervalsBetween(
      Date.UTC(2024, 0, 2, 1),
      Date.UTC(2024, 0, 3, 1),
      config,
    );
    expect(intervals.map((t) => new Date(t).toISOString())).toEqual([
      '2024-01-02T08:00:00.000Z',
      '2024-01-02T16:00:00.000Z',
      '2024-01-03T00:00:00.000Z',
    ]);
  });
});

describe('applyCosts', () => {
  const base = { bars: BARS, symbol: eurusd, quoteToAccount: () => 1 };

  it('charges a LONG its spread at the ENTRY bar', () => {
    // Entry bar spread 0.00008 x 100,000 = $8.
    const [costed] = applyCosts({ ...base, trades: [trade()], config: DEFAULT_COSTS });
    expect(costed!.spreadCost).toBeCloseTo(8, 9);
  });

  it('charges a SHORT its spread at the EXIT bar', () => {
    // Exit bar spread 0.0002 x 100,000 = $20. A short sold at the bid and buys back at the ask.
    const [costed] = applyCosts({
      ...base,
      trades: [trade({ side: 'short' })],
      config: DEFAULT_COSTS,
    });
    expect(costed!.spreadCost).toBeCloseTo(20, 9);
  });

  it('charges the spread ONCE per round trip, not on both fills', () => {
    const [long] = applyCosts({ ...base, trades: [trade()], config: DEFAULT_COSTS });
    const [short] = applyCosts({
      ...base,
      trades: [trade({ side: 'short' })],
      config: DEFAULT_COSTS,
    });
    // If both fills were charged, each would be 8 + 20 = 28.
    expect(long!.spreadCost).not.toBeCloseTo(28, 6);
    expect(short!.spreadCost).not.toBeCloseTo(28, 6);
  });

  it('reduces net P&L by exactly the spread and financing', () => {
    const [costed] = applyCosts({ ...base, trades: [trade()], config: DEFAULT_COSTS });
    expect(costed!.grossPnl).toBeCloseTo(200, 9);
    expect(costed!.netPnl).toBeCloseTo(192, 9); // 200 - 8
  });

  it('keeps the identity cost-drag depends on: net = gross − every component', () => {
    const config: CostConfig = {
      ...DEFAULT_COSTS,
      slippagePoints: 5,
      financing: { ...DEFAULT_COSTS.financing, mode: 'mt5Points', swapLongPoints: -7 },
    };
    const [costed] = applyCosts({
      ...base,
      trades: [trade({ commission: 7, netPnl: 193, exitTime: Date.UTC(2024, 0, 3, 10) })],
      config,
    });

    const c = costed!;
    const totalCosts = c.commission + c.slippageCost + c.spreadCost + c.financingCost;
    // cost-drag.ts computes grossBeforeCosts as netProfit + totalCosts, so that sum must
    // equal engine P&L plus the costs already inside it.
    expect(c.netPnl + totalCosts).toBeCloseTo(c.grossPnl + c.commission + c.slippageCost, 6);
  });

  it('estimates slippage on BOTH fills', () => {
    const config: CostConfig = { ...DEFAULT_COSTS, slippagePoints: 5 };
    const [costed] = applyCosts({ ...base, trades: [trade()], config });
    // 2 x 5 points x 0.00001 x 100,000 = $10.
    expect(costed!.slippageCost).toBeCloseTo(10, 9);
  });

  it('charges nothing at all under ZERO_COSTS, so net equals the engine exactly', () => {
    const [costed] = applyCosts({ ...base, trades: [trade()], config: ZERO_COSTS });
    expect(costed!.spreadCost).toBe(0);
    expect(costed!.financingCost).toBe(0);
    expect(costed!.slippageCost).toBe(0);
    expect(costed!.netPnl).toBe(200);
    expect(costed!.netPnl).toBe(costed!.grossPnl);
  });

  it('converts engine qty from units to LOTS', () => {
    const [costed] = applyCosts({ ...base, trades: [trade({ qty: 250_000 })], config: ZERO_COSTS });
    expect(costed!.qty).toBeCloseTo(2.5, 12);
  });

  it('numbers trades from 1 and excludes open ones', () => {
    const costed = applyCosts({
      ...base,
      trades: [
        trade(),
        trade({ id: 't2', status: 'open', exitTime: null, exitPrice: null, netPnl: null }),
        trade({ id: 't3' }),
      ],
      config: ZERO_COSTS,
    });
    expect(costed.map((t) => t.seq)).toEqual([1, 2]);
  });

  it('signs MAE negative and MFE positive, whatever the engine reported', () => {
    const [costed] = applyCosts({
      ...base,
      trades: [trade({ maxDrawdown: 50, maxRunup: 250 })],
      config: ZERO_COSTS,
    });
    expect(costed!.mae).toBe(-50);
    expect(costed!.mfe).toBe(250);
  });

  it('applies the conversion rate to every money field', () => {
    const config: CostConfig = {
      ...DEFAULT_COSTS,
      slippagePoints: 5,
      financing: { ...DEFAULT_COSTS.financing, mode: 'mt5Points', swapLongPoints: -7 },
    };
    const [at1] = applyCosts({ ...base, trades: [trade({ commission: 7 })], config });
    const [at2] = applyCosts({
      ...base,
      trades: [trade({ commission: 7 })],
      config,
      quoteToAccount: () => 2,
    });

    for (const field of [
      'grossPnl',
      'commission',
      'slippageCost',
      'spreadCost',
      'netPnl',
    ] as const) {
      expect(at2![field], field).toBeCloseTo(at1![field] * 2, 6);
    }
  });
});

describe('applyCosts — price basis', () => {
  const base = { bars: BARS, symbol: eurusd, quoteToAccount: () => 1 };

  // The fixture bars carry DIFFERENT spreads — 0.00008 at entry, 0.0002 at exit — which is what
  // makes the basis observable. With one constant spread every basis totals the same and the
  // change would be invisible.

  it('defaults to bid, preserving the behaviour every other test asserts', () => {
    const [withDefault] = applyCosts({ ...base, trades: [trade()], config: DEFAULT_COSTS });
    const [explicit] = applyCosts({
      ...base,
      trades: [trade()],
      config: DEFAULT_COSTS,
      basis: 'bid',
    });
    expect(withDefault!.spreadCost).toBe(explicit!.spreadCost);
    expect(withDefault!.spreadCost).toBeCloseTo(8, 9);
  });

  it('splits a mid-feed spread across both fills', () => {
    // Half of each bar's own spread: 0.5 x 0.00008 + 0.5 x 0.0002 = 0.00014 x 100,000 = $14.
    const [costed] = applyCosts({
      ...base,
      trades: [trade()],
      config: DEFAULT_COSTS,
      basis: 'mid',
    });
    expect(costed!.spreadCost).toBeCloseTo(14, 9);
  });

  it('costs a long and a short the same on a mid feed, and different amounts on a bid feed', () => {
    const mid = (side: 'long' | 'short') =>
      applyCosts({ ...base, trades: [trade({ side })], config: DEFAULT_COSTS, basis: 'mid' })[0]!
        .spreadCost;
    const bid = (side: 'long' | 'short') =>
      applyCosts({ ...base, trades: [trade({ side })], config: DEFAULT_COSTS, basis: 'bid' })[0]!
        .spreadCost;

    // On a mid feed both legs pay half, so the side cannot matter.
    expect(mid('long')).toBeCloseTo(mid('short'), 9);

    // On a bid feed the charge lands on the buying leg, so it picks up that bar's spread.
    expect(bid('long')).toBeCloseTo(8, 9);
    expect(bid('short')).toBeCloseTo(20, 9);
  });

  it('treats a last-trade feed as mid', () => {
    const last = applyCosts({
      ...base,
      trades: [trade()],
      config: DEFAULT_COSTS,
      basis: 'last',
    })[0]!.spreadCost;
    const mid = applyCosts({ ...base, trades: [trade()], config: DEFAULT_COSTS, basis: 'mid' })[0]!
      .spreadCost;
    expect(last).toBe(mid);
  });

  it('still charges exactly one spread per round trip when the spread is constant', () => {
    const flat: Bar[] = [
      bar(Date.UTC(2024, 0, 2, 10, 0), { spread: 0.0001 }),
      bar(Date.UTC(2024, 0, 2, 11, 0), { spread: 0.0001 }),
    ];
    const cost = (basis: 'bid' | 'mid') =>
      applyCosts({ ...base, bars: flat, trades: [trade()], config: DEFAULT_COSTS, basis })[0]!
        .spreadCost;

    // 0.0001 x 100,000 = $10 either way. The basis moves WHERE the cost is charged, not how much,
    // whenever the spread and the FX rate are the same at both fills.
    expect(cost('bid')).toBeCloseTo(10, 9);
    expect(cost('mid')).toBeCloseTo(10, 9);
  });
});
