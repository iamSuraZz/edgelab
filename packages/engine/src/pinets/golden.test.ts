import { describe, expect, it } from 'vitest';
import { getSeedSymbol, type Bar } from '@edgelab/shared';

import { STRATEGY_FIXTURES } from '../fixtures';
import type { EngineTrade, RunResult } from '../pine-engine';
import { PineTsEngine } from './adapter';

/**
 * Trade-level golden snapshots for every shipped fixture.
 *
 * These are regression detectors, not correctness proofs — `fills.test.ts` holds the
 * hand-verified arithmetic. The job here is to fail loudly if a PineTS upgrade, a resampler
 * change or an instrumentation tweak silently moves a fill, because the symptom of that
 * otherwise is a backtest that is merely slightly wrong.
 *
 * Bars come from a deterministic synthetic series, never the database, so the snapshots do
 * not depend on stored data or on a provider still being reachable.
 *
 * WHEN ONE OF THESE FAILS: do not reach for `-u` first. Read the diff. A changed entry price
 * or bar index means execution moved, which is a bug until proven otherwise. Only update the
 * snapshot once you can say which change caused it and why the new numbers are right.
 */

const M1 = 60_000;
const T0 = Date.UTC(2024, 0, 2, 0, 0); // Tuesday, fx session open

/**
 * Two superimposed sines plus a slow drift: the fast component triggers oscillator crossings,
 * the slow one produces trends for the breakout and trailing strategies, and the drift keeps
 * longs and shorts from being symmetric. Deterministic — no RNG, no Date.now().
 */
function syntheticM1(count: number): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < count; i += 1) {
    const mid = 1.1 + Math.sin(i / 25) * 0.01 + Math.sin(i / 260) * 0.02 + i * 2e-7;
    const wobble = 0.0004 + Math.abs(Math.cos(i / 11)) * 0.0003;
    bars.push({
      time: T0 + i * M1,
      open: round5(mid),
      high: round5(mid + wobble),
      low: round5(mid - wobble),
      close: round5(mid + wobble * Math.sin(i / 7) * 0.5),
      volume: 100 + (i % 17),
      spread: 0.00008,
    });
  }
  return bars;
}

/** Snap to the instrument's 5 decimals so bar prices are representable, like real data. */
function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

/**
 * 40,000 M1 bars (~28 days of continuous minutes). Sized by the most demanding fixture:
 * macd-htf-filter filters on an H4 EMA(50), which needs ~150 H4 bars before it means
 * anything — 6,000 M1 bars is 25 H4 bars, so that fixture took no trades at all and its
 * snapshot would have been an empty array that passed forever.
 */
const BARS = syntheticM1(40_000);
const eurusd = getSeedSymbol('EURUSD');

const engine = new PineTsEngine({
  m1: {
    readM1: (_symbol, fromMs, toMs) =>
      Promise.resolve(BARS.filter((b) => b.time >= fromMs && b.time < toMs)),
  },
  lookupSymbol: (code) => (code === 'EURUSD' ? eurusd : undefined),
});

/** M15 over the whole series, with warmup so the HTF-filter fixture has history to work with. */
const FROM = BARS[1200]!.time;
const TO = BARS[BARS.length - 1]!.time + M1;

// Each fixture is asserted from three angles; without memoizing, that is three identical
// runs per fixture and eighteen for the suite.
const RUN_CACHE = new Map<string, Promise<RunResult>>();

function runFixture(source: string): Promise<RunResult> {
  const cached = RUN_CACHE.get(source);
  if (cached !== undefined) return cached;
  const pending = engine.run({
    source,
    symbol: eurusd,
    timeframe: 'M15',
    fromMs: FROM,
    toMs: TO,
    warmupBars: 400,
  });
  RUN_CACHE.set(source, pending);
  return pending;
}

/**
 * The snapshot shape. Prices are fixed to the instrument's digits and P&L to 2 decimals so a
 * float-noise change in the last bit cannot fail the test, while a real one-tick move in a
 * fill still does.
 */
function snapshotTrade(trade: EngineTrade): Record<string, unknown> {
  return {
    id: trade.id,
    entryId: trade.entryId,
    side: trade.side,
    qty: trade.qty,
    entryBar: trade.entryBar,
    entryPrice: trade.entryPrice.toFixed(eurusd.digits),
    exitBar: trade.exitBar,
    exitPrice: trade.exitPrice === null ? null : trade.exitPrice.toFixed(eurusd.digits),
    exitId: trade.exitId,
    netPnl: trade.netPnl === null ? null : Number(trade.netPnl.toFixed(2)),
    status: trade.status,
  };
}

