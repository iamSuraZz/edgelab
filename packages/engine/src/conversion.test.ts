import { describe, expect, it } from 'vitest';
import { getSeedSymbol, type Bar } from '@edgelab/shared';

import {
  MissingConversionPairError,
  buildRateAt,
  conversionWindow,
  initialCapitalInQuote,
  planConversion,
  resolveConversion,
} from './conversion';

/**
 * The USDJPY hand check from slice E's DONE WHEN, done on the arithmetic.
 *
 * Every figure below is computed by hand in the comments, not copied from a run. Direction is the
 * thing worth checking this hard: inverting USDJPY the wrong way gives P&L wrong by a factor of
 * ~150², which still looks like a plausible amount of money.
 */

const H1 = 3_600_000;
const T0 = Date.UTC(2024, 0, 2, 0, 0);

const KNOWN = new Set(['EURUSD', 'USDJPY', 'GBPUSD', 'EURGBP', 'BTCUSD']);
const known = (s: string): boolean => KNOWN.has(s);

function bar(time: number, close: number): Bar {
  return { time, open: close, high: close, low: close, close, volume: 1 };
}

describe('which pair, and which way round', () => {
  it('USDJPY on a USD account inverts, because USDJPY quotes JPY per USD', () => {
    // The instrument is quoted in JPY; we need USD per JPY; USDJPY gives JPY per USD.
    const plan = planConversion('JPY', 'USD', known);
    expect(plan).toEqual({ kind: 'pair', pair: { symbol: 'USDJPY', invert: true } });
  });

  it('EURGBP on a USD account uses GBPUSD directly, because it already quotes USD per GBP', () => {
    const plan = planConversion('GBP', 'USD', known);
    expect(plan).toEqual({ kind: 'pair', pair: { symbol: 'GBPUSD', invert: false } });
  });

  it('is the identity when the quote currency is already the account currency', () => {
    expect(planConversion('USD', 'USD', known)).toEqual({ kind: 'identity' });
    // Case does not matter — a symbol registry and a user both write these inconsistently.
    expect(planConversion('usd', 'USD', known)).toEqual({ kind: 'identity' });
  });

  it('refuses to invent a pair nobody quotes', () => {
    // Neither JPYGBP nor GBPJPY is in the known set here, so there is no single-pair route.
    expect(planConversion('JPY', 'GBP', (s) => s === 'EURUSD')).toBeNull();
  });
});

describe('the rate series', () => {
  const bars = [bar(T0, 150), bar(T0 + H1, 151), bar(T0 + 2 * H1, 149)];

  it('inverts USDJPY into USD per JPY', () => {
    const rateAt = buildRateAt({ pair: { symbol: 'USDJPY', invert: true }, bars });
    // 1 / 150 = 0.006666…  — one yen is two thirds of a US cent.
    expect(rateAt(T0)).toBeCloseTo(1 / 150, 12);
    expect(rateAt(T0 + H1)).toBeCloseTo(1 / 151, 12);
  });

  it('uses a direct pair unchanged', () => {
    const gbp = [bar(T0, 1.27)];
    const rateAt = buildRateAt({ pair: { symbol: 'GBPUSD', invert: false }, bars: gbp });
    expect(rateAt(T0)).toBeCloseTo(1.27, 12);
  });

  it('holds the last rate at or before the instant, never a later one', () => {
    // Using a later bar's rate would be look-ahead in the reporting layer — the same class of
    // error the validation slice exists to catch, committed on the way out.
    const rateAt = buildRateAt({ pair: { symbol: 'USDJPY', invert: true }, bars });
    expect(rateAt(T0 + H1 + 60_000)).toBeCloseTo(1 / 151, 12);
    expect(rateAt(T0 + 2 * H1 - 1)).toBeCloseTo(1 / 151, 12);
    expect(rateAt(T0 + 2 * H1)).toBeCloseTo(1 / 149, 12);
  });

  it('falls back to the FIRST known rate before the series starts, not to 1', () => {
    // Falling back to 1 would silently report unconverted yen as dollars.
    const rateAt = buildRateAt({ pair: { symbol: 'USDJPY', invert: true }, bars });
    expect(rateAt(T0 - H1)).toBeCloseTo(1 / 150, 12);
  });

  it('refuses to build a rate with no bars', () => {
    expect(() => buildRateAt({ pair: { symbol: 'USDJPY', invert: true }, bars: [] })).toThrow(
      /cannot convert/i,
    );
  });
});

