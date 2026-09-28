import type { Bar } from './market';

/**
 * What a stored price actually represents, and how to get a bid and an ask out of it.
 *
 * Every feed we ingest stores one number per OHLC field, and until now the whole codebase assumed
 * that number was the BID. That is true of Dukascopy and of MT5-style broker exports, and false of
 * Twelve Data, whose forex closes sit roughly half a spread above the bid feed over the same
 * minutes. Assuming bid on a mid feed prices a buy a full spread above where it would really fill
 * and a sell exactly at a price no seller could get.
 *
 * The distinction cannot be inferred from the numbers — a feed's basis is a property of the feed,
 * so it is declared per source and carried with the run.
 *
 * Pure: no I/O, no clock, no config. The SPREAD is resolved by the caller (`spreadPriceAt` in the
 * cost overlay knows about per-bar spreads, symbol defaults and the cost config); this module only
 * decides what to do with it.
 */

/**
 * `bid` — the stored price is the bid. A buyer pays bid + spread.
 *
 * `mid` — the stored price sits between bid and ask. Both sides are half a spread away.
 *
 * `last` — the stored price is the last TRADED price, not a quote at all. Binance klines are
 * this: spot trades print at whichever side of the book they hit, so a minute's close is simply
 * the last print. Over a bar those prints land on both sides of the book, so the honest
 * approximation is the mid — and it is kept as its own label rather than folded into `mid` so a
 * report can say "last-trade prices, treated as mid" instead of quietly claiming a quote we never
 * received.
 */
export type PriceBasis = 'bid' | 'mid' | 'last';

/** A two-sided quote derived from a stored price. */
export interface Quote {
  readonly bid: number;
  readonly ask: number;
}

/** Both sides of a bar. `bid.high` is the highest bid the bar traded through, and so on. */
export interface BarQuotes {
  readonly bid: Pick<Bar, 'open' | 'high' | 'low' | 'close'>;
  readonly ask: Pick<Bar, 'open' | 'high' | 'low' | 'close'>;
  /** The spread used, in price units — echoed so callers can report it without re-deriving. */
  readonly spread: number;
  readonly basis: PriceBasis;
}

/**
 * Which feed stores which basis.
 *
 * Unknown sources fall back to `bid`, which is the conservative choice for a cost model: it charges
 * a buyer the full spread, so an unrecognised feed is never cheaper than a known one. The fallback
 * is deliberately silent at this layer — `describeBasis` is what a report uses to say which feeds
 * were assumed rather than declared.
 */
const BASIS_BY_SOURCE: Readonly<Record<string, PriceBasis>> = {
  dukascopy: 'bid',
  mt5: 'bid',
  'mt5-file': 'bid',
  exness: 'bid',
  twelvedata: 'mid',
  binance: 'last',
};

export function priceBasisForSource(source: string): PriceBasis {
  return BASIS_BY_SOURCE[source.toLowerCase()] ?? 'bid';
}

/** True when the basis was declared for this source rather than defaulted. */
export function isBasisDeclared(source: string): boolean {
  return source.toLowerCase() in BASIS_BY_SOURCE;
}

export function describeBasis(source: string): string {
  const basis = priceBasisForSource(source);
  if (!isBasisDeclared(source)) {
    return `${source}: basis not declared, assuming bid (charges a buyer the full spread)`;
  }
  if (basis === 'last') {
    return `${source}: last-traded prices, treated as mid`;
  }
  return `${source}: ${basis}`;
}

/**
 * How much of the spread a fill on each side pays, given the basis.
 *
 * On a BID feed the stored price IS the sell price, so a sell pays nothing and a buy pays the whole
 * spread. On a MID feed neither side is the stored price and both pay half. Either way a round trip
 * costs exactly one spread — what changes is WHICH fill is charged, and therefore which bar's
 * spread and which bar's FX rate apply to it.
 */
export function spreadShare(basis: PriceBasis, side: 'buy' | 'sell'): number {
  if (basis === 'bid') return side === 'buy' ? 1 : 0;
  return 0.5;
}

/**
 * A single price level, as the two prices a trade could actually happen at.
 *
 * This is the primitive the stop/target checks need: a level read off a stored bar is not the level
 * either side would really transact at unless the basis says so.
 */
export function quoteFor(priceAtBasis: number, basis: PriceBasis, spread: number): Quote {
  if (basis === 'bid') {
    return { bid: priceAtBasis, ask: priceAtBasis + spread };
  }
  const half = spread / 2;
  return { bid: priceAtBasis - half, ask: priceAtBasis + half };
}

/**
 * THE function: every bar's bid and ask, from the basis plus the resolved spread.
 *
 * The spread is applied uniformly across the bar, because one number per bar is all any of our
 * feeds give us. That is an approximation — the spread widens at the extremes it is applied to —
 * and it is a conservative one for the checks that use it, since a constant spread understates how
 * far the ask ran above a bid high in exactly the thin moments where a stop would have been hit.
 */
export function deriveQuotes(bar: Bar, basis: PriceBasis, spread: number): BarQuotes {
  const shift = basis === 'bid' ? 0 : spread / 2;

  return {
    bid: {
      open: bar.open - shift,
      high: bar.high - shift,
      low: bar.low - shift,
      close: bar.close - shift,
    },
    ask: {
      open: bar.open - shift + spread,
      high: bar.high - shift + spread,
      low: bar.low - shift + spread,
      close: bar.close - shift + spread,
    },
    spread,
    basis,
  };
}

/**
 * The side a fill transacts on. Buys lift the ask, sells hit the bid.
 *
 * Trivial, and named because the M1 replay gets it wrong the moment it is written inline: a long's
 * STOP is a sell and triggers on the bid, while the same long's ENTRY is a buy and triggers on the
 * ask.
 */
export function fillSide(action: 'buy' | 'sell'): 'ask' | 'bid' {
  return action === 'buy' ? 'ask' : 'bid';
}
