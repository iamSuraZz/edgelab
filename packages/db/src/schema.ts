import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Time convention: the database stores `timestamptz`; application code works in UTC
 * epoch milliseconds. Convert at this boundary only — see ./time.ts.
 *
 * Price convention: OHLC and P&L use double precision. Backtesting is a simulation, not
 * a ledger, and doubles keep the resampler and metrics allocation-free.
 */

/** Postgres `bytea` as a Node Buffer. drizzle has no built-in for it. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const symbols = pgTable(
  'symbols',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Canonical EdgeLab code, e.g. EURUSD. */
    symbol: text('symbol').notNull().unique(),
    /** fx | metal | index | energy | crypto */
    assetClass: text('asset_class').notNull(),
    baseCcy: text('base_ccy').notNull(),
    quoteCcy: text('quote_ccy').notNull(),
    digits: integer('digits').notNull(),
    /** Smallest quotable increment — MT5's "point". */
    mintick: doublePrecision('mintick').notNull(),
    /** Conventional pip; 10 minticks for 5-digit fx. */
    pipSize: doublePrecision('pip_size').notNull(),
    /** Units of the base instrument per 1.00 lot. */
    contractSize: doublePrecision('contract_size').notNull(),
    pointValue: doublePrecision('point_value').notNull().default(1),
    defaultSpreadPoints: doublePrecision('default_spread_points').notNull().default(0),
    /** { dukascopy: 'eurusd', twelvedata: 'EUR/USD', ... } */
    providerSymbols: jsonb('provider_symbols').notNull().default({}),
    /** fx24x5 | crypto24x7 */
    sessionType: text('session_type').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /**
     * Bumped on every successful ingest or import. The candle cache keys on it, so a
     * re-download invalidates cached resamples without a cache-wide flush.
     */
    dataVersion: integer('data_version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('symbols_asset_class_idx').on(t.assetClass)],
);

/**
 * The single source of truth for market data. Only M1 is stored; every other timeframe
 * is resampled from here. Converted to a Timescale hypertable with compression by
 * src/migrate.ts — Drizzle's generated SQL cannot express either.
 */
export const candlesM1 = pgTable(
  'candles_m1',
  {
    symbolId: uuid('symbol_id')
      .notNull()
      .references(() => symbols.id, { onDelete: 'cascade' }),
    /** Bar OPEN time. */
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    open: doublePrecision('open').notNull(),
    high: doublePrecision('high').notNull(),
    low: doublePrecision('low').notNull(),
    close: doublePrecision('close').notNull(),
    volume: doublePrecision('volume').notNull().default(0),
    /** In PRICE units, not points. Null when the source does not provide one. */
    spread: doublePrecision('spread'),
    /** Which adapter produced this bar: dukascopy | twelvedata | binance | ... */
    source: text('source').notNull(),
  },
  (t) => [primaryKey({ columns: [t.symbolId, t.ts] })],
);

/**
 * A sealed holdout: the most recent slice of a symbol's data, reserved from ordinary reads.
 *
 * One row per symbol. `sealed_from` is an INSTANT rather than a fraction, frozen when the holdout is
 * created — a fraction would move as new data arrived, so yesterday's out-of-sample result would
 * quietly become part of today's training set.
 */
