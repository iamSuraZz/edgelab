import { describe, expect, it, vi } from 'vitest';

import { MixedFeedError, assertSingleFeed } from './feed-guard';

/**
 * The one-series-one-feed guard (A6).
 *
 * Fakes the DB the same way `ingest.resume.test.ts` does — what is being tested is the policy and
 * the message, neither of which needs a database.
 */

const T0 = Date.UTC(2024, 0, 1);
const DAY = 86_400_000;

function dbWith(
  spans: readonly { source: string; bars: number; firstMs: number; lastMs: number }[],
): Parameters<typeof assertSingleFeed>[0]['db'] {
  return {
    pool: {
      query: vi.fn(() =>
        Promise.resolve({
          rows: spans.map((s) => ({
            source: s.source,
            bars: String(s.bars),
            first: new Date(s.firstMs),
            last: new Date(s.lastMs),
          })),
        }),
      ),
    },
  } as unknown as Parameters<typeof assertSingleFeed>[0]['db'];
}

const base = { symbolId: 'sym-1', symbolCode: 'EURUSD', fromMs: T0, toMs: T0 + 30 * DAY };

describe('assertSingleFeed', () => {
  it('returns the source when one feed covers the range', async () => {
    const db = dbWith([{ source: 'dukascopy', bars: 30_000, firstMs: T0, lastMs: T0 + 29 * DAY }]);

    await expect(assertSingleFeed({ db, ...base })).resolves.toBe('dukascopy');
  });

  it('refuses a range spanning two feeds', async () => {
    const db = dbWith([
      { source: 'dukascopy', bars: 18_652, firstMs: T0, lastMs: T0 + 15 * DAY },
      { source: 'twelvedata', bars: 6_238, firstMs: T0 + 16 * DAY, lastMs: T0 + 22 * DAY },
    ]);

    await expect(assertSingleFeed({ db, ...base })).rejects.toThrow(MixedFeedError);
  });

  it('names both feeds, their sizes and their spans', async () => {
    // The message is the product here: "mixed sources" alone tells nobody which range to re-ingest
    // or which dataset to run instead.
    const db = dbWith([
      {
        source: 'dukascopy',
        bars: 18_652,
        firstMs: Date.UTC(2024, 0, 15),
        lastMs: Date.UTC(2024, 0, 31),
      },
      {
        source: 'twelvedata',
        bars: 6_238,
        firstMs: Date.UTC(2024, 1, 1),
        lastMs: Date.UTC(2024, 1, 7),
      },
    ]);

    const error = await assertSingleFeed({ db, ...base }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MixedFeedError);
    const message = (error as Error).message;
    expect(message).toContain('dukascopy (18652 bars, 2024-01-15 .. 2024-01-31)');
    expect(message).toContain('twelvedata (6238 bars, 2024-02-01 .. 2024-02-07)');
    expect(message).toContain('EURUSD.<feed>');
  });

  it('tags the failure in `cause` so it survives the worker thread', async () => {
    // Structured clone drops own properties and normalises `name`, so an untagged refusal reaches
    // the user as "your script has a bug".
    const db = dbWith([
      { source: 'a', bars: 1, firstMs: T0, lastMs: T0 },
      { source: 'b', bars: 1, firstMs: T0 + DAY, lastMs: T0 + DAY },
    ]);

    const error = (await assertSingleFeed({ db, ...base }).catch((e: unknown) => e)) as Error;

    expect(error.cause).toEqual({ edgelabCode: 'validation-failed' });
    expect(structuredClone(error).cause).toEqual({ edgelabCode: 'validation-failed' });
  });

  it('stays silent on an empty range, which has its own better error', async () => {
    // "No data at all" is reported elsewhere with the stored coverage named. Duplicating it here
    // would shadow a specific message with a vaguer one.
    await expect(assertSingleFeed({ db: dbWith([]), ...base })).resolves.toBeNull();
  });

  it('asks about the REQUESTED range, not a padded one', async () => {
    const db = dbWith([{ source: 'dukascopy', bars: 10, firstMs: T0, lastMs: T0 + DAY }]);
    const queried = db as unknown as { pool: { query: ReturnType<typeof vi.fn> } };

    await assertSingleFeed({ db, ...base });

    // Warmup padding differs between the three run paths; guarding the loaded window would refuse
    // different ranges depending on which entry point was used.
    const [, params] = queried.pool.query.mock.calls[0] as [string, unknown[]];
    expect(Number(params[1])).toBe(base.fromMs);
    expect(Number(params[2])).toBe(base.toMs);
  });
});
