import { Indicator, PineTS } from 'pinets';
import { type Bar, type SymbolSpec, timeframeMs, timeframeToPine } from '@edgelab/shared';
import {
  type CompileResult,
  type DeclaredProp,
  type Diagnostic,
  type EngineStats,
  type EngineTrade,
  type InputSpec,
  type InputType,
  type PineEngine,
  type PlotSeries,
  type RunParams,
  type RunResult,
  type ScriptMeta,
} from '../pine-engine';
import { compatibilityDiagnostics } from './compat';
import { instrument, type Instrumentation } from './instrument';
import { ResamplingPineProvider, klinesToBars, type M1Source } from './provider';

/**
 * PineTS-backed engine. The ONLY module that imports `pinets`.
 *
 * Everything non-obvious here is forced by verified PineTS behaviour — see
 * docs/pinets-notes.md, which records what was tested and how.
 */

export const PINETS_VERSION = '0.9.34';

/** Loose views of the pinets objects, so we never widen our public types with `any`. */
interface PineInputMeta {
  id?: string;
  name?: string;
  varId?: string;
  title?: string;
  type?: string;
  defval?: unknown;
  minval?: number;
  maxval?: number;
  step?: number;
  options?: unknown[];
  group?: string;
  tooltip?: string;
  inline?: string;
}

interface PinePropMeta {
  name: string;
  type: string;
  defval: unknown;
  options?: unknown[];
  minval?: number;
  maxval?: number;
  mutable: boolean;
}

interface IndicatorLike {
  prepare(): unknown;
  getDeclarationType(): 'indicator' | 'strategy' | null;
  getInputsMeta(): PineInputMeta[];
  getPropsMeta(): PinePropMeta[];
  input: Record<string, unknown>;
  prop: Record<string, unknown>;
}

interface TradeLike {
  id?: string;
  entry_id?: string;
  entry_price?: number;
  entry_bar_index?: number;
  entry_time?: number;
  exit_id?: string;
  exit_price?: number;
  exit_bar_index?: number;
  exit_time?: number;
  exit_comment?: string;
  size?: number;
  profit?: number;
  commission?: number;
  max_drawdown?: number;
  max_runup?: number;
  status?: string;
}

interface PlotLike {
  title?: string;
  options?: { color?: string };
  data?: { time?: number; value?: number | null }[];
}

interface ContextLike {
  idx?: number;
  plots?: Record<string, PlotLike>;
  warnings?: { message: string; method?: string; bar: number }[];
  strategy?: {
    closedtrades?: TradeLike[];
    opentrades?: TradeLike[];
    netprofit?: number;
  };
}

const KNOWN_INPUT_TYPES: ReadonlySet<string> = new Set<InputType>([
  'int',
  'float',
  'bool',
  'string',
  'source',
  'timeframe',
  'session',
  'color',
  'enum',
  'price',
  'time',
  'symbol',
  'text_area',
]);

export interface PineTsEngineOptions {
  readonly m1: M1Source;
  readonly lookupSymbol: (code: string) => SymbolSpec | undefined;
  /** Default warmup, overridable per run. */
  readonly defaultWarmupBars?: number;
  readonly maxLoops?: number;
}

export class PineTsEngine implements PineEngine {
  public readonly id = 'pinets';
  public readonly engineVersion = PINETS_VERSION;
  public readonly supportedVersions = [5, 6] as const;

  constructor(private readonly options: PineTsEngineOptions) {}

  /* ------------------------------------------------------------- compile */

  compile(source: string): CompileResult {
    // Compatibility findings come first so they survive a transpile failure — a script that
    // will not compile at all still benefits from being told its indentation is wrong.
    const diagnostics: Diagnostic[] = compatibilityDiagnostics(source);

    let kind: ScriptMeta['kind'] = null;
    let inputs: InputSpec[] = [];
    let declaredProps: DeclaredProp[] = [];

    try {
      const ind = Indicator.from(source) as unknown as IndicatorLike;
      // prepare() is where transpilation happens, so this is where errors surface.
      ind.prepare();

      kind = ind.getDeclarationType();
      inputs = ind.getInputsMeta().map(toInputSpec);
      declaredProps = ind.getPropsMeta().map((p) => toDeclaredProp(ind, p));
    } catch (err: unknown) {
      diagnostics.push(toDiagnostic(err));
    }

    return {
      ok: !diagnostics.some((d) => d.severity === 'error'),
      diagnostics,
      meta: {
        kind,
        version: parsePineVersion(source),
        title: parseDeclaredTitle(source),
        declaredProps,
        inputs,
      },
    };
  }

