import type { MessagePort } from 'node:worker_threads';

import { createDbClient, findSymbolByCode, listSymbols, readM1, type DbClient } from '@edgelab/db';
import {
  PineTsEngine,
  flattenMetrics,
  orchestrateRun,
  type OrchestratedRun,
} from '@edgelab/engine';
import type { CostConfig, SymbolSpec, Timeframe } from '@edgelab/shared';
import { timeframeMs } from '@edgelab/shared';

/**
 * The backtest, executed inside a piscina worker thread.
 *
 * Runs in a thread rather than on the BullMQ event loop for two reasons: a Pine run is
 * CPU-bound and would stop the worker heartbeating (Redis then marks the job stalled and
 * re-runs it), and a hostile script has to be killable — which only a thread is.
 *
 * TWO THINGS ABOUT THE THREAD BOUNDARY:
 *
 *  1. **The DB pool is per thread, created once and reused** (spec 03). Piscina loads this
 *     module once per thread, so a module-level pool is naturally thread-local. The
 *     alternative — reading bars on the main thread and structured-cloning them in — copies
 *     ~30 MB for a one-year M5 run, on every job.
 *
 *  2. **Progress travels over a MessagePort**, transferred in with the task. There is no other
 *     channel: a thread cannot touch `job.updateProgress()`, and posting through the pool's
 *     own plumbing is not exposed. The port is optional so the task stays runnable from a test
 *     without one.
 *
 * The return value crosses the thread boundary by structured clone, so it carries only what
 * the caller persists — no engine internals, no bar arrays.
 */

export interface BacktestTaskInput {
  readonly runId: string;
  readonly databaseUrl: string;
  readonly source: string;
  readonly symbolCode: string;
  readonly timeframe: Timeframe;
  readonly fromMs: number;
  readonly toMs: number;
  readonly initialCapital: number;
  readonly accountCurrency: string;
  readonly costs: CostConfig;
  readonly inputs: Record<string, unknown>;
  readonly props: Record<string, unknown>;
  readonly warmupBars: number;
  readonly rfAnnual: number;
  /** Progress sink. Transferred, so it must be listed in the run's `transferList`. */
  readonly progressPort?: MessagePort;
}

export interface BacktestTaskOutput {
  readonly runId: string;
  readonly trades: OrchestratedRun['trades'];
  readonly series: {
    readonly close: OrchestratedRun['equityClose'];
    readonly intrabar: OrchestratedRun['equityIntrabar'];
    readonly daily: OrchestratedRun['daily'];
    readonly monthly: OrchestratedRun['monthly'];
  };
  readonly metrics: Record<string, number | null>;
  readonly report: OrchestratedRun['metrics'];
  readonly summary: BacktestSummary;
  readonly crossCheckOk: boolean;
  readonly crossCheckDeltaPct: number | null;
  readonly crossCheckMessage: string;
  readonly barsProcessed: number;
  readonly engineMs: number;
  readonly totalMs: number;
  readonly diagnostics: OrchestratedRun['engineResult']['diagnostics'];
  /** Entry orders that were placed but never filled — almost always a margin rejection. */
  readonly unfilledEntryOrders: number;
}

export interface BacktestSummary {
  readonly netProfit: number;
  readonly totalReturnPct: number | null;
  readonly cagrPct: number | null;
  readonly profitFactor: number | null;
  readonly maxDrawdownPct: number | null;
  readonly sharpe: number | null;
  readonly winRatePct: number | null;
  readonly closedTrades: number;
  readonly buyAndHoldReturnPct: number | null;
}

/**
 * Coverage that DOES exist, for the "no data" message.
 *
 * NOT attached to the thrown error as a property: structured clone carries an Error's `name`,
 * `message`, `stack` and `cause` across the thread boundary and DROPS every own property, so a
 * `detail` object would silently arrive as undefined on the main thread. The classification
 * therefore travels in `name` and the specifics are baked into `message`.
 */
