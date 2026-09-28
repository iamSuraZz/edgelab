import { createDbClient, findSymbolByCode, listSymbols, readM1, type DbClient } from '@edgelab/db';
import { PineTsEngine, orchestrateRun } from '@edgelab/engine';
import type { CostConfig, SymbolSpec, Timeframe } from '@edgelab/shared';
import { accountMoney, timeframeMs } from '@edgelab/shared';

/**
 * One optimization candidate: a single parameter set over a single window, inside a worker thread.
 *
 * Separate from the backtest task because the requirements are opposite. A backtest persists a run
 * and returns trades, both equity series and a full report — sensible for one run, ruinous for the
 * twelve hundred a four-fold optimization at the combination cap performs. This returns ONLY the
 * handful of numbers the selection needs, so the structured clone across the thread boundary stays
 * a few hundred bytes rather than megabytes.
 *
 * Nothing is written to the database. A candidate is not a run the user asked for; persisting every
 * one of them would bury the runs they did ask for.
 *
 * The DB pool is module-level and therefore per thread, exactly as in the backtest task — piscina
 * loads the module once per thread, so the pool is created once and reused across every candidate
 * that thread handles.
 */

export interface OptimizeTaskInput {
  readonly databaseUrl: string;
  readonly source: string;
  readonly symbolCode: string;
  readonly timeframe: Timeframe;
  readonly fromMs: number;
  readonly toMs: number;
  readonly initialCapital: number;
  readonly accountCurrency: string;
  readonly costs: CostConfig;
  /** The candidate: script input overrides for this run. */
  readonly inputs: Record<string, unknown>;
  readonly props: Record<string, unknown>;
  readonly warmupBars: number;
}

/** Exactly the fields `SegmentMetrics` needs, as plain numbers. */
export interface OptimizeTaskOutput {
  readonly fromMs: number;
  readonly toMs: number;
  readonly trades: number;
  readonly netProfit: number;
  readonly returnPct: number | null;
  readonly profitFactor: number | null;
  readonly sharpe: number | null;
  readonly winRatePct: number | null;
  readonly maxDrawdownPct: number | null;
  readonly expectancy: number | null;
}

let db: DbClient | null = null;

function client(databaseUrl: string): DbClient {
  db ??= createDbClient(databaseUrl, { max: 2, statementTimeoutMs: 600_000 });
  return db;
}

/**
 * M1 bars, cached per thread by window.
 *
 * Every candidate in a fold reads the SAME window — only the script inputs differ — so without this
 * the optimization re-reads the identical bars once per combination. Measured: 204 runs took 79.9s
 * against a 3.8s estimate built from engine time alone, because the estimate counted the run and not
 * the read in front of it. With the cache each window is fetched once per thread.
 *
 * Bounded to a handful of windows because a fold's candidates are dispatched together, so at most a
 * couple of windows are live at a time and an unbounded map would just retain the whole range.
 */
const CACHE_LIMIT = 4;
const barCache = new Map<string, Awaited<ReturnType<typeof readM1>>>();

async function cachedM1(
  dbClient: DbClient,
  symbolId: string,
  fromMs: number,
  toMs: number,
): Promise<Awaited<ReturnType<typeof readM1>>> {
  const key = `${symbolId}|${String(fromMs)}|${String(toMs)}`;
  const hit = barCache.get(key);
  if (hit !== undefined) return hit;

  const bars = await readM1(dbClient, symbolId, fromMs, toMs);
  if (barCache.size >= CACHE_LIMIT) {
    const oldest = barCache.keys().next().value;
    if (oldest !== undefined) barCache.delete(oldest);
  }
  barCache.set(key, bars);
  return bars;
}

let knownSymbolsCache: Set<string> | null = null;

export default async function optimizeCandidate(
  input: OptimizeTaskInput,
): Promise<OptimizeTaskOutput> {
  const dbClient = client(input.databaseUrl);

  const symbolRow = await findSymbolByCode(dbClient, input.symbolCode);
  if (symbolRow === null) throw new Error(`Unknown symbol ${input.symbolCode}.`);

  const tfMs = timeframeMs(input.timeframe) ?? 30 * 24 * 60 * 60_000;
  const barsFromMs = input.fromMs - input.warmupBars * tfMs;

  const m1 = await cachedM1(dbClient, symbolRow.id, barsFromMs, input.toMs);
  // The registry does not change during an optimization, so one query per thread is enough.
  knownSymbolsCache ??= new Set((await listSymbols(dbClient)).map((r) => r.symbol.toUpperCase()));
  const knownSymbols = knownSymbolsCache;

  const spec: SymbolSpec = symbolRow;

  const engine = new PineTsEngine({
    m1: {
      readM1: (_symbol, fromMs, toMs) =>
        Promise.resolve(m1.filter((b) => b.time >= fromMs && b.time < toMs)),
    },
    lookupSymbol: (code) => (code === symbolRow.symbol ? spec : undefined),
  });

  const run = await orchestrateRun({
    engine,
    source: input.source,
    symbol: spec,
    timeframe: input.timeframe,
    fromMs: input.fromMs,
    toMs: input.toMs,
    initialCapital: accountMoney(input.initialCapital),
    accountCurrency: input.accountCurrency,
    costs: input.costs,
    inputs: input.inputs,
    overrides: input.props,
    warmupBars: input.warmupBars,
    conversion: {
      known: (code: string) => knownSymbols.has(code.toUpperCase()),
      loadBars: async (code: string, fromMs: number, toMs: number) => {
        const row = await findSymbolByCode(dbClient, code);
        if (row === null) return [];
        return readM1(dbClient, row.id, fromMs, toMs);
      },
    },
  });

  return {
    fromMs: input.fromMs,
    toMs: input.toMs,
    trades: run.trades.length,
    netProfit: run.metrics.performance.netProfit,
    returnPct: run.metrics.performance.totalReturnPct,
    profitFactor: run.metrics.performance.profitFactor,
    sharpe: run.metrics.risk.sharpe,
    winRatePct: run.metrics.trades.all.winRatePct,
    maxDrawdownPct: run.metrics.risk.intrabar.maxDrawdownPct,
    expectancy: run.metrics.trades.all.expectancy,
  };
}
