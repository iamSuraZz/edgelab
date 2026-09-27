import process from 'node:process';
import { Redis } from 'ioredis';
import { createDbClient, findSymbolByCode } from '@edgelab/db';
import { loadDotEnvFile, loadEnv } from '@edgelab/shared/config';
import type { ProviderId } from '@edgelab/shared';
import { buildProviderRegistry } from '../ingest/providers';
import { runIngest } from '../ingest/ingest';

/**
 * Direct ingest, without going through the queue.
 *
 *   pnpm ingest <SYMBOL> <provider> <fromISO> <toISO> [--force]
 *   pnpm ingest EURUSD dukascopy 2024-01-01 2024-04-01
 *
 * Useful for backfills that would otherwise tie up a queue slot for an hour, and for
 * verifying a provider without the UI.
 */
async function main(): Promise<void> {
  const [symbolCode, providerId, fromIso, toIso, ...flags] = process.argv.slice(2);

  if (
    symbolCode === undefined ||
    providerId === undefined ||
    fromIso === undefined ||
    toIso === undefined
  ) {
    console.error('usage: pnpm ingest <SYMBOL> <provider> <fromISO> <toISO> [--force]');
    process.exit(2);
    return;
  }

  const fromMs = Date.parse(`${fromIso}T00:00:00Z`.slice(0, 24));
  const toMs = Date.parse(`${toIso}T00:00:00Z`.slice(0, 24));
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    throw new Error(`Could not parse dates: ${fromIso} .. ${toIso}`);
  }
  if (toMs <= fromMs) throw new Error('to must be after from');

  loadDotEnvFile();
  const env = loadEnv(process.env);

  const db = createDbClient(env.DATABASE_URL, { max: 4, statementTimeoutMs: 600_000 });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  try {
    const symbol = await findSymbolByCode(db, symbolCode);
    if (symbol === null) throw new Error(`Unknown symbol ${symbolCode}; is the registry seeded?`);

    const registry = buildProviderRegistry(env, redis);

    const startedAt = Date.now();
    let lastLine = '';

    const result = await runIngest(
      db,
      registry,
      {
        symbol,
        provider: providerId as ProviderId,
        fromMs,
        toMs,
        force: flags.includes('--force'),
      },
      (p) => {
        const line = `[${String(p.percent).padStart(3)}%] ${p.message}`;
        if (line !== lastLine) {
          lastLine = line;
          console.log(line);
        }
      },
    );

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log('');
    console.log(`symbol          ${result.symbol}`);
    console.log(`provider        ${result.provider}`);
    console.log(
      `range           ${new Date(result.effectiveFrom).toISOString()} .. ${new Date(result.toMs).toISOString()}` +
        `${result.resumed ? '  (resumed from stored watermark)' : ''}`,
    );
    console.log(`batches         ${String(result.batches)}`);
    console.log(`bars staged     ${String(result.barsStaged)}`);
    console.log(`bars inserted   ${String(result.barsInserted)}`);
    console.log(`duplicates      ${String(result.duplicates)}`);
    console.log(`data version    ${String(result.dataVersion)}`);
    console.log(`elapsed         ${seconds}s`);
  } finally {
    await db.close();
    redis.disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('ingest failed:', err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
