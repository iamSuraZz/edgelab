import { readFileSync } from 'node:fs';

import { createDbClient, readRun } from '@edgelab/db';
import { PineTsEngine } from '@edgelab/engine';
import { loadDotEnvFile, loadEnv } from '@edgelab/shared/config';
import type { OptimizationSpec } from '@edgelab/validation';

import { optimizeRun } from '../validation/optimize-run';

/**
 * Walk-forward optimization, opt-in from the command line.
 *
 *   pnpm optimize <runId> --inputs              # what can be optimised, with suggested ranges
 *   pnpm optimize <runId> --spec spec.json      # run it
 *
 * `--inputs` is the setup form until the Integrity tab exists (step 3): it prints every numeric
 * input the script declares, with its declared bounds, as a spec skeleton ready to edit. Prefilling
 * from the script's own `InputSpec` matters because a range invented without looking will usually
 * either miss the interesting region or sweep values the script rejects.
 */

interface Args {
  readonly runId: string;
  readonly specPath: string | null;
  readonly listInputs: boolean;
  readonly folds: number | undefined;
  readonly threads: number | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const [runId, ...rest] = argv;
  if (runId === undefined || runId.startsWith('--')) {
    throw new Error(
      'Usage: pnpm optimize <runId> [--inputs | --spec <file>] [--folds n] [--threads n]',
    );
  }

  let specPath: string | null = null;
  let listInputs = false;
  let folds: number | undefined;
  let threads: number | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--inputs') listInputs = true;
    else if (flag === '--spec') specPath = rest[++i] ?? null;
    else if (flag === '--folds') folds = Number(rest[++i]);
    else if (flag === '--threads') threads = Number(rest[++i]);
  }

  return { runId, specPath, listInputs, folds, threads };
}

async function main(): Promise<void> {
  loadDotEnvFile();
  const env = loadEnv(process.env);
  const args = parseArgs(process.argv.slice(2));

  const db = createDbClient(env.DATABASE_URL);

  try {
    const run = await readRun(db.db, args.runId);
    if (run === null) throw new Error(`No backtest run with id ${args.runId}.`);

    if (args.listInputs) {
      await printInputs(run.pineSource);
      return;
    }

    if (args.specPath === null) {
      throw new Error('Pass --spec <file>, or --inputs to see what can be optimised.');
    }

    const spec = JSON.parse(readFileSync(args.specPath, 'utf8')) as OptimizationSpec;

    process.stdout.write(
      `optimising ${run.symbol} ${run.timeframe} on ${String(spec.inputs.length)} input(s), ` +
        `objective ${spec.objective}, min ${String(spec.minTrades)} trades\n`,
    );

    let announced = false;
    const report = await optimizeRun({
      db,
      runId: args.runId,
      spec,
      databaseUrl: env.DATABASE_URL,
      ...(args.folds === undefined ? {} : { folds: args.folds }),
      ...(args.threads === undefined ? {} : { maxThreads: args.threads }),
      onProgress: (done, total) => {
        if (!announced) announced = true;
        // Overwrite one line rather than scrolling twelve hundred of them.
        process.stdout.write(`\r  ${String(done)}/${String(total)} runs`);
      },
    });

    if (announced) process.stdout.write('\n');
    printReport(report);
  } finally {
    await db.close();
  }
}

async function printInputs(source: string): Promise<void> {
  const engine = new PineTsEngine({
    m1: { readM1: () => Promise.resolve([]) },
    lookupSymbol: () => undefined,
  });
  const compiled = await engine.compile(source);

  const numeric = compiled.meta.inputs.filter((i) => i.type === 'int' || i.type === 'float');
  if (numeric.length === 0) {
    process.stdout.write('This script declares no numeric inputs, so there is nothing to sweep.\n');
    return;
  }

  process.stdout.write(`\n${String(numeric.length)} optimisable input(s):\n\n`);
  for (const i of numeric) {
    const bounds =
      i.min === undefined && i.max === undefined
        ? '(no declared bounds)'
        : `min ${String(i.min ?? '-')} max ${String(i.max ?? '-')}`;
    process.stdout.write(
      `  ${i.key.padEnd(20)} ${i.title.padEnd(22)} ${String(i.type).padEnd(6)} ` +
        `default ${String(i.default).padEnd(8)} ${bounds}\n`,
    );
  }

  // A skeleton rather than prose: the point is that it can be saved and edited, not read. `name`
  // carries the input's KEY, not its title — a duplicate or empty title aliases to the wrong input.
  const skeleton = {
    inputs: numeric.slice(0, 3).map((i) => ({
      name: i.key,
      min: i.min ?? suggestMin(i.default),
      max: i.max ?? suggestMax(i.default),
      step: i.step ?? (i.type === 'int' ? 1 : 0.1),
    })),
    objective: 'netProfit',
    minTrades: 20,
    maxCombinations: 300,
  };

  process.stdout.write(`\nSpec skeleton (edit the ranges, then --spec it):\n\n`);
  process.stdout.write(`${JSON.stringify(skeleton, null, 2)}\n`);
  process.stdout.write(
    `\nRanges are prefilled from the script's declared minval/maxval where present; ` +
      `where absent they bracket the default and are a guess you should replace.\n`,
  );
}

