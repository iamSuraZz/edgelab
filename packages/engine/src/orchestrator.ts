import { buildMetricsReport, type MetricsReport } from '@edgelab/metrics';
import type {
  Bar,
  CostConfig,
  CostedTrade,
  EquityPoint,
  EquitySample,
  SymbolSpec,
} from '@edgelab/shared';
import { ZERO_COSTS } from '@edgelab/shared';

import { applyCosts, resolveQuoteToAccount, type QuoteToAccount } from './costs';
import {
  MissingConversionDataError,
  conversionWindow,
  initialCapitalInQuote,
  planConversion,
  resolveConversion,
} from './conversion';
import {
  buyAndHoldReturnPct,
  crossCheckZeroCost,
  reconstructEquity,
  type CrossCheck,
} from './equity';
import type { PineEngine, RunParams, RunResult } from './pine-engine';

/**
 * The full run pipeline, as one pure-ish function over an engine.
 *
 *   execute Pine -> apply costs -> reconstruct equity -> compute metrics -> cross-check
 *
 * The only impurity is the engine itself, which reads bars. Everything after it is pure, which
 * is why the cross-check below can be trusted: it re-derives the engine's own bottom line from
 * a completely separate code path and compares.
 */

export interface OrchestrateParams {
  readonly engine: PineEngine;
  readonly source: string;
  readonly symbol: SymbolSpec;
  readonly timeframe: RunParams['timeframe'];
  readonly fromMs: number;
  readonly toMs: number;
  readonly initialCapital: number;
  readonly accountCurrency: string;
  readonly costs: CostConfig;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly overrides?: Readonly<Record<string, unknown>>;
  readonly warmupBars?: number;
  readonly rfAnnual?: number;
  /** Hide data at or after this instant on every timeframe (prefix-invariance testing). */
  readonly dataCutoffTs?: number;
  /** Record every `request.security` call, for the causality check (A1a). */
  readonly recordSecurityCalls?: boolean;
  /** Progress callback, so a worker can stream SSE updates. */
  readonly onProgress?: (percent: number, message: string) => void;
  /**
   * Bars for the currency-conversion pair, when the instrument's quote currency differs from
   * the account currency (spec 03).
   *
   * Supplied by the caller rather than read here because the orchestrator owns no I/O. Omit it
   * and a cross-currency run is refused, which is the old D6 behaviour and the right default
   * for anything that cannot fetch the pair.
   */
  readonly conversion?: ConversionSource;
}

/** What the orchestrator needs in order to convert quote-currency P&L into the account's. */
export interface ConversionSource {
  /** Whether a symbol exists in the registry, so no non-existent pair is invented. */
  readonly known: (symbol: string) => boolean;
  /** Stored bars for the pair over the padded window. */
  readonly loadBars: (
    symbol: string,
    fromMs: number,
    toMs: number,
  ) => Promise<readonly Bar[]> | readonly Bar[];
}

export interface OrchestratedRun {
  readonly engineResult: RunResult;
  readonly trades: readonly CostedTrade[];
  readonly equityClose: readonly EquityPoint[];
  readonly equityIntrabar: readonly EquityPoint[];
  readonly daily: readonly EquitySample[];
  readonly monthly: readonly EquitySample[];
  readonly metrics: MetricsReport;
  readonly buyAndHoldReturnPct: number | null;
  /**
   * The zero-cost cross-check. Always computed against a zero-cost re-derivation of the SAME
   * engine result, so it costs no extra engine run.
   */
  readonly crossCheck: CrossCheck;
  readonly engineMs: number;
  readonly totalMs: number;
}

