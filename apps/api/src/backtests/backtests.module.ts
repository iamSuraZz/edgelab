import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import {
  createRun,
  findSymbolByCode,
  readM1Bars,
  readRun,
  readRunSeries,
  readRunTrades,
  listRuns,
  readStrategyVersion,
  setRunJobId,
  upsertStrategyVersion,
  type DbClient,
  type RunDetailRow,
} from '@edgelab/db';
import { PINETS_VERSION } from '@edgelab/engine';
import {
  CreateBacktestSchema,
  ListRunsQuerySchema,
  SeriesQuerySchema,
  jobCancelChannel,
  type BacktestCreated,
  type CostedTrade,
  type CreateBacktest,
  type ListRunsQuery,
  type EquityPoint,
  type EquitySample,
  type SeriesQuery,
} from '@edgelab/shared';

import { ApiException } from '../common/api-error';
import { ZodPipe } from '../common/zod.pipe';
import { DB_CLIENT, REDIS_CLIENT } from '../infra/infra.module';
import { BACKTEST_QUEUE, QUEUE_NAME } from '../infra/queues.module';
import { PineModule, PineService } from '../pine/pine.module';
import { buyAndHoldCurve, downsampleEquity } from './series';

/**
 * Backtest runs over HTTP.
 *
 * The run row is created BEFORE the job is enqueued, so `POST /backtests` can return an id the
 * caller can immediately poll or subscribe to. The alternative — enqueue first, create the row
 * in the worker — leaves a window where the caller has a job id but nothing to read.
 */