describe.each(STRATEGY_FIXTURES.map((f) => [f.id, f.source] as const))(
  'golden snapshot — %s',
  (id, source) => {
    it('produces the same trades, bar for bar', async () => {
      const result = await runFixture(source);

      // A snapshot of zero trades would silently "pass" forever if the engine broke, so the
      // fixtures have to actually trade on this series.
      expect(result.trades.length, `${id} must produce trades`).toBeGreaterThan(0);

      await expect(result.trades.map(snapshotTrade)).toMatchFileSnapshot(
        `./__snapshots__/trades-${id}.json.snap`,
      );
    });

    it('produces the same run summary', async () => {
      const result = await runFixture(source);

      await expect({
        barsProcessed: result.stats.barsProcessed,
        closedTrades: result.stats.closedTrades,
        openTrades: result.stats.openTrades,
        netprofit:
          result.stats.netprofit === null ? null : Number(result.stats.netprofit.toFixed(2)),
        plots: result.plots.map((p) => p.title).sort(),
        orderLogSize: result.orderLog.length,
        suppressedOrders: result.stats.suppressedOrders,
        // runtimeMs is deliberately absent: it differs every run.
      }).toMatchFileSnapshot(`./__snapshots__/summary-${id}.json.snap`);
    });

    it('holds the invariants a snapshot cannot express', async () => {
      const result = await runFixture(source);

      // Unique ids — the property the run_trades primary key depends on.
      const ids = result.trades.map((t) => t.id);
      expect(new Set(ids).size, `${id} trade ids are unique`).toBe(ids.length);

      for (const trade of result.trades) {
        expect(trade.qty, 'qty positive').toBeGreaterThan(0);
        expect(trade.entryPrice, 'entry price finite').toBeTypeOf('number');
        expect(Number.isFinite(trade.entryPrice)).toBe(true);

        // No position may open before the requested window — the warmup gate's whole job.
        expect(trade.entryTime, 'entry inside the window').toBeGreaterThanOrEqual(FROM);

        if (trade.status === 'closed') {
          expect(trade.exitTime, 'closed trade has an exit time').not.toBeNull();
          expect(trade.exitTime!).toBeGreaterThanOrEqual(trade.entryTime);
          expect(trade.netPnl, 'closed trade has P&L').not.toBeNull();
          expect(Number.isFinite(trade.netPnl!)).toBe(true);
        } else {
          expect(trade.exitTime, 'open trade has no exit').toBeNull();
          expect(trade.netPnl, 'open trade has no realized P&L').toBeNull();
        }
      }

      // Every fill must sit inside the bar it filled on. A fill outside the bar's range is
      // either an engine bug or a data bug, and is the first thing spec 06's audit checks.
      const byTime = new Map(result.bars.map((b, i) => [i, b]));
      for (const trade of result.trades) {
        assertFillInsideBar(byTime.get(trade.entryBar), trade.entryPrice, `${id} entry`);
        if (trade.exitBar !== null && trade.exitPrice !== null) {
          assertFillInsideBar(byTime.get(trade.exitBar), trade.exitPrice, `${id} exit`);
        }
      }
    });
  },
);

function assertFillInsideBar(bar: Bar | undefined, price: number, label: string): void {
  expect(bar, `${label}: fill bar exists`).toBeDefined();
  // A tick of tolerance: stop and limit levels are computed from mintick arithmetic and can
  // land a float-epsilon outside a bar whose range they legitimately touched.
  const tolerance = eurusd.mintick;
  expect(price, `${label} >= low`).toBeGreaterThanOrEqual(bar!.low - tolerance);
  expect(price, `${label} <= high`).toBeLessThanOrEqual(bar!.high + tolerance);
}

describe('golden snapshots — determinism', () => {
  it('gives byte-identical trades across two runs of the same fixture', async () => {
    // If this ever fails, every snapshot above is meaningless. Ordering inside the adapter
    // (the entry-time sort) and PineTS's own iteration must both be stable.
    const source = STRATEGY_FIXTURES[0]!.source;
    // Bypasses the cache on purpose — two genuinely separate runs.
    const fresh = (): Promise<RunResult> =>
      engine.run({
        source,
        symbol: eurusd,
        timeframe: 'M15',
        fromMs: FROM,
        toMs: TO,
        warmupBars: 400,
      });
    const [first, second] = await Promise.all([fresh(), fresh()]);
    expect(JSON.stringify(first.trades)).toBe(JSON.stringify(second.trades));
  });

  it('covers every shipped fixture', () => {
    expect(STRATEGY_FIXTURES).toHaveLength(8);
  });
});
