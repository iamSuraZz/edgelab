import {
  contiguousEndWithin,
  createDbClient,
  finishIngestAttempt,
  findSymbolByCode,
  recentIngestAttempts,
  startIngestAttempt,
  updateIngestAttempt,
} from '@edgelab/db';
import { RateLimitExhaustedError } from '@edgelab/data';
import { Redis } from 'ioredis';

import { loadDotEnvFile, loadEnv } from '@edgelab/shared/config';

import { buildProviderRegistry } from '../ingest/providers';
import { runIngest } from '../ingest/ingest';

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
 * SCHEDULING is deliberately left outside the process. A cron entry or a Task Scheduler job calling
 * this command is inspectable, kills cleanly and survives a deploy; an in-process timer needs the
 * worker to be up all night and hides its own state. One line, e.g.:
 *
 *   17 3 * * *  cd /srv/edgelab && pnpm backfill EURUSD dukascopy 2022-01-01 2024-02-01 >> backfill.log 2>&1
 */

/**
 * Nightly pacing. Roughly 20 seconds between months and 8 between the bid and ask halves of one.
 *
 * Two years is 24 months, so ~8 minutes of deliberate waiting across a job that already spends
 * minutes downloading. That is a trade a scheduled job can afford and an interactive one cannot,
 * which is exactly why this is a separate command from `pnpm ingest`.
 */
const NIGHTLY_PACING = {
  pauseBetweenMonthsMs: 20_000,
  pauseBetweenBatchesMs: 8_000,
  // Fewer than the interactive default: pacing should mean we rarely get here, and when we do the
  // right answer is to stop for the night rather than sit in a five-minute ladder.
  rateLimitRetries: 3,
} as const;

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

  let attemptId: string | null = null;
  let barsWritten = 0;

  try {
    const symbol = await findSymbolByCode(db, symbolCode);
    if (symbol === null) throw new Error(`No symbol "${symbolCode}".`);

    // Where the last attempt left off, printed before doing anything so the log is answerable
    // about progress even if tonight's run achieves nothing.
    const before = await contiguousEndWithin(db, symbol.id, fromMs, toMs, 4 * 86_400_000);
    process.stdout.write(
      before === null
        ? `nothing stored in range yet; starting at ${fromIso}\n`
        : `contiguous through ${new Date(before.last).toISOString().slice(0, 10)}; resuming there\n`,
    );

    const history = await recentIngestAttempts(db, symbol.id, 3);
    for (const h of history) {
      process.stdout.write(
        `  last: ${h.state.padEnd(13)} ${String(h.barsWritten).padStart(7)} bars  ${h.message}\n`,
      );
    }

    const registry = buildProviderRegistry(env, redis, { dukascopy: NIGHTLY_PACING });

    attemptId = await startIngestAttempt(db, {
      symbolId: symbol.id,
      provider,
      fromMs,
      toMs,
    });

    let lastMessage = '';
    const result = await runIngest(
      db,
      registry,
      { symbol, provider: provider as Parameters<typeof runIngest>[2]['provider'], fromMs, toMs },
      async (p) => {
        barsWritten = p.barsWritten;
        if (p.message === lastMessage) return;
        lastMessage = p.message;
        process.stdout.write(`[${String(p.percent).padStart(3)}%] ${p.message}\n`);
        await updateIngestAttempt(db, attemptId!, {
          percent: p.percent,
          message: p.message,
          barsWritten: p.barsWritten,
        });
      },
    );

    const done = result.effectiveFrom >= toMs || result.barsInserted === 0;
    await finishIngestAttempt(db, attemptId, {
      state: 'completed',
      barsWritten: result.barsInserted,
      message: done
        ? `range complete (${String(result.barsInserted)} new bars)`
        : `${String(result.barsInserted)} new bars`,
    });

    process.stdout.write(`\ncompleted: ${String(result.barsInserted)} new bars\n`);
  } catch (error: unknown) {
    // The expected outcome on a throttled night, and NOT a failure.
    if (error instanceof RateLimitExhaustedError) {
      if (attemptId !== null) {
        await finishIngestAttempt(db, attemptId, {
          state: 'rate-limited',
          barsWritten,
          message: `stopped at ${new Date(error.reachedMs).toISOString().slice(0, 10)}; resumes next run`,
        });
      }
      process.stdout.write(`\n${error.message}\n`);
      process.stdout.write(`kept ${String(barsWritten)} bars from this attempt.\n`);
      // Exit ZERO: a scheduled job that reports failure for "come back later" gets muted.
      return;
    }

    if (attemptId !== null) {
      await finishIngestAttempt(db, attemptId, {
        state: 'failed',
        barsWritten,
        message: 'failed',
        error: String(error),
      });
    }
    process.stderr.write(`backfill failed: ${String(error)}\n`);
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
