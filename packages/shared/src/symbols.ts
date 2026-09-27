import type { AssetClass, SymbolSpec } from './market';

/**
 * Seed symbol registry. These rows are inserted once and are then editable from the
 * Settings UI — the database is the source of truth at runtime, not this file.
 *
 * Every `dukascopy` provider id below was taken from dukascopy-node's OWN
 * `instrumentMetaData` export, never guessed. The ids look odd on purpose
 * (`usa500idxusd`, `lightcmdusd`) because that is exactly what the library expects.
 *
 * mintick vs pipSize: mintick is the smallest quotable increment, and is what MT5 calls
 * a "point" — a spread of 12 points means 12 * mintick. pipSize is the conventional pip,
 * which is 10 minticks for 5-digit fx and 3-digit JPY pairs.
 */

interface FxOptions {
  readonly digits?: 3 | 5;
  readonly defaultSpreadPoints?: number;
}

/**
 * The price increment for a given number of decimal digits.
 *
 * Parsed from a decimal string rather than computed as `10 ** -digits`, and that is not
 * pedantry. Exponentiation is **implementation-approximated** in ECMAScript — the spec explicitly
 * permits engines to differ — whereas string-to-number conversion is exactly specified as
 * round-to-nearest. So `10 ** -5` may or may not equal the literal `1e-5` depending on the V8
 * version, while `Number('1e-5')` always does.
 *
 * CI caught this: `10 ** -5` produced 0.000009999999999999999 on the runner's Node and
 * 0.000010000000000000000818 (the literal) on the development machine, one ULP apart. That matters
 * beyond a failing assertion, because mintick is the unit of nearly all price arithmetic here —
 * spreads in points, stop distances, tick snapping — so a mintick that drifts by an ULP makes
 * backtest results depend on which Node built them.
 */
function tickForDigits(digits: number): number {
  return Number(`1e-${String(digits)}`);
}

function fx(pair: string, opts: FxOptions = {}): SymbolSpec {
  const digits = opts.digits ?? 5;
  const mintick = tickForDigits(digits);
  return {
    symbol: pair,
    assetClass: 'fx',
    baseCcy: pair.slice(0, 3),
    quoteCcy: pair.slice(3, 6),
    digits,
    mintick,
    pipSize: mintick * 10,
    contractSize: 100_000,
    pointValue: 1,
    defaultSpreadPoints: opts.defaultSpreadPoints ?? 10,
    providerSymbols: {
      dukascopy: pair.toLowerCase(),
      // Twelve Data names forex pairs with a slash.
      twelvedata: `${pair.slice(0, 3)}/${pair.slice(3, 6)}`,
    },
    sessionType: 'fx24x5',
    enabled: true,
  };
}

