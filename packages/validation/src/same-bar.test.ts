import { describe, expect, it } from 'vitest';

import { lots, units } from '@edgelab/shared';

import { estimateSameBarBias, marketFillsFromTrades, type MarketFill } from './same-bar';

/**
 * The same-bar execution estimate.
 *
 * The sign convention is the whole point, so it is asserted from both sides: buying above the
 * same-bar price costs us, selling below it costs us, and the reverse cases are credits.
 */

/** Bars where close and next open differ by a known, deliberate gap. */
const BARS = [
  { open: 100, close: 101 }, // bar 0 — signal bar for a fill on bar 1
  { open: 102, close: 103 }, // bar 1 — gapped UP 1.0 from bar 0's close
  { open: 102, close: 104 }, // bar 2 — gapped DOWN 1.0 from bar 1's close of 103
  { open: 104, close: 104 }, // bar 3 — flat from bar 2's close
];

describe('estimateSameBarBias', () => {
  it('charges a buy that filled ABOVE the same-bar price', () => {
    // Filled at bar 1's open of 102; a same-bar fill would have been bar 0's close of 101.
    const fills: MarketFill[] = [
      { label: 't1 entry', fillBar: 1, fillPrice: 102, qty: units(2), direction: 'buy' },
    ];

    const result = estimateSameBarBias({ fills, bars: BARS, pointValue: 1, rateAt: () => 1 });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.sameBarPrice).toBe(101);
    expect(result.rows[0]!.priceGap).toBe(1);
    expect(result.rows[0]!.accountCost).toBe(2); // 1.0 x 2 contracts
    expect(result.totalAccountCost).toBe(2);
  });

  it('CREDITS a buy that filled BELOW the same-bar price', () => {
    // Bar 2 opens at 102 after bar 1 closed at 103 — the gap went our way.
    const fills: MarketFill[] = [
      { label: 't1 entry', fillBar: 2, fillPrice: 102, qty: units(1), direction: 'buy' },
    ];

    const result = estimateSameBarBias({ fills, bars: BARS, pointValue: 1, rateAt: () => 1 });

    expect(result.rows[0]!.priceGap).toBe(-1);
    expect(result.totalAccountCost).toBe(-1);
  });

  it('mirrors the sign for a sell', () => {
    // Selling at 102 when a same-bar fill would have got 101 is BETTER for us.
    const sell = estimateSameBarBias({
      fills: [{ label: 't1 exit', fillBar: 1, fillPrice: 102, qty: units(1), direction: 'sell' }],
      bars: BARS,
      pointValue: 1,
      rateAt: () => 1,
    });
    const buy = estimateSameBarBias({
      fills: [{ label: 't1 entry', fillBar: 1, fillPrice: 102, qty: units(1), direction: 'buy' }],
      bars: BARS,
      pointValue: 1,
      rateAt: () => 1,
    });

    expect(sell.totalAccountCost).toBe(-buy.totalAccountCost);
  });

  it('reports zero when there is no gap at all', () => {
    const result = estimateSameBarBias({
      fills: [{ label: 't1 entry', fillBar: 3, fillPrice: 104, qty: units(5), direction: 'buy' }],
      bars: BARS,
      pointValue: 1,
      rateAt: () => 1,
    });

    expect(result.totalAccountCost).toBe(0);
    expect(result.assessed).toBe(1);
  });

  it('scales by contract value and the account rate', () => {
    // 1.0 of price x 2 contracts x 100,000 point value / 150 (yen per dollar) = 1333.33...
    const result = estimateSameBarBias({
      fills: [{ label: 't1 entry', fillBar: 1, fillPrice: 102, qty: units(2), direction: 'buy' }],
      bars: BARS,
      pointValue: 100_000,
      rateAt: () => 1 / 150,
    });

    expect(result.rows[0]!.accountCost).toBeCloseTo((1 * 2 * 100_000) / 150, 6);
  });

  it('counts a fill on bar 0 as unassessable rather than free', () => {
    // There is no preceding bar, so there is no same-bar price. Scoring it zero would dilute the
    // mean and quietly understate the bias.
    const result = estimateSameBarBias({
      fills: [{ label: 't1 entry', fillBar: 0, fillPrice: 100, qty: units(1), direction: 'buy' }],
      bars: BARS,
      pointValue: 1,
      rateAt: () => 1,
    });

    expect(result.assessed).toBe(0);
    expect(result.unassessable).toBe(1);
    expect(result.meanAccountCost).toBeNull();
    expect(result.totalAccountCost).toBe(0);
  });

  it('averages over assessed fills only', () => {
    const result = estimateSameBarBias({
      fills: [
        { label: 'a', fillBar: 1, fillPrice: 102, qty: units(1), direction: 'buy' }, // +1
        { label: 'b', fillBar: 3, fillPrice: 104, qty: units(1), direction: 'buy' }, //  0
        { label: 'c', fillBar: 0, fillPrice: 100, qty: units(1), direction: 'buy' }, // skipped
      ],
      bars: BARS,
      pointValue: 1,
      rateAt: () => 1,
    });

    expect(result.assessed).toBe(2);
    expect(result.unassessable).toBe(1);
    expect(result.meanAccountCost).toBeCloseTo(0.5, 12);
  });

  it('always says it is an estimate', () => {
    const result = estimateSameBarBias({ fills: [], bars: BARS, pointValue: 1, rateAt: () => 1 });

    expect(result.isEstimate).toBe(true);
    expect(result.warning).toMatch(/Estimated, not re-run/);
    expect(result.warning).toMatch(/process_orders_on_close/);
  });
});

