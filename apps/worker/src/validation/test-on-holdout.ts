import {
  findSymbolByCode,
  readHoldoutFresh,
  readRun,
  toDbTime,
  type DbClient,
} from '@edgelab/db';
import {
  analyseHoldoutTest,
  type HoldoutTestResult,
  type SegmentMetrics,
} from '@edgelab/validation';
import { CostConfigSchema, DEFAULT_COSTS, type Timeframe } from '@edgelab/shared';

import { IsolatedPool } from '../pool/isolated-pool';
import { taskPath } from '../pool/pool';
import type { BacktestTaskInput, BacktestTaskOutput } from '../pool/tasks/backtest';

/**
 * Test a stored run's strategy on its symbol's sealed holdout.
 *
 * The ONE route that reads sealed bars, and it exists so that route is deliberate, narrow and
 * counted. Everything else in the codebase reads through `readM1`, which truncates at the seal
 * without the caller having to remember it (A37); this asks for `readM1Unsealed`, which records the
 * view before returning a single bar.
 *
 * The holdout is run as its OWN run from the original starting capital (A24), never as a
 * continuation. A continuation inherits position sizes grown by in-sample profits, so a strategy
 * that made money in sample would trade larger on the holdout and its result would partly measure
 * the in-sample period all over again.
 */

export interface TestOnHoldoutParams {
  readonly db: DbClient;
  readonly runId: string;
  readonly databaseUrl: string;
  readonly maxThreads?: number;
  readonly onProgress?: (percent: number, message: string) => void;
}

export interface TestOnHoldoutReport {
  readonly runId: string;
  readonly checkId: 'overfitting-holdout';
  readonly holdoutId: string;
  readonly sealedFromMs: number;
  readonly sealedToMs: number;
  readonly viewCountBefore: number;
  readonly viewCountAfter: number;
  readonly result: HoldoutTestResult;
  readonly elapsedMs: number;
}

/** Thrown for conditions the caller should report as a refusal, not as a crash. */
export class HoldoutTestRefused extends Error {
  readonly reason: 'no-seal' | 'no-data';

  constructor(reason: 'no-seal' | 'no-data', message: string) {
    super(message);
    this.name = 'HoldoutTestRefused';
    this.reason = reason;
  }
}