export interface NoDataDetail {
  readonly symbol: string;
  readonly requestedFrom: number;
  readonly requestedTo: number;
  readonly availableFrom: number | null;
  readonly availableTo: number | null;
}

/**
 * Codes the main thread branches on, carried in `cause`.
 *
 * NOT in `name`, and not in an own property. Structured clone normalises an Error's `name` to
 * one of the seven built-ins — a custom `NoDataError` arrives as plain `"Error"` — and drops
 * own properties entirely. `cause` is the one channel that survives, and it survives as an
 * arbitrary cloneable value, so a plain object carries the code intact.
 *
 * Verified empirically, not from the spec: see docs/engineering-notes.md.
 */
export const NO_DATA_ERROR = 'no-data';

/** Tag a domain failure so it stays classified after crossing the thread boundary. */
export function taskError(message: string, code: string): Error {
  return new Error(message, { cause: { edgelabCode: code } });
}

/* ------------------------------------------------- thread-local resources */

let cachedDb: DbClient | null = null;
let cachedUrl: string | null = null;

function dbFor(databaseUrl: string): DbClient {
  if (cachedDb !== null && cachedUrl === databaseUrl) return cachedDb;
  // A url change means a different database; drop the old pool rather than leak it.
  void cachedDb?.close();
  // Small on purpose: this pool is per THREAD, and there is one thread per core.
  cachedDb = createDbClient(databaseUrl, { max: 2, statementTimeoutMs: 600_000 });
  cachedUrl = databaseUrl;
  return cachedDb;
}

/**
 * How far before `from` to load M1 for warmup.
 *
 * `warmupBars` counts bars at the RUN timeframe, so it converts to M1 minutes and then pads:
 * fx shuts at weekends, so N timeframe-bars of history spans appreciably more wall-clock time
 * than N × duration.
 */
function warmupSpanMs(timeframe: Timeframe, warmupBars: number): number {
  const durationMs = timeframeMs(timeframe);
  if (durationMs === null) throw new Error(`No duration for timeframe ${timeframe}`);
  return Math.ceil(warmupBars * durationMs * 2.5);
}

