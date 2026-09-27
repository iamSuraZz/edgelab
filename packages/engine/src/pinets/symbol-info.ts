import type { SymbolSpec } from '@edgelab/shared';

/**
 * SymbolSpec -> PineTS ISymbolInfo.
 *
 * ISymbolInfo has ~40 fields and NONE are optional in its TypeScript type, so every one
 * must be supplied. Only a handful are load-bearing for a backtest:
 *
 *   mintick     — strategy.exit profit/loss are in TICKS, so this must be exact
 *   pointvalue  — position value per point
 *   minmove/pricescale — formatting and tick arithmetic
 *   currency    — what the engine's numbers are denominated in
 *   session/timezone   — calendar built-ins
 *
 * The fundamentals and analyst-rating fields have no meaning for us; they are filled with
 * neutral zeros/empties. A script reading them gets 0 rather than a crash — the same thing
 * PineTS's own bundled providers do.
 */
export interface PineSymbolInfo {
  current_contract: string;
  description: string;
  isin: string;
  main_tickerid: string;
  prefix: string;
  root: string;
  ticker: string;
  tickerid: string;
  type: string;
  basecurrency: string;
  country: string;
  currency: string;
  timezone: string;
  employees: number;
  industry: string;
  sector: string;
  shareholders: number;
  shares_outstanding_float: number;
  shares_outstanding_total: number;
  expiration_date: number;
  session: string;
  volumetype: string;
  mincontract: number;
  minmove: number;
  mintick: number;
  pointvalue: number;
  pricescale: number;
  recommendations_buy: number;
  recommendations_buy_strong: number;
  recommendations_date: number;
  recommendations_hold: number;
  recommendations_sell: number;
  recommendations_sell_strong: number;
  recommendations_total: number;
  target_price_average: number;
  target_price_date: number;
  target_price_estimates: number;
  target_price_high: number;
  target_price_low: number;
  target_price_median: number;
}

/** Pine's `syminfo.type` vocabulary. */
function pineType(spec: SymbolSpec): string {
  switch (spec.assetClass) {
    case 'fx':
      return 'forex';
    case 'crypto':
      return 'crypto';
    case 'index':
      return 'index';
    case 'metal':
    case 'energy':
      return 'commodity';
  }
}

/**
 * Session string.
 *
 * NOTE (deliberate simplification, flagged in docs/pinets-notes.md): we report 24x7 for
 * every instrument. Our stored bars are already filtered to open market hours by the data
 * layer, and because this provider serves EVERY timeframe directly the runtime never uses
 * the session to aggregate. Reporting a real fx session spec would require a verified
 * MT5-style session string, which we do not have. Scripts that read `syminfo.session` or
 * use session-dependent built-ins will therefore see 24x7 — revisit if that bites.
 */
function pineSession(): string {
  return '24x7';
}

export function toPineSymbolInfo(spec: SymbolSpec): PineSymbolInfo {
  // pricescale is 1/mintick for decimal instruments, which is how TradingView defines it.
  const pricescale = Math.round(1 / spec.mintick);

  return {
    ticker: spec.symbol,
    tickerid: spec.symbol,
    main_tickerid: spec.symbol,
    description: `${spec.baseCcy}/${spec.quoteCcy}`,
    type: pineType(spec),
    basecurrency: spec.baseCcy,
    currency: spec.quoteCcy,
    timezone: 'Etc/UTC',
    session: pineSession(),
    mintick: spec.mintick,
    minmove: 1,
    pricescale,
    pointvalue: spec.pointValue,
    mincontract: 1,
    volumetype: 'base',

    // Not meaningful for a backtest; neutral values rather than undefined.
    prefix: '',
    root: '',
    isin: '',
    current_contract: '',
    country: '',
    industry: '',
    sector: '',
    employees: 0,
    shareholders: 0,
    shares_outstanding_float: 0,
    shares_outstanding_total: 0,
    expiration_date: 0,
    recommendations_buy: 0,
    recommendations_buy_strong: 0,
    recommendations_date: 0,
    recommendations_hold: 0,
    recommendations_sell: 0,
    recommendations_sell_strong: 0,
    recommendations_total: 0,
    target_price_average: 0,
    target_price_date: 0,
    target_price_estimates: 0,
    target_price_high: 0,
    target_price_low: 0,
    target_price_median: 0,
  };
}