export async function orchestrateRun(params: OrchestrateParams): Promise<OrchestratedRun> {
  const startedAt = Date.now();
  const report = params.onProgress ?? ((): void => undefined);

  /*
   * Currency. The engine runs in the instrument's QUOTE currency; reporting converts bar by bar
   * into the account currency through the conversion pair (spec 03).
   *
   * Resolved before any engine work so a run that cannot be reported in the requested currency
   * is refused up front rather than after a minute of computation. With no conversion source
   * this falls back to the D6 guard — same-currency only — because a caller that cannot load the
   * pair has no way to be right.
   */
  const quoteToAccount: QuoteToAccount = await resolveAccountRate(params);

  /*
   * Restate the starting capital in the QUOTE currency before the engine sees it.
   *
   * The engine sizes positions and checks margin in the instrument's quote currency, so handing
   * it an account-currency figure understates the account by the exchange rate. On USDJPY that is
   * a factor of ~148: a 10,000 USD account arrived as 10,000 JPY, about 67 dollars, and every
   * entry order was silently cancelled for insufficient margin — 21 orders placed, none filled,
   * a completely flat equity curve and no error.
   *
   * Identity conversion leaves this exactly as it was, so same-currency runs are untouched.
   */
  const engineCapital = initialCapitalInQuote(params.initialCapital, quoteToAccount(params.fromMs));

  report(5, 'running engine');
  const engineStartedAt = Date.now();
  const engineResult = await params.engine.run({
    source: params.source,
    symbol: params.symbol,
    timeframe: params.timeframe,
    fromMs: params.fromMs,
    toMs: params.toMs,
    ...(params.inputs === undefined ? {} : { inputs: params.inputs }),
    // Ours first so an explicit caller override still wins, matching how the API merges sizing
    // props. Nothing in the app sets `initial_capital`, so in practice this always applies.
    overrides: { initial_capital: engineCapital, ...params.overrides },
    ...(params.warmupBars === undefined ? {} : { warmupBars: params.warmupBars }),
    ...(params.dataCutoffTs === undefined ? {} : { dataCutoffTs: params.dataCutoffTs }),
    ...(params.recordSecurityCalls === true ? { recordSecurityCalls: true } : {}),
  });
  const engineMs = Date.now() - engineStartedAt;

  // Only the bars inside the requested window belong to the report. Warmup bars were loaded to
  // prime indicators, and counting them would stretch the window, dilute exposure, and add
  // flat days to the return series.
  const windowBars = engineResult.bars.filter(
    (b) => b.time >= params.fromMs && b.time < params.toMs,
  );

  report(45, 'applying costs');
  const costed = applyCosts({
    trades: engineResult.trades,
    bars: engineResult.bars,
    symbol: params.symbol,
    config: params.costs,
    quoteToAccount,
  });

  report(60, 'reconstructing equity');
  const openTrades = engineResult.trades.filter((t) => t.status === 'open');

  const equity = reconstructEquity({
    bars: windowBars,
    trades: rebaseToWindow(costed, engineResult.bars, windowBars),
    openTrades,
    initialCapital: params.initialCapital,
    symbol: params.symbol,
    quoteToAccount,
  });

  report(75, 'cross-checking');
  /*
   * The cross-check has to compare like with like, in two respects.
   *
   * COSTS: the engine's netprofit includes no spread or financing, so it is compared against a
   * zero-cost overlay of the same trades. Comparing against the costed figure would "fail" every
   * run that charged anything, which is noise.
   *
   * CURRENCY: identity conversion, NOT this run's rate. The engine's netprofit is denominated in
   * the instrument's quote currency, so converting our side into the account currency would
   * compare yen against dollars and fail every cross-currency run by the exchange rate — which
   * is exactly what USDJPY did. The question this check answers is whether our reconstruction of
   * the engine's own trades agrees with the engine, and that is a quote-currency question.
   */
  const zeroCosted = applyCosts({
    trades: engineResult.trades,
    bars: engineResult.bars,
    symbol: params.symbol,
    config: ZERO_COSTS,
    quoteToAccount: () => 1,
  });
  const crossCheck = crossCheckZeroCost(
    engineResult.stats.netprofit,
    zeroCosted.reduce((sum, t) => sum + t.netPnl, 0),
  );

  report(85, 'computing metrics');
  const metrics = buildMetricsReport({
    trades: costed,
    equityClose: equity.close,
    equityIntrabar: equity.intrabar,
    daily: equity.daily,
    monthly: equity.monthly,
    initialCapital: params.initialCapital,
    window: { fromMs: params.fromMs, toMs: params.toMs },
    instrument: {
      symbol: params.symbol.symbol,
      accountCurrency: params.accountCurrency,
      quoteCurrency: params.symbol.quoteCcy,
      mintick: params.symbol.mintick,
      pipSize: params.symbol.pipSize,
      pointValue: params.symbol.pointValue,
      contractSize: params.symbol.contractSize,
    },
    rfAnnual: params.rfAnnual ?? 0,
    openPnl: equity.openPnl,
    buyAndHoldReturnPct: buyAndHoldReturnPct(windowBars),
    barsInMarket: equity.barsInMarket,
    totalBars: windowBars.length,
  });

  report(100, 'done');

  return {
    engineResult,
    trades: costed,
    equityClose: equity.close,
    equityIntrabar: equity.intrabar,
    daily: equity.daily,
    monthly: equity.monthly,
    metrics,
    buyAndHoldReturnPct: buyAndHoldReturnPct(windowBars),
    crossCheck,
    engineMs,
    totalMs: Date.now() - startedAt,
  };
}

