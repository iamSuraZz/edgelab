/* Throwaway probe: EMA-cross STRATEGY throughput at 100k / 500k / 1M bars. */
import { PineTS } from 'pinets';

const MIN = 60_000;
const T0 = Date.UTC(2015, 0, 1);

const SYMINFO = {
  ticker: 'TEST',
  tickerid: 'TEST',
  description: 'bench',
  type: 'forex',
  currency: 'USD',
  basecurrency: 'EUR',
  timezone: 'UTC',
  session: '24x7',
  mintick: 0.00001,
  minmove: 1,
  pricescale: 100000,
  pointvalue: 1,
  mincontract: 1,
  volumetype: 'base',
  prefix: '',
  root: '',
  isin: '',
  main_tickerid: 'TEST',
  current_contract: '',
  country: '',
  industry: '',
  sector: '',
  employees: 0,
  shareholders: 0,
  shares_outstanding_float: 0,
  shares_outstanding_total: 0,
  expiration_date: 0,
  recommendations_buy: 0,
  recommendations_buy_strong: 0,
  recommendations_date: 0,
  recommendations_hold: 0,
  recommendations_sell: 0,
  recommendations_sell_strong: 0,
  recommendations_total: 0,
  target_price_average: 0,
  target_price_date: 0,
  target_price_estimates: 0,
  target_price_high: 0,
  target_price_low: 0,
  target_price_median: 0,
};

/** Deterministic pseudo-random walk so runs are comparable. */
function makeBars(n) {
  const bars = new Array(n);
  let price = 1.1;
  let seed = 42;
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    price += (seed / 0x7fffffff - 0.5) * 0.0004;
    const t = T0 + i * MIN;
    bars[i] = {
      openTime: t,
      closeTime: t + MIN,
      open: price,
      high: price + 0.0003,
      low: price - 0.0003,
      close: price + 0.0001,
      volume: 100,
      quoteAssetVolume: 0,
      numberOfTrades: 0,
      takerBuyBaseAssetVolume: 0,
      takerBuyQuoteAssetVolume: 0,
      ignore: 0,
    };
  }
  return bars;
}

const provider = (bars) => ({
  async getMarketData() {
    return bars;
  },
  async getSymbolInfo() {
    return SYMINFO;
  },
  configure() {},
});

const EMA_CROSS = `//@version=5
strategy("EMA cross bench", overlay=true, initial_capital=10000, default_qty_type=strategy.fixed, default_qty_value=1)
fast = ta.ema(close, 12)
slow = ta.ema(close, 26)
if ta.crossover(fast, slow)
    strategy.entry("L", strategy.long)
if ta.crossunder(fast, slow)
    strategy.entry("S", strategy.short)
plot(fast, title="fast")
plot(slow, title="slow")
`;

console.log('bars        build_ms   run_ms    bars/sec    trades   heap_mb   netprofit');
console.log('-'.repeat(82));

for (const n of [100_000, 500_000, 1_000_000]) {
  if (global.gc) global.gc();
  const buildStart = Date.now();
  const bars = makeBars(n);
  const buildMs = Date.now() - buildStart;

  const before = process.memoryUsage().heapUsed;
  const started = Date.now();
  let ctx;
  try {
    ctx = await new PineTS(provider(bars), 'TEST', '1', n).run(EMA_CROSS);
  } catch (err) {
    console.log(`${String(n).padEnd(11)} THREW: ${err?.message ?? err}`);
    continue;
  }
  const runMs = Date.now() - started;
  const heapMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;

  const closed = ctx.strategy?.closedtrades?.length ?? -1;
  const net = ctx.strategy?.netprofit;

  console.log(
    `${String(n).padEnd(11)} ${String(buildMs).padStart(7)}  ${String(runMs).padStart(7)}  ` +
      `${String(Math.round(n / (runMs / 1000))).padStart(9)}  ${String(closed).padStart(7)}  ` +
      `${heapMb.toFixed(0).padStart(7)}  ${typeof net === 'number' ? net.toFixed(2) : String(net)}`,
  );
}