describe('the USDJPY hand check — two trades', () => {
  /**
   * Account: USD 10,000. Instrument: USDJPY, so the engine runs in JPY.
   * Contract size 100,000; 1 lot = 100,000 units. `pointValue` 1.
   *
   * Conversion bars (USDJPY close): entry-day 150.00, exit-day 151.00 for trade 1;
   * 149.00 at trade 2's exit.
   *
   * TRADE 1 — long 1 lot, entry 150.00, exit 150.50.
   *   Engine P&L, in JPY:  (150.50 − 150.00) × 100,000 = 50,000 JPY
   *   Converted at the EXIT bar's rate, 1/151:
   *     50,000 / 151 = 331.1258 USD (331.125827814569…)
   *
   * TRADE 2 — short 1 lot, entry 151.00, exit 149.00.
   *   Engine P&L, in JPY:  (151.00 − 149.00) × 100,000 = 200,000 JPY
   *   Converted at 1/149:
   *     200,000 / 149 = 1342.2819 USD (1342.28187919463…)
   *
   * Total: 331.1258 + 1342.2819 = 1673.4077 USD
   */
  const conversionBars = [bar(T0, 150), bar(T0 + H1, 151), bar(T0 + 2 * H1, 149)];
  const rateAt = buildRateAt({ pair: { symbol: 'USDJPY', invert: true }, bars: conversionBars });

  const UNITS = 100_000;

  it('trade 1: 50,000 JPY at 151 is 331.13 USD', () => {
    const jpy = (150.5 - 150.0) * UNITS;
    expect(jpy).toBe(50_000);

    const usd = jpy * rateAt(T0 + H1);
    expect(usd).toBeCloseTo(50_000 / 151, 9);
    expect(usd).toBeCloseTo(331.1258, 4);
  });

  it('trade 2: 200,000 JPY at 149 is 1342.28 USD', () => {
    const jpy = (151.0 - 149.0) * UNITS;
    expect(jpy).toBe(200_000);

    const usd = jpy * rateAt(T0 + 2 * H1);
    expect(usd).toBeCloseTo(200_000 / 149, 9);
    expect(usd).toBeCloseTo(1342.2819, 4);
  });

  it('the two together come to 1673.41 USD', () => {
    const total = 50_000 * rateAt(T0 + H1) + 200_000 * rateAt(T0 + 2 * H1);
    expect(total).toBeCloseTo(1673.4077, 4);
  });

  it('inverting the wrong way is off by ~150², which is why direction is tested', () => {
    // 50,000 × 151 = 7,550,000 — still "money", and 22,805× the right answer.
    const wrongWay = buildRateAt({
      pair: { symbol: 'USDJPY', invert: false },
      bars: conversionBars,
    });
    const wrong = 50_000 * wrongWay(T0 + H1);
    expect(wrong).toBe(7_550_000);
    expect(wrong / (50_000 / 151)).toBeCloseTo(151 * 151, 6);
  });

  it('restates the starting capital into the quote currency at the first bar', () => {
    // USD 10,000 at 1/150 USD per JPY is 1,500,000 JPY.
    expect(initialCapitalInQuote(10_000, rateAt(T0))).toBeCloseTo(1_500_000, 6);
  });

  it('rejects a non-positive rate rather than producing an infinity', () => {
    expect(() => initialCapitalInQuote(10_000, 0)).toThrow(RangeError);
  });
});

describe('resolving a run', () => {
  const usdjpy = getSeedSymbol('USDJPY');
  const eurusd = getSeedSymbol('EURUSD');

  const base = {
    accountCurrency: 'USD',
    fromMs: T0,
    toMs: T0 + 3 * H1,
    known,
  };

  it('is the identity for a USD-quoted symbol, and loads nothing', () => {
    let loads = 0;
    const outcome = resolveConversion({
      ...base,
      symbol: eurusd,
      loadBars: () => {
        loads += 1;
        return [];
      },
    });

    expect(outcome.kind).toBe('identity');
    expect(loads, 'identity must not touch storage').toBe(0);
    if (outcome.kind === 'identity') expect(outcome.rateAt(T0)).toBe(1);
  });

  it('converts a JPY-quoted symbol through USDJPY', () => {
    const outcome = resolveConversion({
      ...base,
      symbol: usdjpy,
      loadBars: () => [bar(T0, 150)],
    });

    expect(outcome.kind).toBe('converted');
    if (outcome.kind === 'converted') {
      expect(outcome.pair).toEqual({ symbol: 'USDJPY', invert: true });
      expect(outcome.rateAt(T0)).toBeCloseTo(1 / 150, 12);
    }
  });

  it('names the exact download when the pair has no stored bars', () => {
    // Spec 03: "If that pair's data is missing, queue its download and tell me."
    const outcome = resolveConversion({ ...base, symbol: usdjpy, loadBars: () => [] });

    expect(outcome.kind).toBe('needs-data');
    if (outcome.kind === 'needs-data') {
      expect(outcome.missing.symbol).toBe('USDJPY');
      expect(outcome.missing.reason).toContain('quoted in JPY');
      expect(outcome.missing.reason).toContain('USDJPY');
      // Padded backwards so the run's first bar has a rate at or before it.
      expect(outcome.missing.fromMs).toBe(T0 - 86_400_000);
    }
  });

  it('asks for the conversion bars over a backward-padded window', () => {
    const requested: { fromMs: number; toMs: number }[] = [];
    resolveConversion({
      ...base,
      symbol: usdjpy,
      loadBars: (_s, fromMs, toMs) => {
        requested.push({ fromMs, toMs });
        return [bar(T0, 150)];
      },
    });

    expect(requested[0]).toEqual(conversionWindow(base.fromMs, base.toMs));
  });

  it('throws when no single pair can link the two currencies', () => {
    expect(() =>
      resolveConversion({
        ...base,
        accountCurrency: 'GBP',
        symbol: usdjpy,
        known: (s) => s === 'EURUSD',
        loadBars: () => [],
      }),
    ).toThrow(MissingConversionPairError);
  });
});