  /* ----------------------------------------------------------------- run */

  async run(params: RunParams): Promise<RunResult> {
    const startedAt = Date.now();
    const spec = params.symbol;

    const ind = Indicator.from(params.source) as unknown as IndicatorLike;

    // ORDER MATTERS: overrides must be applied BEFORE the first prepare(). prepare() is
    // idempotent and caches PreparedScript.inputs from the values current at that moment,
    // so preparing first would bake in the defaults and silently ignore every override.
    // (The `.input` proxy scans lazily, so writing before prepare() is fine.)
    applyInputOverrides(ind, params.inputs);
    applyPropOverrides(ind, params.overrides);

    const warmupBars = params.warmupBars ?? this.options.defaultWarmupBars ?? 0;
    const bucketMs = timeframeMs(params.timeframe) ?? 31 * 24 * 60 * 60_000;
    const loadFromMs = Math.max(0, params.fromMs - warmupBars * bucketMs);

    // The gate is what makes warmup safe: indicators see the earlier bars, but no position
    // may open before the requested start.
    const instrumentation: Instrumentation = instrument(ind, {
      ...(warmupBars > 0 ? { tradingWindowStartMs: params.fromMs } : {}),
      ...(params.recordSecurityCalls === true ? { recordSecurityCalls: true } : {}),
    });

    const provider = new ResamplingPineProvider({
      m1: this.options.m1,
      lookupSymbol: this.options.lookupSymbol,
      ...(params.dataCutoffTs === undefined ? {} : { dataCutoffTs: params.dataCutoffTs }),
    });

    params.onProgress?.(5, `loading ${spec.symbol} ${params.timeframe}`);

    const pine = new PineTS(
      provider as unknown as ConstructorParameters<typeof PineTS>[0],
      spec.symbol,
      timeframeToPine(params.timeframe),
      undefined,
      loadFromMs,
      params.toMs,
    );

    if (this.options.maxLoops !== undefined) {
      pine.setMaxLoops(this.options.maxLoops);
    }

    params.onProgress?.(15, 'executing script');

    const ctx = (await pine.run(ind as unknown as Indicator)) as unknown as ContextLike;

    // The provider records instead of throwing, because a rejection inside
    // request.security escapes as an unhandled rejection and never reaches this promise.
    // Surface it here so the job fails loudly instead of returning partial data.
    const providerError = provider.firstError();
    if (providerError !== undefined) throw providerError;

    // `request.security` returns a Promise, so the interceptor records a pending value and fills it
    // in on resolution. Reading the log before those settle would report every call as `value: null`
    // and the causality check would see nothing but unmatched observations.
    await instrumentation.securityLog?.settle();

    params.onProgress?.(90, 'mapping results');

    const klines = await provider.getMarketData(
      spec.symbol,
      timeframeToPine(params.timeframe),
      undefined,
      loadFromMs,
      params.toMs,
    );
    // The spread lookup matters: Kline drops it, and without it every trade is costed at the
    // symbol's default spread instead of what the data measured.
    const bars: Bar[] = klinesToBars(klines, (openTime) =>
      provider.spreadAt(params.timeframe, openTime),
    );

    const plots = mapPlots(ctx);
    const trades = mapTrades(ctx);

    const stats: EngineStats = {
      netprofit: ctx.strategy?.netprofit ?? null,
      closedTrades: ctx.strategy?.closedtrades?.length ?? 0,
      openTrades: ctx.strategy?.opentrades?.length ?? 0,
      barsProcessed: bars.length,
      runtimeMs: Date.now() - startedAt,
      warmupBars: bars.filter((b) => b.time < params.fromMs).length,
      indicatorWarmupBars: countIndicatorWarmup(plots),
      suppressedOrders: instrumentation.suppressed(),
      noopOrders: instrumentation.noops(),
    };

    params.onProgress?.(100, 'done');

    return {
      trades,
      plots,
      orderLog: instrumentation.orderLog,
      securityCalls: instrumentation.securityLog?.calls ?? null,
      stats,
      diagnostics: (ctx.warnings ?? []).map((w) => ({
        line: null,
        col: null,
        message: w.method === undefined ? w.message : `${w.method}: ${w.message}`,
        severity: 'warning' as const,
        code: 'runtime-warning',
      })),
      bars,
      // PineTS's currency conversion is a passthrough, so the engine's numbers are in the
      // instrument's quote currency. The reporting layer converts to the account currency.
      engineCurrency: spec.quoteCcy,
    };
  }
}