/**
 * Re-index trade bar numbers from the FULL bar array (warmup included) onto the window array.
 *
 * The engine numbers bars from the start of everything it loaded, but equity is reconstructed
 * over the window only. Without this, a trade's `entryBar` would point at the wrong bar — or
 * past the end of the array — and its mark-to-market would silently land on the wrong day.
 */
function rebaseToWindow(
  trades: readonly CostedTrade[],
  allBars: readonly Bar[],
  windowBars: readonly Bar[],
): CostedTrade[] {
  const firstWindowTime = windowBars[0]?.time;
  if (firstWindowTime === undefined) return [...trades];

  const offset = allBars.findIndex((b) => b.time === firstWindowTime);
  if (offset <= 0) return [...trades];

  return trades.map((t) => ({
    ...t,
    entryBar: t.entryBar - offset,
    exitBar: t.exitBar - offset,
  }));
}

/** Flatten a MetricsReport into the key→value rows `run_metrics` stores. */
export function flattenMetrics(report: MetricsReport): Record<string, number | null> {
  const out: Record<string, number | null> = {};

  const walk = (value: unknown, path: string): void => {
    if (value === null) {
      out[path] = null;
      return;
    }
    if (typeof value === 'number') {
      out[path] = Number.isFinite(value) ? value : null;
      return;
    }
    if (typeof value === 'boolean') {
      out[path] = value ? 1 : 0;
      return;
    }
    // Arrays (the monthly table, notes) are not scalar metrics and live in the summary blob.
    if (typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) {
        walk(child, path === '' ? key : `${path}.${key}`);
      }
    }
  };

  walk(report, '');
  return out;
}

/**
 * The quote -> account rate function for this run.
 *
 * Two hops because `resolveConversion` is pure and takes a SYNCHRONOUS bar reader, while bars
 * come from the database: plan first to learn which pair (if any) is needed, await just that
 * pair's bars, then resolve against what was loaded.
 */
async function resolveAccountRate(params: OrchestrateParams): Promise<QuoteToAccount> {
  const source = params.conversion;

  // No way to load a pair, so the only honest answer for a cross-currency run is to refuse.
  if (source === undefined) {
    return resolveQuoteToAccount(params.symbol, params.accountCurrency);
  }

  const plan = planConversion(params.symbol.quoteCcy, params.accountCurrency, source.known);
  if (plan === null || plan.kind === 'identity') {
    // `resolveConversion` raises the precise MissingConversionPairError for a null plan, and
    // returns identity without touching I/O otherwise, so both cases go through it unchanged.
    const outcome = resolveConversion({
      symbol: params.symbol,
      accountCurrency: params.accountCurrency,
      fromMs: params.fromMs,
      toMs: params.toMs,
      known: source.known,
      loadBars: () => [],
    });
    if (outcome.kind === 'needs-data') throw new MissingConversionDataError(outcome.missing);
    return outcome.rateAt;
  }

  const window = conversionWindow(params.fromMs, params.toMs);
  const bars = await source.loadBars(plan.pair.symbol, window.fromMs, window.toMs);

  const outcome = resolveConversion({
    symbol: params.symbol,
    accountCurrency: params.accountCurrency,
    fromMs: params.fromMs,
    toMs: params.toMs,
    known: source.known,
    loadBars: () => bars,
  });

  if (outcome.kind === 'needs-data') throw new MissingConversionDataError(outcome.missing);
  return outcome.rateAt;
}
