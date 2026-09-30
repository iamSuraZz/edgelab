import { accountMoney, lots, price } from '@edgelab/shared';
import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { CostedTrade, EquityPoint, EquitySample } from '@edgelab/shared';

import type { Database } from './client';
import {
  backtestRuns,
  runMetrics,
  runSeries,
  runTrades,
  strategies,
  strategyVersions,
  symbols,
} from './schema';
import {
  SERIES_KINDS,
  decodeEquityCurve,
  decodeSamples,
  encodeEquityCurve,
  encodeSamples,
  type SeriesKind,
} from './series-codec';
import { fromDbTime, fromDbTimeOrNull, toDbTime, type DbTimestamp } from './time';

/**
 * Persistence for strategies, versions and runs.
 *
 * Everything here converts at the epoch-ms ↔ timestamptz boundary and nowhere else, per the
 * convention in ./time.ts.
 */

export function hashSource(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

/* ------------------------------------------------- strategies and versions */

export interface UpsertStrategyVersionParams {
  readonly name: string;
  readonly pineSource: string;
  readonly pineVersion: string;
  readonly title?: string | null;
  readonly notes?: string | null;
}

export interface StrategyVersionRef {
  readonly strategyId: string;
  readonly versionId: string;
  readonly version: number;
  readonly sourceHash: string;
  /** False when an identical version already existed. */
  readonly created: boolean;
}

/**
 * Find or create the strategy, then find or create the version for this exact source.
 *
 * Idempotent on the source hash, which is what makes "Save" safe to press twice: an unchanged
 * script resolves to the version already stored rather than adding a duplicate. A run can then
 * always point at a version, with no special case for "unsaved".
 */
export async function upsertStrategyVersion(
  db: Database,
  params: UpsertStrategyVersionParams,
): Promise<StrategyVersionRef> {
  const sourceHash = hashSource(params.pineSource);

  const existingStrategy = await db
    .select({ id: strategies.id })
    .from(strategies)
    .where(eq(strategies.name, params.name))
    .limit(1);

  let strategyId = existingStrategy[0]?.id;
  if (strategyId === undefined) {
    const inserted = await db
      .insert(strategies)
      .values({
        name: params.name,
        notes: params.notes ?? null,
      })
      .returning({ id: strategies.id });
    strategyId = inserted[0]!.id;
  }

  const existingVersion = await db
    .select({ id: strategyVersions.id, version: strategyVersions.version })
    .from(strategyVersions)
    .where(
      and(eq(strategyVersions.strategyId, strategyId), eq(strategyVersions.sourceHash, sourceHash)),
    )
    .limit(1);

  const found = existingVersion[0];
  if (found !== undefined) {
    return {
      strategyId,
      versionId: found.id,
      version: found.version,
      sourceHash,
      created: false,
    };
  }

  // Next version number. Racy under concurrent saves, which the unique index on
  // (strategy_id, version) turns into a loud constraint violation rather than a duplicate.
  const latest = await db
    .select({ version: strategyVersions.version })
    .from(strategyVersions)
    .where(eq(strategyVersions.strategyId, strategyId))
    .orderBy(desc(strategyVersions.version))
    .limit(1);

  const version = (latest[0]?.version ?? 0) + 1;

  const inserted = await db
    .insert(strategyVersions)
    .values({
      strategyId,
      version,
      pineSource: params.pineSource,
      sourceHash,
      pineVersion: params.pineVersion,
      title: params.title ?? null,
    })
    .returning({ id: strategyVersions.id });

  return { strategyId, versionId: inserted[0]!.id, version, sourceHash, created: true };
}

/* ------------------------------------------------------------------- runs */

export interface CreateRunParams {
  readonly strategyVersionId: string;
  readonly symbolId: string;
  readonly timeframe: string;
  /** The range that ACTUALLY ran, after any holdout truncation (A40). */
  readonly fromMs: number;
  readonly toMs: number;
  /** What was asked for, when a seal cut it short. Omit when nothing was withheld. */
  readonly requestedToMs?: number;
  readonly initialCapital: number;
  readonly accountCurrency: string;
  readonly costs: unknown;
  readonly inputs?: Record<string, unknown>;
  readonly props?: Record<string, unknown>;
  readonly warmupBars?: number;
  readonly engineId: string;
  readonly engineVersion: string;
  readonly dataVersion: number;
  /**
   * Initial state. The API enqueues and so starts at ; the CLI runs inline and starts
   * at . Defaulting either way would mislabel the other.
   */
  readonly state?: 'queued' | 'running';
}

export async function createRun(db: Database, params: CreateRunParams): Promise<string> {
  const inserted = await db
    .insert(backtestRuns)
    .values({
      strategyVersionId: params.strategyVersionId,
      symbolId: params.symbolId,
      timeframe: params.timeframe,
      rangeFrom: toDbTime(params.fromMs),
      rangeTo: toDbTime(params.toMs),
      requestedRangeTo: params.requestedToMs === undefined ? null : toDbTime(params.requestedToMs),
      initialCapital: params.initialCapital,
      accountCurrency: params.accountCurrency,
      costs: params.costs,
      inputs: params.inputs ?? {},
      props: params.props ?? {},
      warmupBars: params.warmupBars ?? 0,
      engineId: params.engineId,
      engineVersion: params.engineVersion,
      dataVersion: params.dataVersion,
      state: params.state ?? 'running',
    })
    .returning({ id: backtestRuns.id });

  return inserted[0]!.id;
}

export interface CompleteRunParams {
  readonly runId: string;
  readonly trades: readonly CostedTrade[];
  readonly series: {
    readonly close: readonly EquityPoint[];
    readonly intrabar: readonly EquityPoint[];
    readonly daily: readonly EquitySample[];
    readonly monthly: readonly EquitySample[];
  };
  /** Flat metric key -> value. Nulls are stored, because "undefined" is a real result. */
  readonly metrics: Readonly<Record<string, number | null>>;
  readonly summary: unknown;
  readonly crossCheckOk: boolean;
  readonly crossCheckDeltaPct: number | null;
  readonly barsProcessed: number;
  readonly engineMs: number;
  readonly totalMs: number;
}

/**
 * Write a finished run's results and mark it complete, in ONE transaction.
 *
 * Atomic on purpose: a run row saying `completed` with half its trades missing is worse than no
 * row at all, because nothing downstream would know to distrust it.
 */
export async function completeRun(db: Database, params: CompleteRunParams): Promise<void> {
  const { runId } = params;

  await db.transaction(async (tx) => {
    // Re-running into the same row must not accumulate. Deleting first makes this idempotent.
    await tx.delete(runTrades).where(eq(runTrades.runId, runId));
    await tx.delete(runSeries).where(eq(runSeries.runId, runId));
    await tx.delete(runMetrics).where(eq(runMetrics.runId, runId));

    if (params.trades.length > 0) {
      // Chunked: Postgres caps a statement at 65,535 bind parameters, and these rows carry
      // ~20 columns each, so a 10k-trade run would blow the limit in a single insert.
      const CHUNK = 500;
      for (let i = 0; i < params.trades.length; i += CHUNK) {
        await tx.insert(runTrades).values(
          params.trades.slice(i, i + CHUNK).map((t) => ({
            runId,
            seq: t.seq,
            side: t.side,
            qty: t.qty,
            entryTs: toDbTime(t.entryTime),
            exitTs: toDbTime(t.exitTime),
            entryBar: t.entryBar,
            exitBar: t.exitBar,
            entryPrice: t.entryPrice,
            exitPrice: t.exitPrice,
            grossPnl: t.grossPnl,
            commission: t.commission,
            slippageCost: t.slippageCost,
            slippageRefund: t.slippageRefund,
            spreadCost: t.spreadCost,
            financingCost: t.financingCost,
            netPnl: t.netPnl,
            mae: t.mae,
            mfe: t.mfe,
            barsHeld: t.barsHeld,
            exitReason: t.exitReason,
          })),
        );
      }
    }

    const encoded = {
      close: encodeEquityCurve(params.series.close),
      intrabar: encodeEquityCurve(params.series.intrabar),
      daily: encodeSamples(params.series.daily),
      monthly: encodeSamples(params.series.monthly),
    } satisfies Record<SeriesKind, ReturnType<typeof encodeSamples>>;

    await tx.insert(runSeries).values(
      SERIES_KINDS.map((kind) => ({
        runId,
        kind,
        format: encoded[kind].format,
        pointCount: encoded[kind].pointCount,
        payload: encoded[kind].payload,
        uncompressedBytes: encoded[kind].uncompressedBytes,
      })),
    );

    const metricRows = Object.entries(params.metrics).map(([metricKey, value]) => ({
      runId,
      metricKey,
      value,
    }));
    if (metricRows.length > 0) {
      const CHUNK = 1_000;
      for (let i = 0; i < metricRows.length; i += CHUNK) {
        await tx.insert(runMetrics).values(metricRows.slice(i, i + CHUNK));
      }
    }

    await tx
      .update(backtestRuns)
      .set({
        state: 'completed',
        error: null,
        summary: params.summary,
        crossCheckOk: params.crossCheckOk,
        crossCheckDeltaPct: params.crossCheckDeltaPct,
        barsProcessed: params.barsProcessed,
        engineMs: Math.round(params.engineMs),
        totalMs: Math.round(params.totalMs),
        completedAt: sql`now()`,
      })
      .where(eq(backtestRuns.id, runId));
  });
}

/**
 * Move a run to a state, optionally recording why.
 *
 * Exists so a job can mark a run terminal the moment it knows, rather than leaving the row in
 * `running` while it unwinds. A row stuck in `running` after a worker restart is
 * indistinguishable from one still in progress, which is the worst of the available outcomes.
 */
export async function setRunState(
  db: Database,
  runId: string,
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled',
  error?: string,
): Promise<void> {
  const terminal = state === 'completed' || state === 'failed' || state === 'cancelled';
  await db
    .update(backtestRuns)
    .set({
      state,
      error: error === undefined ? null : error.slice(0, 4_000),
      ...(terminal ? { completedAt: sql`now()` } : {}),
    })
    .where(eq(backtestRuns.id, runId));
}

/** The queue job id, recorded once the job is enqueued so cancellation can find it. */
export async function setRunJobId(db: Database, runId: string, jobId: string): Promise<void> {
  await db.update(backtestRuns).set({ queueJobId: jobId }).where(eq(backtestRuns.id, runId));
}

export async function failRun(db: Database, runId: string, error: string): Promise<void> {
  await db
    .update(backtestRuns)
    .set({
      state: 'failed',
      // Truncated: a Pine stack trace can be enormous and the column is read by the UI.
      error: error.slice(0, 4_000),
      completedAt: sql`now()`,
    })
    .where(eq(backtestRuns.id, runId));
}

/* ------------------------------------------------------------- reading back */

export interface RunSummaryRow {
  readonly id: string;
  readonly strategyName: string;
  readonly version: number;
  readonly symbol: string;
  readonly timeframe: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly state: string;
  readonly crossCheckOk: boolean | null;
  readonly summary: unknown;
  readonly createdAt: number;
  readonly completedAt: number | null;
  readonly tradeCount: number;
}

export async function listRuns(db: Database, limit = 50): Promise<RunSummaryRow[]> {
  const rows = await db.execute<{
    id: string;
    strategy_name: string;
    version: number;
    symbol: string;
    timeframe: string;
    // `DbTimestamp`, not `Date`: this is the repo's one RAW query, and raw rows skip drizzle's
    // column mappers, so these arrive as ISO strings (A54). Annotating them `Date` is what let a
    // list endpoint that throws on every row compile and ship.
    range_from: DbTimestamp;
    range_to: DbTimestamp;
    state: string;
    cross_check_ok: boolean | null;
    summary: unknown;
    created_at: DbTimestamp;
    completed_at: DbTimestamp | null;
    trade_count: string;
  }>(sql`
    select r.id,
           s.name          as strategy_name,
           v.version,
           sym.symbol,
           r.timeframe,
           r.range_from,
           r.range_to,
           r.state,
           r.cross_check_ok,
           r.summary,
           r.created_at,
           r.completed_at,
           (select count(*) from run_trades t where t.run_id = r.id) as trade_count
      from backtest_runs r
      join strategy_versions v on v.id = r.strategy_version_id
      join strategies s        on s.id = v.strategy_id
      join symbols sym         on sym.id = r.symbol_id
     order by r.created_at desc
     limit ${limit}
  `);

  return rows.rows.map((r) => ({
    id: r.id,
    strategyName: r.strategy_name,
    version: r.version,
    symbol: r.symbol,
    timeframe: r.timeframe,
    fromMs: fromDbTime(r.range_from),
    toMs: fromDbTime(r.range_to),
    state: r.state,
    crossCheckOk: r.cross_check_ok,
    summary: r.summary,
    createdAt: fromDbTime(r.created_at),
    completedAt: fromDbTimeOrNull(r.completed_at),
    tradeCount: Number(r.trade_count),
  }));
}

export interface RunDetailRow {
  readonly id: string;
  readonly strategyId: string;
  readonly strategyName: string;
  readonly strategyVersionId: string;
  readonly version: number;
  readonly pineSource: string;
  readonly sourceHash: string;
  readonly symbol: string;
  readonly timeframe: string;
  /** The range that actually ran. */
  readonly fromMs: number;
  readonly toMs: number;
  /** What was asked for, when a sealed holdout cut it short. Null when nothing was withheld. */
  readonly requestedToMs: number | null;
  readonly initialCapital: number;
  readonly accountCurrency: string;
  readonly costs: unknown;
  readonly inputs: unknown;
  readonly props: unknown;
  readonly warmupBars: number;
  readonly engineId: string;
  readonly engineVersion: string;
  readonly dataVersion: number;
  readonly state: string;
  readonly error: string | null;
  readonly queueJobId: string | null;
  readonly summary: unknown;
  readonly crossCheckOk: boolean | null;
  readonly crossCheckDeltaPct: number | null;
  readonly barsProcessed: number | null;
  readonly engineMs: number | null;
  readonly totalMs: number | null;
  readonly createdAt: number;
  readonly completedAt: number | null;
}

/**
 * Everything about one run, including the source it ran, in a single query.
 *
 * The source is joined in rather than fetched separately because the report page needs it to
 * show the script beside the results, and a second round trip for a column that is already on
 * the join path is waste.
 */
export async function readRun(db: Database, runId: string): Promise<RunDetailRow | null> {
  const rows = await db
    .select({
      run: backtestRuns,
      version: strategyVersions,
      strategy: strategies,
      symbol: symbols.symbol,
    })
    .from(backtestRuns)
    .innerJoin(strategyVersions, eq(strategyVersions.id, backtestRuns.strategyVersionId))
    .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId))
    .innerJoin(symbols, eq(symbols.id, backtestRuns.symbolId))
    .where(eq(backtestRuns.id, runId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;

  return {
    id: row.run.id,
    strategyId: row.strategy.id,
    strategyName: row.strategy.name,
    strategyVersionId: row.version.id,
    version: row.version.version,
    pineSource: row.version.pineSource,
    sourceHash: row.version.sourceHash,
    symbol: row.symbol,
    timeframe: row.run.timeframe,
    fromMs: fromDbTime(row.run.rangeFrom),
    toMs: fromDbTime(row.run.rangeTo),
    requestedToMs: row.run.requestedRangeTo === null ? null : fromDbTime(row.run.requestedRangeTo),
    initialCapital: row.run.initialCapital,
    accountCurrency: row.run.accountCurrency,
    costs: row.run.costs,
    inputs: row.run.inputs,
    props: row.run.props,
    warmupBars: row.run.warmupBars,
    engineId: row.run.engineId,
    engineVersion: row.run.engineVersion,
    dataVersion: row.run.dataVersion,
    state: row.run.state,
    error: row.run.error,
    queueJobId: row.run.queueJobId,
    summary: row.run.summary,
    crossCheckOk: row.run.crossCheckOk,
    crossCheckDeltaPct: row.run.crossCheckDeltaPct,
    barsProcessed: row.run.barsProcessed,
    engineMs: row.run.engineMs,
    totalMs: row.run.totalMs,
    createdAt: fromDbTime(row.run.createdAt),
    completedAt: fromDbTimeOrNull(row.run.completedAt),
  };
}

/* ------------------------------------------------- strategies, for the API */

export interface StrategyRow {
  readonly id: string;
  readonly name: string;
  readonly notes: string | null;
  readonly tags: string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly versionCount: number;
  readonly latestVersion: StrategyVersionRow | null;
}

export interface StrategyVersionRow {
  readonly id: string;
  readonly version: number;
  readonly sourceHash: string;
  readonly pineVersion: string;
  readonly title: string | null;
  readonly createdAt: number;
}

export async function listStrategies(db: Database, limit = 200): Promise<StrategyRow[]> {
  const rows = await db.select().from(strategies).orderBy(desc(strategies.updatedAt)).limit(limit);
  if (rows.length === 0) return [];

  // One query for every version rather than N+1: the library page shows a card per strategy
  // with its latest version, and a per-strategy round trip is what makes that page slow.
  const versions = await db.select().from(strategyVersions).orderBy(desc(strategyVersions.version));

  const byStrategy = new Map<string, StrategyVersionRow[]>();
  for (const v of versions) {
    const list = byStrategy.get(v.strategyId) ?? [];
    list.push(toVersionRow(v));
    byStrategy.set(v.strategyId, list);
  }

  return rows.map((s) => {
    const own = byStrategy.get(s.id) ?? [];
    return {
      id: s.id,
      name: s.name,
      notes: s.notes,
      tags: Array.isArray(s.tags) ? (s.tags as string[]) : [],
      createdAt: fromDbTime(s.createdAt),
      updatedAt: fromDbTime(s.updatedAt),
      versionCount: own.length,
      latestVersion: own[0] ?? null,
    };
  });
}

export interface StrategyDetail extends StrategyRow {
  readonly versions: StrategyVersionRow[];
}

export async function readStrategy(db: Database, id: string): Promise<StrategyDetail | null> {
  const rows = await db.select().from(strategies).where(eq(strategies.id, id)).limit(1);
  const s = rows[0];
  if (s === undefined) return null;

  const versions = await db
    .select()
    .from(strategyVersions)
    .where(eq(strategyVersions.strategyId, id))
    .orderBy(desc(strategyVersions.version));

  const mapped = versions.map(toVersionRow);

  return {
    id: s.id,
    name: s.name,
    notes: s.notes,
    tags: Array.isArray(s.tags) ? (s.tags as string[]) : [],
    createdAt: fromDbTime(s.createdAt),
    updatedAt: fromDbTime(s.updatedAt),
    versionCount: mapped.length,
    latestVersion: mapped[0] ?? null,
    versions: mapped,
  };
}

export async function setStrategyTags(
  db: Database,
  strategyId: string,
  tags: readonly string[],
): Promise<void> {
  await db
    .update(strategies)
    .set({ tags: [...tags], updatedAt: new Date() })
    .where(eq(strategies.id, strategyId));
}

/**
 * Rename or annotate a strategy.
 *
 * Takes a partial and builds the SET clause from the keys PRESENT, so omitting `notes` leaves
 * them alone while passing `null` clears them — a distinction `notes?: string` cannot make and
 * that the Library's "edit tags without touching the notes" flow depends on.
 */
export async function updateStrategyMeta(
  db: Database,
  strategyId: string,
  patch: { name?: string; notes?: string | null },
): Promise<void> {
  await db
    .update(strategies)
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.notes === undefined ? {} : { notes: patch.notes }),
      updatedAt: new Date(),
    })
    .where(eq(strategies.id, strategyId));
}

