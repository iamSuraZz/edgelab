import { readFileSync } from 'node:fs';
import process from 'node:process';

import {
  completeRun,
  createDbClient,
  createRun,
  failRun,
  findSymbolByCode,
  listSymbols,
  ResampledM1Source,
  countM1InWindow,
  readM1Bars,
  upsertStrategyVersion,
  type DbClient,
} from '@edgelab/db';
import {
  CurrencyMismatchError,
  PineTsEngine,
  STRATEGY_FIXTURES,
  flattenMetrics,
  getFixture,
  orchestrateRun,
  type OrchestratedRun,
} from '@edgelab/engine';
import {
  CostConfigSchema,
  DEFAULT_COSTS,
  TIMEFRAME_CODES,
  timeframeMs,
  type CostConfig,
  type SymbolSpec,
  type Timeframe,
  accountMoney,
} from '@edgelab/shared';
import { VALIDATION_FIXTURES } from '@edgelab/validation';

import { assertSingleFeed } from '../ingest/feed-guard';
import { loadDotEnvFile, loadEnv } from '@edgelab/shared/config';

import { MemoryProbe } from '../diagnostics/memory-probe';

/**
 * Run a backtest end to end, without the queue or the API.
 *
 *   pnpm backtest --fixture ema-cross --symbol EURUSD --tf H1 \
 *     --from 2024-01-01 --to 2024-02-01 [--costs costs.json]
 *   pnpm backtest --all --symbol EURUSD --tf H1 --from 2024-01-01 --to 2024-02-01
 *
 * Chains engine -> costs -> equity -> metrics, persists the run, and prints the KPI summary
 * and the cross-check result. This is the whole backend pipeline in one command, which is what
 * makes it useful: if this works, the API and the UI are wiring rather than logic.
 */

interface Args {
  readonly fixtures: string[];
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly fromMs: number;
  readonly toMs: number;
  readonly costs: CostConfig;
  readonly initialCapital: number;
  readonly accountCurrency: string;
  readonly warmupBars: number;
  readonly sourceFile: string | null;
  /** Print a per-stage memory table. Run with `--expose-gc` for retained rather than peak-ish numbers. */
  readonly measureMemory: boolean;
  /**
   * Position size in LOTS, applied as a `default_qty_value` override. 0 keeps whatever the
   * script itself declares.
   *
   * Needed because Pine sizes positions in CONTRACTS, and the fixtures all declare
   * `default_qty_value=1` — which on EURUSD is one unit of EUR, so a whole month of trading
   * moves the account by a few cents. Faithful to the script, useless as a report.
   */
  readonly lots: number;
  /**
   * Account leverage, converted to the engine's margin percentages as `100 / leverage`
   * (spec 03).
   *
   * Not cosmetic: PineTS cancels an order whose required margin exceeds equity, silently. At
   * the engine's default of 100% margin, one standard lot of EURUSD needs ~$110,000, so every
   * order on a $10,000 account is dropped and the run reports zero trades with no explanation.
   */
  readonly leverage: number;
}