export const SEED_SYMBOLS: readonly SymbolSpec[] = [
  /* ---- fx majors ---- */
  fx('EURUSD', { defaultSpreadPoints: 8 }),
  fx('GBPUSD', { defaultSpreadPoints: 12 }),
  fx('USDJPY', { digits: 3, defaultSpreadPoints: 10 }),
  fx('USDCHF', { defaultSpreadPoints: 14 }),
  fx('AUDUSD', { defaultSpreadPoints: 12 }),
  fx('NZDUSD', { defaultSpreadPoints: 18 }),
  fx('USDCAD', { defaultSpreadPoints: 15 }),

  /* ---- fx crosses ---- */
  fx('EURJPY', { digits: 3, defaultSpreadPoints: 14 }),
  fx('GBPJPY', { digits: 3, defaultSpreadPoints: 20 }),
  fx('EURGBP', { defaultSpreadPoints: 14 }),

  /* ---- metals ---- */
  {
    symbol: 'XAUUSD',
    assetClass: 'metal',
    baseCcy: 'XAU',
    quoteCcy: 'USD',
    digits: 2,
    mintick: 0.01,
    // Gold is conventionally quoted in 0.1 pips.
    pipSize: 0.1,
    contractSize: 100,
    pointValue: 1,
    defaultSpreadPoints: 20,
    providerSymbols: { dukascopy: 'xauusd', twelvedata: 'XAU/USD' },
    sessionType: 'fx24x5',
    enabled: true,
  },
  {
    symbol: 'XAGUSD',
    assetClass: 'metal',
    baseCcy: 'XAG',
    quoteCcy: 'USD',
    digits: 3,
    mintick: 0.001,
    pipSize: 0.01,
    contractSize: 5_000,
    pointValue: 1,
    defaultSpreadPoints: 25,
    providerSymbols: { dukascopy: 'xagusd', twelvedata: 'XAG/USD' },
    sessionType: 'fx24x5',
    enabled: true,
  },

  /* ---- crypto ---- */
  {
    symbol: 'BTCUSD',
    assetClass: 'crypto',
    baseCcy: 'BTC',
    quoteCcy: 'USD',
    digits: 2,
    mintick: 0.01,
    pipSize: 0.01,
    contractSize: 1,
    pointValue: 1,
    defaultSpreadPoints: 400,
    // Binance spot has no BTCUSD pair; USDT is the liquid proxy.
    providerSymbols: { dukascopy: 'btcusd', binance: 'BTCUSDT', twelvedata: 'BTC/USD' },
    sessionType: 'crypto24x7',
    enabled: true,
  },
  {
    symbol: 'ETHUSD',
    assetClass: 'crypto',
    baseCcy: 'ETH',
    quoteCcy: 'USD',
    digits: 2,
    mintick: 0.01,
    pipSize: 0.01,
    contractSize: 1,
    pointValue: 1,
    defaultSpreadPoints: 100,
    providerSymbols: { dukascopy: 'ethusd', binance: 'ETHUSDT', twelvedata: 'ETH/USD' },
    sessionType: 'crypto24x7',
    enabled: true,
  },

  /* ---- index CFDs: Dukascopy does offer these, verified against instrumentMetaData ---- */
  index('US500', 'US 500 Index', 'usa500idxusd', 'USD', 6),
  index('US30', 'US 30 Index', 'usa30idxusd', 'USD', 40),
  index('USTEC', 'US 100 Tech Index', 'usatechidxusd', 'USD', 20),

  /* ---- energy ---- */
  {
    symbol: 'USOIL',
    assetClass: 'energy',
    baseCcy: 'USOIL',
    quoteCcy: 'USD',
    digits: 3,
    mintick: 0.001,
    pipSize: 0.01,
    // Editable: brokers differ on whether a lot is 100 or 1000 barrels.
    contractSize: 1_000,
    pointValue: 1,
    defaultSpreadPoints: 30,
    providerSymbols: { dukascopy: 'lightcmdusd' },
    sessionType: 'fx24x5',
    enabled: true,
  },
  {
    symbol: 'UKOIL',
    assetClass: 'energy',
    baseCcy: 'UKOIL',
    quoteCcy: 'USD',
    digits: 3,
    mintick: 0.001,
    pipSize: 0.01,
    contractSize: 1_000,
    pointValue: 1,
    defaultSpreadPoints: 30,
    providerSymbols: { dukascopy: 'brentcmdusd' },
    sessionType: 'fx24x5',
    enabled: true,
  },
];

/** Index CFDs are quoted to 1 decimal and sized 1 unit per lot by default. */
function index(
  symbol: string,
  _description: string,
  dukascopyId: string,
  quoteCcy: string,
  defaultSpreadPoints: number,
): SymbolSpec {
  return {
    symbol,
    assetClass: 'index',
    baseCcy: symbol,
    quoteCcy,
    digits: 1,
    mintick: 0.1,
    pipSize: 0.1,
    // Editable in Settings; brokers vary.
    contractSize: 1,
    pointValue: 1,
    defaultSpreadPoints,
    providerSymbols: { dukascopy: dukascopyId },
    sessionType: 'fx24x5',
    enabled: true,
  };
}

const BY_SYMBOL: ReadonlyMap<string, SymbolSpec> = new Map(SEED_SYMBOLS.map((s) => [s.symbol, s]));

export function findSeedSymbol(symbol: string): SymbolSpec | undefined {
  return BY_SYMBOL.get(symbol.toUpperCase());
}

export function getSeedSymbol(symbol: string): SymbolSpec {
  const spec = findSeedSymbol(symbol);
  if (spec === undefined) {
    throw new Error(`Unknown symbol: ${symbol}`);
  }
  return spec;
}

export function seedSymbolsByAssetClass(assetClass: AssetClass): readonly SymbolSpec[] {
  return SEED_SYMBOLS.filter((s) => s.assetClass === assetClass);
}

/**
 * Smallest price increment — MT5's "point". Spreads and slippage are quoted in these.
 * Prefer the stored mintick over deriving it from digits, because index and energy
 * contracts are user-editable.
 */
export function pointSize(spec: Pick<SymbolSpec, 'mintick'>): number {
  return spec.mintick;
}

/** Convert a spread in points to a price delta. */
export function pointsToPrice(spec: Pick<SymbolSpec, 'mintick'>, points: number): number {
  return points * spec.mintick;
}

/** Convert a price delta to points. */
export function priceToPoints(spec: Pick<SymbolSpec, 'mintick'>, price: number): number {
  return price / spec.mintick;
}

/** Look up which identifier a provider knows this symbol by. */
export function providerSymbolFor(spec: SymbolSpec, provider: string): string | undefined {
  return (spec.providerSymbols as Record<string, string | undefined>)[provider];
}
