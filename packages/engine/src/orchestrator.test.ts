import { describe, expect, it } from 'vitest';
import { DEFAULT_COSTS, ZERO_COSTS, getSeedSymbol, type Bar, accountMoney } from '@edgelab/shared';

import { CurrencyMismatchError } from './costs';
import { STRATEGY_FIXTURES } from './fixtures';
import { flattenMetrics, orchestrateRun } from './orchestrator';
import { PineTsEngine } from './pinets/adapter';

const M1 = 60_000;
const T0 = Date.UTC(2024, 0, 2, 0, 0);
const eurusd = getSeedSymbol('EURUSD');

/** Enough bars for an M15 run with warmup, with amplitude to trigger an EMA cross. */
function syntheticM1(count: number): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const mid = 1.1 + Math.sin(i / 25) * 0.01 + Math.sin(i / 260) * 0.02;
    return {
      time: T0 + i * M1,
      open: round5(mid),
      high: round5(mid + 0.0006),
      low: round5(mid - 0.0006),
      close: round5(mid + 0.0002),
      volume: 100,
      spread: 0.00008,
    };
  });
}

function round5(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}

const BARS = syntheticM1(12_000);

function makeEngine(): PineTsEngine {
  return new PineTsEngine({
    m1: {
      readM1: (_symbol, fromMs, toMs) =>
        Promise.resolve(BARS.filter((b) => b.time >= fromMs && b.time < toMs)),
    },
    lookupSymbol: (code) => (code === 'EURUSD' ? eurusd : undefined),
  });
}

const EMA_CROSS = STRATEGY_FIXTURES[0]!.source;
const FROM = BARS[4_000]!.time;
const TO = BARS[BARS.length - 1]!.time + M1;

const base = {
  source: EMA_CROSS,
  symbol: eurusd,
  timeframe: 'M15' as const,
  fromMs: FROM,
  toMs: TO,
  initialCapital: accountMoney(10_000),
  accountCurrency: 'USD',
  // 1 lot at 1:100 leverage, so orders are affordable and actually fill.
  overrides: {
    default_qty_type: 'fixed',
    default_qty_value: 100_000,
    margin_long: 1,
    margin_short: 1,
  },
  warmupBars: 200,
};

