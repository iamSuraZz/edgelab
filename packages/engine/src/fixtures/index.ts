/**
 * Example strategies, selectable from the Studio dropdown and used as golden-test inputs.
 *
 * All are indented with 4 spaces: pinets 0.10.0 rejects 2/3/8-space indentation, and while
 * we pin 0.9.34 (which accepts any), keeping fixtures at 4 spaces means they stay valid if
 * we ever upgrade. See docs/pinets-notes.md section 1.
 */

export interface StrategyFixture {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
}

const EMA_CROSS = `//@version=5
strategy("EMA Cross", overlay=true, initial_capital=10000,
     default_qty_type=strategy.fixed, default_qty_value=1)

fastLen = input.int(12, "Fast EMA", minval=1, maxval=200, group="Moving averages")
slowLen = input.int(26, "Slow EMA", minval=2, maxval=400, group="Moving averages")

fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)

if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)

if ta.crossunder(fast, slow)
    strategy.entry("Short", strategy.short)

plot(fast, title="Fast EMA", color=color.aqua)
plot(slow, title="Slow EMA", color=color.orange)
`;

const RSI_MEAN_REVERSION = `//@version=5
strategy("RSI Mean Reversion", overlay=false, initial_capital=10000,
     default_qty_type=strategy.fixed, default_qty_value=1)

rsiLen    = input.int(14, "RSI length", minval=2, maxval=100, group="Signal")
oversold  = input.int(30, "Oversold", minval=1, maxval=49, group="Signal")
overbought= input.int(70, "Overbought", minval=51, maxval=99, group="Signal")
tpTicks   = input.int(200, "Take profit (ticks)", minval=1, group="Exits")
slTicks   = input.int(100, "Stop loss (ticks)", minval=1, group="Exits")

r = ta.rsi(close, rsiLen)

if ta.crossover(r, oversold)
    strategy.entry("Long", strategy.long)

if ta.crossunder(r, overbought)
    strategy.entry("Short", strategy.short)

strategy.exit("Bracket", profit=tpTicks, loss=slTicks)

plot(r, title="RSI", color=color.purple)
hline(oversold, title="Oversold")
hline(overbought, title="Overbought")
`;

const BOLLINGER_BREAKOUT = `//@version=5
strategy("Bollinger Breakout", overlay=true, initial_capital=10000,
     default_qty_type=strategy.fixed, default_qty_value=1)

length = input.int(20, "Length", minval=2, maxval=200, group="Bands")
mult   = input.float(2.0, "Std dev", minval=0.1, maxval=5.0, step=0.1, group="Bands")

basis = ta.sma(close, length)
dev   = mult * ta.stdev(close, length)
upper = basis + dev
lower = basis - dev

if ta.crossover(close, upper)
    strategy.entry("Long", strategy.long)

if ta.crossunder(close, lower)
    strategy.entry("Short", strategy.short)

plot(basis, title="Basis", color=color.gray)
plot(upper, title="Upper", color=color.teal)
plot(lower, title="Lower", color=color.teal)
`;

const SUPERTREND_ATR = `//@version=5
strategy("Supertrend ATR", overlay=true, initial_capital=10000,
     default_qty_type=strategy.fixed, default_qty_value=1)

atrLen  = input.int(10, "ATR length", minval=1, maxval=100, group="Supertrend")
factor  = input.float(3.0, "Factor", minval=0.5, maxval=10.0, step=0.1, group="Supertrend")

[st, dir] = ta.supertrend(factor, atrLen)

if dir < 0 and dir[1] >= 0
    strategy.entry("Long", strategy.long)

if dir > 0 and dir[1] <= 0
    strategy.entry("Short", strategy.short)

plot(st, title="Supertrend", color=dir < 0 ? color.green : color.red)
`;

const ATR_BRACKET = `//@version=5
strategy("ATR Bracket", overlay=true, initial_capital=10000,
     default_qty_type=strategy.fixed, default_qty_value=1)

emaLen   = input.int(20, "EMA length", minval=2, group="Signal")
atrLen   = input.int(14, "ATR length", minval=2, group="Exits")
slMult   = input.float(1.5, "Stop (x ATR)", minval=0.1, group="Exits")
tpMult   = input.float(3.0, "Target (x ATR)", minval=0.1, group="Exits")

e = ta.ema(close, emaLen)
a = ta.atr(atrLen)

if ta.crossover(close, e)
    strategy.entry("Long", strategy.long)

if ta.crossunder(close, e)
    strategy.entry("Short", strategy.short)

// Levels move with volatility, so they never form two tight clusters: the only way to know them
// is the order log. This is the fixture that proves the checks do not fall back to n/a on a
// strategy whose stop is not a fixed number of ticks.
longStop  = strategy.position_avg_price - a * slMult
longTP    = strategy.position_avg_price + a * tpMult
shortStop = strategy.position_avg_price + a * slMult
shortTP   = strategy.position_avg_price - a * tpMult

if strategy.position_size > 0
    strategy.exit("AtrBracket", from_entry="Long", stop=longStop, limit=longTP)
if strategy.position_size < 0
    strategy.exit("AtrBracket", from_entry="Short", stop=shortStop, limit=shortTP)

plot(e, title="EMA", color=color.orange)
`;

