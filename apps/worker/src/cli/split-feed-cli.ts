import {
  createDbClient,
  findSymbolByCode,
  moveSourceToFeedSymbol,
  sourcesInRange,
} from '@edgelab/db';
import { loadDotEnvFile, loadEnv } from '@edgelab/shared/config';

/**
 * Move one feed's bars out of a symbol's series into their own dataset.
 *
 *   pnpm run data:split-feed EURUSD twelvedata [feedTag]
 *
 * Explicit tooling rather than a migration, deliberately. Which feeds are mixed depends on what a
 * given machine happened to ingest, so a migration would either guess or hard-code one person's
 * accident. This names the symbol and the source and does exactly that.
 *
 * Nothing is deleted: the rows move to `<symbol>.<feed>`, which keeps two feeds comparable on
 * purpose instead of silently interleaved.
 */

async function main(): Promise<void> {
  const [symbol, source, feedTag] = process.argv.slice(2);

  if (symbol === undefined || source === undefined) {
    process.stderr.write(
      'usage: pnpm run data:split-feed <symbol> <source> [feedTag]\n' +
        '  e.g. pnpm run data:split-feed EURUSD twelvedata\n',
    );
    process.exitCode = 1;
    return;
  }

  loadDotEnvFile();
  const env = loadEnv(process.env);
  const db = createDbClient(env.DATABASE_URL, { max: 4 });

  try {
    const row = await findSymbolByCode(db, symbol);
    if (row === null) {
      process.stderr.write(`No symbol "${symbol}".\n`);
      process.exitCode = 1;
      return;
    }

    // Whole history, so the caller does not have to know where the contamination sits.
    const before = await sourcesInRange(db, row.id, 0, Date.now() + 86_400_000);
    process.stdout.write(`${symbol} currently holds:\n`);
    for (const s of before) {
      process.stdout.write(
        `  ${s.source.padEnd(12)} ${String(s.bars).padStart(8)} bars  ` +
          `${new Date(s.firstMs).toISOString().slice(0, 10)} .. ` +
          `${new Date(s.lastMs).toISOString().slice(0, 10)}\n`,
      );
    }

    if (!before.some((s) => s.source === source)) {
      process.stdout.write(`\nNothing to move: no "${source}" bars under ${symbol}.\n`);
      return;
    }
    if (before.length === 1) {
      process.stdout.write(
        `\nRefusing: "${source}" is the ONLY feed under ${symbol}, so moving it would leave the ` +
          'canonical series empty. Rename the symbol instead if that is what you want.\n',
      );
      process.exitCode = 1;
      return;
    }

    const result = await moveSourceToFeedSymbol(db, {
      baseCode: symbol,
      source,
      ...(feedTag === undefined ? {} : { feed: feedTag }),
    });

    process.stdout.write(`\nmoved ${String(result.moved)} bars to ${result.targetCode}\n`);

    const after = await sourcesInRange(db, row.id, 0, Date.now() + 86_400_000);
    process.stdout.write(`${symbol} now holds: ${after.map((s) => s.source).join(', ')}\n`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`split-feed failed: ${String(error)}\n`);
  process.exitCode = 1;
});
