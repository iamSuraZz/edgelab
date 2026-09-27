import { describe, expect, it } from 'vitest';
import { type Bar, getSeedSymbol } from '@edgelab/shared';
import { STRATEGY_FIXTURES } from '../fixtures';
import {
  PineTsEngine,
  parseDeclaredTitle,
  parsePineVersion,
  SettingsValidationError,
} from './adapter';
import { parsePineTimeframe, splitTicker } from './timeframe';
import type { M1Source } from './provider';

const M1 = 60_000;
const T0 = Date.UTC(2024, 0, 2, 0, 0); // a Tuesday, so the fx session is open

/**
 * Deterministic synthetic M1: a sine wave with enough amplitude to trigger crossovers,
 * so golden results are stable without depending on stored market data.
 */
function syntheticM1(count: number): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < count; i += 1) {
    const price = 1.1 + Math.sin(i / 25) * 0.01;
    bars.push({
      time: T0 + i * M1,
      open: price,
      high: price + 0.0004,
      low: price - 0.0004,
      close: price + 0.0001,
      volume: 100,
      spread: 0.00008,
    });
  }
  return bars;
}

function sourceOf(bars: readonly Bar[]): M1Source {
  return {
    readM1: async (_symbol, fromMs, toMs) => bars.filter((b) => b.time >= fromMs && b.time < toMs),
  };
}

const eurusd = getSeedSymbol('EURUSD');

function makeEngine(bars: readonly Bar[]): PineTsEngine {
  return new PineTsEngine({
    m1: sourceOf(bars),
    lookupSymbol: (code) => (code === 'EURUSD' ? eurusd : undefined),
  });
}

describe('source parsing helpers', () => {
  it('reads the Pine version', () => {
    expect(parsePineVersion('//@version=5\nstrategy("x")')).toBe(5);
    expect(parsePineVersion('// @version = 6\n')).toBe(6);
    expect(parsePineVersion('strategy("x")')).toBeNull();
  });

  it('reads the declared title, positional or named', () => {
    expect(parseDeclaredTitle('strategy("My Strat", overlay=true)')).toBe('My Strat');
    expect(parseDeclaredTitle('indicator(title="Named", overlay=false)')).toBe('Named');
    expect(parseDeclaredTitle("strategy('Single Quoted')")).toBe('Single Quoted');
    expect(parseDeclaredTitle('plot(close)')).toBeNull();
  });
});

describe('timeframe parsing', () => {
  it('accepts Pine period strings', () => {
    expect(parsePineTimeframe('1')).toBe('M1');
    expect(parsePineTimeframe('15')).toBe('M15');
    expect(parsePineTimeframe('240')).toBe('H4');
    expect(parsePineTimeframe('D')).toBe('D1');
    expect(parsePineTimeframe('W')).toBe('W1');
    expect(parsePineTimeframe('M')).toBe('MN1');
  });

  it('accepts unit-suffixed forms, and is CASE SENSITIVE on M', () => {
    expect(parsePineTimeframe('4h')).toBe('H4');
    expect(parsePineTimeframe('4H')).toBe('H4');
    expect(parsePineTimeframe('1m')).toBe('M1'); // minute
    expect(parsePineTimeframe('1M')).toBe('MN1'); // month
    expect(parsePineTimeframe('1D')).toBe('D1');
  });

  it('rejects timeframes we do not store', () => {
    expect(parsePineTimeframe('45')).toBeNull();
    expect(parsePineTimeframe('5s')).toBeNull();
    expect(parsePineTimeframe('3D')).toBeNull();
    expect(parsePineTimeframe('')).toBeNull();
  });

  it('splits the extended ticker modifier', () => {
    expect(splitTicker('EURUSD')).toEqual({ symbol: 'EURUSD', modifier: null });
    expect(splitTicker('EURUSD;heikinashi')).toEqual({
      symbol: 'EURUSD',
      modifier: 'heikinashi',
    });
  });
});

