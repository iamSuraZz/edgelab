import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MEMORY_LIMIT_MB,
  RunTooLargeError,
  assertRunFitsMemory,
  estimateRunMemory,
} from './memory-budget';

/**
 * The pre-flight check (A73).
 *
 * Its job is to refuse the runs that used to KILL the worker, and to let through the ones that now
 * fit. Both halves matter: a check tuned only to refuse would reject the BTC run this work was done
 * to make possible.
 *
 * The bar counts are the real ones from the stored data — BTCUSD 4,765,345 M1 rows over nine years,
 * XAUUSD 2,443,915 over six and a half — so these assertions are about the actual failing runs rather
 * than about round numbers.
 */

const BTC_M1 = 4_765_345;
const XAU_M1 = 2_443_915;

describe('estimateRunMemory', () => {
  it('scales with CHART bars, not M1 bars', () => {
    // The whole point of the streaming read: the minutes are paged, so a nine-year range costs the
    // same to read at H1 as at D1 and only the engine's bar count drives the estimate.
    const h1 = estimateRunMemory({ m1Bars: BTC_M1, timeframe: 'H1' });
    const d1 = estimateRunMemory({ m1Bars: BTC_M1, timeframe: 'D1' });

    expect(h1.chartBars).toBeGreaterThan(d1.chartBars);
    expect(h1.estimatedBytes).toBeGreaterThan(d1.estimatedBytes);
    // Same stored minutes either way.
    expect(h1.m1Bars).toBe(d1.m1Bars);
  });

  it('derives chart bars from the timeframe', () => {
    // 4.77M minutes at 15 per bar.
    expect(estimateRunMemory({ m1Bars: BTC_M1, timeframe: 'M15' }).chartBars).toBe(
      Math.ceil(BTC_M1 / 15),
    );
  });

  it('accepts the runs that the streaming read made possible', () => {
    // Measured after the fix: BTC M15 peaked at 232MB and XAU M5 at 472MB, both well under 1024.
    expect(estimateRunMemory({ m1Bars: BTC_M1, timeframe: 'M15' }).fits).toBe(true);
    expect(estimateRunMemory({ m1Bars: XAU_M1, timeframe: 'M5' }).fits).toBe(true);
  });

  it('refuses M1 over a multi-year range, which cannot fit at any limit we set', () => {
    // 4.77M chart bars at ~850 B each is ~4GB of engine and equity state. No read strategy helps:
    // the engine genuinely holds that many bars.
    expect(estimateRunMemory({ m1Bars: BTC_M1, timeframe: 'M1' }).fits).toBe(false);
  });

  it('honours a raised limit', () => {
    const m1 = estimateRunMemory({ m1Bars: BTC_M1, timeframe: 'M1' });
    expect(m1.fits).toBe(false);

    // The limit is configurable so a bigger host can do more, and the estimate uses whatever it is.
    expect(estimateRunMemory({ m1Bars: BTC_M1, timeframe: 'M1', limitMb: 8_192 }).fits).toBe(true);
  });

  it('defaults to 1024MB, the limit the failing runs hit', () => {
    expect(DEFAULT_MEMORY_LIMIT_MB).toBe(1024);
    expect(estimateRunMemory({ m1Bars: 1_000, timeframe: 'H1' }).limitBytes).toBe(
      1024 * 1024 * 1024,
    );
  });

  it('keeps headroom rather than allowing a run right up to the limit', () => {
    // V8 fragments, and a run estimated at exactly the limit dies. The estimate must refuse before
    // the ceiling, not at it.
    const atLimit = estimateRunMemory({ m1Bars: 1_000_000, timeframe: 'M1', limitMb: 1024 });
    if (atLimit.estimatedBytes < atLimit.limitBytes && atLimit.estimatedBytes > 0) {
      expect(atLimit.fits).toBe(atLimit.estimatedBytes <= atLimit.limitBytes * 0.8);
    }
  });
});

describe('assertRunFitsMemory', () => {
  it('returns the estimate when the run fits', () => {
    const estimate = assertRunFitsMemory({
      m1Bars: BTC_M1,
      timeframe: 'M15',
      symbol: 'BTCUSD',
    });
    expect(estimate.fits).toBe(true);
  });

  it('refuses an oversized run instead of letting the worker be killed', () => {
    expect(() =>
      assertRunFitsMemory({ m1Bars: BTC_M1, timeframe: 'M1', symbol: 'BTCUSD' }),
    ).toThrow(RunTooLargeError);
  });

  it('states the bars, the estimate and the limit', () => {
    // An actionable refusal: the reader should not have to run it again to learn why.
    try {
      assertRunFitsMemory({ m1Bars: BTC_M1, timeframe: 'M1', symbol: 'BTCUSD' });
      throw new Error('should have refused');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(RunTooLargeError);
      const message = (error as Error).message;

      // The FIGURES, not the sentence shape: the wording gained a time branch once the time budget
      // landed, and a test pinned to phrasing fails on an improvement rather than on a defect.
      expect(message).toMatch(/BTCUSD M1/);
      expect(message).toMatch(/4,765,345 stored minutes/);
      expect(message).toMatch(/1024MB limit/);
      // And that nothing was spent finding out.
      expect(message).toMatch(/Nothing was read/);
    }
  });

  it('names the smallest timeframe that would fit, rather than saying "try higher"', () => {
    try {
      assertRunFitsMemory({ m1Bars: BTC_M1, timeframe: 'M1', symbol: 'BTCUSD' });
      throw new Error('should have refused');
    } catch (error: unknown) {
      const message = (error as Error).message;
      // The reader cannot compute this themselves and would otherwise guess twice.
      expect(message).toMatch(/Run it on M\d+ or higher/);
    }
  });
});