const MACD_HTF_FILTER = `//@version=5
strategy("MACD with HTF trend filter", overlay=true, initial_capital=10000,
     default_qty_type=strategy.fixed, default_qty_value=1)

fastLen = input.int(12, "MACD fast", minval=1, group="MACD")
slowLen = input.int(26, "MACD slow", minval=2, group="MACD")
sigLen  = input.int(9, "MACD signal", minval=1, group="MACD")
htf     = input.timeframe("240", "Trend timeframe", group="Trend filter")
trendLen= input.int(50, "Trend EMA", minval=2, group="Trend filter")

[macdLine, signalLine, _hist] = ta.macd(close, fastLen, slowLen, sigLen)

// Non-repainting: lookahead_off plus [1] so the HTF value is only used once closed.
htfTrend = request.security(syminfo.tickerid, htf, ta.ema(close, trendLen)[1],
     lookahead=barmerge.lookahead_off)

bullish = close > htfTrend
bearish = close < htfTrend

if ta.crossover(macdLine, signalLine) and bullish
    strategy.entry("Long", strategy.long)

if ta.crossunder(macdLine, signalLine) and bearish
    strategy.entry("Short", strategy.short)

plot(htfTrend, title="HTF trend", color=color.yellow)
`;

const DONCHIAN_TRAILING = `//@version=5
strategy("Donchian Breakout", overlay=true, initial_capital=10000,
     default_qty_type=strategy.fixed, default_qty_value=1)

length     = input.int(20, "Channel length", minval=2, maxval=200, group="Channel")
trailTicks = input.int(300, "Trail offset (ticks)", minval=1, group="Exit")
trailStart = input.int(150, "Trail trigger (ticks)", minval=1, group="Exit")

upper = ta.highest(high, length)
lower = ta.lowest(low, length)

if close >= upper[1]
    strategy.entry("Long", strategy.long)

if close <= lower[1]
    strategy.entry("Short", strategy.short)

strategy.exit("Trail", trail_points=trailStart, trail_offset=trailTicks)

plot(upper, title="Upper", color=color.green)
plot(lower, title="Lower", color=color.red)
`;

export const STRATEGY_FIXTURES: readonly StrategyFixture[] = [
  {
    id: 'ema-cross',
    name: 'EMA Cross',
    description: 'Long on fast/slow EMA crossover, short on crossunder. The simplest baseline.',
    source: EMA_CROSS,
  },
  {
    id: 'rsi-mean-reversion',
    name: 'RSI Mean Reversion',
    description:
      'Buys oversold, sells overbought, with a strategy.exit stop-loss and take-profit in ticks.',
    source: RSI_MEAN_REVERSION,
  },
  {
    id: 'bollinger-breakout',
    name: 'Bollinger Breakout',
    description: 'Enters on a close beyond the upper or lower Bollinger band.',
    source: BOLLINGER_BREAKOUT,
  },
  {
    id: 'supertrend-atr',
    name: 'Supertrend ATR',
    description: 'Follows Supertrend direction flips, sized off an ATR-based stop.',
    source: SUPERTREND_ATR,
  },
  {
    id: 'macd-htf-filter',
    name: 'MACD with HTF trend filter',
    description:
      'MACD crossovers filtered by a higher-timeframe EMA via request.security, in non-repainting form.',
    source: MACD_HTF_FILTER,
  },
  {
    id: 'atr-bracket',
    name: 'ATR Bracket',
    description:
      'EMA cross with volatility-scaled stop and target, set as PRICES via strategy.exit. Its ' +
      'levels move every bar, so they cannot be recovered by clustering exit prices — this is the ' +
      'fixture that exercises reading them from the order log.',
    source: ATR_BRACKET,
  },
  {
    id: 'donchian-trailing',
    name: 'Donchian Breakout',
    description:
      'Channel breakout with a trailing stop via strategy.exit trail_points/trail_offset.',
    source: DONCHIAN_TRAILING,
  },
];

export function getFixture(id: string): StrategyFixture {
  const f = STRATEGY_FIXTURES.find((x) => x.id === id);
  if (f === undefined) throw new Error(`Unknown fixture: ${id}`);
  return f;
}
