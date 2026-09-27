import process from 'node:process';
import {
  bumpDataVersion,
  copyBarsIgnoreDuplicates,
  createDbClient,
  findSymbolByCode,
} from '@edgelab/db';
import { streamExnessZip, streamMt5Csv } from '@edgelab/data';
import { loadDotEnvFile, loadEnv } from '@edgelab/shared/config';

/**
 * Import a local file, without going through the upload endpoint.
 *
 *   pnpm import mt5 <SYMBOL> <file.csv> <serverUtcOffsetMinutes>
 *   pnpm import exness <SYMBOL> <file.zip>
 *
 * The MT5 offset is required and has no default on purpose: guessing it silently shifts
 * every bar in the file.
 */
async function main(): Promise<void> {
  const [kind, symbolCode, filePath, offsetArg] = process.argv.slice(2);

  if (kind === undefined || symbolCode === undefined || filePath === undefined) {
    console.error('usage: pnpm import mt5 <SYMBOL> <file.csv> <serverUtcOffsetMinutes>');
    console.error('       pnpm import exness <SYMBOL> <file.zip>');
    process.exit(2);
    return;
  }

  loadDotEnvFile();
  const env = loadEnv(process.env);
  const db = createDbClient(env.DATABASE_URL, { max: 2, statementTimeoutMs: 600_000 });

  try {
    const symbol = await findSymbolByCode(db, symbolCode);
    if (symbol === null) throw new Error(`Unknown symbol ${symbolCode}`);

    let inserted = 0;
    let duplicates = 0;
    let batches = 0;

    const store = async (bars: Parameters<typeof copyBarsIgnoreDuplicates>[1]['bars']) => {
      const result = await copyBarsIgnoreDuplicates(db, {
        symbolId: symbol.id,
        source: kind === 'mt5' ? 'mt5-csv' : 'exness-ticks',
        bars,
      });
      inserted += result.inserted;
      duplicates += result.duplicates;
      batches += 1;
      console.log(
        `  batch ${String(batches)}: +${String(result.inserted)} new, ${String(result.duplicates)} dup`,
      );
    };

    if (kind === 'mt5') {
      if (offsetArg === undefined) {
        throw new Error('MT5 import needs the broker server UTC offset in minutes (e.g. 120)');
      }
      const serverUtcOffsetMinutes = Number(offsetArg);
      if (!Number.isInteger(serverUtcOffsetMinutes)) {
        throw new Error(`Bad offset: ${offsetArg}`);
      }

      console.log(`importing MT5 bars for ${symbol.symbol} (server offset ${offsetArg} min)`);
      const stats = await streamMt5Csv(
        filePath,
        { serverUtcOffsetMinutes, mintick: symbol.mintick },
        store,
      );
      console.log(
        `rows=${String(stats.rows)} parsed=${String(stats.bars)} malformed=${String(stats.malformed)}`,
      );
    } else if (kind === 'exness') {
      console.log(`importing Exness ticks for ${symbol.symbol}`);
      const stats = await streamExnessZip(filePath, {}, store);
      console.log(
        `entries=${String(stats.entries)} ticks=${String(stats.ticks)} ` +
          `bars=${String(stats.bars)} malformed=${String(stats.malformed)}`,
      );
    } else {
      throw new Error(`Unknown import kind: ${kind} (expected mt5 or exness)`);
    }

    if (inserted > 0) {
      const version = await bumpDataVersion(db, symbol.id);
      console.log(`data version -> ${String(version)}`);
    }

    console.log(`\ninserted ${String(inserted)} bars, ${String(duplicates)} were already stored`);
  } finally {
    await db.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('import failed:', err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