describe('compile', () => {
  const engine = makeEngine(syntheticM1(10));

  it('compiles every shipped fixture and exposes its inputs', () => {
    for (const fixture of STRATEGY_FIXTURES) {
      const result = engine.compile(fixture.source);
      const errors = result.diagnostics.filter((d) => d.severity === 'error');
      if (!result.ok) {
        throw new Error(`${fixture.id} failed to compile: ${JSON.stringify(errors)}`);
      }
      expect(result.meta.kind, fixture.id).toBe('strategy');
      expect(result.meta.version, fixture.id).toBe(5);
      expect(result.meta.title, fixture.id).toBeTruthy();
      expect(result.meta.inputs.length, `${fixture.id} inputs`).toBeGreaterThan(0);
    }
  });

  it('gives every input a stable key, a title and a type', () => {
    const { meta } = engine.compile(STRATEGY_FIXTURES[0]!.source);
    for (const input of meta.inputs) {
      expect(input.key, 'key').toBeTruthy();
      expect(input.title, 'title').toBeTruthy();
      expect(input.type).toBeTruthy();
    }
    const keys = meta.inputs.map((i) => i.key);
    expect(new Set(keys).size, 'keys are unique').toBe(keys.length);
  });

  it('carries min/max through for numeric inputs', () => {
    const { meta } = engine.compile(STRATEGY_FIXTURES[0]!.source);
    const fast = meta.inputs.find((i) => i.title === 'Fast EMA');
    expect(fast?.type).toBe('int');
    expect(fast?.default).toBe(12);
    expect(fast?.min).toBe(1);
    expect(fast?.max).toBe(200);
  });

  it('groups inputs as the script declares', () => {
    const { meta } = engine.compile(STRATEGY_FIXTURES[1]!.source);
    expect(new Set(meta.inputs.map((i) => i.group))).toEqual(new Set(['Signal', 'Exits']));
  });

  it('reports declared props with their mutability', () => {
    const { meta } = engine.compile(STRATEGY_FIXTURES[0]!.source);
    expect(meta.declaredProps.length).toBeGreaterThan(0);
    const title = meta.declaredProps.find((p) => p.name === 'title');
    // title/shorttitle are immutable — the settings form must render them read-only.
    expect(title?.mutable).toBe(false);
    const capital = meta.declaredProps.find((p) => p.name === 'initial_capital');
    expect(capital?.mutable).toBe(true);
  });

  it('identifies an indicator as an indicator', () => {
    const result = engine.compile('//@version=5\nindicator("Ind")\nplot(close)\n');
    expect(result.ok).toBe(true);
    expect(result.meta.kind).toBe('indicator');
  });

  it('returns a diagnostic rather than throwing on bad Pine', () => {
    const result = engine.compile('//@version=5\nstrategy("bad"\nthis is not pine @@@\n');
    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]?.severity).toBe('error');
    expect(result.diagnostics[0]?.message).toBeTruthy();
  });
});

describe('run', () => {
  const bars = syntheticM1(1200);
  const engine = makeEngine(bars);
  const from = bars[200]!.time;
  const to = bars[bars.length - 1]!.time + M1;

  const emaCross = STRATEGY_FIXTURES[0]!.source;

  it('produces trades, plots, an order log and stats', async () => {
    const result = await engine.run({
      source: emaCross,
      symbol: eurusd,
      timeframe: 'M15',
      fromMs: from,
      toMs: to,
    });

    expect(result.bars.length).toBeGreaterThan(0);
    expect(result.plots.length).toBe(2); // Fast EMA + Slow EMA
    expect(result.plots.map((p) => p.title).sort()).toEqual(['Fast EMA', 'Slow EMA']);
    expect(result.orderLog.length).toBeGreaterThan(0);
    expect(result.stats.barsProcessed).toBe(result.bars.length);
    expect(result.stats.runtimeMs).toBeGreaterThanOrEqual(0);
    expect(result.engineCurrency).toBe('USD');
  });

  it('never reports a drawing collection as a plot', async () => {
    const result = await engine.run({
      source: emaCross,
      symbol: eurusd,
      timeframe: 'M15',
      fromMs: from,
      toMs: to,
    });
    expect(result.plots.some((p) => p.title.startsWith('__'))).toBe(false);
  });

  it('aligns plot points to the executed bars', async () => {
    const result = await engine.run({
      source: emaCross,
      symbol: eurusd,
      timeframe: 'M15',
      fromMs: from,
      toMs: to,
    });
    for (const plot of result.plots) {
      expect(plot.points.length, plot.title).toBe(result.bars.length);
      expect(plot.points[0]?.time).toBe(result.bars[0]?.time);
    }
  });

  it('splits signed size into side + positive qty', async () => {
    const result = await engine.run({
      source: emaCross,
      symbol: eurusd,
      timeframe: 'M15',
      fromMs: from,
      toMs: to,
    });
    for (const t of result.trades) {
      expect(t.qty, 'qty is positive').toBeGreaterThan(0);
      expect(['long', 'short']).toContain(t.side);
    }
  });

  it('classifies every order-log row', async () => {
    const result = await engine.run({
      source: emaCross,
      symbol: eurusd,
      timeframe: 'M15',
      fromMs: from,
      toMs: to,
    });
    for (const row of result.orderLog) {
      expect(['placed', 'noop', 'suppressed']).toContain(row.outcome);
      expect(row.bar).toBeGreaterThanOrEqual(0);
      // A placed row must carry what the engine actually created.
      if (row.outcome === 'placed') expect(row.resolved).not.toBeNull();
    }
  });

  it('applies input overrides, keyed by varId', async () => {
    const compiled = engine.compile(emaCross);
    const fast = compiled.meta.inputs.find((i) => i.title === 'Fast EMA');
    expect(fast).toBeDefined();

    const base = await engine.run({
      source: emaCross,
      symbol: eurusd,
      timeframe: 'M15',
      fromMs: from,
      toMs: to,
    });
    const overridden = await engine.run({
      source: emaCross,
      symbol: eurusd,
      timeframe: 'M15',
      fromMs: from,
      toMs: to,
      inputs: { [fast!.key]: 3 },
    });

    // Compare the whole series, not the first emitted value: an EMA is seeded from the
    // first close, so point[0] is identical for every length and would prove nothing.
    const seriesOf = (r: typeof base) =>
      (r.plots.find((p) => p.title === 'Fast EMA')?.points ?? []).map((pt) => pt.value);

    const a = seriesOf(base);
    const b = seriesOf(overridden);
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(30);

    const differingIndex = a.findIndex((v, i) => v !== b[i]);
    expect(differingIndex, 'EMA(3) must differ from EMA(12) somewhere').toBeGreaterThan(-1);

    // And the values must be real numbers, not na, well past the warmup.
    expect(typeof a[30]).toBe('number');
    expect(typeof b[30]).toBe('number');
    expect(a[30]).not.toBe(b[30]);
  });

  it('rejects a bad input override as a settings error, not a compile error', async () => {
    await expect(
      engine.run({
        source: emaCross,
        symbol: eurusd,
        timeframe: 'M15',
        fromMs: from,
        toMs: to,
        inputs: { nonexistentInput: 5 },
      }),
    ).rejects.toThrow(SettingsValidationError);
  });

  it('applies run-parameter overrides', async () => {
    const result = await engine.run({
      source: emaCross,
      symbol: eurusd,
      timeframe: 'M15',
      fromMs: from,
      toMs: to,
      overrides: { initial_capital: 50_000, pyramiding: 3 },
    });
    expect(result.stats.barsProcessed).toBeGreaterThan(0);
  });

  it('refuses an unsupported ticker modifier instead of silently using standard candles', async () => {
    const withHa = `//@version=5
strategy("ha", overlay=true)
x = request.security("EURUSD;heikinashi", "60", close)
plot(x)
`;
    await expect(
      engine.run({
        source: withHa,
        symbol: eurusd,
        timeframe: 'M15',
        fromMs: from,
        toMs: to,
      }),
    ).rejects.toThrow(/heikinashi/);
  });
});