function suggestMin(defval: unknown): number {
  const d = typeof defval === 'number' ? defval : 10;
  return Math.max(1, Math.round(d / 2));
}

function suggestMax(defval: unknown): number {
  const d = typeof defval === 'number' ? defval : 10;
  return Math.max(2, Math.round(d * 2));
}

function printReport(report: Awaited<ReturnType<typeof optimizeRun>>): void {
  const r = report.result;

  process.stdout.write(
    `\n  ${String(report.estimate.totalRuns)} runs on ${String(report.estimate.threads)} threads, ` +
      `estimated ${(report.estimate.estimatedMs / 1000).toFixed(1)}s, actual ` +
      `${(report.elapsedMs / 1000).toFixed(1)}s\n`,
  );
  process.stdout.write(
    `  grid ${String(r.gridSize)} combination(s), ran ${String(r.combinationsRun)}` +
      `${r.sampled ? ' (sampled)' : ''}\n\n`,
  );

  process.stdout.write(`  ${r.verdict.toUpperCase()}  ${r.explanation}\n\n`);

  for (const f of r.folds) {
    if (!f.assessable) {
      process.stdout.write(`  fold ${String(f.index)}: no winner met the trade floor\n`);
      continue;
    }
    const params = Object.entries(f.winner ?? {})
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(' ');
    process.stdout.write(
      `  fold ${String(f.index)}: ${params.padEnd(28)} IS ${(f.inSample?.returnPct ?? 0).toFixed(2)}% ` +
        `-> OOS ${(f.outOfSample?.returnPct ?? 0).toFixed(2)}%  ` +
        `WFE ${f.wfe === null ? 'n/a' : f.wfe.toFixed(2)}${f.wfeStable ? '' : ' (unstable)'}\n`,
    );
  }

  process.stdout.write(`\n  stitched out-of-sample equity:\n`);
  for (const p of r.stitchedEquity) {
    process.stdout.write(
      `    after fold ${String(p.foldIndex)}: ${p.cumulativeReturnPct.toFixed(2)}%\n`,
    );
  }

  process.stdout.write(`\n  parameter drift:\n`);
  for (const d of r.drift) {
    process.stdout.write(
      `    ${d.name.padEnd(20)} ${d.values.join(' -> ').padEnd(24)} ` +
        `mean step ${(d.meanStepFraction * 100).toFixed(0)}% of range, ` +
        `${String(d.distinctValues)} distinct\n`,
    );
  }

  if (r.sensitivity !== null) printHeatmap(r.sensitivity);
}

function printHeatmap(grid: NonNullable<WfGrid>): void {
  const as = [...new Set(grid.cells.map((c) => c.a))].sort((x, y) => x - y);
  const bs = [...new Set(grid.cells.map((c) => c.b))].sort((x, y) => x - y);
  const values = grid.cells.map((c) => c.value).filter((v): v is number => v !== null);
  if (values.length === 0) return;

  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // Five buckets is enough to see a plateau from a spike and no more than a terminal can show.
  const shades = [' ', '.', ':', '+', '#'];

  process.stdout.write(
    `\n  sensitivity (${grid.inputA} x ${grid.inputB}, ${grid.objective}` +
      `${grid.collapsed ? ', third axis collapsed to its best' : ''}):\n`,
  );
  process.stdout.write(`    ${''.padEnd(8)}${bs.map((b) => String(b).padStart(6)).join('')}\n`);

  for (const a of as) {
    const row = bs.map((b) => {
      const cell = grid.cells.find((c) => c.a === a && c.b === b);
      if (cell?.value == null) return '     ?';
      const t = hi === lo ? 1 : (cell.value - lo) / (hi - lo);
      return `     ${shades[Math.min(shades.length - 1, Math.floor(t * shades.length))]!}`;
    });
    process.stdout.write(`    ${String(a).padEnd(8)}${row.join('')}\n`);
  }
  process.stdout.write(
    `    low ${lo.toFixed(0)} "${shades[0]!}" .. high ${hi.toFixed(0)} "${shades[4]!}"\n`,
  );
}

type WfGrid = Awaited<ReturnType<typeof optimizeRun>>['result']['sensitivity'];

main().catch((error: unknown) => {
  process.stderr.write(`optimize failed: ${String(error)}\n`);
  process.exitCode = 1;
});