export default async function backtestTask(input: BacktestTaskInput): Promise<BacktestTaskOutput> {
  const post = (percent: number, message: string): void => {
    input.progressPort?.postMessage({ percent, message });
  };

  const db = dbFor(input.databaseUrl);

  post(2, 'loading bars');

  const symbolRow = await findSymbolByCode(db, input.symbolCode);
  if (symbolRow === null) {
    throw new Error(`Unknown symbol ${input.symbolCode}`);
  }
  const spec: SymbolSpec = symbolRow;

  const barsFromMs = input.fromMs - warmupSpanMs(input.timeframe, input.warmupBars);
  const m1 = await readM1(db, symbolRow.id, barsFromMs, input.toMs);

  // Which instruments exist at all, for the conversion planner below. One query, so a
  // cross-currency run does not probe the registry per candidate spelling.
  const knownSymbols = new Set((await listSymbols(db)).map((r) => r.symbol.toUpperCase()));

  // A window with no bars is the single most common failure, so it gets a typed detail
  // rather than an opaque throw. The coverage probe is only run on this path.
  const inWindow = m1.filter((b) => b.time >= input.fromMs && b.time < input.toMs);
  if (inWindow.length === 0) {
    const coverage = await readCoverage(db, symbolRow.id);
    throw taskError(
      describeNoData({
        symbol: spec.symbol,
        requestedFrom: input.fromMs,
        requestedTo: input.toMs,
        availableFrom: coverage.firstMs,
        availableTo: coverage.lastMs,
      }),
      NO_DATA_ERROR,
    );
  }

  const engine = new PineTsEngine({
    m1: {
      readM1: (_symbol, fromMs, toMs) =>
        Promise.resolve(m1.filter((b) => b.time >= fromMs && b.time < toMs)),
    },
    lookupSymbol: (code) => (code === spec.symbol ? spec : undefined),
  });

  const run = await orchestrateRun({
    engine,
    source: input.source,
    symbol: spec,
    timeframe: input.timeframe,
    fromMs: input.fromMs,
    toMs: input.toMs,
    initialCapital: input.initialCapital,
    accountCurrency: input.accountCurrency,
    costs: input.costs,
    inputs: input.inputs,
    overrides: input.props,
    warmupBars: input.warmupBars,
    rfAnnual: input.rfAnnual,
    /*
     * Currency conversion (spec 03). Reads the pair's M1 straight from this thread's pool, the
     * same way the chart's own bars are read — so a USDJPY run on a USD account reports USD P&L
     * instead of being refused.
     *
     * `known` asks the symbol registry rather than trusting a constructed name, so a missing
     * link is reported as "nothing quotes EUR/XYZ" and not as a failed lookup of an invented
     * instrument.
     */
    conversion: {
      known: (code) => knownSymbols.has(code.toUpperCase()),
      loadBars: async (code, fromMs, toMs) => {
        const row = await findSymbolByCode(db, code);
        if (row === null) return [];
        return readM1(db, row.id, fromMs, toMs);
      },
    },
    // The engine's 0–100 is squeezed into 5–95 so the surrounding load and persist steps
    // have room at either end and progress never appears to go backwards.
    onProgress: (percent, message) => {
      post(5 + percent * 0.9, message);
    },
  });

  post(97, 'persisting');

  const unfilledEntryOrders =
    run.engineResult.trades.length === 0
      ? run.engineResult.orderLog.filter(
          (r) => r.outcome === 'placed' && (r.method === 'entry' || r.method === 'order'),
        ).length
      : 0;

  return {
    runId: input.runId,
    trades: run.trades,
    series: {
      close: run.equityClose,
      intrabar: run.equityIntrabar,
      daily: run.daily,
      monthly: run.monthly,
    },
    metrics: flattenMetrics(run.metrics),
    report: run.metrics,
    summary: {
      netProfit: run.metrics.performance.netProfit,
      totalReturnPct: run.metrics.performance.totalReturnPct,
      cagrPct: run.metrics.performance.cagrPct,
      profitFactor: run.metrics.performance.profitFactor,
      maxDrawdownPct: run.metrics.risk.intrabar.maxDrawdownPct,
      sharpe: run.metrics.risk.sharpe,
      winRatePct: run.metrics.trades.all.winRatePct,
      closedTrades: run.metrics.trades.all.trades,
      buyAndHoldReturnPct: run.buyAndHoldReturnPct,
    },
    crossCheckOk: run.crossCheck.ok,
    crossCheckDeltaPct: run.crossCheck.deltaPct,
    crossCheckMessage: run.crossCheck.message,
    barsProcessed: run.engineResult.stats.barsProcessed,
    engineMs: run.engineMs,
    totalMs: run.totalMs,
    diagnostics: run.engineResult.diagnostics,
    unfilledEntryOrders,
  };
}

export function describeNoData(d: NoDataDetail): string {
  if (d.availableFrom === null || d.availableTo === null) {
    return `No ${d.symbol} data stored at all. Download some with POST /api/data/ingest first.`;
  }
  const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  return (
    `No ${d.symbol} data in ${iso(d.requestedFrom)} .. ${iso(d.requestedTo)}. ` +
    `Stored coverage is ${iso(d.availableFrom)} .. ${iso(d.availableTo)}.`
  );
}

async function readCoverage(
  db: DbClient,
  symbolId: string,
): Promise<{ firstMs: number | null; lastMs: number | null }> {
  const result = await db.pool.query<{ first: Date | null; last: Date | null }>(
    'SELECT min(ts) AS first, max(ts) AS last FROM candles_m1 WHERE symbol_id = $1',
    [symbolId],
  );
  const row = result.rows[0];
  return {
    firstMs: row?.first == null ? null : row.first.getTime(),
    lastMs: row?.last == null ? null : row.last.getTime(),
  };
}