describe('run — warmup gate (contract test)', () => {
  const bars = syntheticM1(2000);
  const engine = makeEngine(bars);
  const emaCross = STRATEGY_FIXTURES[0]!.source;
  const to = bars[bars.length - 1]!.time + M1;
  const from = bars[900]!.time;

  /**
   * This is the test that catches a SILENT break of the instrumentation seam. If
   * `_prepared.fn` stops being reachable, the run still succeeds and still returns
   * plausible fills — only the gate quietly stops applying. Asserting that gating
   * CHANGES the outcome is the only way to notice.
   */
  it('gating changes the result and suppresses pre-window orders', async () => {
    const gated = await engine.run({
      source: emaCross,
      symbol: eurusd,
      timeframe: 'M15',
      fromMs: from,
      toMs: to,
      warmupBars: 200,
    });

    const ungated = await engine.run({
      source: emaCross,
      symbol: eurusd,
      timeframe: 'M15',
      fromMs: from,
      toMs: to,
      warmupBars: 0,
    });

    expect(gated.stats.warmupBars, 'warmup bars were loaded').toBeGreaterThan(0);
    expect(gated.stats.suppressedOrders, 'orders were suppressed').toBeGreaterThan(0);
    expect(ungated.stats.suppressedOrders, 'no gate means no suppression').toBe(0);

    // Every suppressed row must lie strictly before the trading window.
    for (const row of gated.orderLog) {
      if (row.outcome === 'suppressed') {
        expect(row.time).not.toBeNull();
        expect(row.time!).toBeLessThan(from);
      }
    }
    // And only entry/order are ever gated.
    const gatedMethods = new Set(
      gated.orderLog.filter((r) => r.outcome === 'suppressed').map((r) => r.method),
    );
    for (const m of gatedMethods) expect(['entry', 'order']).toContain(m);
  });

  it('opens no position before the trading window', async () => {
    const gated = await engine.run({
      source: emaCross,
      symbol: eurusd,
      timeframe: 'M15',
      fromMs: from,
      toMs: to,
      warmupBars: 200,
    });
    for (const t of gated.trades) {
      expect(t.entryTime, 'no entry before the window').toBeGreaterThanOrEqual(from);
    }
  });

  it('still warms indicators up on the pre-window bars', async () => {
    const gated = await engine.run({
      source: emaCross,
      symbol: eurusd,
      timeframe: 'M15',
      fromMs: from,
      toMs: to,
      warmupBars: 200,
    });

    // The slow EMA(26) must already be producing values by the time the window opens,
    // which is the entire point of loading warmup bars.
    const slow = gated.plots.find((p) => p.title === 'Slow EMA');
    expect(slow).toBeDefined();
    const atWindowOpen = slow!.points.find((p) => p.time >= from);
    expect(atWindowOpen?.value, 'indicator is warm at window open').not.toBeNull();
  });
});
