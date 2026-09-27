import { describe, expect, it } from 'vitest';
import { SymbolSpecSchema } from './market';
import {
  SEED_SYMBOLS,
  findSeedSymbol,
  getSeedSymbol,
  pointsToPrice,
  pointSize,
  priceToPoints,
  providerSymbolFor,
  seedSymbolsByAssetClass,
} from './symbols';

describe('seed symbol registry', () => {
  it('has unique symbols', () => {
    const codes = SEED_SYMBOLS.map((s) => s.symbol);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('every row satisfies the shared schema', () => {
    for (const spec of SEED_SYMBOLS) {
      const parsed = SymbolSpecSchema.safeParse(spec);
      if (!parsed.success) {
        throw new Error(`${spec.symbol}: ${JSON.stringify(parsed.error.issues)}`);
      }
    }
  });

  it('contains every symbol the spec asked us to seed', () => {
    for (const code of [
      'EURUSD',
      'GBPUSD',
      'USDJPY',
      'USDCHF',
      'AUDUSD',
      'NZDUSD',
      'USDCAD',
      'EURJPY',
      'GBPJPY',
      'EURGBP',
      'XAUUSD',
      'XAGUSD',
      'BTCUSD',
      'ETHUSD',
    ]) {
      expect(findSeedSymbol(code), code).toBeDefined();
    }
  });

  it('covers every asset class', () => {
    for (const cls of ['fx', 'metal', 'index', 'energy', 'crypto'] as const) {
      expect(seedSymbolsByAssetClass(cls).length, cls).toBeGreaterThan(0);
    }
  });

  it('gives every symbol a dukascopy id, since that is the keyless default provider', () => {
    for (const spec of SEED_SYMBOLS) {
      expect(providerSymbolFor(spec, 'dukascopy'), spec.symbol).toBeTruthy();
    }
  });

  it('uses the exact dukascopy ids taken from instrumentMetaData', () => {
    // Regression guard: these are the library's own ids, not a naming convention we
    // invented. The index and commodity ones especially cannot be derived.
    const expected: Record<string, string> = {
      EURUSD: 'eurusd',
      USDJPY: 'usdjpy',
      XAUUSD: 'xauusd',
      XAGUSD: 'xagusd',
      BTCUSD: 'btcusd',
      ETHUSD: 'ethusd',
      US500: 'usa500idxusd',
      US30: 'usa30idxusd',
      USTEC: 'usatechidxusd',
      USOIL: 'lightcmdusd',
      UKOIL: 'brentcmdusd',
    };
    for (const [symbol, id] of Object.entries(expected)) {
      expect(providerSymbolFor(getSeedSymbol(symbol), 'dukascopy'), symbol).toBe(id);
    }
  });

  it('maps crypto to Binance USDT pairs, because spot has no USD pair', () => {
    expect(providerSymbolFor(getSeedSymbol('BTCUSD'), 'binance')).toBe('BTCUSDT');
    expect(providerSymbolFor(getSeedSymbol('ETHUSD'), 'binance')).toBe('ETHUSDT');
  });

  it('marks crypto as 24x7 and everything else as 24x5', () => {
    for (const spec of SEED_SYMBOLS) {
      const expected = spec.assetClass === 'crypto' ? 'crypto24x7' : 'fx24x5';
      expect(spec.sessionType, spec.symbol).toBe(expected);
    }
  });
});

describe('contract specifications', () => {
  it('derives fx currencies from the pair', () => {
    const eurusd = getSeedSymbol('EURUSD');
    expect(eurusd.baseCcy).toBe('EUR');
    expect(eurusd.quoteCcy).toBe('USD');
    expect(eurusd.contractSize).toBe(100_000);
  });

  it('prices JPY pairs to 3 decimals and the rest to 5', () => {
    expect(getSeedSymbol('USDJPY').digits).toBe(3);
    expect(getSeedSymbol('GBPJPY').digits).toBe(3);
    expect(getSeedSymbol('EURUSD').digits).toBe(5);
  });

  it('uses the contract sizes named in the spec', () => {
    expect(getSeedSymbol('EURUSD').contractSize).toBe(100_000);
    expect(getSeedSymbol('XAUUSD').contractSize).toBe(100);
    expect(getSeedSymbol('XAGUSD').contractSize).toBe(5_000);
    expect(getSeedSymbol('BTCUSD').contractSize).toBe(1);
  });

  it('keeps mintick consistent with digits', () => {
    for (const spec of SEED_SYMBOLS) {
      expect(spec.mintick, spec.symbol).toBeCloseTo(10 ** -spec.digits, 12);
    }
  });

  it('makes a pip a whole number of minticks, and at least one', () => {
    for (const spec of SEED_SYMBOLS) {
      const ratio = spec.pipSize / spec.mintick;
      expect(Math.abs(ratio - Math.round(ratio)), spec.symbol).toBeLessThan(1e-6);
      expect(ratio, spec.symbol).toBeGreaterThanOrEqual(1);
    }
  });

  it('defaults pointValue to 1', () => {
    for (const spec of SEED_SYMBOLS) expect(spec.pointValue, spec.symbol).toBe(1);
  });

  it('converts between points and price', () => {
    const eurusd = getSeedSymbol('EURUSD');
    expect(pointSize(eurusd)).toBeCloseTo(0.00001, 12);
    expect(pointsToPrice(eurusd, 10)).toBeCloseTo(0.0001, 12);
    expect(priceToPoints(eurusd, 0.0001)).toBeCloseTo(10, 8);

    const xauusd = getSeedSymbol('XAUUSD');
    expect(pointsToPrice(xauusd, 20)).toBeCloseTo(0.2, 12);
  });

  it('is case-insensitive on lookup and throws on the hard variant', () => {
    expect(findSeedSymbol('eurusd')?.symbol).toBe('EURUSD');
    expect(findSeedSymbol('NOPE99')).toBeUndefined();
    expect(() => getSeedSymbol('NOPE99')).toThrow(/Unknown symbol/);
  });
});