export async function testOnHoldout(params: TestOnHoldoutParams): Promise<TestOnHoldoutReport> {
  const startedAt = Date.now();
  const report = params.onProgress ?? ((): void => undefined);

  const run = await readRun(params.db.db, params.runId);
  if (run === null) throw new Error(`No backtest run with id ${params.runId}.`);

  const symbolRow = await findSymbolByCode(params.db, run.symbol);
  if (symbolRow === null) throw new Error(`Run ${params.runId} references unknown ${run.symbol}.`);

  report(5, 'reading the seal');

  // Uncached on the way IN too, so `viewCountBefore` is the real starting count rather than
  // whatever this process happened to cache earlier.
  const seal = await readHoldoutFresh(params.db, symbolRow.id);
  if (seal === null) {
    throw new HoldoutTestRefused(
      'no-seal',
      `No holdout is sealed for ${run.symbol}, so there is nothing withheld to test on. ` +
        'Seal one with `pnpm holdout seal` before any run you intend to test this way — sealing ' +
        'data you have already used is not a holdout.',
    );
  }

  /*
   * The sealed window is everything from the seal forward that we actually hold.
   *
   * Taken from coverage rather than from the run's requested range: the run was truncated AT the
   * seal (A40), so its own `toMs` says nothing about how much withheld data exists, and using it
   * would silently test on an empty window.
   */
  const sealedFromMs = seal.sealedFromMs;
  const lastStoredMs = await lastBarAtOrAfter(params.db, symbolRow.id, sealedFromMs);
  const sealedToMs = lastStoredMs === null ? sealedFromMs : lastStoredMs + 1;

  if (sealedToMs <= sealedFromMs) {
    throw new HoldoutTestRefused(
      'no-data',
      `The seal on ${run.symbol} starts at ${iso(sealedFromMs)} and there are no stored bars at ` +
        'or after it, so the holdout is empty. Nothing was read and no view was counted.',
    );
  }

  report(15, `running ${run.timeframe} on the sealed range`);

  const costs = CostConfigSchema.safeParse(run.costs);
  const pool = new IsolatedPool<BacktestTaskInput, BacktestTaskOutput>({
    filename: taskPath('backtest'),
    maxThreads: params.maxThreads ?? 1,
    taskTimeoutMs: 300_000,
  });

  try {
    const out = await pool.run({
      runId: run.id,
      databaseUrl: params.databaseUrl,
      source: run.pineSource,
      symbolCode: run.symbol,
      timeframe: run.timeframe as Timeframe,
      fromMs: sealedFromMs,
      toMs: sealedToMs,
      initialCapital: run.initialCapital,
      accountCurrency: run.accountCurrency,
      costs: costs.success ? costs.data : DEFAULT_COSTS,
      inputs: asRecord(run.inputs),
      props: asRecord(run.props),
      warmupBars: run.warmupBars,
      /*
       * Zero, because the risk-free rate is not persisted on the run — it reaches the engine as job
       * data and is not recovered here. It affects SHARPE only, and the verdict turns on return per
       * day (A36), so nothing scored here depends on it. Worth knowing when reading the holdout's
       * Sharpe beside the in-sample one, which is why it is said rather than assumed.
       */
      rfAnnual: 0,
      // The whole point of this module.
      unsealed: true,
    });

    report(85, 'comparing against the in-sample result');

    /*
     * Re-read UNCACHED after the run (A59).
     *
     * `readM1Unsealed` incremented the count inside a worker thread, through that thread's own
     * client and its own cache — so a cached read here would hand back the value this process saw
     * before the run and report a look that cost nothing.
     */
    const after = await readHoldoutFresh(params.db, symbolRow.id);

    const result = analyseHoldoutTest({
      inSample: segmentFromRun(run),
      holdout: segmentFromOutput(out, sealedFromMs, sealedToMs),
      viewCountAfter: after?.viewCount ?? seal.viewCount + 1,
    });

    report(100, result.verdict);

    return {
      runId: run.id,
      checkId: 'overfitting-holdout',
      holdoutId: seal.id,
      sealedFromMs,
      sealedToMs,
      viewCountBefore: seal.viewCount,
      viewCountAfter: after?.viewCount ?? seal.viewCount + 1,
      result,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    await pool.close();
  }
}

/**
 * The last stored bar at or after the seal.
 *
 * Read from the bars rather than from the run's range: the run was truncated AT the seal (A40), so
 * its `toMs` says nothing about how much withheld data exists, and trusting it would test on an
 * empty window and report the emptiness as a result.
 */
async function lastBarAtOrAfter(
  db: DbClient,
  symbolId: string,
  fromMs: number,
): Promise<number | null> {
  const result = await db.pool.query<{ last: Date | string | null }>(
    `SELECT max(ts) AS last FROM candles_m1 WHERE symbol_id = $1 AND ts >= $2`,
    [symbolId, toDbTime(fromMs)],
  );
  const last = result.rows[0]?.last ?? null;
  return last === null ? null : new Date(last).getTime();
}

/** The stored run's own figures, which are what "in sample" means for this comparison. */
function segmentFromRun(run: NonNullable<Awaited<ReturnType<typeof readRun>>>): SegmentMetrics {
  const s = (run.summary ?? {}) as Record<string, number | null | undefined>;
  return {
    fromMs: run.fromMs,
    toMs: run.toMs,
    trades: numberOr(s['closedTrades'], 0),
    netProfit: numberOr(s['netProfit'], 0),
    returnPct: nullableNumber(s['totalReturnPct']),
    profitFactor: nullableNumber(s['profitFactor']),
    sharpe: nullableNumber(s['sharpe']),
    winRatePct: nullableNumber(s['winRatePct']),
    maxDrawdownPct: nullableNumber(s['maxDrawdownPct']),
    expectancy: nullableNumber(s['expectancy']),
  };
}

function segmentFromOutput(out: BacktestTaskOutput, fromMs: number, toMs: number): SegmentMetrics {
  const s = out.summary;
  return {
    fromMs,
    toMs,
    trades: s.closedTrades,
    netProfit: s.netProfit,
    returnPct: s.totalReturnPct,
    profitFactor: s.profitFactor,
    sharpe: s.sharpe,
    winRatePct: s.winRatePct,
    maxDrawdownPct: s.maxDrawdownPct,
    expectancy: nullableNumber(out.metrics['expectancy']),
  };
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Undefined and non-finite both become null — never 0, which would read as a measured zero. */
function nullableNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