/** Bump `updatedAt` so the library list sorts a freshly-edited strategy to the top. */
export async function touchStrategy(db: Database, strategyId: string): Promise<void> {
  await db.update(strategies).set({ updatedAt: new Date() }).where(eq(strategies.id, strategyId));
}

/** The stored source for a version, for a run that references it by id. */
export async function readStrategyVersion(
  db: Database,
  versionId: string,
): Promise<{ id: string; strategyId: string; version: number; pineSource: string } | null> {
  const rows = await db
    .select()
    .from(strategyVersions)
    .where(eq(strategyVersions.id, versionId))
    .limit(1);
  const v = rows[0];
  return v === undefined
    ? null
    : { id: v.id, strategyId: v.strategyId, version: v.version, pineSource: v.pineSource };
}

function toVersionRow(v: {
  id: string;
  version: number;
  sourceHash: string;
  pineVersion: string;
  title: string | null;
  createdAt: Date;
}): StrategyVersionRow {
  return {
    id: v.id,
    version: v.version,
    sourceHash: v.sourceHash,
    pineVersion: v.pineVersion,
    title: v.title,
    createdAt: fromDbTime(v.createdAt),
  };
}

export async function readRunTrades(db: Database, runId: string): Promise<CostedTrade[]> {
  const rows = await db
    .select()
    .from(runTrades)
    .where(eq(runTrades.runId, runId))
    .orderBy(runTrades.seq);

  /*
   * The other boundary where plain numbers become a CostedTrade — the first being the cost overlay.
   * Branding is applied here rather than trusted, because a column is just a double and the DB has
   * no idea whether it holds lots or units. `qty` is written in LOTS by `applyCosts`; if that ever
   * changes, this is the line that has to change with it.
   */
  return rows.map((r) => ({
    seq: r.seq,
    side: r.side === 'short' ? ('short' as const) : ('long' as const),
    qty: lots(r.qty),
    entryTime: fromDbTime(r.entryTs),
    exitTime: fromDbTime(r.exitTs),
    entryBar: r.entryBar,
    exitBar: r.exitBar,
    entryPrice: price(r.entryPrice),
    exitPrice: price(r.exitPrice),
    grossPnl: accountMoney(r.grossPnl),
    commission: accountMoney(r.commission),
    slippageCost: accountMoney(r.slippageCost),
    slippageRefund: accountMoney(r.slippageRefund),
    spreadCost: accountMoney(r.spreadCost),
    financingCost: accountMoney(r.financingCost),
    netPnl: accountMoney(r.netPnl),
    mae: r.mae === null ? null : accountMoney(r.mae),
    mfe: r.mfe === null ? null : accountMoney(r.mfe),
    barsHeld: r.barsHeld,
    exitReason: r.exitReason,
  }));
}

/** One stored series, decoded. Null when the run has no blob of that kind. */
export async function readRunSeries(
  db: Database,
  runId: string,
  kind: SeriesKind,
): Promise<EquityPoint[] | EquitySample[] | null> {
  const rows = await db
    .select()
    .from(runSeries)
    .where(and(eq(runSeries.runId, runId), eq(runSeries.kind, kind)))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;

  return kind === 'close' || kind === 'intrabar'
    ? decodeEquityCurve(row.payload, row.format)
    : decodeSamples(row.payload, row.format);
}