@Injectable()
export class BacktestsService {
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(BACKTEST_QUEUE) private readonly queue: Queue,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(PineService) private readonly pine: PineService,
  ) {}

  async create(body: CreateBacktest): Promise<BacktestCreated> {
    const symbol = await findSymbolByCode(this.db, body.symbol);
    if (symbol === null) {
      throw ApiException.notFound(
        `No symbol "${body.symbol}". Check GET /api/symbols for what is configured.`,
      );
    }

    /*
     * D6's cross-currency refusal is GONE — the conversion layer is wired in (spec 03), so a
     * USDJPY run on a USD account converts bar by bar through USDJPY instead of being rejected.
     *
     * Nothing replaces it here on purpose. Whether a run is convertible depends on which pair is
     * needed and whether its bars are stored, and only the job can answer that: it holds the
     * symbol registry and the bar store. Guessing at submit time would either duplicate that
     * logic or refuse runs that would have worked. The job reports `no-data` naming the pair and
     * the range to download.
     */

    const { source, versionRef } = await this.resolveSource(body);

    // Sizing override (spec 03's margin % = 100/leverage). Merged UNDER the caller's own props
    // so an explicit `props` entry always wins.
    const props: Record<string, unknown> =
      body.lots > 0
        ? {
            default_qty_type: 'fixed',
            default_qty_value: body.lots * symbol.contractSize,
            margin_long: 100 / body.leverage,
            margin_short: 100 / body.leverage,
            ...body.props,
          }
        : { ...body.props };

    const runId = await createRun(this.db.db, {
      strategyVersionId: versionRef.versionId,
      symbolId: symbol.id,
      timeframe: body.timeframe,
      fromMs: body.from,
      toMs: body.to,
      initialCapital: body.initialCapital,
      accountCurrency: body.accountCurrency.toUpperCase(),
      costs: body.costs,
      inputs: body.inputs,
      props,
      warmupBars: body.warmupBars,
      engineId: 'pinets',
      engineVersion: PINETS_VERSION,
      dataVersion: symbol.dataVersion,
      state: 'queued',
    });

    const job = await this.queue.add(QUEUE_NAME.backtest, {
      runId,
      source,
      symbolCode: symbol.symbol,
      timeframe: body.timeframe,
      fromMs: body.from,
      toMs: body.to,
      initialCapital: body.initialCapital,
      accountCurrency: body.accountCurrency.toUpperCase(),
      costs: body.costs,
      inputs: body.inputs,
      props,
      warmupBars: body.warmupBars,
      rfAnnual: body.rfAnnual,
    });

    const jobId = String(job.id);
    await setRunJobId(this.db.db, runId, jobId);

    return {
      runId,
      jobId,
      strategyId: versionRef.strategyId,
      strategyVersionId: versionRef.versionId,
      version: versionRef.version,
      eventsUrl: `/api/jobs/${jobId}/events`,
    };
  }

  /**
   * Resolve the request down to a stored version plus its source.
   *
   * An inline `source` is SAVED first. Spec 04 requires a run to be reproducible, and a run
   * pointing at a source that exists only in a queue payload is not — the payload is pruned
   * once the job ages out.
   */
  private async resolveSource(body: CreateBacktest): Promise<{
    source: string;
    versionRef: { strategyId: string; versionId: string; version: number };
  }> {
    if (body.strategyVersionId !== undefined) {
      const version = await readStrategyVersion(this.db.db, body.strategyVersionId);
      if (version === null) {
        throw ApiException.notFound(`No strategy version with id ${body.strategyVersionId}.`);
      }
      return {
        source: version.pineSource,
        versionRef: {
          strategyId: version.strategyId,
          versionId: version.id,
          version: version.version,
        },
      };
    }

    const source = body.source!;
    const compiled = this.pine.compile(source);
    if (!compiled.ok) {
      const first = compiled.diagnostics.find((d) => d.severity === 'error');
      throw ApiException.compileFailed(
        `The script does not compile: ${first?.message ?? 'unknown error'}`,
        { diagnostics: compiled.diagnostics },
      );
    }

    const ref = await upsertStrategyVersion(this.db.db, {
      name: body.name ?? compiled.meta.title ?? 'Untitled strategy',
      pineSource: source,
      pineVersion: compiled.meta.version === 6 ? 'v6' : 'v5',
      title: compiled.meta.title,
    });

    return {
      source,
      versionRef: { strategyId: ref.strategyId, versionId: ref.versionId, version: ref.version },
    };
  }

  /**
   * Recent runs, newest first, for the Runs page.
   *
   * Reads the denormalised  rather than joining run_metrics: the list shows a handful of
   * KPIs per row, and a metrics join would fetch 131 rows per run to display eight of them.
   */
  async list(limit: number): Promise<unknown> {
    const rows = await listRuns(this.db.db, limit);
    return rows.map((r) => {
      const summary = (r.summary ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        strategyName: r.strategyName,
        version: r.version,
        symbol: r.symbol,
        timeframe: r.timeframe,
        from: r.fromMs,
        to: r.toMs,
        state: r.state,
        crossCheckOk: r.crossCheckOk,
        tradeCount: r.tradeCount,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
        kpis: {
          netProfit: summary['netProfit'] ?? null,
          totalReturnPct: summary['totalReturnPct'] ?? null,
          profitFactor: summary['profitFactor'] ?? null,
          maxDrawdownPct: summary['maxDrawdownPct'] ?? null,
          sharpe: summary['sharpe'] ?? null,
          winRatePct: summary['winRatePct'] ?? null,
          closedTrades: summary['closedTrades'] ?? null,
        },
      };
    });
  }

  async get(runId: string): Promise<unknown> {
    const run = await this.requireRun(runId);
    const summary = (run.summary ?? {}) as Record<string, unknown>;

    return {
      id: run.id,
      state: run.state,
      error: run.error,
      errorCode: run.error === null ? null : 'see summary',
      strategy: {
        id: run.strategyId,
        name: run.strategyName,
        versionId: run.strategyVersionId,
        version: run.version,
        sourceHash: run.sourceHash,
        source: run.pineSource,
      },
      config: {
        symbol: run.symbol,
        timeframe: run.timeframe,
        from: run.fromMs,
        to: run.toMs,
        initialCapital: run.initialCapital,
        accountCurrency: run.accountCurrency,
        costs: run.costs,
        inputs: run.inputs,
        props: run.props,
        warmupBars: run.warmupBars,
      },
      provenance: {
        engineId: run.engineId,
        engineVersion: run.engineVersion,
        dataVersion: run.dataVersion,
        jobId: run.queueJobId,
      },
      // The full MetricsReport is inside the summary blob; hoisted so the report page does not
      // have to know it was nested.
      metrics: summary['report'] ?? null,
      kpis: {
        netProfit: summary['netProfit'] ?? null,
        totalReturnPct: summary['totalReturnPct'] ?? null,
        cagrPct: summary['cagrPct'] ?? null,
        profitFactor: summary['profitFactor'] ?? null,
        maxDrawdownPct: summary['maxDrawdownPct'] ?? null,
        sharpe: summary['sharpe'] ?? null,
        winRatePct: summary['winRatePct'] ?? null,
        closedTrades: summary['closedTrades'] ?? null,
        buyAndHoldReturnPct: summary['buyAndHoldReturnPct'] ?? null,
      },
      notes: (summary['report'] as { notes?: unknown } | undefined)?.notes ?? [],
      diagnostics: summary['diagnostics'] ?? [],
      unfilledEntryOrders: summary['unfilledEntryOrders'] ?? 0,
      crossCheck: {
        ok: run.crossCheckOk,
        deltaPct: run.crossCheckDeltaPct,
        message: summary['crossCheckMessage'] ?? null,
      },
      timings: {
        barsProcessed: run.barsProcessed,
        engineMs: run.engineMs,
        totalMs: run.totalMs,
        createdAt: run.createdAt,
        completedAt: run.completedAt,
      },
    };
  }

  async trades(runId: string): Promise<{ runId: string; count: number; trades: CostedTrade[] }> {
    const run = await this.requireRun(runId);
    const trades = await readRunTrades(this.db.db, run.id);
    return { runId: run.id, count: trades.length, trades };
  }

  /**
   * Equity, drawdown and buy & hold for the chart.
   *
   * Drawdown is not stored: it is recomputed from equity on decode, because storing a series
   * derivable in one pass would have tripled every blob.
   */
  async series(runId: string, query: SeriesQuery): Promise<unknown> {
    const run = await this.requireRun(runId);
    if (run.state !== 'completed') {
      throw ApiException.conflict(`Run ${run.id} is ${run.state}, so it has no series yet.`, {
        state: run.state,
      });
    }

    const [close, intrabar, daily, monthly] = (await Promise.all([
      readRunSeries(this.db.db, run.id, 'close'),
      readRunSeries(this.db.db, run.id, 'intrabar'),
      readRunSeries(this.db.db, run.id, 'daily'),
      readRunSeries(this.db.db, run.id, 'monthly'),
    ])) as [
      EquityPoint[] | null,
      EquityPoint[] | null,
      EquitySample[] | null,
      EquitySample[] | null,
    ];

    if (close === null) {
      throw ApiException.notFound(`Run ${run.id} has no stored series.`);
    }

    const shape = (curve: readonly EquityPoint[]): unknown => {
      const view = query.full
        ? { points: curve, originalCount: curve.length, downsampled: false }
        : downsampleEquity(curve, query.points);
      return {
        count: view.points.length,
        originalCount: view.originalCount,
        downsampled: view.downsampled,
        points: view.points.map((p) => ({
          time: p.time,
          equity: p.equity,
          drawdown: p.drawdown,
          drawdownPct: p.drawdownPct,
        })),
      };
    };

    return {
      runId: run.id,
      initialCapital: run.initialCapital,
      accountCurrency: run.accountCurrency,
      equityClose: shape(close),
      equityIntrabar: intrabar === null ? null : shape(intrabar),
      daily: daily ?? [],
      monthly: monthly ?? [],
      buyAndHold: await this.buyAndHold(run, query),
    };
  }

  /**
   * Buy & hold, rebased to the run's starting capital.
   *
   * Rebuilt from bars rather than stored: it is a property of the instrument and window, not of
   * the run, so persisting it per run would duplicate the same curve for every strategy tested
   * on the same range.
   */
  private async buyAndHold(run: RunDetailRow, query: SeriesQuery): Promise<unknown> {
    const symbol = await findSymbolByCode(this.db, run.symbol);
    if (symbol === null) return null;

    const m1 = await readM1Bars(this.db, symbol.id, run.fromMs, run.toMs);
    if (m1.length === 0) return null;

    const { resample } = await import('@edgelab/data');
    const bars = resample(m1, run.timeframe as Parameters<typeof resample>[1]);
    if (bars.length === 0) return null;

    const curve = buyAndHoldCurve(bars, run.initialCapital, bars[0]!.open);
    const view = query.full
      ? { points: curve, originalCount: curve.length, downsampled: false }
      : downsampleEquity(curve, query.points);

    return {
      count: view.points.length,
      originalCount: view.originalCount,
      downsampled: view.downsampled,
      points: view.points.map((p) => ({ time: p.time, equity: p.equity })),
    };
  }

  /**
   * Cancel a run's job.
   *
   * Two paths, because BullMQ offers no single one: a job still WAITING is removed from the
   * queue outright, while a job already RUNNING can only be reached out of band — the worker
   * holds the AbortController, so the request is published on a Redis channel it subscribes to.
   */
  async cancel(runId: string): Promise<{ runId: string; jobId: string; action: string }> {
    const run = await this.requireRun(runId);

    if (run.state === 'completed' || run.state === 'failed' || run.state === 'cancelled') {
      throw ApiException.notCancellable(
        `Run ${run.id} already finished (${run.state}), so there is nothing to cancel.`,
      );
    }
    if (run.queueJobId === null) {
      throw ApiException.notCancellable(`Run ${run.id} has no job attached.`);
    }

    const job = await this.queue.getJob(run.queueJobId);
    if (job === undefined) {
      throw ApiException.notCancellable(
        `Job ${run.queueJobId} is no longer in the queue; it may have aged out.`,
      );
    }

    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
      await job.remove();
      const { setRunState } = await import('@edgelab/db');
      await setRunState(this.db.db, run.id, 'cancelled', 'Cancelled before it started.');
      return { runId: run.id, jobId: run.queueJobId, action: 'removed-from-queue' };
    }

    await this.redis.publish(jobCancelChannel(run.queueJobId), '1');
    return { runId: run.id, jobId: run.queueJobId, action: 'abort-signalled' };
  }

  private async requireRun(runId: string): Promise<RunDetailRow> {
    const run = await readRun(this.db.db, runId);
    if (run === null) throw ApiException.notFound(`No backtest run with id ${runId}.`);
    return run;
  }
}

