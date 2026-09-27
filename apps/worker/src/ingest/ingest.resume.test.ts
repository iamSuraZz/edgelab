import { describe, expect, it, vi } from 'vitest';

import { runIngest } from './ingest';
import type { ProviderRegistry } from './providers';

/**
 * The resume watermark.
 *
 * Regression cover for a silent data loss: the cursor used to come from the newest bar stored
 * for the symbol ANYWHERE, so a backfill of an earlier period resolved past its own end, took
 * the "nothing left to do" early return, and reported success having fetched nothing.
 *
 * Everything below fakes the DB and the provider — the rule being tested is which range gets
 * requested, which needs no database to observe.
 */

const SYMBOL = {
  id: 'sym-1',
  symbol: 'EURUSD',
  dataVersion: 3,
} as unknown as Parameters<typeof runIngest>[2]['symbol'];

const DAY = 24 * 60 * 60 * 1_000;
const JAN_2024 = Date.UTC(2024, 0, 1);
const FEB_2024 = Date.UTC(2024, 1, 1);
const JAN_2022 = Date.UTC(2022, 0, 1);

/** Records the window the provider was asked for, and yields nothing. */
function spyProvider(): {
  registry: ProviderRegistry;
  asked: { from: number; to: number }[];
} {
  const asked: { from: number; to: number }[] = [];
  const provider = {
    capabilities: () => ({ enabled: true, label: 'fake' }),
    // Records the window, then yields one empty batch. An empty batch rather than nothing at
    // all because a generator with no `yield` is a lint error, and `runIngest` skips empty
    // batches anyway — this test is about the REQUESTED range, not the data.
    fetchM1: async function* (_s: unknown, from: number, to: number) {
      asked.push({ from, to });
      await Promise.resolve();
      yield [];
    },
  };
  return {
    registry: { get: () => provider } as unknown as ProviderRegistry,
    asked,
  };
}

/** A DB whose stored range within any window is fixed by the caller. */
function fakeDb(stored: { first: number; last: number } | null): {
  db: Parameters<typeof runIngest>[0];
  queries: { from: number; to: number }[];
} {
  const queries: { from: number; to: number }[] = [];
  return {
    db: {
      pool: {
        query: vi.fn((sql: string, params: unknown[]) => {
          if (sql.includes('WITH days AS')) {
            queries.push({ from: Number(params[1]), to: Number(params[2]) });
            return Promise.resolve({
              rows: [
                stored === null
                  ? { first: null, last: null }
                  : { first: new Date(stored.first), last: new Date(stored.last) },
              ],
            });
          }
          return Promise.resolve({ rows: [] });
        }),
      },
    } as unknown as Parameters<typeof runIngest>[0],
    queries,
  };
}

describe('ingest resume watermark', () => {
  it('does NOT skip a backfill that ends before the stored data begins', async () => {
    // The exact shape that lost two years: January 2024 stored, 2022-01-01 -> 2024-02-01 asked.
    const { db } = fakeDb({ first: JAN_2024, last: FEB_2024 - 60_000 });
    const { registry, asked } = spyProvider();

    const result = await runIngest(db, registry, {
      symbol: SYMBOL,
      provider: 'dukascopy',
      fromMs: JAN_2022,
      toMs: FEB_2024,
    });

    expect(result.resumed).toBe(false);
    expect(result.effectiveFrom).toBe(JAN_2022);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.from).toBe(JAN_2022);
  });

  it('still resumes when the stored data reaches the start of the window', async () => {
    // Half of January stored, all of January asked: picking up where it left off is the point.
    const lastStored = JAN_2024 + 15 * DAY;
    const { db } = fakeDb({ first: JAN_2024, last: lastStored });
    const { registry, asked } = spyProvider();

    const result = await runIngest(db, registry, {
      symbol: SYMBOL,
      provider: 'dukascopy',
      fromMs: JAN_2024,
      toMs: FEB_2024,
    });

    expect(result.resumed).toBe(true);
    expect(asked[0]!.from).toBe(lastStored + 60_000);
  });

  it('tolerates a window that opens on a weekend', async () => {
    // Asking from Saturday when the first bar is Monday is not a gap, and re-downloading the
    // whole range every time because of it would make resume useless.
    const saturday = Date.UTC(2024, 0, 6);
    const monday = Date.UTC(2024, 0, 8);
    const lastStored = JAN_2024 + 20 * DAY;
    const { db } = fakeDb({ first: monday, last: lastStored });
    const { registry, asked } = spyProvider();

    const result = await runIngest(db, registry, {
      symbol: SYMBOL,
      provider: 'dukascopy',
      fromMs: saturday,
      toMs: FEB_2024,
    });

    expect(result.resumed).toBe(true);
    expect(asked[0]!.from).toBe(lastStored + 60_000);
  });

  it('starts at the requested point when nothing is stored in the window', async () => {
    const { db } = fakeDb(null);
    const { registry, asked } = spyProvider();

    const result = await runIngest(db, registry, {
      symbol: SYMBOL,
      provider: 'dukascopy',
      fromMs: JAN_2022,
      toMs: FEB_2024,
    });

    expect(result.resumed).toBe(false);
    expect(asked[0]!.from).toBe(JAN_2022);
  });

  it('honours force by ignoring stored data entirely', async () => {
    const { db } = fakeDb({ first: JAN_2024, last: JAN_2024 + 20 * DAY });
    const { registry, asked } = spyProvider();

    const result = await runIngest(db, registry, {
      symbol: SYMBOL,
      provider: 'dukascopy',
      fromMs: JAN_2024,
      toMs: FEB_2024,
      force: true,
    });

    expect(result.resumed).toBe(false);
    expect(asked[0]!.from).toBe(JAN_2024);
  });

  it('only counts data inside the requested window', async () => {
    // The guard must ask about the window, not the whole table — otherwise it is the same bug
    // wearing a different query.
    const { db, queries } = fakeDb({ first: JAN_2024, last: FEB_2024 - 60_000 });
    const { registry } = spyProvider();

    await runIngest(db, registry, {
      symbol: SYMBOL,
      provider: 'dukascopy',
      fromMs: JAN_2022,
      toMs: FEB_2024,
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]).toEqual({ from: JAN_2022, to: FEB_2024 });
  });
});
