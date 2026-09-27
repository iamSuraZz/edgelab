import { beforeAll, describe, expect, it } from 'vitest';
import { getSeedSymbol, type Bar } from '@edgelab/shared';

import type { RunResult } from '../pine-engine';
import { PineTsEngine } from './adapter';

/**
 * The five hand-verified fill cases from spec 03.
 *
 * Every expected number below is computed by hand from the bar table, not copied from a
 * previous run. That is the whole point: a golden snapshot tells you the engine still does
 * what it did yesterday, while these tell you it does the RIGHT thing.
 *
 * The strategies run on M1 so the bars the script sees are exactly the bars written here —
 * no resampling between the fixture and the fill.
 */

const M1 = 60_000;
const T0 = Date.UTC(2024, 0, 2, 0, 0); // Tuesday, fx session open

const eurusd = getSeedSymbol('EURUSD');
const MINTICK = eurusd.mintick; // 0.00001 for a 5-digit pair

/**
 * Bar table. Bars 3 and 7 open with a deliberate GAP away from the previous close, so a fill
 * at "the next bar's open" is arithmetically distinguishable from a fill at "this bar's
 * close" — without the gap both tests would pass on the wrong behaviour.
 *
 *  #  open     high     low      close     note
 *  0  1.1000   1.1005   1.0995   1.1002
 *  1  1.1002   1.1008   1.1000   1.1006
 *  2  1.1006   1.1010   1.1004   1.1008    signal bar
 *  3  1.1020   1.1025   1.1015   1.1022    GAPPED open = the entry fill
 *  4  1.1022   1.1028   1.1018   1.1026
 *  5  1.1026   1.1030   1.1000   1.1005    low 1.1000 penetrates a stop at 1.1010
 *  6  1.1005   1.1010   1.1000   1.1008    signal bar for the exit
 *  7  1.1040   1.1045   1.1035   1.1042    GAPPED open = the exit fill
 *  8  1.1042   1.1048   1.1038   1.1046
 *  9  1.1046   1.1050   1.1040   1.1048
 */
const ROWS: readonly (readonly [number, number, number, number])[] = [
  [1.1, 1.1005, 1.0995, 1.1002],
  [1.1002, 1.1008, 1.1, 1.1006],
  [1.1006, 1.101, 1.1004, 1.1008],
  [1.102, 1.1025, 1.1015, 1.1022],
  [1.1022, 1.1028, 1.1018, 1.1026],
  [1.1026, 1.103, 1.1, 1.1005],
  [1.1005, 1.101, 1.1, 1.1008],
  [1.104, 1.1045, 1.1035, 1.1042],
  [1.1042, 1.1048, 1.1038, 1.1046],
  [1.1046, 1.105, 1.104, 1.1048],
];

const BARS: Bar[] = ROWS.map(([open, high, low, close], i) => ({
  time: T0 + i * M1,
  open,
  high,
  low,
  close,
  volume: 100,
  spread: 0.00008,
}));

const bar = (i: number): Bar => BARS[i]!;

function makeEngine(): PineTsEngine {
  return new PineTsEngine({
    m1: {
      readM1: (_symbol, fromMs, toMs) =>
        Promise.resolve(BARS.filter((b) => b.time >= fromMs && b.time < toMs)),
    },
    lookupSymbol: (code) => (code === 'EURUSD' ? eurusd : undefined),
  });
}

/** Runs on M1 over the whole table with the warmup gate off, so bar_index === array index. */
function run(source: string): Promise<RunResult> {
  return makeEngine().run({
    source,
    symbol: eurusd,
    timeframe: 'M1',
    fromMs: bar(0).time,
    toMs: bar(BARS.length - 1).time + M1,
    warmupBars: 0,
  });
}

const HEADER =
  '//@version=5\nstrategy("fill case", overlay=true, initial_capital=100000, ' +
  'default_qty_type=strategy.fixed, default_qty_value=1';

describe('fill case 1 — a market entry fills at the NEXT bar’s open', () => {
  let result: RunResult;

  beforeAll(async () => {
    result = await run(`${HEADER})
if bar_index == 2
    strategy.entry("L", strategy.long)
if bar_index == 6
    strategy.close("L")
`);
  });

  it('enters on bar 3 at 1.1020, not on bar 2 at 1.1008', () => {
    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    expect(trade.entryBar).toBe(3);
    expect(trade.entryPrice).toBe(bar(3).open);
    expect(trade.entryPrice).toBe(1.102);
    // The signal bar's close — what a same-bar fill would have produced.
    expect(trade.entryPrice).not.toBe(bar(2).close);
    expect(trade.entryTime).toBe(bar(3).time);
  });

  it('exits on bar 7 at 1.1040, one bar after the close signal', () => {
    const trade = result.trades[0]!;
    expect(trade.exitBar).toBe(7);
    expect(trade.exitPrice).toBe(bar(7).open);
    expect(trade.exitPrice).toBe(1.104);
    expect(trade.status).toBe('closed');
  });

  it('nets 1.1040 − 1.1020 = 0.0020 per unit', () => {
    expect(result.trades[0]!.netPnl).toBeCloseTo(0.002, 12);
    expect(result.stats.netprofit).toBeCloseTo(0.002, 12);
  });

  it('logs the order on the SIGNAL bar, not the fill bar', () => {
    // The distinction matters for the look-ahead checks in spec 06, which reason about when
    // a decision was made rather than when it was executed.
    const entry = result.orderLog.find((r) => r.method === 'entry');
    expect(entry?.bar).toBe(2);
    expect(entry?.time).toBe(bar(2).time);
    expect(entry?.outcome).toBe('placed');
  });
});

