import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDbClient } from './client';
import { loadLocalEnv, requireDatabaseUrl } from './env-file';
import { seedSymbols } from './seed';
import { describeCompression, setupTimescale } from './timescale';

/**
 * Applies Drizzle migrations, then the Timescale setup and symbol seed that migrations
 * cannot express. Every step is idempotent, so this is safe to re-run.
 */
async function main(): Promise<void> {
  loadLocalEnv();
  const migrationsFolder = path.resolve(__dirname, '..', 'drizzle');

  if (!existsSync(migrationsFolder)) {
    throw new Error(
      `No migrations found at ${migrationsFolder}. Generate them first:\n` + `  pnpm db:generate`,
    );
  }

  const client = createDbClient(requireDatabaseUrl(), { max: 1, statementTimeoutMs: 600_000 });

  try {
    await migrate(client.db, { migrationsFolder });
    console.log('drizzle migrations applied');

    const timescale = await setupTimescale(client);
    console.log(
      `timescale: hypertable ${timescale.hypertableCreated ? 'created' : 'already present'}, ` +
        `compression ${timescale.compressionConfigured ? 'configured' : 'already configured'}, ` +
        `policy ${timescale.policyJobId === null ? 'already present' : `job ${String(timescale.policyJobId)}`}`,
    );

    const seed = await seedSymbols(client);
    console.log(
      `symbols: ${String(seed.inserted)} inserted, ${String(seed.existing)} already present`,
    );

    const report = await describeCompression(client);
    console.log(
      `compression: segmentby=[${report.segmentBy.join(',')}] orderby=[${report.orderBy.join(',')}] ` +
        `policies=${String(report.policyJobs)} chunks=${String(report.chunkCount)}`,
    );

    // Assert rather than trust: a mis-specified segmentby is only a WARNING in Postgres.
    if (!report.segmentBy.includes('symbol_id')) {
      throw new Error('compression segmentby is not symbol_id — conflicting inserts would be slow');
    }
  } finally {
    await client.close();
  }
}

main()
  .then(() => {
    console.log('migrate: done');
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error('migrate: failed');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
