import { createDbClient, findSymbolByCode, recentIngestAttempts } from '@edgelab/db';
import { Redis } from 'ioredis';

import { loadDotEnvFile, loadEnv } from '@edgelab/shared/config';

import { runBackfill } from '../ingest/backfill';

/**
 * The nightly backfill.
 *
 *   pnpm backfill EURUSD dukascopy 2022-01-01 2024-02-01
 *
 * Designed to be run repeatedly on a schedule and to make progress each time, rather than to
 * finish in one go. Three properties make that work:
 *
 *  1. **Paced below the limit, not backed off after hitting it.** Three attempts at this backfill
 *     died on HTTP 429 through the full six-step backoff ladder. Backoff is reactive: by the time
 *     it fires, the connection is already being throttled. So the pauses here are long by
 *     construction — a nightly job has all night.
 *
 *  2. **A persistent 429 is a clean stop, not a failure.** It exits zero, records `rate-limited`
 *     with the cursor it reached, and says when to come back. An operator who sees red every
 *     morning stops reading the mail.
 *
 *  3. **Resumable.** `runIngest` advances the cursor to the end of the contiguous run covering the
 *     requested start — verified on real data, including the case where an earlier attempt left a
 *     hole in the middle.
 *
 * SCHEDULING now lives INSIDE the worker as a repeatable job (A68), which reverses what this file
 * used to argue. The old reasoning — a cron entry is inspectable and survives a deploy — assumed a
 * laptop; on a server that runs around the clock the worker is already up, and a host cron entry
 * would be invisible to this repo. This command remains the way to run one attempt by hand.
 */

function parseDate(value: string, label: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`${label} is not a date: ${value}`);
  return ms;
}

async function main(): Promise<void> {
  const [symbolCode, provider, fromIso, toIso] = process.argv.slice(2);

  if (
    symbolCode === undefined ||
    provider === undefined ||
    fromIso === undefined ||
    toIso === undefined
  ) {
    process.stderr.write(
      'usage: pnpm backfill <SYMBOL> <provider> <fromISO> <toISO>\n' +
        '  e.g. pnpm backfill EURUSD dukascopy 2022-01-01 2024-02-01\n',
    );
    process.exitCode = 1;
    return;
  }

  loadDotEnvFile();
  const env = loadEnv(process.env);
  const db = createDbClient(env.DATABASE_URL, { max: 4 });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const fromMs = parseDate(fromIso, 'from');
  const toMs = parseDate(toIso, 'to');

  try {
    const history = await recentIngestAttempts(
      db,
      (await findSymbolByCode(db, symbolCode))?.id ?? '',
      3,
    );
    for (const h of history) {
      process.stdout.write(
        `  last: ${h.state.padEnd(13)} ${String(h.barsWritten).padStart(7)} bars  ${h.message}
`,
      );
    }

    const outcome = await runBackfill(
      { symbolCode, provider, fromMs, toMs },
      {
        db,
        redis,
        env,
        log: (line) =>
          process.stdout.write(`${line}
`),
      },
    );

    // Exit ZERO on a throttled night: a scheduled job that reports failure for "come back later"
    // gets muted, and the attempt is already recorded as `rate-limited` for the Data page.
    if (outcome.state === 'rate-limited') return;
  } catch (error: unknown) {
    process.stderr.write(`backfill failed: ${String(error)}
`);
    process.exitCode = 1;
  } finally {
    await db.close();
    await redis.quit().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`backfill failed: ${String(error)}\n`);
  process.exitCode = 1;
});
