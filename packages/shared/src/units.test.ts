import { describe, expect, it } from 'vitest';

import {
  accountMoney,
  accountToQuoteMoney,
  lots,
  lotsToUnits,
  price,
  priceDeltaToQuoteMoney,
  priceDifference,
  quoteMoney,
  quoteToAccountMoney,
  sumAccountMoney,
  unbrand,
  units,
  unitsToLots,
} from './units';

/**
 * The unit brands.
 *
 * These tests assert two things: the arithmetic is right, and the brands are compile-time only so
 * nothing changes at run time. What they cannot assert is the part that matters most — that a `Lots`
 * value fails to compile where `Units` is wanted — because a test that failed to compile would not
 * run. Those cases are pinned as `@ts-expect-error` instead, which fails the BUILD if the brand ever
 * stops separating them.
 */

describe('brands are compile-time only', () => {
  it('leaves values as plain numbers', () => {
    expect(lots(2)).toBe(2);
    expect(units(200_000)).toBe(200_000);
    expect(quoteMoney(-3100)).toBe(-3100);
    expect(typeof lots(2)).toBe('number');
  });

  it('round-trips through unbrand unchanged', () => {
    expect(unbrand(accountMoney(1.5))).toBe(1.5);
  });
});

describe('lots and units', () => {
  it('converts one lot of FX to 100,000 units', () => {
    expect(lotsToUnits(lots(1), 100_000)).toBe(100_000);
    expect(lotsToUnits(lots(2.5), 100_000)).toBe(250_000);
  });

  it('round-trips', () => {
    expect(unitsToLots(lotsToUnits(lots(3), 100_000), 100_000)).toBe(3);
  });

  it('respects a non-FX contract size', () => {
    // XAUUSD is 100 ounces per lot, not 100,000 — which is why the factor is a parameter and not a
    // constant hidden in the function.
    expect(lotsToUnits(lots(1), 100)).toBe(100);
  });

  it('rejects a Lots value where Units is required', () => {
    // THE BUG THIS EXISTS FOR, twice over: mintick x qty where qty was in lots.
    // @ts-expect-error Lots is not assignable to Units
    priceDeltaToQuoteMoney(priceDifference(price(1.1), price(1.0)), lots(1), 1);
  });
});

describe('price deltas to money', () => {
  it('prices a move over a position', () => {
    // 0.00416 of price on 100,000 units at pointValue 1 = 416 quote currency.
    const delta = priceDifference(price(1.09355), price(1.08939));
    expect(priceDeltaToQuoteMoney(delta, units(100_000), 1)).toBeCloseTo(416, 6);
  });

  it('uses the magnitude of size, so a short does not flip the sign twice', () => {
    const delta = priceDifference(price(1.1), price(1.09));
    expect(priceDeltaToQuoteMoney(delta, units(-100_000), 1)).toBeCloseTo(
      priceDeltaToQuoteMoney(delta, units(100_000), 1),
      9,
    );
  });

  it('refuses to add a price to a price', () => {
    // @ts-expect-error Price is not a PriceDelta
    const bad: ReturnType<typeof priceDifference> = price(1.1);
    expect(bad).toBe(1.1);
  });
});

describe('quote to account money', () => {
  it('converts yen to dollars at dollars-per-yen', () => {
    // The hand-checked USDJPY trade: -3,100 JPY at 1/144.413 = -21.4662 USD.
    const usd = quoteToAccountMoney(quoteMoney(-3100), 1 / 144.413);
    expect(usd).toBeCloseTo(-21.4662, 4);
  });

  it('round-trips', () => {
    const rate = 1 / 144.413;
    expect(accountToQuoteMoney(quoteToAccountMoney(quoteMoney(84_800), rate), rate)).toBeCloseTo(
      84_800,
      6,
    );
  });

  it('refuses a non-positive rate rather than returning Infinity', () => {
    expect(() => accountToQuoteMoney(accountMoney(100), 0)).toThrow(RangeError);
  });

  it('will not let quote money be used where account money is required', () => {
    // The cross-check compared yen against dollars once. This is the shape that stops it.
    // @ts-expect-error QuoteMoney is not assignable to AccountMoney
    sumAccountMoney([quoteMoney(1)]);
  });
});

describe('summing', () => {
  it('adds money of one currency', () => {
    expect(sumAccountMoney([accountMoney(1.5), accountMoney(-0.5)])).toBe(1);
  });

  it('is zero for nothing', () => {
    expect(sumAccountMoney([])).toBe(0);
  });
});
