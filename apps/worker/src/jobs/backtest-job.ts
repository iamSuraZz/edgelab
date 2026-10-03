import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';

import { completeRun, failRun, findSymbolByCode, setRunState, type DbClient } from '@edgelab/db';
import type { CostConfig, Timeframe } from '@edgelab/shared';

import { assertSingleFeed } from '../ingest/feed-guard';
import { TaskFailure } from '../pool/errors';
import type { TaskPool } from '../pool/pool';
import type { BacktestTaskOutput } from '../pool/tasks/backtest';
import type { CancellationWatcher } from './cancellation';
import type { JobEventPublisher } from './events';

/**
 * The `backtest` job.
 *
 * The run row already exists (the API created it, so a client has an id to poll before the job
 * is even picked up). This job's contract is therefore: move it out of `queued`, and leave it
 * in exactly one terminal state — `completed`, `failed` or `cancelled` — whatever happens.
 * A row stuck in `running` after the worker restarts is the failure mode to avoid, because
 * nothing downstream can tell it from a job still in progress.
 */

export const BACKTEST_JOB = 'backtest';

export interface BacktestJobData {
  readonly runId: string;
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
}

export interface BacktestJobResult {
  readonly runId: string;
  readonly closedTrades: number;
  readonly netProfit: number;
  readonly crossCheckOk: boolean;
}

export interface BacktestJobDeps {
  readonly db: DbClient;
  readonly pool: TaskPool;
  readonly events: JobEventPublisher;
  readonly cancellation: CancellationWatcher;
  readonly databaseUrl: string;
  readonly redis: Redis;
}

export async function processBacktestJob(
  job: Job<BacktestJobData>,
  deps: BacktestJobDeps,
): Promise<BacktestJobResult> {
  const jobId = String(job.id);
  const { runId } = job.data;
  const base = { jobId, queue: 'backtest', runId };

  const controller = deps.cancellation.register(jobId);
  const progress = deps.events.throttled(base);

  await deps.events.emit({
    ...base,
    state: 'running',
    percent: 1,
    message: 'starting',
    updatedAt: Date.now(),
  });
  await setRunState(deps.db.db, runId, 'running');

  try {
    /*
     * One series, one feed (A6) — checked HERE, on the main thread, before a worker thread is
     * spent.
     *
     * Deliberately not inside the piscina task. It was there first and it made the no-data e2e
     * test fail with `task-timeout`: the thread loads its own module graph outside vitest's
     * resolution, and the extra import stalled it past the 120s limit. Nothing about this check
     * needs a thread — it is one indexed query — and running it out here also keeps the refusal
     * off the structured-clone path entirely.
     */
    const symbolRow = await findSymbolByCode(deps.db, job.data.symbolCode);
    if (symbolRow !== null) {
      await assertSingleFeed({
        db: deps.db,
        symbolId: symbolRow.id,
        symbolCode: job.data.symbolCode,
        fromMs: job.data.fromMs,
        toMs: job.data.toMs,
      });
    }
    // An unknown symbol is not this guard's business — the task reports it with a better message.

    const output = await deps.pool.backtest(
      {
        // So the task refuses against the limit the pool actually enforces.
        memoryLimitMb: deps.pool.stats.memoryLimitMb,
        taskTimeoutMs: deps.pool.stats.timeoutMs,
        runId,
        databaseUrl: deps.databaseUrl,
        source: job.data.source,
        symbolCode: job.data.symbolCode,
        timeframe: job.data.timeframe,
        fromMs: job.data.fromMs,
        toMs: job.data.toMs,
        initialCapital: job.data.initialCapital,
        accountCurrency: job.data.accountCurrency,
        costs: job.data.costs,
        inputs: job.data.inputs,
        props: job.data.props,
        warmupBars: job.data.warmupBars,
        rfAnnual: job.data.rfAnnual,
      },
      {
        signal: controller.signal,
        onProgress: (percent, message) => {
          progress.report(percent, message);
          // BullMQ's own progress, so `bullmq` tooling and a stalled-job check both see life.
          void job.updateProgress(Math.round(percent)).catch(() => undefined);
        },
      },
    );

    await progress.flush();
    await persist(deps.db, output);

    await deps.events.emit({
      ...base,
      state: 'completed',
      percent: 100,
      message: summaryLine(output),
      updatedAt: Date.now(),
    });

    return {
      runId,
      closedTrades: output.summary.closedTrades,
      netProfit: output.summary.netProfit,
      crossCheckOk: output.crossCheckOk,
    };
  } catch (error: unknown) {
    await progress.flush();

    const cancelled = controller.signal.aborted;
    const { message, code } = describeFailure(error, cancelled);

    // The run row is marked terminal BEFORE rethrowing, so a client polling the run never sees
    // it stuck in `running` — even if BullMQ then retries the job.
    if (cancelled) {
      await setRunState(deps.db.db, runId, 'cancelled', message);
    } else {
      await failRun(deps.db.db, runId, message);
    }

    await deps.events.emit({
      ...base,
      state: cancelled ? 'cancelled' : 'failed',
      percent: 100,
      message: cancelled ? 'cancelled' : 'failed',
      updatedAt: Date.now(),
      error: message,
      errorCode: code,
    });

    // A cancelled job must not be retried; BullMQ only honours that via UnrecoverableError,
    // which we cannot import without coupling this module to bullmq's class hierarchy — so the
    // job is marked done and the failure is reported through the run row and the event stream.
    if (cancelled) {
      return { runId, closedTrades: 0, netProfit: 0, crossCheckOk: false };
    }
    throw error instanceof Error ? error : new Error(message);
  } finally {
    deps.cancellation.unregister(jobId);
  }
}