@Controller('backtests')
export class BacktestsController {
  constructor(@Inject(BacktestsService) private readonly backtests: BacktestsService) {}

  @Post()
  create(@Body(new ZodPipe(CreateBacktestSchema)) body: CreateBacktest): Promise<BacktestCreated> {
    return this.backtests.create(body);
  }

  /**
   * Listed BEFORE . Nest matches routes in declaration order, so a  declared after
   *  still works, but any literal path would be swallowed by the parameter route —
   * worth keeping the safe order by habit.
   */
  @Get()
  list(@Query(new ZodPipe(ListRunsQuerySchema)) query: ListRunsQuery): Promise<unknown> {
    return this.backtests.list(query.limit);
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<unknown> {
    return this.backtests.get(id);
  }

  @Get(':id/trades')
  trades(@Param('id') id: string): Promise<unknown> {
    return this.backtests.trades(id);
  }

  @Get(':id/series')
  series(
    @Param('id') id: string,
    @Query(new ZodPipe(SeriesQuerySchema)) query: SeriesQuery,
  ): Promise<unknown> {
    return this.backtests.series(id, query);
  }

  @Delete(':id/job')
  cancel(@Param('id') id: string): Promise<unknown> {
    return this.backtests.cancel(id);
  }
}

@Module({
  // BacktestsService compiles the source before enqueuing, so it needs PineService.
  imports: [PineModule],
  controllers: [BacktestsController],
  providers: [BacktestsService],
  exports: [BacktestsService],
})
export class BacktestsModule {}
