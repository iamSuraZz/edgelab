import { describe, expect, it } from 'vitest';
import { getSeedSymbol, DEFAULT_COSTS, type Bar } from '@edgelab/shared';

import { applyCosts } from '../costs';
import { PineTsEngine } from './adapter';

/**
 * The measured per-bar spread must reach the cost overlay.
 *
 * Regression cover for a silent overcharge. PineTS's `Kline` type has no spread field, so the
 * resampled spread was dropped at the engine boundary and `klinesToBars` hardcoded `spread:
 * null`. `spreadPriceAt` then fell back to `symbol.defaultSpreadPoints` on EVERY trade — 8
 * points on EURUSD, against ~3.5 measured in the stored data — so spec 04's "a run with no
 * costs file uses the per-bar spreads from the data" silently did not hold, and every backtest
 * was charged roughly twice the real spread.
 *
 * Nothing failed visibly, which is the point: the fallback exists so a bar with no spread is
 * never free, and it made the bug look like a working feature.
 *
 * The golden snapshots could not have caught it either. They build synthetic bars with
 * `spread: 0.00008`, which is EXACTLY EURUSD's 8-point default — so the measured value and the
 * fallback were the same number and the snapshots were identical either way. Hence the
 * deliberately different 3 points here.
 */

const M1 = 60_000;
const T0 = Date.UTC(2024, 0, 2, 0, 0);
const eurusd = getSeedSymbol('EURUSD');

/** 3 points, deliberately different from EURUSD's 8-point default so the two are separable. */
const MEASURED_SPREAD = 0.00003;

function syntheticM1(count: number, spread: number | null): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < count; i += 1) {
    const mid = 1.1 + Math.sin(i / 25) * 0.01 + i * 2e-7;
    out.push({
      time: T0 + i * M1,
      open: mid,
      high: mid + 3e-4,
      low: mid - 3e-4,
      close: mid + 1e-5,
      volume: 100,
      ...(spread === null ? {} : { spread }),
    });
  }
  return out;
}

const ONE_TRADE = `//@version=5
strategy("One trade", default_qty_type=strategy.fixed, default_qty_value=1)
if bar_index == 5
    strategy.entry("L", strategy.long)
if bar_index == 20
    strategy.close("L")
`;

function engineFor(bars: readonly Bar[]): PineTsEngine {
  return new PineTsEngine({
    m1: {
      readM1: (_s, f, t) => Promise.resolve(bars.filter((b) => b.time >= f && b.time < t)),
    },
    lookupSymbol: (c) => (c === 'EURUSD' ? eurusd : undefined),
  });
}

async function runOn(bars: readonly Bar[]): ReturnType<PineTsEngine['run']> {
  return engineFor(bars).run({
    source: ONE_TRADE,
    symbol: eurusd,
    timeframe: 'M15',
    fromMs: bars[0]!.time,
    toMs: bars[bars.length - 1]!.time + M1,
    warmupBars: 0,
  });
}

describe('per-bar spread reaches the cost overlay', () => {
  it('surfaces the resampled spread on the run bars', async () => {
    const result = await runOn(syntheticM1(6_000, MEASURED_SPREAD));

    expect(result.bars.length).toBeGreaterThan(0);
    // Every bucket is built from M1 bars that all carry the same spread, so the weighted mean
    // is that same value.
    for (const bar of result.bars) {
      expect(bar.spread).toBeCloseTo(MEASURED_SPREAD, 12);
    }
  });

  it('charges the MEASURED spread, not the symbol default', async () => {
    const result = await runOn(syntheticM1(6_000, MEASURED_SPREAD));

    const costed = applyCosts({
      trades: result.trades,
      bars: result.bars,
      symbol: eurusd,
      config: DEFAULT_COSTS,
      quoteToAccount: () => 1,
    });

    expect(costed).toHaveLength(1);

    // Spread is charged once per round trip on the CONTRACT quantity the script traded, which
    // is the engine trade's qty. `CostedTrade.qty` is the same size expressed in LOTS, so it is
    // 1e-5 of this and must not be used for the arithmetic.
    const units = result.trades[0]!.qty;
    const expected = MEASURED_SPREAD * units * eurusd.pointValue;
    expect(costed[0]!.spreadCost).toBeCloseTo(expected, 12);

    // And decisively NOT the default, which is what it used to charge.
    const defaultCharge = eurusd.defaultSpreadPoints * eurusd.mintick * units * eurusd.pointValue;
    expect(costed[0]!.spreadCost).toBeLessThan(defaultCharge);
    expect(defaultCharge / costed[0]!.spreadCost).toBeCloseTo(8 / 3, 6);
  });

  it('still falls back to the symbol default when the data measured nothing', async () => {
    // The fallback is deliberate — a bar with no spread must never be free — so it has to
    // survive the fix.
    const result = await runOn(syntheticM1(6_000, null));

    for (const bar of result.bars) expect(bar.spread).toBeNull();

    const costed = applyCosts({
      trades: result.trades,
      bars: result.bars,
      symbol: eurusd,
      config: DEFAULT_COSTS,
      quoteToAccount: () => 1,
    });

    const units = result.trades[0]!.qty;
    const expected = eurusd.defaultSpreadPoints * eurusd.mintick * units * eurusd.pointValue;
    expect(costed[0]!.spreadCost).toBeCloseTo(expected, 12);
  });
});
