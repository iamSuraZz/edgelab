import {
  bumpDataVersion,
  copyBarsIgnoreDuplicates,
  createDbClient,
  findSymbolByCode,
  sourcesInRange,
} from '@edgelab/db';
import { syntheticM1 } from '@edgelab/data';
import { loadDotEnvFile, loadEnv } from '@edgelab/shared/config';

/**
 * Seed deterministic synthetic bars.
 *
 *   pnpm run data:seed-synthetic EURUSD 2024-01-01 2024-02-01
 *
 * For CI, which must run the full e2e and smoke suites without calling a provider — Dukascopy is
 * rate-limiting us outright and Twelve Data's free tier is 800 requests a day that a per-push job
 * would exhaust. Also usable locally on a fresh database.
 *
 * Stored under the source `synthetic`, which makes it visible for what it is in coverage and, more
 * importantly, makes it subject to the one-feed rule (A6): seeding into a symbol that already holds
 * real bars for the range would create a mixed series and every run over it would be refused. So
 * this refuses first, rather than corrupting a series and letting the guard explain it later.
 */

const SOURCE = 'synthetic';

function parseDate(value: string, label: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`${label} is not a date: ${value}`);
  return ms;
}

async function main(): Promise<void> {
  const [symbolCode, fromIso, toIso] = process.argv.slice(2);

  if (symbolCode === undefined || fromIso === undefined || toIso === undefined) {
    process.stderr.write(
      'usage: pnpm run data:seed-synthetic <SYMBOL> <fromISO> <toISO>\n' +
        '  e.g. pnpm run data:seed-synthetic EURUSD 2024-01-01 2024-02-01\n',
    );
    process.exitCode = 1;
    return;
  }

  loadDotEnvFile();
  const env = loadEnv(process.env);
  const db = createDbClient(env.DATABASE_URL, { max: 4 });

  const fromMs = parseDate(fromIso, 'from');
  const toMs = parseDate(toIso, 'to');

  try {
    const symbol = await findSymbolByCode(db, symbolCode);
    if (symbol === null)
      throw new Error(`No symbol "${symbolCode}". Run \`pnpm db:migrate\` first.`);

    const existing = await sourcesInRange(db, symbol.id, fromMs, toMs);
    const foreign = existing.filter((s) => s.source !== SOURCE);
    if (foreign.length > 0) {
      process.stderr.write(
        `Refusing: ${symbolCode} already holds ${foreign.map((s) => s.source).join(', ')} bars in ` +
          `this range. Mixing feeds is what A6 forbids — every run over the join would be refused. ` +
          `Seed a fresh database, or pick a range this symbol does not cover.\n`,
      );
      process.exitCode = 1;
      return;
    }

    const bars = syntheticM1({
      fromMs,
      toMs,
      basePrice: 1.1,
      mintick: symbol.mintick,
      // A realistic 3 points, deliberately NOT EURUSD's 8-point default, so a run that silently
      // falls back to the default is distinguishable from one that read the stored spread.
      spread: symbol.mintick * 3,
    });

    const result = await copyBarsIgnoreDuplicates(db, {
      symbolId: symbol.id,
      source: SOURCE,
      bars,
    });

    if (result.inserted > 0) await bumpDataVersion(db, symbol.id);

    process.stdout.write(
      `seeded ${String(result.inserted)} synthetic bars into ${symbol.symbol} ` +
        `(${fromIso} .. ${toIso}), ${String(result.duplicates)} already present\n`,
    );
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`seed-synthetic failed: ${String(error)}\n`);
  process.exitCode = 1;
});