const USAGE = `usage:
  pnpm backtest --fixture <name> --symbol EURUSD --tf H1 --from 2024-01-01 --to 2024-02-01 [options]
  pnpm backtest --all --symbol EURUSD --tf H1 --from 2024-01-01 --to 2024-02-01

options:
  --fixture <name>    one of: ${[...STRATEGY_FIXTURES, ...VALIDATION_FIXTURES].map((f) => f.id).join(', ')}
  --all               run every fixture
  --file <path.pine>  run a Pine file instead of a fixture
  --mem               print heap/external per stage, with bytes per bar
  --costs <file.json> CostConfig overrides, merged over the defaults
  --capital <n>       initial capital (default 10000)
  --currency <CCY>    account currency (default USD)
  --warmup <n>        bars loaded before --from (default 500)
  --lots <n>          position size in lots, overriding the script (default 1; 0 = script)
  --leverage <n>      account leverage; margin % = 100/leverage (default 100)`;

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  const bare = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      bare.add(name);
    } else {
      flags.set(name, next);
      i += 1;
    }
  }

  const symbol = flags.get('symbol') ?? 'EURUSD';
  const tf = flags.get('tf') ?? 'H1';
  if (!(TIMEFRAME_CODES as readonly string[]).includes(tf)) {
    throw new Error(`Unknown timeframe "${tf}". One of: ${TIMEFRAME_CODES.join(', ')}`);
  }

  const fromIso = flags.get('from');
  const toIso = flags.get('to');
  if (fromIso === undefined || toIso === undefined) throw new Error(USAGE);

  const fromMs = Date.parse(`${fromIso}T00:00:00Z`);
  const toMs = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    throw new Error(`Could not parse dates: ${fromIso} .. ${toIso}`);
  }
  if (toMs <= fromMs) throw new Error('--to must be after --from');

  const sourceFile = flags.get('file') ?? null;
  const measureMemory = bare.has('mem');
  const fixtureName = flags.get('fixture');
  const fixtures = bare.has('all')
    ? STRATEGY_FIXTURES.map((f) => f.id)
    : fixtureName !== undefined
      ? [fixtureName]
      : sourceFile !== null
        ? []
        : ['ema-cross'];

  return {
    fixtures,
    symbol,
    timeframe: tf as Timeframe,
    fromMs,
    toMs,
    costs: loadCosts(flags.get('costs')),
    initialCapital: Number(flags.get('capital') ?? 10_000),
    accountCurrency: (flags.get('currency') ?? 'USD').toUpperCase(),
    warmupBars: Number(flags.get('warmup') ?? 500),
    sourceFile,
    measureMemory,
    lots: Number(flags.get('lots') ?? 1),
    leverage: Number(flags.get('leverage') ?? 100),
  };
}

/**
 * Cost overrides are MERGED over the defaults, one level deep, so a file only has to name what
 * it changes. Validated through the zod schema so a typo fails here rather than silently
 * charging nothing.
 */