export const holdouts = pgTable(
  'holdouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    symbolId: uuid('symbol_id')
      .notNull()
      .references(() => symbols.id, { onDelete: 'cascade' }),
    sealedFrom: timestamp('sealed_from', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Times this seal has been deliberately broken. The number that makes a holdout mean anything. */
    viewCount: integer('view_count').notNull().default(0),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    /**
     * Set when the seal is retired. Rows are NEVER deleted.
     *
     * Deleting would let drop-then-seal reset the view count — the same loophole that refusing to
     * re-seal closes, reachable by two commands instead of one. The history is what makes a fresh
     * seal's "viewed 0 times" honest or not.
     */
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (t) => [
    // At most one ACTIVE seal per symbol; retired ones accumulate freely.
    uniqueIndex('holdouts_one_active_per_symbol')
      .on(t.symbolId)
      .where(sql`${t.retiredAt} IS NULL`),
  ],
);

/** An ingest or import run, so the Data page can show history and resume. */
export const ingestJobs = pgTable(
  'ingest_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    symbolId: uuid('symbol_id')
      .notNull()
      .references(() => symbols.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    rangeFrom: timestamp('range_from', { withTimezone: true }).notNull(),
    rangeTo: timestamp('range_to', { withTimezone: true }).notNull(),
    /** queued | running | completed | failed | cancelled */
    state: text('state').notNull().default('queued'),
    barsWritten: integer('bars_written').notNull().default(0),
    /** 0..100 */
    percent: integer('percent').notNull().default(0),
    message: text('message').notNull().default(''),
    error: text('error'),
    /** BullMQ job id, so the SSE endpoint can subscribe. */
    queueJobId: text('queue_job_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('ingest_jobs_symbol_idx').on(t.symbolId),
    index('ingest_jobs_state_idx').on(t.state),
  ],
);

/* ------------------------------------------------- strategies and versions */

/**
 * A strategy is the NAME and its metadata; the Pine source lives in its versions.
 *
 * Split this way because a run has to stay reproducible: it points at the exact source it ran,
 * so editing the script afterwards cannot silently rewrite the history of past runs.
 */
export const strategies = pgTable('strategies', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  notes: text('notes'),
  /** Free-form labels for the library page. */
  tags: jsonb('tags').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One immutable snapshot of a strategy's source.
 *
 * `sourceHash` is unique per strategy, which is what makes "Save" idempotent: saving an
 * unchanged script finds the existing version instead of piling up duplicates.
 */
export const strategyVersions = pgTable(
  'strategy_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    strategyId: uuid('strategy_id')
      .notNull()
      .references(() => strategies.id, { onDelete: 'cascade' }),
    /** 1-based, monotonic per strategy. */
    version: integer('version').notNull(),
    pineSource: text('pine_source').notNull(),
    /** sha256 of the source, hex. */
    sourceHash: text('source_hash').notNull(),
    /** 'v5' | 'v6' */
    pineVersion: text('pine_version').notNull(),
    /** Title declared by strategy()/indicator(), when it has one. */
    title: text('title'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('strategy_versions_hash_idx').on(t.strategyId, t.sourceHash),
    uniqueIndex('strategy_versions_number_idx').on(t.strategyId, t.version),
  ],
);

/* ----------------------------------------------------------- backtest runs */

/**
 * Everything needed to reproduce a run, plus its summary.
 *
 * The reproducibility set is deliberate: config alone is not enough, because the same config
 * against re-downloaded data or an upgraded engine is a different experiment.
 * `engineVersion` and `dataVersion` are what let a stale result be recognised as stale.
 */
export const backtestRuns = pgTable(
  'backtest_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    strategyVersionId: uuid('strategy_version_id')
      .notNull()
      .references(() => strategyVersions.id, { onDelete: 'cascade' }),
    symbolId: uuid('symbol_id')
      .notNull()
      .references(() => symbols.id, { onDelete: 'restrict' }),
    /** Timeframe code from @edgelab/shared, e.g. 'H4'. */
    timeframe: text('timeframe').notNull(),
    rangeFrom: timestamp('range_from', { withTimezone: true }).notNull(),
    rangeTo: timestamp('range_to', { withTimezone: true }).notNull(),

    initialCapital: doublePrecision('initial_capital').notNull(),
    accountCurrency: text('account_currency').notNull(),
    /** CostConfig as given. */
    costs: jsonb('costs').notNull(),
    /** Input overrides, keyed by InputSpec.key. */
    inputs: jsonb('inputs').notNull().default({}),
    /** strategy() property overrides. */
    props: jsonb('props').notNull().default({}),
    warmupBars: integer('warmup_bars').notNull().default(0),

    engineId: text('engine_id').notNull(),
    engineVersion: text('engine_version').notNull(),
    /** symbols.data_version at run time: bumped whenever stored bars change. */
    dataVersion: integer('data_version').notNull(),

    state: text('state').notNull().default('queued'),
    error: text('error'),
    /** BullMQ job id, so cancellation and the SSE endpoint can find the job from the run. */
    queueJobId: text('queue_job_id'),
    /** Denormalised KPIs for the runs table, so listing does not need run_metrics. */
    summary: jsonb('summary'),
    /** Zero-cost cross-check outcome; a failure has to be visible on the report. */
    crossCheckOk: boolean('cross_check_ok'),
    crossCheckDeltaPct: doublePrecision('cross_check_delta_pct'),

    barsProcessed: integer('bars_processed'),
    engineMs: integer('engine_ms'),
    totalMs: integer('total_ms'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('backtest_runs_version_idx').on(t.strategyVersionId),
    index('backtest_runs_state_idx').on(t.state),
    index('backtest_runs_symbol_tf_idx').on(t.symbolId, t.timeframe),
    index('backtest_runs_created_idx').on(t.createdAt),
  ],
);

/**
 * One row per closed trade, after costs. Mirrors `CostedTrade` field for field.
 *
 * Keyed on (run_id, seq) rather than a surrogate id: seq is already unique within a run and is
 * what the report, the chart markers and the CSV export all refer to.
 */
export const runTrades = pgTable(
  'run_trades',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => backtestRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    side: text('side').notNull(),
    /** Lots, always positive. */
    qty: doublePrecision('qty').notNull(),
    entryTs: timestamp('entry_ts', { withTimezone: true }).notNull(),
    exitTs: timestamp('exit_ts', { withTimezone: true }).notNull(),
    entryBar: integer('entry_bar').notNull(),
    exitBar: integer('exit_bar').notNull(),
    entryPrice: doublePrecision('entry_price').notNull(),
    exitPrice: doublePrecision('exit_price').notNull(),

    /** The engine's own P&L, before our overlay. */
    grossPnl: doublePrecision('gross_pnl').notNull(),
    commission: doublePrecision('commission').notNull().default(0),
    slippageCost: doublePrecision('slippage_cost').notNull().default(0),
    /** Limit-fill slippage credited back (A29). Not a cost; a correction for an engine divergence. */
    slippageRefund: doublePrecision('slippage_refund').notNull().default(0),
    spreadCost: doublePrecision('spread_cost').notNull().default(0),
    financingCost: doublePrecision('financing_cost').notNull().default(0),
    /** After ALL costs. Every statistic is computed from this. */
    netPnl: doublePrecision('net_pnl').notNull(),

    mae: doublePrecision('mae'),
    mfe: doublePrecision('mfe'),
    barsHeld: integer('bars_held'),
    exitReason: text('exit_reason'),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.seq] }),
    index('run_trades_exit_idx').on(t.runId, t.exitTs),
  ],
);