describe('fill case 2 — strategy.exit loss=N fills at entry − N×mintick for a long', () => {
  let result: RunResult;

  beforeAll(async () => {
    result = await run(`${HEADER})
if bar_index == 2
    strategy.entry("L", strategy.long)
strategy.exit("X", from_entry="L", loss=100)
`);
  });

  it('places the stop exactly 100 ticks below the entry', () => {
    const trade = result.trades[0]!;
    const expectedStop = trade.entryPrice - 100 * MINTICK;
    // 1.1020 − 100 × 0.00001 = 1.1020 − 0.001 = 1.1010
    expect(MINTICK).toBe(0.00001);
    expect(expectedStop).toBeCloseTo(1.101, 12);
    expect(trade.exitPrice).toBeCloseTo(expectedStop, 12);
  });

  it('fills AT the stop price, not at the bar’s low', () => {
    const trade = result.trades[0]!;
    // Bar 5 ranges down to 1.1000, well through the stop. Filling at the low would be a
    // free 10 extra pips of slippage in the strategy's favour.
    expect(trade.exitBar).toBe(5);
    expect(bar(5).low).toBeLessThan(trade.exitPrice!);
    expect(trade.exitPrice).not.toBe(bar(5).low);
    expect(trade.exitId).toBe('X');
  });

  it('loses exactly the risked distance', () => {
    expect(result.trades[0]!.netPnl).toBeCloseTo(-0.001, 12);
  });

  it('does not trigger on bar 4, whose low stays above the stop', () => {
    expect(bar(4).low).toBeGreaterThan(1.101);
  });
});

describe('fill case 3 — the pyramiding cap is respected', () => {
  const sourceWith = (pyramiding: number): string => `//@version=5
strategy("pyr", overlay=true, initial_capital=100000, pyramiding=${String(pyramiding)}, default_qty_type=strategy.fixed, default_qty_value=1)
if bar_index >= 1 and bar_index <= 5
    strategy.entry("L", strategy.long)
plot(strategy.position_size, "pos")
`;

  const positionSeries = (result: RunResult): (number | null)[] =>
    result.plots.find((p) => p.title === 'pos')?.points.map((p) => p.value) ?? [];

  it('stops adding at 2 units despite five entry calls', async () => {
    const result = await run(sourceWith(2));
    const position = positionSeries(result);
    expect(Math.max(...position.map((v) => v ?? 0))).toBe(2);
    expect(position.at(-1)).toBe(2);
    expect(result.trades).toHaveLength(2);
  });

  it('caps at 1 unit when pyramiding is 1', async () => {
    const result = await run(sourceWith(1));
    expect(Math.max(...positionSeries(result).map((v) => v ?? 0))).toBe(1);
    expect(result.trades).toHaveLength(1);
  });

  it('lets all five through when the cap is 5, proving the cap is what bound it', async () => {
    // Without this, a cap test passes just as happily against an engine that drops every
    // entry after the first for some unrelated reason.
    const result = await run(sourceWith(5));
    expect(Math.max(...positionSeries(result).map((v) => v ?? 0))).toBe(5);
    expect(result.trades).toHaveLength(5);
  });
});