function loadCosts(path: string | undefined): CostConfig {
  if (path === undefined) return DEFAULT_COSTS;

  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const partial = parsed as Partial<CostConfig>;

  return CostConfigSchema.parse({
    ...DEFAULT_COSTS,
    ...partial,
    spread: { ...DEFAULT_COSTS.spread, ...(partial.spread ?? {}) },
    financing: { ...DEFAULT_COSTS.financing, ...(partial.financing ?? {}) },
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  loadDotEnvFile();
  const env = loadEnv(process.env);
  const db = createDbClient(env.DATABASE_URL, { max: 4, statementTimeoutMs: 600_000 });

  let failures = 0;

  try {
    const symbolRow = await findSymbolByCode(db, args.symbol);
    if (symbolRow === null) throw new Error(`Unknown symbol ${args.symbol}`);

    const spec: SymbolSpec = symbolRow;

    // Load ONCE and reuse across every fixture: at 500 warmup bars on H1 that is weeks of M1,
    // and re-reading it per fixture would dominate the runtime.
    const barsFromMs = args.fromMs - warmupSpanMs(args);
    await assertSingleFeed({
      db,
      symbolId: symbolRow.id,
      symbolCode: spec.symbol,
      fromMs: args.fromMs,
      toMs: args.toMs,
    });

    // A seal cutting the range short is ANNOUNCED, never silent: a run that covers less than it
    // appears to is worse than one that refuses, because its numbers look like an answer.
    const probe = args.measureMemory ? new MemoryProbe({ forceGc: true }) : null;
    probe?.mark('baseline', null);

    /*
     * COUNT the range before reading it (A72).
     *
     * The old path read every M1 row into an array and kept it for the run — 800MB for nine years of
     * BTC, which is what killed the worker. Nothing here needs the minutes: the engine asks for
     * candles at the chart timeframe, and the source aggregates while paging.
     */
    const counted = await countM1InWindow(db, symbolRow.id, barsFromMs, args.toMs);
    probe?.mark('count (no read)', counted.bars);

    const effectiveToMs = counted.truncatedAtMs ?? args.toMs;
    if (counted.truncatedAtMs !== null) {
      console.log(
        `   NOTE: a sealed holdout cut this range at ` +
          `${new Date(counted.truncatedAtMs).toISOString().slice(0, 10)}. ` +
          `The run below covers less than you asked for.`,
      );
    }

    if (counted.bars === 0) {
      throw new Error(
        `No stored M1 bars for ${args.symbol} in ${new Date(barsFromMs).toISOString().slice(0, 10)}` +
          ` .. ${new Date(args.toMs).toISOString().slice(0, 10)}. Run \`pnpm ingest\` first.`,
      );
    }

    let m1BarsRead = 0;
    // `m1Source`, not `source`: the fixture loop below binds `source` to the Pine SCRIPT, and two
    // different things under one name in overlapping scopes is a trap for whoever edits this next.
    const m1Source = new ResampledM1Source({
      db,
      symbolId: (code) => (code === spec.symbol ? symbolRow.id : undefined),
      onBarsRead: (n) => {
        m1BarsRead += n;
      },
    });

    const engine = new PineTsEngine({
      m1: m1Source,
      lookupSymbol: (code) => (code === spec.symbol ? spec : undefined),
    });

    printHeader(args, spec, counted.bars);

    const names = args.fixtures.length > 0 ? args.fixtures : ['(file)'];

    for (const name of names) {
      const { source, label } =
        args.sourceFile !== null
          ? { source: readFileSync(args.sourceFile, 'utf8'), label: args.sourceFile }
          : { source: sourceForFixture(name), label: name };

      const ok = await runOne({
        probe,
        m1BarsRead: () => m1BarsRead,
        // The EFFECTIVE range: every downstream consumer — the engine, the metrics window, the
        // stored row — sees the window that actually ran, so none of them has to correct for a
        // truncation later (A40).
        args: { ...args, toMs: effectiveToMs },
        ...(counted.truncatedAtMs === null ? {} : { requestedToMs: args.toMs }),
        db,
        engine,
        spec,
        source,
        label,
        dataVersion: symbolRow.dataVersion,
      });
      if (!ok) failures += 1;
    }

    console.log('');
    if (failures > 0) {
      console.error(`${String(failures)} of ${String(names.length)} run(s) FAILED`);
      process.exitCode = 1;
    } else {
      console.log(`All ${String(names.length)} run(s) completed and persisted.`);
    }
  } finally {
    await db.close();
  }
}

/**
 * How far before `from` to load M1 bars for warmup.
 *
 * `warmupBars` counts bars at the RUN timeframe, so it has to be converted to M1 minutes, then
 * padded generously — fx closes at weekends, so N timeframe-bars of history spans considerably
 * more than N × duration of wall-clock time.
 */
/** Lots -> the contract count Pine sizes in, plus the margin that position needs. */
function sizingOverride(args: Args, spec: SymbolSpec): Record<string, unknown> {
  const marginPct = args.leverage > 0 ? 100 / args.leverage : 100;
  return {
    default_qty_type: 'fixed',
    default_qty_value: args.lots * spec.contractSize,
    margin_long: marginPct,
    margin_short: marginPct,
  };
}

function warmupSpanMs(args: Args): number {
  const durationMs = timeframeMs(args.timeframe);
  if (durationMs === null) throw new Error(`No duration for timeframe ${args.timeframe}`);
  return Math.ceil(args.warmupBars * durationMs * 2.5);
}

interface RunOneParams {
  readonly args: Args;
  /** What was asked for, when a seal cut it short. Absent when nothing was withheld. */
  readonly requestedToMs?: number;
  readonly db: DbClient;
  readonly engine: PineTsEngine;
  readonly spec: SymbolSpec;
  readonly source: string;
  readonly label: string;
  readonly dataVersion: number;
  readonly probe?: MemoryProbe | null;
  /** M1 rows the aggregated read consumed, for the memory table. */
  readonly m1BarsRead?: () => number;
}

async function runOne(params: RunOneParams): Promise<boolean> {
  const { args, db, engine, spec, source, label } = params;

  const compiled = engine.compile(source);
  const errors = compiled.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    console.log('');
    console.log(`${label}: COMPILE FAILED`);
    for (const d of errors) console.log(`  ${formatDiagnostic(d)}`);
    return false;
  }

  const warnings = compiled.diagnostics.filter((d) => d.severity === 'warning');

  const symbolRow = await findSymbolByCode(db, spec.symbol);

  // Which instruments exist, for the conversion planner: it must never invent a pair nobody quotes.
  const knownSymbols = new Set((await listSymbols(db)).map((r) => r.symbol.toUpperCase()));
  if (symbolRow === null) throw new Error(`Symbol ${spec.symbol} vanished mid-run`);

  const version = await upsertStrategyVersion(db.db, {
    name: compiled.meta.title ?? label,
    pineSource: source,
    pineVersion: compiled.meta.version === 6 ? 'v6' : 'v5',
    title: compiled.meta.title,
  });

  const runId = await createRun(db.db, {
    strategyVersionId: version.versionId,
    symbolId: symbolRow.id,
    timeframe: args.timeframe,
    fromMs: args.fromMs,
    toMs: args.toMs,
    ...(params.requestedToMs === undefined ? {} : { requestedToMs: params.requestedToMs }),
    initialCapital: args.initialCapital,
    accountCurrency: args.accountCurrency,
    costs: args.costs,
    warmupBars: args.warmupBars,
    props: args.lots > 0 ? sizingOverride(args, spec) : {},
    engineId: engine.id,
    engineVersion: engine.engineVersion,
    dataVersion: params.dataVersion,
  });

  try {
    const run = await orchestrateRun({
      ...(params.probe == null
        ? {}
        : { onStage: (stageName, bars) => void params.probe!.mark(stageName, bars) }),
      engine,
      source,
      symbol: spec,
      timeframe: args.timeframe,
      fromMs: args.fromMs,
      toMs: args.toMs,
      // The mint site: a number off the command line becomes account-currency money here.
      initialCapital: accountMoney(args.initialCapital),
      accountCurrency: args.accountCurrency,
      costs: args.costs,
      warmupBars: args.warmupBars,
      // Currency conversion (spec 03), so the CLI can run a non-USD-quoted instrument on a USD
      // account. Same source the worker uses.
      conversion: {
        known: (code) => knownSymbols.has(code.toUpperCase()),
        loadBars: async (code, fromMs, toMs) => {
          const row = await findSymbolByCode(db, code);
          if (row === null) return [];
          return readM1Bars(db, row.id, fromMs, toMs);
        },
      },
      ...(args.lots > 0 ? { overrides: sizingOverride(args, spec) } : {}),
    });

    const summary = {
      netProfit: run.metrics.performance.netProfit,
      totalReturnPct: run.metrics.performance.totalReturnPct,
      cagrPct: run.metrics.performance.cagrPct,
      profitFactor: run.metrics.performance.profitFactor,
      maxDrawdownPct: run.metrics.risk.intrabar.maxDrawdownPct,
      sharpe: run.metrics.risk.sharpe,
      winRatePct: run.metrics.trades.all.winRatePct,
      closedTrades: run.metrics.trades.all.trades,
      buyAndHoldReturnPct: run.buyAndHoldReturnPct,
      /*
       * The FULL report, like the queued job stores (A65).
       *
       * Omitting it made every CLI-created run a second-class citizen in the UI: `GET
       * /backtests/:id` returns `metrics: null`, so the report page showed no monthly heatmap, no
       * cost waterfall and no metric tables — while the CLI printed those very figures to the
       * terminal as it saved the run. The CLI is the primary tool in this project, so its runs have
       * to be as readable as the API's.
       */
      report: run.metrics,
      diagnostics: run.engineResult.diagnostics,
      // Same derivation the queued job uses: entry orders placed and never filled, which is
      // almost always a margin rejection and only meaningful when nothing traded at all.
      unfilledEntryOrders:
        run.engineResult.trades.length === 0
          ? run.engineResult.orderLog.filter(
              (r) => r.outcome === 'placed' && (r.method === 'entry' || r.method === 'order'),
            ).length
          : 0,
    };

    await completeRun(db.db, {
      runId,
      trades: run.trades,
      series: {
        close: run.equityClose,
        intrabar: run.equityIntrabar,
        daily: run.daily,
        monthly: run.monthly,
      },
      metrics: flattenMetrics(run.metrics),
      summary,
      crossCheckOk: run.crossCheck.ok,
      crossCheckDeltaPct: run.crossCheck.deltaPct,
      barsProcessed: run.engineResult.stats.barsProcessed,
      engineMs: run.engineMs,
      totalMs: run.totalMs,
    });

    params.probe?.mark('persistence', run.trades.length);

    printRun(label, runId, run, warnings.length);

    if (params.probe != null) {
      console.log('');
      console.log('   MEMORY BY STAGE');
      console.log(params.probe.format());
    }

    return run.crossCheck.ok;
  } catch (error: unknown) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    await failRun(db.db, runId, message);

    console.log('');
    console.log(`${label}: RUN FAILED`);
    if (error instanceof CurrencyMismatchError) {
      // A configuration problem, not a bug — say so without a stack trace.
      console.log(`  ${error.message}`);
    } else {
      console.log(`  ${message}`);
    }
    return false;
  }
}

