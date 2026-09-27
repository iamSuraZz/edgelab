/**
 * Branded unit types, so the compiler catches what review has not.
 *
 * Four unit mix-ups have shipped in this repo, every one of them silent:
 *
 *   1. The engine was handed ACCOUNT-currency capital where it wanted QUOTE currency. On USDJPY that
 *      is out by ~148x, so every order was cancelled for insufficient margin and the run reported a
 *      clean zero with a PASSING cross-check.
 *   2. The cross-check compared yen against dollars and failed every cross-currency run by the
 *      exchange rate.
 *   3. The same-bar estimate multiplied a tick by a LOTS quantity, producing a figure 100,000x too
 *      small.
 *   4. The fill audit did exactly the same thing again, one session later, and reported a
 *      penetration cost of "0.00".
 *
 * The common shape: every one of these quantities is a `number`, so the compiler is indifferent to
 * multiplying a lot count by a tick, or adding yen to dollars. A comment saying "in lots" is a
 * comment; it does not stop `mintick * qty` from type-checking.
 *
 * ZERO RUNTIME COST. These are compile-time-only brands — the values are plain numbers at run time,
 * the constructors are identity functions, and nothing here changes behaviour. The point is that
 * `Lots` and `Units` become mutually unassignable, and money in two currencies stops being the same
 * type.
 *
 * CONVERSIONS ARE NAMED. There is no cast between brands; the only way across is a function whose
 * name says what it did and which takes the factor it needs. That is what makes a wrong conversion
 * visible at the call site instead of invisible in a multiplication.
 */

declare const brand: unique symbol;

/** A nominal type: `number` at run time, distinct at compile time. */
type Branded<B extends string> = number & { readonly [brand]: B };

/* --------------------------------------------------------------- quantities */

/**
 * Position size in LOTS — the broker's contract unit. One lot of EURUSD is 100,000 euro.
 *
 * `CostedTrade.qty` is this. Multiplying it by a tick is the mistake made twice.
 */
export type Lots = Branded<'Lots'>;

/**
 * Position size in UNITS of the base instrument — what Pine calls contracts.
 *
 * `default_qty_value=1` on EURUSD is ONE EURO, not one lot, which is why the CLI has a `--lots`
 * override at all.
 */
export type Units = Branded<'Units'>;

/* -------------------------------------------------------------------- prices */

/** A quoted price, in the instrument's quote currency per unit of base. */
export type Price = Branded<'Price'>;

/** A price DIFFERENCE. Distinct from `Price` because a price plus a price is meaningless. */
export type PriceDelta = Branded<'PriceDelta'>;

/* --------------------------------------------------------------------- money */

/** Money in the INSTRUMENT's quote currency — yen for USDJPY. What the engine computes in. */
export type QuoteMoney = Branded<'QuoteMoney'>;

/** Money in the ACCOUNT's currency. What every report and metric is denominated in. */
export type AccountMoney = Branded<'AccountMoney'>;

/* -------------------------------------------------------------- constructors */

export const lots = (n: number): Lots => n as Lots;
export const units = (n: number): Units => n as Units;
export const price = (n: number): Price => n as Price;
export const priceDelta = (n: number): PriceDelta => n as PriceDelta;
export const quoteMoney = (n: number): QuoteMoney => n as QuoteMoney;
export const accountMoney = (n: number): AccountMoney => n as AccountMoney;

/** Drop the brand. Named so that reaching for it is a visible choice. */
export const unbrand = (n: Branded<string>): number => n;

/* --------------------------------------------------------------- conversions */

/**
 * Lots to units, through the instrument's contract size.
 *
 * The conversion that was skipped twice. It takes `contractSize` because there is no universal
 * answer — 100,000 for FX, 100 for XAUUSD, 1 for an index CFD — so a caller cannot get here without
 * having looked it up.
 */
export function lotsToUnits(q: Lots, contractSize: number): Units {
  return (q * contractSize) as Units;
}

export function unitsToLots(q: Units, contractSize: number): Lots {
  return (q / contractSize) as Lots;
}

/**
 * A price move, over a position, as money in the QUOTE currency.
 *
 * `pointValue` is the quote-currency value of one price unit for one unit of base — 1 for most FX.
 * Taking `Units` rather than `Lots` is deliberate: it makes the lots-vs-units question impossible to
 * skip, because a `Lots` value will not compile here.
 */
export function priceDeltaToQuoteMoney(
  delta: PriceDelta,
  size: Units,
  pointValue: number,
): QuoteMoney {
  return (delta * Math.abs(size) * pointValue) as QuoteMoney;
}

/**
 * Quote currency to account currency, at a rate.
 *
 * `rate` is ACCOUNT per QUOTE — dollars per yen for a USDJPY run on a USD account, i.e. the
 * reciprocal of the USDJPY price. Getting that direction backwards is wrong by the square of the
 * rate, which still looks like money, which is why the parameter is named for its direction.
 */
export function quoteToAccountMoney(m: QuoteMoney, accountPerQuote: number): AccountMoney {
  return (m * accountPerQuote) as AccountMoney;
}

export function accountToQuoteMoney(m: AccountMoney, accountPerQuote: number): QuoteMoney {
  if (!(accountPerQuote > 0)) {
    throw new RangeError(`accountPerQuote must be positive, received ${String(accountPerQuote)}`);
  }
  return (m / accountPerQuote) as QuoteMoney;
}

/** Difference between two prices. The only sanctioned way to get a `PriceDelta`. */
export function priceDifference(a: Price, b: Price): PriceDelta {
  return (a - b) as PriceDelta;
}

/** Sum money of one currency. Typed so two currencies cannot be added by accident. */
export function sumAccountMoney(values: Iterable<AccountMoney>): AccountMoney {
  let total = 0;
  for (const v of values) total += v;
  return total as AccountMoney;
}

export function sumQuoteMoney(values: Iterable<QuoteMoney>): QuoteMoney {
  let total = 0;
  for (const v of values) total += v;
  return total as QuoteMoney;
}