/* --------------------------------------------------------------- mapping */

function toInputSpec(meta: PineInputMeta): InputSpec {
  // Key on varId: titles can duplicate (aliasing to the first input) or be empty. Fall
  // back to `id` because 0.10.x emits `in_N` ids.
  const key = meta.varId ?? meta.id ?? meta.title ?? '';
  const rawType = meta.type ?? 'string';
  const type = (KNOWN_INPUT_TYPES.has(rawType) ? rawType : 'string') as InputType;

  return {
    key,
    title: meta.title ?? meta.name ?? key,
    type,
    default: meta.defval,
    ...(meta.minval === undefined ? {} : { min: meta.minval }),
    ...(meta.maxval === undefined ? {} : { max: meta.maxval }),
    // `step` is absent when the script declares none — do not invent one.
    ...(meta.step === undefined ? {} : { step: meta.step }),
    ...(meta.options === undefined ? {} : { options: meta.options }),
    ...(meta.group === undefined ? {} : { group: meta.group }),
    ...(meta.tooltip === undefined ? {} : { tooltip: meta.tooltip }),
    ...(meta.inline === undefined ? {} : { inline: meta.inline }),
  };
}

/**
 * The script's declared prop value is not exposed publicly, so read it through the `.prop`
 * live view and fall back to the schema default. Reading an immutable key can throw.
 */
function toDeclaredProp(ind: IndicatorLike, meta: PinePropMeta): DeclaredProp {
  let value: unknown = meta.defval;
  try {
    const read = ind.prop[meta.name];
    if (read !== undefined) value = read;
  } catch {
    // Immutable or unknown key — the schema default stands.
  }

  const type = (['string', 'int', 'float', 'bool', 'enum'] as const).includes(meta.type as 'string')
    ? (meta.type as DeclaredProp['type'])
    : 'string';

  return {
    name: meta.name,
    type,
    value,
    schemaDefault: meta.defval,
    mutable: meta.mutable,
    ...(meta.options === undefined ? {} : { options: meta.options }),
    ...(meta.minval === undefined ? {} : { min: meta.minval }),
    ...(meta.maxval === undefined ? {} : { max: meta.maxval }),
  };
}

function mapTrades(ctx: ContextLike): EngineTrade[] {
  const closed = ctx.strategy?.closedtrades ?? [];
  const open = ctx.strategy?.opentrades ?? [];

  // Ordered by entry, then numbered from 1 — the way a trade list reads, and the way
  // TradingView numbers them. PineTS's own ids cannot be used: it numbers closedtrades and
  // opentrades independently, so a reversal produces two distinct trades both called
  // `trade_1`. `entry_bar_index` breaks ties so the order is total and deterministic.
  const ordered = [...closed, ...open].sort((a, b) => {
    const byTime = (a.entry_time ?? 0) - (b.entry_time ?? 0);
    if (byTime !== 0) return byTime;
    return (a.entry_bar_index ?? 0) - (b.entry_bar_index ?? 0);
  });

  return ordered.map((t, i) => {
    // `size` is SIGNED: positive long, negative short.
    const size = t.size ?? 0;
    return {
      id: `t${String(i + 1)}`,
      engineId: t.id ?? null,
      entryId: t.entry_id ?? '',
      side: size < 0 ? ('short' as const) : ('long' as const),
      qty: Math.abs(size),
      entryTime: t.entry_time ?? 0,
      entryBar: t.entry_bar_index ?? -1,
      entryPrice: t.entry_price ?? 0,
      exitTime: t.exit_time ?? null,
      exitBar: t.exit_bar_index ?? null,
      exitPrice: t.exit_price ?? null,
      exitId: t.exit_id ?? null,
      exitComment: t.exit_comment ?? null,
      commission: t.commission ?? 0,
      // undefined means OPEN, never break-even zero.
      netPnl: t.profit ?? null,
      maxRunup: t.max_runup ?? null,
      maxDrawdown: t.max_drawdown ?? null,
      status: t.status === 'open' ? ('open' as const) : ('closed' as const),
    };
  });
}