/* ------------------------------------------------------------------ output */

function formatDiagnostic(d: { line: number | null; message: string }): string {
  return `${d.line === null ? '' : `line ${String(d.line)}: `}${d.message}`;
}

function printHeader(args: Args, spec: SymbolSpec, m1Count: number): void {
  console.log(
    `${spec.symbol} ${args.timeframe}  ` +
      `${new Date(args.fromMs).toISOString().slice(0, 10)} .. ` +
      `${new Date(args.toMs).toISOString().slice(0, 10)}`,
  );
  console.log(
    // 'en-US' explicitly: the default locale groups by lakh on this machine, so a contract
    // size of 100000 printed as "1,00,000".
    `capital ${args.initialCapital.toLocaleString('en-US')} ${args.accountCurrency}  ` +
      `size ${
        args.lots > 0
          ? `${String(args.lots)} lot(s) @ 1:${String(args.leverage)} (override)`
          : 'per script'
      }  ` +
      `warmup ${String(args.warmupBars)} bars`,
  );
  console.log(
    `spread ${args.costs.spread.source}  financing ${args.costs.financing.mode}  ` +
      `mintick ${String(spec.mintick)}  contract ${spec.contractSize.toLocaleString('en-US')}`,
  );
  console.log(`M1 bars loaded ${m1Count.toLocaleString('en-US')}`);
}

