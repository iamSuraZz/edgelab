import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findSymbolByCode, readM1 } from '@edgelab/db';
import { PineTsEngine, STRATEGY_FIXTURES, orchestrateRun } from '@edgelab/engine';
import {
  DEFAULT_COSTS,
  timeframeMs,
  type ApiError,
  type BacktestCreated,
  type JobEvent,
  accountMoney,
} from '@edgelab/shared';

import { apiDelete, apiGet, apiPost, followJobEvents, startHarness, type Harness } from './helpers';

/**
 * The slice-B acceptance test: the whole chain over HTTP.
 *
 *   compile a fixture -> save a version -> POST /backtests -> follow SSE to completion
 *   -> fetch report, trades and series
 *
 * And the assertion that makes it worth having: the KPIs the API reports must equal what the
 * slice-A pipeline produces for the same config, computed independently in this process. Without
 * that, a run could travel the whole queue-and-thread path and come back with quietly different
 * numbers — the exact failure that a "did it return 200" test cannot see.
 *
 * Needs `docker compose up -d` and stored EURUSD M1 bars for January 2024.
 */

const FIXTURE = STRATEGY_FIXTURES[0]!; // ema-cross
const SYMBOL = 'EURUSD';
const TIMEFRAME = 'H1' as const;
const FROM = Date.UTC(2024, 0, 1);
const TO = Date.UTC(2024, 1, 1);

/** Matches the CLI's own defaults, so "equals the CLI output" is a like-for-like comparison. */
const RUN_CONFIG = {
  symbol: SYMBOL,
  timeframe: TIMEFRAME,
  from: FROM,
  to: TO,
  initialCapital: 10_000,
  accountCurrency: 'USD',
  warmupBars: 500,
  lots: 1,
  leverage: 100,
  rfAnnual: 0,
} as const;

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

describe('preconditions', () => {
  it('has EURUSD bars stored for the test window', async () => {
    const { status, body } = await apiGet<{ symbol: string; coverage: { barCount: number } }[]>(
      harness,
      '/symbols',
    );
    expect(status).toBe(200);

    const eurusd = body.find((s) => s.symbol === SYMBOL);
    expect(eurusd, 'EURUSD must be seeded').toBeDefined();
    expect(
      eurusd!.coverage.barCount,
      'run `pnpm ingest EURUSD dukascopy 2024-01-01 2024-02-01` first',
    ).toBeGreaterThan(10_000);
  });
});

