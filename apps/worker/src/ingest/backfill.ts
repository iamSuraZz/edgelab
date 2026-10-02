import {
  blockedNotice,
  contiguousEndWithin,
  findSymbolByCode,
  finishIngestAttempt,
  rateLimitStreak,
  startIngestAttempt,
  updateIngestAttempt,
  type DbClient,
} from '@edgelab/db';
import { RateLimitExhaustedError } from '@edgelab/data';
import type { Env } from '@edgelab/shared/config';
import type Redis from 'ioredis';

import { buildProviderRegistry } from './providers';
import { runIngest } from './ingest';

/**
 * One backfill attempt, shared by the CLI and the scheduled job.
 *
 * Extracted so the two cannot drift. The properties that make a nightly backfill work are all in
 * here rather than in either caller:
 *
 *  1. **Paced below the limit, not backed off after hitting it.** Three attempts died on HTTP 429
 *     through a six-step backoff ladder. Backoff is reactive — by the time it fires the connection
 *     is already throttled — so the pauses are long by construction. A nightly job has all night.
 *  2. **A persistent 429 is a clean stop, not a failure.** It records `rate-limited` with the cursor
 *     it reached and reports when to come back. Red every morning gets muted.
 *  3. **Resumable.** `runIngest` advances to the end of the contiguous run covering the requested
 *     start, including the case where an earlier attempt left a hole in the middle.
 */

/** Roughly 20s between months and 8s between the bid and ask halves of one. */
export const NIGHTLY_PACING = {
  pauseBetweenMonthsMs: 20_000,
  pauseBetweenBatchesMs: 8_000,
  /**
   * Fewer than the interactive default: pacing should mean we rarely get here, and when we do the
   * right answer is to stop for the night rather than sit in a five-minute ladder.
   */
  rateLimitRetries: 3,
} as const;

export type BackfillState = 'completed' | 'rate-limited' | 'failed';

export interface BackfillOutcome {
  readonly state: BackfillState;
  readonly barsWritten: number;
  readonly message: string;
  /** True when the requested range is fully stored, so tonight's run had nothing left to do. */
  readonly rangeComplete: boolean;
}

export interface BackfillTarget {
  readonly symbolCode: string;
  readonly provider: string;
  readonly fromMs: number;
  readonly toMs: number;
}

export interface BackfillDeps {
  readonly db: DbClient;
  readonly redis: Redis;
  readonly env: Env;
  /** Where progress goes: stdout for the CLI, the job log for the scheduled run. */
  readonly log: (line: string) => void;
}

export async function runBackfill(
  target: BackfillTarget,
  deps: BackfillDeps,
): Promise<BackfillOutcome> {
  const { db, redis, env, log } = deps;
  const { symbolCode, provider, fromMs, toMs } = target;

  const symbol = await findSymbolByCode(db, symbolCode);
  if (symbol === null) throw new Error(`No symbol "${symbolCode}".`);

  // Where the last attempt left off, reported BEFORE doing anything, so the log is answerable
  // about progress even if tonight achieves nothing.
  const before = await contiguousEndWithin(db, symbol.id, fromMs, toMs, 4 * 86_400_000);
  log(
    before === null
      ? `nothing stored in range yet; starting at ${iso(fromMs)}`
      : `contiguous through ${iso(before.last)}; resuming there`,
  );

  // A STREAK of refusals is different information from one refusal (A11), and reported up front so
  // it shows even on a night that fails immediately.
  const notice = blockedNotice(provider, await rateLimitStreak(db, symbol.id, provider));
  if (notice !== null) log(`!! ${notice}`);

  const registry = buildProviderRegistry(env, redis, { dukascopy: NIGHTLY_PACING });

  const attemptId = await startIngestAttempt(db, {
    symbolId: symbol.id,
    provider,
    fromMs,
    toMs,
  });

  let barsWritten = 0;
  let lastMessage = '';

  try {
    const result = await runIngest(
      db,
      registry,
      { symbol, provider: provider as Parameters<typeof runIngest>[2]['provider'], fromMs, toMs },
      async (p) => {
        barsWritten = p.barsWritten;
        if (p.message === lastMessage) return;
        lastMessage = p.message;
        log(`[${String(p.percent).padStart(3)}%] ${p.message}`);
        await updateIngestAttempt(db, attemptId, {
          percent: p.percent,
          message: p.message,
          barsWritten: p.barsWritten,
        });
      },
    );

    const rangeComplete = result.effectiveFrom >= toMs || result.barsInserted === 0;
    const message = rangeComplete
      ? `range complete (${String(result.barsInserted)} new bars)`
      : `${String(result.barsInserted)} new bars`;

    await finishIngestAttempt(db, attemptId, {
      state: 'completed',
      barsWritten: result.barsInserted,
      message,
    });

    log(`completed: ${String(result.barsInserted)} new bars`);
    return { state: 'completed', barsWritten: result.barsInserted, message, rangeComplete };
  } catch (error: unknown) {
    // The EXPECTED outcome on a throttled night, and not a failure.
    if (error instanceof RateLimitExhaustedError) {
      const message = `stopped at ${iso(error.reachedMs)}; resumes next run`;
      await finishIngestAttempt(db, attemptId, {
        state: 'rate-limited',
        barsWritten,
        message,
      });
      log(error.message);
      log(`kept ${String(barsWritten)} bars from this attempt.`);
      return { state: 'rate-limited', barsWritten, message, rangeComplete: false };
    }

    await finishIngestAttempt(db, attemptId, {
      state: 'failed',
      barsWritten,
      message: 'failed',
      error: String(error),
    });
    throw error;
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Parse the scheduled targets from an environment variable.
 *
 *   BACKFILL_TARGETS="EURUSD:dukascopy:2022-01-01:2024-02-01,USDJPY:dukascopy:2024-01-01:2024-02-01"
 *
 * Empty means NO scheduled backfill, which is the default: a server that silently started hitting a
 * provider because it was deployed would be worse than one that needs a variable set. Every parse
 * failure throws with the offending entry, because a typo that disables the night's work quietly is
 * the whole problem with scheduled jobs.
 */
export function parseBackfillTargets(raw: string): BackfillTarget[] {
  if (raw.trim() === '') return [];

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const parts = entry.split(':');
      if (parts.length !== 4) {
        throw new Error(
          `BACKFILL_TARGETS entry "${entry}" is not SYMBOL:provider:fromISO:toISO ` +
            '(e.g. EURUSD:dukascopy:2022-01-01:2024-02-01).',
        );
      }

      const [symbolCode, provider, fromIso, toIso] = parts as [string, string, string, string];
      const fromMs = Date.parse(fromIso);
      const toMs = Date.parse(toIso);

      if (Number.isNaN(fromMs)) throw new Error(`BACKFILL_TARGETS "${entry}": bad from date.`);
      if (Number.isNaN(toMs)) throw new Error(`BACKFILL_TARGETS "${entry}": bad to date.`);
      if (!(fromMs < toMs)) throw new Error(`BACKFILL_TARGETS "${entry}": from is not before to.`);

      return { symbolCode, provider, fromMs, toMs };
    });
}