function printRun(label: string, runId: string, run: OrchestratedRun, warningCount: number): void {
  const m = run.metrics;
  const p = m.performance;
  const t = m.trades.all;

  console.log('');
  console.log(`── ${label} ${'─'.repeat(Math.max(0, 58 - label.length))}`);
  console.log(`   run ${runId}`);

  const rows: [string, string][] = [
    ['Net profit', money(p.netProfit)],
    ['Total return', pct(p.totalReturnPct)],
    ['CAGR', `${pct(p.cagrPct)}${p.annualizedFromShortWindow ? ' (short window)' : ''}`],
    ['Buy & hold', pct(p.buyAndHoldReturnPct)],
    ['vs buy & hold', pct(p.vsBuyAndHoldPct)],
    ['Profit factor', num(p.profitFactor)],
    [
      'Max DD (intrabar)',
      `${mag(m.risk.intrabar.maxDrawdown)}  ${mag(m.risk.intrabar.maxDrawdownPct, '%')}`,
    ],
    [
      'Max DD (close)',
      `${mag(m.risk.closeToClose.maxDrawdown)}  ${mag(m.risk.closeToClose.maxDrawdownPct, '%')}`,
    ],
    ['Recovery factor', num(p.recoveryFactor)],
    ['Sharpe', num(m.risk.sharpe)],
    ['Sortino', num(m.risk.sortino)],
    ['Sharpe (TV style)', num(m.risk.sharpeTradingView)],
    ['Ulcer index', num(m.risk.ulcerIndex)],
    ['Closed trades', String(t.trades)],
    ['Win rate', mag(t.winRatePct, '%')],
    ['Expectancy', money(t.expectancy)],
    ['Win/loss ratio', num(t.winLossRatio)],
    ['Largest win / loss', `${money(t.largestWin)} / ${money(t.largestLoss)}`],
    ['Exposure', mag(m.trades.exposurePct, '%')],
    ['Total costs', mag(m.costs.totalCosts)],
    ['Cost drag', pct(m.costs.costDragPct)],
    ['Break-even/side', `${num(m.costs.breakEvenPerSidePips)} pips`],
  ];

  for (const [name, value] of rows) {
    console.log(`   ${name.padEnd(20)} ${value}`);
  }

  console.log(
    `   ${'Bars / runtime'.padEnd(20)} ${String(run.engineResult.stats.barsProcessed)} bars, ` +
      `engine ${String(run.engineMs)}ms (setup ${String(run.engineResult.stats.setupMs)}ms, exec ${String(run.engineResult.stats.executeMs)}ms), total ${String(run.totalMs)}ms`,
  );
  if (warningCount > 0) {
    console.log(`   ${'Compatibility'.padEnd(20)} ${String(warningCount)} warning(s)`);
  }
  const refunded = run.metrics.costs.slippageRefunded.total;
  if (refunded !== 0) {
    console.log(
      `   ${'Slippage refunded'.padEnd(20)} ${refunded.toFixed(2)}  (limit fills; engine divergence)`,
    );
  }
  // Measured, per fill type — the only way to tell whether a limit fill actually slips.
  if (run.slippageByType.length > 0) {
    const shown = run.slippageByType
      .map(
        (r) =>
          `${r.type} ${String(r.fills)} fills ${r.meanTicks.toFixed(2)}t (${String(r.slipped)} slipped)`,
      )
      .join(', ');
    console.log(`   ${'Slippage by fill'.padEnd(20)} ${shown}`);
  }
  console.log(`   ${'Cross-check'.padEnd(20)} ${run.crossCheck.ok ? 'PASS' : 'FAIL'}`);
  if (!run.crossCheck.ok) console.log(`   ${run.crossCheck.message}`);

  // Orders placed but nothing filled is almost always a margin rejection, which PineTS does
  // silently — the run just reports zero trades and every metric as "—". Saying so turns a
  // baffling empty report into an actionable one.
  const placed = run.engineResult.orderLog.filter(
    (r) => r.outcome === 'placed' && (r.method === 'entry' || r.method === 'order'),
  ).length;
  if (
    placed > 0 &&
    run.engineResult.stats.closedTrades === 0 &&
    run.engineResult.trades.length === 0
  ) {
    console.log(
      `   WARNING: ${String(placed)} entry order(s) were placed but none filled. The usual cause ` +
        'is insufficient margin — PineTS cancels such orders without reporting it. Lower --lots ' +
        'or raise --leverage.',
    );
  }

  for (const note of m.notes) console.log(`   note: ${note}`);
}