describe('POST /pine/compile', () => {
  it('compiles a fixture and exposes its inputs keyed by varId', async () => {
    const { status, body } = await apiPost<{
      ok: boolean;
      errorCount: number;
      meta: {
        kind: string;
        version: number;
        title: string;
        inputs: { key: string; title: string }[];
      };
    }>(harness, '/pine/compile', { source: FIXTURE.source });

    expect(status).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.errorCount).toBe(0);
    expect(body.meta.kind).toBe('strategy');
    expect(body.meta.version).toBe(5);
    expect(body.meta.inputs.length).toBeGreaterThan(0);

    // Keys must be unique, which is the whole reason they are varIds and not titles.
    const keys = body.meta.inputs.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('reports diagnostics for a broken script WITHOUT failing the request', async () => {
    // The editor calls this on every debounced keystroke; 4xx-ing mid-word would make normal
    // typing look like failure.
    const { status, body } = await apiPost<{ ok: boolean; errorCount: number }>(
      harness,
      '/pine/compile',
      { source: '//@version=5\nstrategy("broken"\nthis is not pine @@@\n' },
    );

    expect(status).toBe(201);
    expect(body.ok).toBe(false);
    expect(body.errorCount).toBeGreaterThan(0);
  });

  it('rejects an empty body through the shared schema', async () => {
    const { status, body } = await apiPost<ApiError>(harness, '/pine/compile', { source: '' });
    expect(status).toBe(400);
    expect(body.code).toBe('validation-failed');
    expect(body.message).toContain('source');
  });
});

describe('strategies', () => {
  let strategyId: string;
  let versionId: string;

  it('saves a strategy and its first version', async () => {
    const { status, body } = await apiPost<{
      strategyId: string;
      versionId: string;
      version: number;
    }>(harness, '/strategies', {
      // Unique per run so repeated test runs do not collide on the name.
      name: `E2E EMA Cross ${String(Date.now())}`,
      source: FIXTURE.source,
      tags: ['e2e'],
    });

    expect(status).toBe(201);
    expect(body.version).toBe(1);
    strategyId = body.strategyId;
    versionId = body.versionId;
  });

  it('does NOT create a second version for identical source', async () => {
    // The hash-keyed idempotency from spec 04: pressing Save twice must not pile up versions.
    const { body } = await apiPost<{ versionId: string; version: number; created: boolean }>(
      harness,
      `/strategies/${strategyId}/versions`,
      { source: FIXTURE.source },
    );

    expect(body.created).toBe(false);
    expect(body.versionId).toBe(versionId);
    expect(body.version).toBe(1);
  });

  it('DOES create a version when the source changes', async () => {
    const { body } = await apiPost<{ version: number; created: boolean }>(
      harness,
      `/strategies/${strategyId}/versions`,
      { source: `${FIXTURE.source}\n// a change\n` },
    );

    expect(body.created).toBe(true);
    expect(body.version).toBe(2);
  });

  it('lists the strategy with its latest version', async () => {
    const { body } = await apiGet<{ id: string; versionCount: number }[]>(harness, '/strategies');
    const found = body.find((s) => s.id === strategyId);
    expect(found?.versionCount).toBe(2);
  });

  it('404s on an unknown id with a real message', async () => {
    const { status, body } = await apiGet<ApiError>(
      harness,
      '/strategies/00000000-0000-0000-0000-000000000000',
    );
    expect(status).toBe(404);
    expect(body.code).toBe('not-found');
    expect(body.message).toContain('No strategy');
  });
});

describe('the full backtest chain over HTTP', () => {
  let runId: string;
  let jobId: string;
  let events: JobEvent[];

  it('accepts the run and returns ids to poll', async () => {
    const { status, body } = await apiPost<{
      runId: string;
      jobId: string;
      eventsUrl: string;
      version: number;
    }>(harness, '/backtests', { source: FIXTURE.source, name: 'E2E chain', ...RUN_CONFIG });

    expect(status).toBe(201);
    expect(body.runId).toBeTruthy();
    expect(body.jobId).toBeTruthy();
    expect(body.eventsUrl).toBe(`/api/jobs/${body.jobId}/events`);

    runId = body.runId;
    jobId = body.jobId;
  });

  it('is readable as queued or running before it finishes', async () => {
    const { status, body } = await apiGet<{ id: string; state: string }>(
      harness,
      `/backtests/${runId}`,
    );
    expect(status).toBe(200);
    // The run row exists from the moment POST returns, which is the point of creating it before
    // enqueueing — a client never holds an id with nothing behind it.
    expect(['queued', 'running', 'completed']).toContain(body.state);
  });

  it('streams progress over SSE and ends on completion', async () => {
    const outcome = await followJobEvents(harness, jobId);
    events = outcome.events;

    expect(outcome.final.state, `job failed: ${outcome.final.error ?? ''}`).toBe('completed');
    expect(outcome.final.percent).toBe(100);
    expect(outcome.final.runId).toBe(runId);

    // Progress must be monotonic — a bar that jumps backwards is worse than none.
    const percents = events.map((e) => e.percent);
    expect([...percents].sort((a, b) => a - b)).toEqual(percents);

    // And it must actually report intermediate progress, not just a start and an end. This is
    // what proves the MessagePort bridge out of the piscina thread works.
    expect(events.length).toBeGreaterThan(2);
    expect(events.some((e) => e.percent > 5 && e.percent < 100)).toBe(true);
  });

  it('serves the report with metrics and a passing cross-check', async () => {
    const { status, body } = await apiGet<{
      state: string;
      kpis: Record<string, number | null>;
      crossCheck: { ok: boolean; deltaPct: number | null };
      metrics: { performance: { netProfit: number }; notes: string[] } | null;
      timings: { barsProcessed: number; engineMs: number };
      provenance: { engineId: string; engineVersion: string; dataVersion: number };
    }>(harness, `/backtests/${runId}`);

    expect(status).toBe(200);
    expect(body.state).toBe('completed');
    expect(body.crossCheck.ok, 'zero-cost cross-check must pass').toBe(true);
    expect(body.metrics).not.toBeNull();
    expect(body.kpis['closedTrades']).toBeGreaterThan(0);
    expect(body.timings.barsProcessed).toBeGreaterThan(0);
    expect(body.provenance.engineId).toBe('pinets');
    expect(body.provenance.engineVersion).toBeTruthy();
  });

  it('serves the trades, numbered from 1 with unique ids', async () => {
    const { status, body } = await apiGet<{
      count: number;
      trades: { seq: number; side: string; netPnl: number; spreadCost: number }[];
    }>(harness, `/backtests/${runId}/trades`);

    expect(status).toBe(200);
    expect(body.count).toBeGreaterThan(0);
    expect(body.trades.map((t) => t.seq)).toEqual(body.trades.map((_, i) => i + 1));
    // Costs were actually charged — DEFAULT_COSTS reads the spread from the bars.
    expect(body.trades.every((t) => t.spreadCost > 0)).toBe(true);
  });

  it('serves equity, drawdown and buy & hold, downsampled by default', async () => {
    const { status, body } = await apiGet<{
      equityClose: {
        count: number;
        originalCount: number;
        downsampled: boolean;
        points: { time: number; equity: number; drawdown: number }[];
      };
      equityIntrabar: { count: number } | null;
      daily: { time: number; equity: number }[];
      buyAndHold: { count: number } | null;
    }>(harness, `/backtests/${runId}/series?points=100`);

    expect(status).toBe(200);
    expect(body.equityClose.points.length).toBeGreaterThan(0);
    expect(body.equityIntrabar).not.toBeNull();
    expect(body.daily.length).toBeGreaterThan(0);
    expect(body.buyAndHold).not.toBeNull();

    // Times ascending: a client draws these straight onto a chart.
    const times = body.equityClose.points.map((p) => p.time);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // Drawdown is recomputed on decode rather than stored, so it must survive the round trip.
    expect(body.equityClose.points.every((p) => p.drawdown >= 0)).toBe(true);
  });

  it('serves every point with ?full=1', async () => {
    const [downsampled, full] = await Promise.all([
      apiGet<{ equityClose: { count: number; originalCount: number; downsampled: boolean } }>(
        harness,
        `/backtests/${runId}/series?points=100`,
      ),
      apiGet<{ equityClose: { count: number; originalCount: number; downsampled: boolean } }>(
        harness,
        `/backtests/${runId}/series?full=1`,
      ),
    ]);

    expect(full.body.equityClose.downsampled).toBe(false);
    expect(full.body.equityClose.count).toBe(full.body.equityClose.originalCount);
    expect(downsampled.body.equityClose.count).toBeLessThan(full.body.equityClose.count);
  });

  /**
   * The assertion the whole slice turns on.
   *
   * Recomputes the same config with the slice-A pipeline, in this process, and requires the
   * numbers to match what came back over HTTP. Anything that silently altered the run on the
   * way through — a mis-serialised cost config, a warmup window shifted by the queue payload, a
   * sizing override applied twice — shows up here and nowhere else.
   */
  it('reports KPIs identical to the slice-A pipeline for the same config', async () => {
    const symbol = await findSymbolByCode(harness.workers.db, SYMBOL);
    expect(symbol).not.toBeNull();

    const durationMs = timeframeMs(TIMEFRAME)!;
    const barsFrom = FROM - Math.ceil(RUN_CONFIG.warmupBars * durationMs * 2.5);
    const m1 = await readM1(harness.workers.db, symbol!.id, barsFrom, TO);

    const engine = new PineTsEngine({
      m1: {
        readM1: (_code, fromMs, toMs) =>
          Promise.resolve(m1.filter((b) => b.time >= fromMs && b.time < toMs)),
      },
      lookupSymbol: (code) => (code === symbol!.symbol ? symbol! : undefined),
    });

    const expected = await orchestrateRun({
      engine,
      source: FIXTURE.source,
      symbol: symbol!,
      timeframe: TIMEFRAME,
      fromMs: FROM,
      toMs: TO,
      initialCapital: accountMoney(RUN_CONFIG.initialCapital),
      accountCurrency: RUN_CONFIG.accountCurrency,
      costs: DEFAULT_COSTS,
      warmupBars: RUN_CONFIG.warmupBars,
      rfAnnual: RUN_CONFIG.rfAnnual,
      // Exactly what the API derives from lots/leverage.
      overrides: {
        default_qty_type: 'fixed',
        default_qty_value: RUN_CONFIG.lots * symbol!.contractSize,
        margin_long: 100 / RUN_CONFIG.leverage,
        margin_short: 100 / RUN_CONFIG.leverage,
      },
    });

    const { body } = await apiGet<{
      kpis: Record<string, number | null>;
      crossCheck: { ok: boolean };
    }>(harness, `/backtests/${runId}`);

    // Money to the cent, ratios to 6 places: these come from the same arithmetic on both sides,
    // so anything beyond float noise is a real divergence.
    expect(body.kpis['closedTrades']).toBe(expected.metrics.trades.all.trades);
    expect(body.kpis['netProfit']).toBeCloseTo(expected.metrics.performance.netProfit, 2);
    expect(body.kpis['totalReturnPct']).toBeCloseTo(
      expected.metrics.performance.totalReturnPct!,
      6,
    );
    expect(body.kpis['profitFactor']).toBeCloseTo(expected.metrics.performance.profitFactor!, 6);
    expect(body.kpis['maxDrawdownPct']).toBeCloseTo(
      expected.metrics.risk.intrabar.maxDrawdownPct!,
      6,
    );
    expect(body.kpis['sharpe']).toBeCloseTo(expected.metrics.risk.sharpe!, 6);
    expect(body.kpis['winRatePct']).toBeCloseTo(expected.metrics.trades.all.winRatePct!, 6);
    expect(body.kpis['buyAndHoldReturnPct']).toBeCloseTo(expected.buyAndHoldReturnPct!, 6);
    expect(body.crossCheck.ok).toBe(expected.crossCheck.ok);

    // And the trades match one for one, not just in aggregate: equal totals can hide two
    // offsetting errors.
    const { body: served } = await apiGet<{
      trades: { seq: number; entryBar: number; entryPrice: number; netPnl: number }[];
    }>(harness, `/backtests/${runId}/trades`);

    expect(served.trades.length).toBe(expected.trades.length);
    for (const [i, trade] of served.trades.entries()) {
      const want = expected.trades[i]!;
      expect(trade.entryBar, `trade ${String(i + 1)} entry bar`).toBe(want.entryBar);
      expect(trade.entryPrice, `trade ${String(i + 1)} entry price`).toBeCloseTo(
        want.entryPrice,
        9,
      );
      expect(trade.netPnl, `trade ${String(i + 1)} net P&L`).toBeCloseTo(want.netPnl, 6);
    }
  });

  it('refuses to cancel a run that already finished', async () => {
    const { status, body } = await apiDelete<ApiError>(harness, `/backtests/${runId}/job`);
    expect(status).toBe(409);
    expect(body.code).toBe('job-not-cancellable');
    expect(body.message).toContain('already finished');
  });
});

describe('errors name the real reason', () => {
  it('says which data is missing, not just "bad request"', async () => {
    // 2030 is well past anything stored, so this exercises the message spec'd in the prompt.
    const { status, body } = await apiPost<ApiError>(harness, '/backtests', {
      source: FIXTURE.source,
      ...RUN_CONFIG,
      from: Date.UTC(2030, 0, 1),
      to: Date.UTC(2030, 1, 1),
    });

    // Accepted at submit time (the range is well formed), then failed by the job with a message
    // that names the coverage that does exist.
    expect(status).toBe(201);
    const created = body as unknown as { jobId: string; runId: string };
    const outcome = await followJobEvents(harness, created.jobId);

    expect(outcome.final.state).toBe('failed');
    expect(outcome.final.errorCode).toBe('no-data');
    expect(outcome.final.error).toMatch(/No EURUSD data/);
    expect(outcome.final.error).toMatch(/2030-01-01/);

    const { body: run } = await apiGet<{ state: string; error: string }>(
      harness,
      `/backtests/${created.runId}`,
    );
    expect(run.state).toBe('failed');
    expect(run.error).toMatch(/No EURUSD data/);
  });

  /**
   * D6's blanket refusal of cross-currency runs is gone — the conversion layer is wired in, so
   * the run is ACCEPTED and the job reports what it actually needs.
   *
   * EURUSD on a EUR account converts through EURUSD itself (EUR per USD is its reciprocal), and
   * those bars are stored, so this one now succeeds outright. The test therefore checks the thing
   * that changed: submit no longer rejects on currency alone.
   */
  it('accepts a cross-currency run now the conversion layer exists', async () => {
    const { status, body } = await apiPost<BacktestCreated>(harness, '/backtests', {
      source: FIXTURE.source,
      ...RUN_CONFIG,
      accountCurrency: 'EUR',
    });

    expect(status).toBe(201);
    expect(body.runId).toBeTruthy();

    const outcome = await followJobEvents(harness, body.jobId);
    expect(outcome.final.state, `job failed: ${outcome.final.error ?? ''}`).toBe('completed');

    // And the report says it is in EUR, not silently in USD.
    const { body: report } = await apiGet<{ config: { accountCurrency: string } }>(
      harness,
      `/backtests/${body.runId}`,
    );
    expect(report.config.accountCurrency).toBe('EUR');
  });

  it('rejects an inverted date range with the failing field', async () => {
    const { status, body } = await apiPost<ApiError>(harness, '/backtests', {
      source: FIXTURE.source,
      ...RUN_CONFIG,
      from: TO,
      to: FROM,
    });

    expect(status).toBe(400);
    expect(body.code).toBe('validation-failed');
    expect(body.message).toContain('from');
  });

  it('names the stored coverage when candles are asked for outside it', async () => {
    const { status, body } = await apiGet<ApiError>(
      harness,
      `/candles?symbol=${SYMBOL}&tf=H1&from=${String(Date.UTC(2030, 0, 1))}&to=${String(Date.UTC(2030, 1, 1))}`,
    );

    expect(status).toBe(404);
    expect(body.code).toBe('no-data');
    expect(body.message).toMatch(/No EURUSD data after/);
  });

  it('refuses an ingest for a provider the symbol has no id for', async () => {
    const { status, body } = await apiPost<ApiError>(harness, '/data/ingest', {
      symbol: SYMBOL,
      provider: 'binance',
      from: FROM,
      to: TO,
    });

    expect(status).toBe(400);
    expect(body.code).toBe('validation-failed');
    expect(body.message).toContain('no instrument id');
  });
});

describe('GET /candles', () => {
  it('serves resampled candles for a stored range', async () => {
    const { status, body } = await apiGet<{
      symbol: string;
      timeframe: string;
      count: number;
      candles: { time: number; open: number; closeTime: number }[];
    }>(harness, `/candles?symbol=${SYMBOL}&tf=H4&from=${String(FROM)}&to=${String(TO)}`);

    expect(status).toBe(200);
    expect(body.timeframe).toBe('H4');
    expect(body.count).toBeGreaterThan(0);

    // Buckets must be ordered and disjoint — the resampler's own invariant, checked here
    // because this is the path the chart actually uses.
    for (let i = 1; i < body.candles.length; i += 1) {
      expect(body.candles[i]!.time).toBeGreaterThanOrEqual(body.candles[i - 1]!.closeTime);
    }
  });

  it('rejects an unknown timeframe through the shared enum', async () => {
    const { status, body } = await apiGet<ApiError>(
      harness,
      `/candles?symbol=${SYMBOL}&tf=M7&from=${String(FROM)}&to=${String(TO)}`,
    );
    expect(status).toBe(400);
    expect(body.code).toBe('validation-failed');
  });
});
