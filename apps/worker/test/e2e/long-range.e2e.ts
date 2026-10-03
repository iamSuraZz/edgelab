import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ResampledM1Source,
  countM1InWindow,
  createDbClient,
  findSymbolByCode,
  readM1,
  type DbClient,
} from '@edgelab/db';
import { RunTooLargeError, assertRunFitsMemory } from '@edgelab/shared';
import { loadDotEnvFile, loadEnv } from '@edgelab/shared/config';

/**
 * The long-range regression (A72–A75).
 *
 * Two obligations, pulling in opposite directions:
 *
 *  1. a multi-year M1 series must aggregate and RUN within the limit — the point of the streaming
 *     read, and the thing a check tuned only to refuse would have broken;
 *  2. the same series at M1 must be REFUSED up front, not killed half way through.
 *
 * It uses the EURUSD range the suite already seeds — two years of minutes — rather than generating
 * its own. The first version seeded three years of synthetic 24/7 bars in `beforeAll`, which measured
 * **160s per year** on this machine and failed CI outright: a regression test that costs eight minutes
 * of setup is one that gets deleted. The property under test does not need novel data, only a
 * multi-year span and both read paths to compare.
 *
 * PRECONDITIONS — stated so a failure is diagnosable:
 *   docker compose up -d && pnpm db:migrate
 *   pnpm run data:seed-synthetic EURUSD 2022-01-01 2022-07-01   # or any multi-year coverage
 */

const SYMBOL = 'EURUSD';

let db: DbClient;
let symbolId: string;
let m1Bars: number;
let fromMs: number;
let toMs: number;

beforeAll(async () => {
  loadDotEnvFile();
  const env = loadEnv(process.env);
  db = createDbClient(env.DATABASE_URL, { max: 4, statementTimeoutMs: 600_000 });

  const symbol = await findSymbolByCode(db, SYMBOL);
  expect(symbol, `${SYMBOL} must exist; run \`pnpm db:migrate\``).not.toBeNull();
  symbolId = symbol!.id;

  // Whatever is stored, rather than a hardcoded window: this suite runs against a developer database
  // and against CI's synthetic seed, and the two cover different ranges.
  const span = await db.pool.query<{ first: Date | string; last: Date | string }>(
    `SELECT min(ts) AS first, max(ts) AS last FROM candles_m1 WHERE symbol_id = $1`,
    [symbolId],
  );
  const first = span.rows[0]?.first;
  const last = span.rows[0]?.last;
  expect(first, `no stored ${SYMBOL} bars`).toBeTruthy();

  fromMs = new Date(first!).getTime();
  toMs = new Date(last!).getTime() + 60_000;
  m1Bars = (await countM1InWindow(db, symbolId, fromMs, toMs)).bars;
}, 300_000);

afterAll(async () => {
  await db.pool.end().catch(() => undefined);
});

describe('a multi-year M1 series', () => {
  it('spans more than a year and holds enough minutes to matter', () => {
    const years = (toMs - fromMs) / (365 * 24 * 60 * 60_000);
    expect(years, 'needs a multi-year span to be a long-range test').toBeGreaterThan(1);
    expect(m1Bars).toBeGreaterThan(100_000);
  });

  it('aggregates to H1 holding candles rather than minutes', async () => {
    const source = new ResampledM1Source({
      db,
      symbolId: (code) => (code === SYMBOL ? symbolId : undefined),
    });

    const candles = await source.readResampled(SYMBOL, 'H1', fromMs, toMs);
    const streamingGrowth = await measureRetained(() =>
      source.readResampled(SYMBOL, 'H1', fromMs, toMs),
    );

    expect(candles.length).toBeGreaterThan(1_000);
    // 60 minutes a bar, so far fewer candles than minutes.
    expect(candles.length).toBeLessThan(m1Bars / 50);

    /*
     * The A/B — the OLD path on the SAME range, in the same process — but only when a GC is available.
     *
     * Without `--expose-gc`, `heapUsed` deltas measure ALLOCATION RATE rather than retention, and the
     * streaming read allocates one short-lived object per row: it measured HIGHER than the read it
     * beats by 4x. A comparison that can invert is worse than no comparison, so it runs only when it
     * can be made to mean something:
     *
     *   NODE_OPTIONS=--expose-gc pnpm test:e2e
     *
     * The authoritative numbers live in A72, measured with `pnpm backtest --mem --expose-gc` on the
     * actual failing runs. What is asserted unconditionally above — candle count far below minute
     * count, and the pre-flight behaviour below — is what this suite can prove on its own.
     */
    const gc = (globalThis as { gc?: () => void }).gc;
    if (typeof gc !== 'function') {
      console.log('long-range: skipping the memory A/B — run with NODE_OPTIONS=--expose-gc for it');
      return;
    }

    const materialisingGrowth = await measureRetained(async () => {
      const result = await readM1(db, symbolId, fromMs, toMs);
      expect(result.bars.length).toBe(m1Bars);
      return result;
    });

    // Measured on the real data: the materialising read retains several times what the streaming one
    // does. A factor of two is a wide margin around a gap that measures ~4x.
    expect(materialisingGrowth).toBeGreaterThan(streamingGrowth * 2);
  }, 600_000);

  it('is accepted by the pre-flight check at H1', () => {
    expect(assertRunFitsMemory({ m1Bars, timeframe: 'H1', symbol: SYMBOL }).fits).toBe(true);
  });

  it('REFUSES a multi-year M1 run rather than letting the worker be killed', () => {
    /*
     * The real failing case, at the bar count that produced it: nine years of BTC minutes. Asserted
     * against that figure rather than this range's, because a two-year fx series — weekends excluded
     * — can be small enough to fit at M1, and the test must pin the behaviour that mattered.
     */
    expect(() =>
      assertRunFitsMemory({ m1Bars: 4_765_345, timeframe: 'M1', symbol: 'BTCUSD' }),
    ).toThrow(RunTooLargeError);
  });

  it('the refusal names the bars and a timeframe that would work', () => {
    try {
      assertRunFitsMemory({ m1Bars: 4_765_345, timeframe: 'M1', symbol: 'BTCUSD' });
      throw new Error('should have refused');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(RunTooLargeError);
      const message = (error as Error).message;

      expect(message).toMatch(/BTCUSD M1/);
      expect(message).toMatch(/4,765,345 stored minutes/);
      expect(message).toMatch(/Run it on M\d+ or higher|Shorten the range/);
      // Nothing was spent finding out, which is the whole improvement over being killed mid-run.
      expect(message).toMatch(/Nothing was read/);
    }
  });
});

/**
 * Heap RETAINED by a value, with garbage collected away first.
 *
 * `heapUsed` deltas without a forced GC measure allocation rate rather than retention — the streaming
 * read allocates one short-lived object per row, and without collection it measured HIGHER than the
 * read it beats. The value is held across the final GC so what remains is what it retains.
 */
async function measureRetained<T>(produce: () => Promise<T>): Promise<number> {
  const gc = (globalThis as { gc?: () => void }).gc;
  // Callers check for `gc` before using the result; without it this still returns a number, just a
  // noisier one, and nothing asserts on it.
  gc?.();
  gc?.();
  const before = process.memoryUsage().heapUsed;

  const value = await produce();

  gc?.();
  gc?.();
  const after = process.memoryUsage().heapUsed;

  // Referenced after the final GC, so it cannot have been collected as unreachable.
  expect(value).toBeTruthy();
  return after - before;
}