/**
 * Formatting rule: an explicit +/− sign goes on figures where DIRECTION is the point (profit,
 * return, expectancy), and is omitted from figures that are magnitudes (a drawdown, a win rate,
 * a ratio). "+0.06" for a drawdown reads like a gain.
 *
 * The minus is U+2212, not a hyphen, so negatives line up under positives in a proportional
 * terminal font.
 */
function signed(value: number | null, suffix = ''): string {
  if (value === null) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(2)}${suffix}`;
}

function money(value: number | null): string {
  return signed(value);
}

function pct(value: number | null): string {
  return signed(value, '%');
}

/** A magnitude: no sign, because it has no direction. */
function mag(value: number | null, suffix = ''): string {
  return value === null ? '—' : `${Math.abs(value).toFixed(2)}${suffix}`;
}

/** A ratio, which CAN be negative and means something different when it is. */
function num(value: number | null): string {
  if (value === null) return '—';
  return `${value < 0 ? '−' : ''}${Math.abs(value).toFixed(2)}`;
}

main().catch((err: unknown) => {
  console.error('backtest failed:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});

/**
 * Resolve a fixture id against both catalogues.
 *
 * The validation fixtures are deliberately absent from the Studio dropdown — one of them exists
 * only to cheat — but they still need to be runnable, because slice D's whole premise is that the
 * leaky one produces a run the checks then fail.
 */
function sourceForFixture(name: string): string {
  const validation = VALIDATION_FIXTURES.find((f) => f.id === name);
  return validation !== undefined ? validation.source : getFixture(name).source;
}