/** Drawing collections live under `__labels__`-style keys and are not plots. */
function mapPlots(ctx: ContextLike): PlotSeries[] {
  const out: PlotSeries[] = [];
  for (const [key, plot] of Object.entries(ctx.plots ?? {})) {
    if (key.startsWith('__')) continue;
    out.push({
      title: plot.title ?? key,
      color: plot.options?.color ?? null,
      points: (plot.data ?? []).map((p) => ({
        time: p.time ?? 0,
        // Pine's `na` reaches us as either null OR NaN, and `?? null` does not catch NaN.
        // Letting NaN through would poison the chart and every downstream calculation.
        value: typeof p.value === 'number' && Number.isFinite(p.value) ? p.value : null,
      })),
    });
  }
  return out;
}

/** Leading bars where every plot is still null — the script's own warmup. */
function countIndicatorWarmup(plots: readonly PlotSeries[]): number | null {
  if (plots.length === 0) return null;
  const length = Math.max(...plots.map((p) => p.points.length));
  for (let i = 0; i < length; i += 1) {
    if (plots.some((p) => p.points[i]?.value != null)) return i;
  }
  return length;
}

/* ------------------------------------------------------------- overrides */

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

/**
 * Input and prop writes are validated EAGERLY and throw synchronously at assignment, not
 * at run time. They are settings problems, not compile diagnostics, so they get their own
 * error type.
 */
function applyInputOverrides(
  ind: IndicatorLike,
  inputs: Readonly<Record<string, unknown>> | undefined,
): void {
  if (inputs === undefined) return;
  for (const [key, value] of Object.entries(inputs)) {
    if (value === undefined) continue;
    try {
      ind.input[key] = value;
    } catch (err: unknown) {
      throw new SettingsValidationError(
        `Input "${key}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function applyPropOverrides(
  ind: IndicatorLike,
  overrides: RunParams['overrides'] | undefined,
): void {
  if (overrides === undefined) return;
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    try {
      ind.prop[name] = value;
    } catch (err: unknown) {
      throw new SettingsValidationError(
        `Run parameter "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/* ----------------------------------------------------------- diagnostics */

/** `... at 6:3 ...` or `Indentation error at 6:9` — the runtime embeds position in text. */
const POSITION_RE = /\bat (\d+):(\d+)/;

export function toDiagnostic(err: unknown): Diagnostic {
  const message = err instanceof Error ? err.message : String(err);

  const withPos = err as { line?: unknown; column?: unknown; col?: unknown };
  let line = typeof withPos?.line === 'number' ? withPos.line : null;
  let col =
    typeof withPos?.column === 'number'
      ? withPos.column
      : typeof withPos?.col === 'number'
        ? withPos.col
        : null;

  if (line === null) {
    const m = POSITION_RE.exec(message);
    if (m !== null) {
      line = Number(m[1]);
      col = Number(m[2]);
    }
  }

  return { line, col, message, severity: 'error' };
}

export function parsePineVersion(source: string): number | null {
  const m = /\/\/\s*@version\s*=\s*(\d+)/.exec(source);
  return m === null ? null : Number(m[1]);
}

/** First positional string of strategy()/indicator(), or its `title=` argument. */
export function parseDeclaredTitle(source: string): string | null {
  const call = /\b(?:strategy|indicator)\s*\(([\s\S]*?)\)/.exec(source);
  if (call === null) return null;
  const args = call[1] ?? '';

  const named = /\btitle\s*=\s*(['"])((?:\\.|(?!\1).)*)\1/.exec(args);
  if (named !== null) return named[2] ?? null;

  const positional = /^\s*(['"])((?:\\.|(?!\1).)*)\1/.exec(args);
  return positional === null ? null : (positional[2] ?? null);
}