describe('marketFillsFromTrades', () => {
  const TRADES = [
    {
      seq: 1,
      side: 'long' as const,
      qty: lots(1),
      entryBar: 5,
      entryPrice: 10,
      exitBar: 9,
      exitPrice: 11,
    },
    {
      seq: 2,
      side: 'short' as const,
      qty: lots(2),
      entryBar: 9,
      entryPrice: 11,
      exitBar: 12,
      exitPrice: 10,
    },
  ];

  it('opens a long with a buy and closes it with a sell', () => {
    const fills = marketFillsFromTrades(1, TRADES);

    expect(fills.map((f) => `${f.label}:${f.direction}`)).toEqual([
      't1 entry:buy',
      't1 exit:sell',
      't2 entry:sell',
      't2 exit:buy',
    ]);
  });

  it('carries the bar, price and size of each leg', () => {
    const fills = marketFillsFromTrades(1, TRADES);

    expect(fills[1]).toEqual({
      label: 't1 exit',
      fillBar: 9,
      fillPrice: 11,
      qty: 1,
      direction: 'sell',
    });
  });

  it('lets the caller exclude legs that were not market fills', () => {
    // A stop or limit exit fills at its own level, not the next open, so it is not comparable.
    const fills = marketFillsFromTrades(1, TRADES, (_seq, leg) => leg === 'entry');

    expect(fills.map((f) => f.label)).toEqual(['t1 entry', 't2 entry']);
  });
});

describe('marketFillsFromTrades — lots to units', () => {
  /**
   * The regression that motivated the brands. A trade's `qty` is in LOTS; a fill's is in UNITS,
   * because `pointValue` is per unit. The conversion was absent for two sessions, so every
   * same-bar estimate came out by a factor of contractSize and the report read "-0.00".
   */
  it('scales a trade qty by the contract size', () => {
    const fills = marketFillsFromTrades(100_000, [
      {
        seq: 1,
        side: 'long' as const,
        qty: lots(2),
        entryBar: 5,
        entryPrice: 10,
        exitBar: 9,
        exitPrice: 11,
      },
    ]);

    expect(fills.map((f) => f.qty)).toEqual([200_000, 200_000]);
  });

  it('prices a fill in account money, not 1/contractSize of it', () => {
    const fills = marketFillsFromTrades(100_000, [
      {
        seq: 1,
        side: 'long' as const,
        qty: lots(1),
        entryBar: 1,
        entryPrice: 102,
        exitBar: 3,
        exitPrice: 104,
      },
    ]);

    // Entry gapped 1.0 above bar 0's close on one lot of 100,000 at pointValue 1 = 100,000.
    const result = estimateSameBarBias({ fills, bars: BARS, pointValue: 1, rateAt: () => 1 });

    expect(result.rows[0]!.accountCost).toBe(100_000);
  });
});
