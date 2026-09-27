import type {
  ApiError,
  BacktestCreated,
  Candle,
  CostConfig,
  CostedTrade,
  JobEvent,
  StrategySummary,
  Timeframe,
} from '@edgelab/shared';
import type { MetricsReport } from '@edgelab/metrics';

/**
 * The API client.
 *
 * Every call funnels through `request()` so the `{ code, message, details }` envelope is unpacked
 * in exactly one place. That matters more than it looks: the whole point of the envelope is that
 * `message` names the real reason ("No EURUSD data after 2024-01-31"), and a client that fell back
 * to "Request failed" anywhere would throw that away precisely when it is most needed.
 *
 * Requests go to a relative `/api`, which the Vite dev server proxies and nginx serves in
 * production — the browser only ever talks to one origin.
 */

const BASE = '/api';

/** An API failure with the server's own envelope attached. */
export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly payload: ApiError,
  ) {
    super(payload.message);
    this.name = 'ApiClientError';
  }

  get code(): ApiError['code'] {
    return this.payload.code;
  }

  /** Zod issues, when the failure was validation. */
  get issues(): { path: string; message: string }[] {
    const details = this.payload.details as { issues?: { path: string; message: string }[] } | null;
    return details?.issues ?? [];
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers:
        init?.body === undefined
          ? init?.headers
          : { 'content-type': 'application/json', ...init?.headers },
    });
  } catch (cause: unknown) {
    // A network failure is almost always "the API is not running", which is worth saying
    // outright rather than surfacing a bare TypeError from fetch.
    throw new ApiClientError(0, {
      code: 'internal',
      message: 'Could not reach the API. Is it running? (`pnpm dev`)',
      details: String(cause),
    });
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed: unknown = text === '' ? null : safeJson(text);

  if (!response.ok) {
    const envelope = parsed as Partial<ApiError> | null;
    throw new ApiClientError(response.status, {
      code: envelope?.code ?? 'internal',
      message: envelope?.message ?? `${String(response.status)} ${response.statusText}`,
      ...(envelope?.details === undefined ? {} : { details: envelope.details }),
    });
  }

  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/* ------------------------------------------------------------------- compile */

export interface InputSpecDto {
  readonly key: string;
  readonly title: string;
  readonly type: string;
  readonly default: unknown;
  readonly min?: number | null;
  readonly max?: number | null;
  readonly step?: number | null;
  readonly options?: readonly (string | number)[] | null;
  readonly group?: string | null;
  readonly tooltip?: string | null;
  readonly inline?: string | null;
}

export interface DiagnosticDto {
  readonly line: number | null;
  readonly col: number | null;
  readonly message: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly code?: string;
}

export interface DeclaredPropDto {
  readonly name: string;
  readonly value: unknown;
  readonly mutable: boolean;
}

export interface CompileResponse {
  readonly ok: boolean;
  readonly diagnostics: readonly DiagnosticDto[];
  readonly meta: {
    readonly kind: 'strategy' | 'indicator' | null;
    readonly version: number | null;
    readonly title: string | null;
    readonly inputs: readonly InputSpecDto[];
    readonly declaredProps: readonly DeclaredPropDto[];
  };
  readonly errorCount: number;
  readonly warningCount: number;
}

export function compilePine(source: string, signal?: AbortSignal): Promise<CompileResponse> {
  return request('/pine/compile', {
    method: 'POST',
    body: JSON.stringify({ source }),
    ...(signal === undefined ? {} : { signal }),
  });
}

export interface FixtureDto {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
}

export function fetchFixtures(): Promise<FixtureDto[]> {
  // GET: it is a read of static data. Both sides used POST, which worked but meant the browser
  // could not cache it and read like a mutation.
  return request('/pine/fixtures');
}

/* ---------------------------------------------------------------- strategies */

export function listStrategies(): Promise<StrategySummary[]> {
  return request('/strategies');
}

export function createStrategy(body: {
  name: string;
  source: string;
  notes?: string | null;
  tags?: string[];
}): Promise<{ strategyId: string; versionId: string; version: number }> {
  return request('/strategies', { method: 'POST', body: JSON.stringify(body) });
}

export function addStrategyVersion(
  strategyId: string,
  source: string,
): Promise<{ versionId: string; version: number; created: boolean }> {
  return request(`/strategies/${strategyId}/versions`, {
    method: 'POST',
    body: JSON.stringify({ source }),
  });
}

/** A strategy with every version listed, newest first. */
export interface StrategyDetail extends StrategySummary {
  readonly versions: readonly {
    readonly id: string;
    readonly version: number;
    readonly sourceHash: string;
    readonly pineVersion: string;
    readonly title: string | null;
    readonly createdAt: number;
  }[];
}

export function fetchStrategy(strategyId: string): Promise<StrategyDetail> {
  return request(`/strategies/${strategyId}`);
}

export function fetchStrategyVersion(
  strategyId: string,
  versionId: string,
): Promise<{ id: string; strategyId: string; version: number; source: string }> {
  return request(`/strategies/${strategyId}/versions/${versionId}`);
}

export function updateStrategy(
  strategyId: string,
  patch: { name?: string; notes?: string | null; tags?: string[] },
): Promise<StrategySummary> {
  return request(`/strategies/${strategyId}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

/* ------------------------------------------------------------------- symbols */

export interface SymbolCoverage {
  readonly barCount: number;
  readonly firstBar: number | null;
  readonly lastBar: number | null;
  readonly sources: readonly string[];
}

export interface SymbolDto {
  readonly id: string;
  readonly symbol: string;
  readonly assetClass: string;
  readonly baseCcy: string;
  readonly quoteCcy: string;
  readonly digits: number;
  readonly mintick: number;
  readonly pipSize: number;
  readonly contractSize: number;
  readonly pointValue: number;
  readonly defaultSpreadPoints: number;
  readonly sessionType: string;
  readonly dataVersion: number;
  readonly coverage: SymbolCoverage;
}

export function listSymbols(): Promise<SymbolDto[]> {
  return request('/symbols');
}

/* ------------------------------------------------------------------- candles */

export interface CandlesResponse {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly count: number;
  readonly candles: readonly Candle[];
  readonly dataVersion: number;
}

export function fetchCandles(
  symbol: string,
  tf: Timeframe,
  fromMs: number,
  toMs: number,
): Promise<CandlesResponse> {
  const query = new URLSearchParams({
    symbol,
    tf,
    from: String(fromMs),
    to: String(toMs),
  });
  return request(`/candles?${query.toString()}`);
}

/* ----------------------------------------------------------------- backtests */

export interface CreateBacktestBody {
  readonly source?: string;
  readonly strategyVersionId?: string;
  readonly name?: string;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly from: number;
  readonly to: number;
  readonly initialCapital: number;
  readonly accountCurrency: string;
  readonly costs: CostConfig;
  readonly inputs: Record<string, unknown>;
  readonly props: Record<string, unknown>;
  readonly warmupBars: number;
  readonly rfAnnual: number;
  readonly lots: number;
  readonly leverage: number;
}

export function createBacktest(body: CreateBacktestBody): Promise<BacktestCreated> {
  return request('/backtests', { method: 'POST', body: JSON.stringify(body) });
}

export interface RunKpis {
  readonly netProfit: number | null;
  readonly totalReturnPct: number | null;
  readonly cagrPct: number | null;
  readonly profitFactor: number | null;
  readonly maxDrawdownPct: number | null;
  readonly sharpe: number | null;
  readonly winRatePct: number | null;
  readonly closedTrades: number | null;
  readonly buyAndHoldReturnPct: number | null;
}

export interface RunDetail {
  readonly id: string;
  readonly state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly error: string | null;
  readonly strategy: {
    readonly id: string;
    readonly name: string;
    readonly versionId: string;
    readonly version: number;
    readonly sourceHash: string;
    readonly source: string;
  };
  readonly config: {
    readonly symbol: string;
    readonly timeframe: Timeframe;
    readonly from: number;
    readonly to: number;
    readonly initialCapital: number;
    readonly accountCurrency: string;
    readonly costs: CostConfig;
    readonly inputs: Record<string, unknown>;
    readonly props: Record<string, unknown>;
    readonly warmupBars: number;
  };
  readonly provenance: {
    readonly engineId: string;
    readonly engineVersion: string;
    readonly dataVersion: number;
    readonly jobId: string | null;
  };
  readonly metrics: MetricsReport | null;
  readonly kpis: RunKpis;
  readonly notes: readonly string[];
  readonly diagnostics: readonly DiagnosticDto[];
  readonly unfilledEntryOrders: number;
  readonly crossCheck: {
    readonly ok: boolean | null;
    readonly deltaPct: number | null;
    readonly message: string | null;
  };
  readonly timings: {
    readonly barsProcessed: number | null;
    readonly engineMs: number | null;
    readonly totalMs: number | null;
    readonly createdAt: number;
    readonly completedAt: number | null;
  };
}

export function fetchRun(runId: string): Promise<RunDetail> {
  return request(`/backtests/${runId}`);
}

export function fetchRunTrades(
  runId: string,
): Promise<{ runId: string; count: number; trades: CostedTrade[] }> {
  return request(`/backtests/${runId}/trades`);
}

export interface SeriesView {
  readonly count: number;
  readonly originalCount: number;
  readonly downsampled: boolean;
  readonly points: readonly {
    time: number;
    equity: number;
    drawdown: number;
    drawdownPct: number;
  }[];
}

export interface RunSeries {
  readonly runId: string;
  readonly initialCapital: number;
  readonly accountCurrency: string;
  readonly equityClose: SeriesView;
  readonly equityIntrabar: SeriesView | null;
  readonly daily: readonly { time: number; equity: number }[];
  readonly monthly: readonly { time: number; equity: number }[];
  readonly buyAndHold: {
    readonly count: number;
    readonly points: readonly { time: number; equity: number }[];
  } | null;
}

export function fetchRunSeries(runId: string, points = 2_000): Promise<RunSeries> {
  return request(`/backtests/${runId}/series?points=${String(points)}`);
}

export function cancelRun(
  runId: string,
): Promise<{ runId: string; jobId: string; action: string }> {
  return request(`/backtests/${runId}/job`, { method: 'DELETE' });
}

/* ---------------------------------------------------------------------- jobs */

/**
 * Subscribe to a job's progress.
 *
 * `EventSource` rather than a fetch stream: it reconnects on its own, which matters because the
 * API's SSE stream is long-lived and a dev-server restart mid-run should not silently stop
 * reporting. The caller gets a disposer.
 *
 * `onEnd` fires on the server's explicit `end` frame, so the caller closes deterministically
 * rather than guessing from the last state.
 */
export function subscribeToJob(
  jobId: string,
  handlers: {
    onProgress: (event: JobEvent) => void;
    onEnd: () => void;
    onError?: (message: string) => void;
  },
): () => void {
  const source = new EventSource(`${BASE}/jobs/${jobId}/events`);

  source.addEventListener('progress', (raw) => {
    try {
      handlers.onProgress(JSON.parse((raw as MessageEvent<string>).data) as JobEvent);
    } catch {
      // A malformed frame is not worth killing the stream over; the next one usually lands.
    }
  });

  source.addEventListener('end', () => {
    source.close();
    handlers.onEnd();
  });

  source.addEventListener('error', () => {
    // EventSource reports both a transient reconnect and a hard failure here, so the only
    // reliable signal is the readyState.
    if (source.readyState === EventSource.CLOSED) {
      handlers.onError?.('Progress stream closed unexpectedly.');
      handlers.onEnd();
    }
  });

  return () => {
    source.close();
  };
}

/* --------------------------------------------------------------- runs list */

export interface RunListItem {
  readonly id: string;
  readonly strategyName: string;
  readonly version: number;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly from: number;
  readonly to: number;
  readonly state: string;
  readonly crossCheckOk: boolean | null;
  readonly tradeCount: number;
  readonly createdAt: number;
  readonly completedAt: number | null;
  readonly kpis: {
    readonly netProfit: number | null;
    readonly totalReturnPct: number | null;
    readonly profitFactor: number | null;
    readonly maxDrawdownPct: number | null;
    readonly sharpe: number | null;
    readonly winRatePct: number | null;
    readonly closedTrades: number | null;
  };
}

export function listRuns(limit = 50): Promise<RunListItem[]> {
  return request(`/backtests?limit=${String(limit)}`);
}