/**
 * Equity and sample series as COMPRESSED BLOBS — one row per series, not one per bar.
 *
 * Spec 04 requires this and the reason is arithmetic: a one-year M5 run is ~75,000 bars, and
 * four series of that stored as individual rows is ~300,000 rows for a single run. Runs
 * accumulate, and the series are only ever read whole — to draw a chart or to feed the metrics
 * engine. A row per bar buys queryability nobody uses and costs two orders of magnitude in
 * write volume and index size.
 *
 * `kind` is 'close' | 'intrabar' | 'daily' | 'monthly'. Encoding lives in ./series-codec.ts.
 */
export const runSeries = pgTable(
  'run_series',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => backtestRuns.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    /** Codec identifier, so an old blob stays readable after the format changes. */
    format: text('format').notNull(),
    pointCount: integer('point_count').notNull(),
    payload: bytea('payload').notNull(),
    uncompressedBytes: integer('uncompressed_bytes').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.kind] })],
);

/** Long-form metrics, one row per metric, for cross-run comparison queries. */
export const runMetrics = pgTable(
  'run_metrics',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => backtestRuns.id, { onDelete: 'cascade' }),
    metricKey: text('metric_key').notNull(),
    value: doublePrecision('value'),
  },
  (t) => [primaryKey({ columns: [t.runId, t.metricKey] })],
);

export const schema = {
  symbols,
  candlesM1,
  ingestJobs,
  strategies,
  strategyVersions,
  backtestRuns,
  runTrades,
  runSeries,
  runMetrics,
};
