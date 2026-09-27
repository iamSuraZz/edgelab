import type { Bar, SymbolSpec, Timeframe, TradeSide } from '@edgelab/shared';

/**
 * Pine execution sits behind this interface so the runtime can be replaced later. The
 * only implementation today is PineTsEngine (pinets 0.9.34) — see docs/pinets-notes.md
 * for what was verified about it.
 *
 * Nothing outside src/pinets/ may import pinets directly.
 */

/* ------------------------------------------------------------------ compile */

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  /** 1-based, or null when the runtime gave no position. */
  readonly line: number | null;
  readonly col: number | null;
  readonly message: string;
  readonly severity: DiagnosticSeverity;
  /** Set for compatibility findings so the UI can group them. */
  readonly code?: string;
}

/** Input types we render a control for. Anything else is passed through as a string. */
export type InputType =
  | 'int'
  | 'float'
  | 'bool'
  | 'string'
  | 'source'
  | 'timeframe'
  | 'session'
  | 'color'
  | 'enum'
  | 'price'
  | 'time'
  | 'symbol'
  | 'text_area';

export interface InputSpec {
  /**
   * Stable override key. This is the script's variable id, NOT the title: duplicate
   * titles alias to the first input and an empty title is addressable only by varId.
   */
  readonly key: string;
  readonly title: string;
  readonly type: InputType;
  readonly default: unknown;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: readonly unknown[];
  readonly group?: string;
  readonly tooltip?: string;
  /** Pine's `inline=` — the form groups these onto one row. */
  readonly inline?: string;
}

/** One `strategy()` / `indicator()` declaration argument. */
export interface DeclaredProp {
  readonly name: string;
  readonly type: 'string' | 'int' | 'float' | 'bool' | 'enum';
  /** Value the script declared, or the schema default when the script omitted it. */
  readonly value: unknown;
  readonly schemaDefault: unknown;
  /** False for title/shorttitle — the UI must render them read-only. */
  readonly mutable: boolean;
  readonly options?: readonly unknown[];
  readonly min?: number;
  readonly max?: number;
}

export interface ScriptMeta {
  readonly kind: 'strategy' | 'indicator' | null;
  /** Pine version from `//@version=N`, or null when absent. */
  readonly version: number | null;
  readonly title: string | null;
  readonly declaredProps: readonly DeclaredProp[];
  readonly inputs: readonly InputSpec[];
}

export interface CompileResult {
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly meta: ScriptMeta;
}

/* ---------------------------------------------------------------------- run */

/** Broker/run parameters. Undefined means "use the script's declared value". */
export interface RunOverrides {
  readonly initial_capital?: number;
  readonly default_qty_type?: 'fixed' | 'cash' | 'percent_of_equity';
  readonly default_qty_value?: number;
  readonly pyramiding?: number;
  readonly commission_type?: 'percent' | 'cash_per_contract' | 'cash_per_order';
  readonly commission_value?: number;
  /** In ticks, as Pine defines it. */
  readonly slippage?: number;
  readonly process_orders_on_close?: boolean;
  readonly margin_long?: number;
  readonly margin_short?: number;
  readonly currency?: string;
}

export interface RunParams {
  readonly source: string;
  readonly symbol: SymbolSpec;
  readonly timeframe: Timeframe;
  /** Inclusive start of the TRADING window, UTC epoch ms. */
  readonly fromMs: number;
  /** Exclusive end, UTC epoch ms. */
  readonly toMs: number;
  /**
   * Extra bars loaded before `fromMs` so indicators warm up. The trading-window gate
   * suppresses entries on them. 0 disables warmup.
   */
  readonly warmupBars?: number;
  /** Keyed by InputSpec.key (varId). */
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly overrides?: RunOverrides;
  /**
   * Truncate the DATA at this instant, on every timeframe.
   *
   * Any higher-timeframe bucket whose close extends past it is dropped entirely rather than
   * served half-formed, which is what makes the prefix-invariance test able to catch a
   * higher-timeframe leak. Distinct from `toMs`: that shortens the TRADING window, this hides
   * data the strategy would otherwise be able to read.
   */
  readonly dataCutoffTs?: number;
  /** Wall-clock ceiling for the run. */
  readonly timeoutMs?: number;
  readonly onProgress?: (percent: number, message: string) => void;
}