describe('orchestrateRun', () => {
  it('runs the whole pipeline and returns every stage’s output', async () => {
    const run = await orchestrateRun({ ...base, engine: makeEngine(), costs: DEFAULT_COSTS });

    expect(run.trades.length, 'produced trades').toBeGreaterThan(0);
    expect(run.equityClose.length).toBeGreaterThan(0);
    expect(run.equityIntrabar).toHaveLength(run.equityClose.length);
    expect(run.daily.length).toBeGreaterThan(0);
    expect(run.metrics.trades.all.trades).toBe(run.trades.length);
    expect(run.engineMs).toBeGreaterThanOrEqual(0);
  });

  it('restricts equity to the requested window, excluding warmup bars', async () => {
    const run = await orchestrateRun({ ...base, engine: makeEngine(), costs: DEFAULT_COSTS });

    // Warmup bars primed indicators but are not part of the report: counting them would
    // stretch the window and dilute every per-bar statistic.
    expect(run.engineResult.stats.warmupBars).toBeGreaterThan(0);
    expect(run.equityClose.length).toBeLessThan(run.engineResult.bars.length);
    expect(run.equityClose[0]!.time).toBeGreaterThanOrEqual(FROM);
    expect(run.equityClose.at(-1)!.time).toBeLessThan(TO);
  });

  it('rebases trade bar indices onto the window, so no mark lands out of range', async () => {
    // The engine numbers bars from the start of everything it LOADED. Equity is reconstructed
    // over the window only, so an un-rebased entryBar points past the end of the array and the
    // position silently never gets marked.
    const run = await orchestrateRun({ ...base, engine: makeEngine(), costs: DEFAULT_COSTS });

    for (const trade of run.trades) {
      expect(trade.entryTime, 'entry inside the window').toBeGreaterThanOrEqual(FROM);
    }

    // If rebasing were missing, every open position would fall off the end and the equity
    // curve would be perfectly flat despite trades existing.
    const equities = new Set(run.equityClose.map((p) => p.equity));
    expect(equities.size, 'equity actually moves').toBeGreaterThan(1);
  });

  it('PASSES the zero-cost cross-check, and still passes with costs applied', async () => {
    // The cross-check compares the engine against a ZERO-cost re-derivation, so charging
    // spread must not make it fail — that would be a false alarm on every realistic run.
    const free = await orchestrateRun({ ...base, engine: makeEngine(), costs: ZERO_COSTS });
    const paid = await orchestrateRun({ ...base, engine: makeEngine(), costs: DEFAULT_COSTS });

    expect(free.crossCheck.ok, free.crossCheck.message).toBe(true);
    expect(paid.crossCheck.ok, paid.crossCheck.message).toBe(true);
    expect(free.crossCheck.absoluteDelta).toBeLessThan(1e-6);
  });

  it('makes costs visibly reduce net profit', async () => {
    const free = await orchestrateRun({ ...base, engine: makeEngine(), costs: ZERO_COSTS });
    const paid = await orchestrateRun({ ...base, engine: makeEngine(), costs: DEFAULT_COSTS });

    expect(paid.metrics.costs.totalCosts).toBeGreaterThan(0);
    expect(paid.metrics.performance.netProfit).toBeLessThan(free.metrics.performance.netProfit);
    // And the difference is exactly the spread charged.
    expect(free.metrics.performance.netProfit - paid.metrics.performance.netProfit).toBeCloseTo(
      paid.metrics.costs.spread.total,
      6,
    );
  });

  it('computes a buy & hold benchmark over the window', async () => {
    const run = await orchestrateRun({ ...base, engine: makeEngine(), costs: DEFAULT_COSTS });
    expect(run.buyAndHoldReturnPct).not.toBeNull();
    expect(run.metrics.performance.buyAndHoldReturnPct).toBe(run.buyAndHoldReturnPct);
  });

  it('reports progress monotonically from start to finish', async () => {
    const seen: number[] = [];
    await orchestrateRun({
      ...base,
      engine: makeEngine(),
      costs: DEFAULT_COSTS,
      onProgress: (percent) => seen.push(percent),
    });
    expect(seen.at(-1)).toBe(100);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('REFUSES a cross-currency run before doing any work (D6)', async () => {
    await expect(
      orchestrateRun({
        ...base,
        engine: makeEngine(),
        costs: DEFAULT_COSTS,
        accountCurrency: 'EUR',
      }),
    ).rejects.toThrow(CurrencyMismatchError);
  });
});

describe('flattenMetrics', () => {
  it('flattens nested sections into dotted keys', () => {
    const flat = flattenMetrics({
      performance: { netProfit: 700, profitFactor: 2.4 },
      risk: { intrabar: { maxDrawdown: 300 } },
    } as never);

    expect(flat['performance.netProfit']).toBe(700);
    expect(flat['performance.profitFactor']).toBe(2.4);
    expect(flat['risk.intrabar.maxDrawdown']).toBe(300);
  });

  it('keeps null as null, because "undefined metric" is a real result', () => {
    const flat = flattenMetrics({ performance: { profitFactor: null } } as never);
    expect(flat['performance.profitFactor']).toBeNull();
    expect('performance.profitFactor' in flat).toBe(true);
  });

  it('turns a non-finite value into null rather than storing NaN', () => {
    // A NaN in a double column is storable and poisons every later comparison.
    const flat = flattenMetrics({ risk: { sharpe: Number.NaN, sortino: Infinity } } as never);
    expect(flat['risk.sharpe']).toBeNull();
    expect(flat['risk.sortino']).toBeNull();
  });

  it('encodes booleans as 0/1 so they fit a numeric column', () => {
    const flat = flattenMetrics({ performance: { annualizedFromShortWindow: true } } as never);
    expect(flat['performance.annualizedFromShortWindow']).toBe(1);
  });

  it('skips arrays, which are not scalar metrics', () => {
    const flat = flattenMetrics({ monthlyReturns: [{ year: 2024 }], notes: ['x'] } as never);
    expect(Object.keys(flat)).toHaveLength(0);
  });

  it('produces a usable set of keys from a real report', async () => {
    const run = await orchestrateRun({ ...base, engine: makeEngine(), costs: DEFAULT_COSTS });
    const flat = flattenMetrics(run.metrics);

    expect(Object.keys(flat).length).toBeGreaterThan(50);
    expect(flat['performance.netProfit']).toBeCloseTo(run.metrics.performance.netProfit, 9);
    for (const value of Object.values(flat)) {
      expect(value === null || Number.isFinite(value)).toBe(true);
    }
  });
});