async function persist(db: DbClient, output: BacktestTaskOutput): Promise<void> {
  await completeRun(db.db, {
    runId: output.runId,
    trades: output.trades,
    series: output.series,
    metrics: output.metrics,
    summary: {
      ...output.summary,
      report: output.report,
      crossCheckMessage: output.crossCheckMessage,
      diagnostics: output.diagnostics,
      unfilledEntryOrders: output.unfilledEntryOrders,
    },
    crossCheckOk: output.crossCheckOk,
    crossCheckDeltaPct: output.crossCheckDeltaPct,
    barsProcessed: output.barsProcessed,
    engineMs: output.engineMs,
    totalMs: output.totalMs,
  });
}

function summaryLine(output: BacktestTaskOutput): string {
  const trades = output.summary.closedTrades;
  const net = output.summary.netProfit.toFixed(2);
  return `${String(trades)} trade(s), net ${net}, cross-check ${output.crossCheckOk ? 'PASS' : 'FAIL'}`;
}

/**
 * Turn whatever went wrong into a message a user can act on, plus a stable code.
 *
 * Classification travels in `cause`. An error crossing back out of a worker thread is
 * structured-cloned, which DROPS own properties and NORMALISES `name` to one of the seven
 * built-ins — so neither a `code` property nor a custom `name` survives the trip. `cause` does,
 * and it clones as an arbitrary value, so a plain `{ edgelabCode }` object arrives intact.
 *
 * The no-data case is singled out because it is by far the most common failure: asking for a
 * range that was never downloaded. "No EURUSD data in 2024-02-01 .. 2024-03-01" sends you to
 * the Data page; "bad request" sends you to re-read your script.
 */
function describeFailure(error: unknown, cancelled: boolean): { message: string; code: string } {
  if (cancelled) return { message: 'Cancelled.', code: 'cancelled' };

  // A domain failure tagged inside the thread, checked BEFORE the pool's generic verdict —
  // otherwise "no data for that range" is reported as "your script has a bug". The pool wraps
  // anything the task throws in TaskScriptError, which is the right default and the wrong
  // answer for a failure the task classified itself.
  const tagged = domainCode(error);
  if (tagged !== null) {
    return { message: error instanceof Error ? error.message : String(error), code: tagged };
  }

  // TaskFailure is raised on THIS side of the boundary by the pool, so instanceof is sound.
  if (error instanceof TaskFailure) {
    return { message: error.message, code: error.code };
  }

  if (error instanceof Error) {
    return { message: error.message, code: 'internal' };
  }

  return { message: String(error), code: 'internal' };
}

/**
 * Read a code out of `cause`, following the chain the pool's wrapper adds.
 *
 * Two levels because the pool re-throws as `TaskScriptError` with the original as its own
 * `cause`, so a tagged error ends up one hop deeper than it started.
 */
function domainCode(error: unknown): string | null {
  for (let current: unknown = error, depth = 0; depth < 4; depth += 1) {
    if (!(current instanceof Error)) break;
    const cause: unknown = current.cause;
    if (typeof cause === 'object' && cause !== null && 'edgelabCode' in cause) {
      const code = (cause as { edgelabCode: unknown }).edgelabCode;
      if (typeof code === 'string' && KNOWN_CODES.has(code)) return code;
    }
    current = cause;
  }
  return null;
}

/** Codes the API and UI understand. An unrecognised tag falls through to `internal`. */
const KNOWN_CODES = new Set(['no-data', 'currency-mismatch', 'validation-failed', 'unsupported']);