/** A completed round trip, as the engine reports it (engine currency, pre-overlay). */
export interface EngineTrade {
  /**
   * Run-unique, `t1`-based, numbered by entry order — what the trade list and chart markers
   * key on, and the primary key of `run_trades`.
   *
   * Assigned by us, NOT taken from the engine. PineTS numbers `closedtrades` and
   * `opentrades` independently, so a run that reverses a position yields two different
   * trades both calling themselves `trade_1`.
   */
  readonly id: string;
  /** Whatever the engine called this trade, kept for cross-checking. May not be unique. */
  readonly engineId: string | null;
  readonly entryId: string;
  readonly side: TradeSide;
  /** Always positive; the engine's signed size is split into side + qty. */
  readonly qty: number;
  readonly entryTime: number;
  readonly entryBar: number;
  readonly entryPrice: number;
  readonly exitTime: number | null;
  readonly exitBar: number | null;
  readonly exitPrice: number | null;
  readonly exitId: string | null;
  readonly exitComment: string | null;
  readonly commission: number;
  /** Engine P&L in the engine's currency. Null while the trade is open. */
  readonly netPnl: number | null;
  readonly maxRunup: number | null;
  readonly maxDrawdown: number | null;
  readonly status: 'open' | 'closed';
}

export interface PlotPoint {
  readonly time: number;
  readonly value: number | null;
}

export interface PlotSeries {
  readonly title: string;
  readonly color: string | null;
  /** One point per bar, ascending, aligned to the run's bars. */
  readonly points: readonly PlotPoint[];
}

/** Outcome of an intercepted strategy call — see docs/pinets-notes.md §6. */
export type OrderOutcome = 'placed' | 'noop' | 'suppressed';

export interface OrderLogEntry {
  readonly method: 'entry' | 'order' | 'exit' | 'close' | 'close_all' | 'cancel' | 'cancel_all';
  readonly bar: number;
  readonly time: number | null;
  /**
   * `placed` — the engine created an order.
   * `noop`   — called through but nothing appeared (pyramiding cap, margin, …).
   * `suppressed` — our trading-window gate stopped it.
   */
  readonly outcome: OrderOutcome;
  /** Arguments as written by the script, resolved positionally + by name. */
  readonly args: Readonly<Record<string, unknown>>;
  /** The order the engine actually created, when `outcome === 'placed'`. */
  readonly resolved: Readonly<Record<string, unknown>> | null;
}

export interface EngineStats {
  readonly netprofit: number | null;
  readonly closedTrades: number;
  readonly openTrades: number;
  readonly barsProcessed: number;
  readonly runtimeMs: number;
  /** Bars loaded purely for warmup, before the trading window. */
  readonly warmupBars: number;
  /** How many leading bars the script's own indicators needed before emitting. */
  readonly indicatorWarmupBars: number | null;
  readonly suppressedOrders: number;
  readonly noopOrders: number;
}

export interface RunResult {
  readonly trades: readonly EngineTrade[];
  readonly plots: readonly PlotSeries[];
  readonly orderLog: readonly OrderLogEntry[];
  readonly stats: EngineStats;
  /** Runtime warnings the script produced, already shaped as diagnostics. */
  readonly diagnostics: readonly Diagnostic[];
  /** The bars the run actually executed on, for equity reconstruction. */
  readonly bars: readonly Bar[];
  /** Currency the engine's numbers are denominated in (the instrument's quote ccy). */
  readonly engineCurrency: string;
}

export interface PineEngine {
  readonly id: string;
  readonly engineVersion: string;
  readonly supportedVersions: readonly number[];
  compile(source: string): CompileResult;
  run(params: RunParams): Promise<RunResult>;
}

export class PineCompileError extends Error {
  public readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    const first = diagnostics.find((d) => d.severity === 'error');
    super(first?.message ?? 'Pine compilation failed');
    this.name = 'PineCompileError';
    this.diagnostics = diagnostics;
  }
}

/**
 * Thrown when the instrumentation seam is missing. Deliberately fatal: without it the
 * order log would be silently empty and the trading-window gate would silently stop
 * gating, producing a backtest that ignores the warmup cutoff without erroring.
 */
export class InstrumentationUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `PineTS instrumentation seam unavailable (${detail}). Refusing to run: the order ` +
        `log would be empty and the trading-window gate would not apply. See ` +
        `docs/pinets-notes.md section 5.`,
    );
    this.name = 'InstrumentationUnavailableError';
  }
}