describe('fill case 4 — an opposite strategy.entry reverses the position', () => {
  let result: RunResult;

  beforeAll(async () => {
    result = await run(`${HEADER})
if bar_index == 2
    strategy.entry("L", strategy.long)
if bar_index == 6
    strategy.entry("S", strategy.short)
plot(strategy.position_size, "pos")
`);
  });

  it('closes the long and opens a short on the same bar at the same price', () => {
    expect(result.trades).toHaveLength(2);
    const [long, short] = result.trades;

    expect(long!.side).toBe('long');
    expect(long!.status).toBe('closed');
    expect(long!.exitBar).toBe(7);
    expect(long!.exitPrice).toBe(bar(7).open);
    // The reversal is attributed to the order that caused it.
    expect(long!.exitId).toBe('S');

    expect(short!.side).toBe('short');
    expect(short!.status).toBe('open');
    expect(short!.entryBar).toBe(7);
    expect(short!.entryPrice).toBe(bar(7).open);
  });

  it('flips position_size from +1 to −1 with no flat bar between', () => {
    const position = result.plots.find((p) => p.title === 'pos')!.points.map((p) => p.value);
    expect(position[6]).toBe(1);
    expect(position[7]).toBe(-1);
  });

  it('gives the two trades DISTINCT ids', () => {
    // PineTS numbers closedtrades and opentrades independently, so both of these arrive as
    // "trade_1". Persisting them under the engine's id would collide in run_trades.
    const [long, short] = result.trades;
    expect(long!.id).not.toBe(short!.id);
    expect(result.trades.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(long!.engineId).toBe(short!.engineId);
  });

  it('leaves the short open rather than inventing an exit', () => {
    const short = result.trades[1]!;
    expect(short.exitTime).toBeNull();
    expect(short.exitPrice).toBeNull();
    expect(short.netPnl).toBeNull();
    expect(result.stats.openTrades).toBe(1);
    expect(result.stats.closedTrades).toBe(1);
  });
});

/**
 * Fill case 5 is a DIVERGENCE, not a pass.
 *
 * Spec 03 expects `process_orders_on_close` to fill at the same bar's close. PineTS 0.9.34
 * accepts the property and ignores it: the name appears only in its declaration schema and
 * defaults object, never in the fill path, which is unconditional —
 * `if (order.bar >= ctx.idx) continue` and then `fillPrice = open[0]`.
 *
 * So the test asserts the real behaviour, states the divergence in its name, and asserts that
 * `compile()` WARNS about it. The warning is the actual protection: a silent one-bar shift in
 * every fill is exactly the kind of difference that makes a backtest untrustworthy.
 */
describe('fill case 5 — process_orders_on_close is IGNORED by PineTS (divergence)', () => {
  const withFlag = `//@version=5
strategy("poc", overlay=true, initial_capital=100000, process_orders_on_close=true, default_qty_type=strategy.fixed, default_qty_value=1)
if bar_index == 2
    strategy.entry("L", strategy.long)
if bar_index == 6
    strategy.close("L")
`;

  const withoutFlag = `${HEADER})
if bar_index == 2
    strategy.entry("L", strategy.long)
if bar_index == 6
    strategy.close("L")
`;

  it('fills at the next bar’s open, where TradingView would use this bar’s close', async () => {
    const result = await run(withFlag);
    const trade = result.trades[0]!;

    // What PineTS does:
    expect(trade.entryBar).toBe(3);
    expect(trade.entryPrice).toBe(bar(3).open);
    expect(trade.exitBar).toBe(7);
    expect(trade.exitPrice).toBe(bar(7).open);

    // What TradingView would have done, recorded so the gap is explicit and measurable.
    const tradingViewEntry = bar(2).close; // 1.1008
    const tradingViewExit = bar(6).close; // 1.1008
    expect(trade.entryPrice).not.toBe(tradingViewEntry);
    expect(trade.exitPrice).not.toBe(tradingViewExit);
    // TradingView's P&L here would be 0.0000; ours is 0.0020.
    expect(tradingViewExit - tradingViewEntry).toBeCloseTo(0, 12);
    expect(trade.netPnl).toBeCloseTo(0.002, 12);
  });

  it('produces results identical to omitting the flag, which is what "ignored" means', async () => {
    const [on, off] = await Promise.all([run(withFlag), run(withoutFlag)]);
    expect(on.trades.map((t) => [t.entryBar, t.entryPrice, t.exitBar, t.exitPrice])).toEqual(
      off.trades.map((t) => [t.entryBar, t.entryPrice, t.exitBar, t.exitPrice]),
    );
  });

  it('WARNS at compile time, so the divergence is never silent', () => {
    const compiled = makeEngine().compile(withFlag);
    expect(compiled.ok, 'a warning must not block the run').toBe(true);

    const warning = compiled.diagnostics.find((d) => d.code === 'ignored-strategy-prop');
    expect(warning, 'process_orders_on_close must be reported').toBeDefined();
    expect(warning!.severity).toBe('warning');
    expect(warning!.message).toContain('process_orders_on_close');
    expect(warning!.message).toContain('IGNORED');
    expect(warning!.line).toBe(2);
  });

  it('stays quiet when the flag is absent or set to its no-op value', () => {
    expect(makeEngine().compile(withoutFlag).diagnostics).toHaveLength(0);
    const explicitFalse = withFlag.replace(
      'process_orders_on_close=true',
      'process_orders_on_close=false',
    );
    expect(
      makeEngine()
        .compile(explicitFalse)
        .diagnostics.filter((d) => d.code === 'ignored-strategy-prop'),
    ).toHaveLength(0);
  });
});
