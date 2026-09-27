import { describe, expect, it } from 'vitest';
import { getSeedSymbol, type Bar } from '@edgelab/shared';

import type { RunResult } from '../pine-engine';
import { PineTsEngine } from './adapter';

/**
 * P&L sign convention, from first principles.
 *
 * The zero-cost cross-check cannot catch a sign error: it only proves our equity reconstruction
 * agrees with the engine's, so a side flipped in BOTH agrees perfectly and is wrong twice.
 * These tests instead assert the one thing no reconstruction can fake — that a long held
 * through a RISING market makes money, a short through the same market loses it, and each
 * amount equals the fill-price difference times quantity.
 *
 * The series rises monotonically, so the direction of every P&L is known before running
 * anything. One trade per script, opened near the start and closed near the end, so the
 * expected value is arithmetic rather than a simulation.
 */

const M1 = 60_000;
const T0 = Date.UTC(2024, 0, 2, 0, 0); // Tuesday, fx session open
const eurusd = getSeedSymbol('EURUSD');

/**
 * A strictly rising series with no noise.
 *
 * Deliberately boring: any wobble would make "did the long make money" depend on exactly which
 * bar filled, which is what the golden snapshots are for. Here the answer must hold for ANY
 * pair of fills, which makes a sign error unmissable.
 */
function risingM1(count: number): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < count; i += 1) {
    const mid = 1.1 + i * 1e-5;
    bars.push({
      time: T0 + i * M1,
      open: round5(mid),
      high: round5(mid + 2e-5),
      low: round5(mid - 2e-5),
      close: round5(mid + 1e-5),
      volume: 100,
      spread: 0,
    });
  }
  return bars;
}

function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

const BARS = risingM1(3_000);

const engine = new PineTsEngine({
  m1: {
    readM1: (_symbol, fromMs, toMs) =>
      Promise.resolve(BARS.filter((b) => b.time >= fromMs && b.time < toMs)),
  },
  lookupSymbol: (code) => (code === 'EURUSD' ? eurusd : undefined),
});

/** Enter on the second bar, exit near the end. `qty` is in contracts, as Pine counts. */
const QTY = 10_000;

const LONG_ONCE = `//@version=5
strategy("Long once", overlay=true, default_qty_type=strategy.fixed, default_qty_value=${String(QTY)})
if bar_index == 2
    strategy.entry("L", strategy.long)
if bar_index == 150
    strategy.close("L")
`;

const SHORT_ONCE = `//@version=5
strategy("Short once", overlay=true, default_qty_type=strategy.fixed, default_qty_value=${String(QTY)})
if bar_index == 2
    strategy.entry("S", strategy.short)
if bar_index == 150
    strategy.close("S")
`;

function run(source: string): Promise<RunResult> {
  return engine.run({
    source,
    symbol: eurusd,
    timeframe: 'M15',
    fromMs: BARS[0]!.time,
    toMs: BARS[BARS.length - 1]!.time + M1,
    warmupBars: 0,
  });
}

describe('P&L sign convention on a rising market', () => {
  it('a long that buys low and sells high earns the price difference times qty', async () => {
    const result = await run(LONG_ONCE);

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;

    expect(trade.side).toBe('long');
    expect(trade.exitPrice).not.toBeNull();
    expect(trade.qty).toBe(QTY);

    // The market only rises, so a long held across bars must have exited above its entry.
    expect(trade.exitPrice!).toBeGreaterThan(trade.entryPrice);

    // The identity. `EngineTrade.netPnl` is the ENGINE's P&L before our cost overlay, and the
    // fixture sets no commission, so it must equal the fill difference times quantity exactly.
    const expected = (trade.exitPrice! - trade.entryPrice) * trade.qty;
    expect(trade.netPnl!).toBeCloseTo(expected, 6);
    expect(trade.netPnl!).toBeGreaterThan(0);
  });

  it('a short in the same market loses exactly what the long made', async () => {
    const [long, short] = await Promise.all([run(LONG_ONCE), run(SHORT_ONCE)]);

    const l = long.trades[0]!;
    const s = short.trades[0]!;

    expect(s.side).toBe('short');
    expect(s.exitPrice).not.toBeNull();

    // Reversed difference for a short: this is the assertion a flipped sign fails.
    const expected = (s.entryPrice - s.exitPrice!) * s.qty;
    expect(s.netPnl!).toBeCloseTo(expected, 6);
    expect(s.netPnl!).toBeLessThan(0);

    // Same bars, same fills, opposite sides: the two figures must be mirror images. If both
    // came out negative — the classic double sign error — this is what catches it.
    expect(s.netPnl!).toBeCloseTo(-l.netPnl!, 6);
  });

  it('the fills themselves move the right way', async () => {
    // A long entered before it exited on a rising series must have paid less than it received;
    // a short the reverse. Catches an entry/exit swap, which leaves P&L magnitude intact.
    const [long, short] = await Promise.all([run(LONG_ONCE), run(SHORT_ONCE)]);

    const l = long.trades[0]!;
    const s = short.trades[0]!;

    expect(l.entryBar).toBeLessThan(l.exitBar!);
    expect(s.entryBar).toBeLessThan(s.exitBar!);
    expect(l.entryPrice).toBeLessThan(l.exitPrice!);
    expect(s.entryPrice).toBeLessThan(s.exitPrice!);
  });

  it('a long and a short cannot both be profitable on a monotone series', async () => {
    // The sanity property behind the whole test: on a market that only goes one way, one side
    // must lose. Three fixtures all showing PF 0.09 is what made this worth asserting.
    const [long, short] = await Promise.all([run(LONG_ONCE), run(SHORT_ONCE)]);

    const lp = long.trades[0]!.netPnl!;
    const sp = short.trades[0]!.netPnl!;

    expect(lp > 0 && sp > 0).toBe(false);
    expect(lp).toBeGreaterThan(0);
    expect(sp).toBeLessThan(0);
  });
});
