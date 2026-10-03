import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bumpDataVersion,
  copyBarsIgnoreDuplicates,
  createDbClient,
  findSymbolByCode,
  countM1InWindow,
  type DbClient,
} from '@edgelab/db';
import { syntheticM1 } from '@edgelab/data';
import { loadDotEnvFile, loadEnv } from '@edgelab/shared/config';

import { ResampledM1Source } from '../../src/data/resampled-source';
import { RunTooLargeError, assertRunFitsMemory } from '../../src/pool/memory-budget';

/**
 * The long-range regression (A72/A73).
 *
 * Two obligations, and they pull in opposite directions:
 *
 *  1. a multi-year M1 series must RUN on a sensible timeframe within the limit — the whole point of
 *     the streaming read, and the thing a check tuned only to refuse would have broken;
 *  2. the same series at M1 must be REFUSED up front, not killed half way through.
 *
 * Needs the docker stack. It seeds its own symbol and removes it afterwards, so it cannot disturb
 * stored work — and it uses a symbol with no real bars, because seeding synthetic data beside a real
 * feed is what the one-feed rule refuses (A6).
 */

const SYMBOL = 'ETHUSD';
const FROM = Date.UTC(2021, 0, 1);
/** Three years of 24/7 minutes: ~1.58M bars, enough that the old path would have held ~270MB. */
const TO = Date.UTC(2024, 0, 1);

let db: DbClient;
let symbolId: string;

beforeAll(async () => {
  loadDotEnvFile();
  const env = loadEnv(process.env);
  db = createDbClient(env.DATABASE_URL, { max: 4, statementTimeoutMs: 600_000 });

  const symbol = await findSymbolByCode(db, SYMBOL);
  expect(symbol, `${SYMBOL} must exist in the registry; run \`pnpm db:migrate\``).not.toBeNull();
  symbolId = symbol!.id;

  const existing = await countM1InWindow(db, symbolId, FROM, TO);
  if (existing.bars === 0) {
    // Written in month-sized batches: building 1.58M bars in one array would reproduce the very
    // problem under test inside the test's own setup.
    for (let start = FROM; start < TO;) {
      const end = Math.min(TO, start + 30 * 24 * 60 * 60_000);
      const bars = // 24/7, like the crypto series this regression stands in for.
        syntheticM1({
          fromMs: start,
          toMs: end,
          skipWeekends: false,
          basePrice: 2_000,
          mintick: 0.01,
        });
      await copyBarsIgnoreDuplicates(db, { symbolId, source: 'synthetic', bars });
      start = end;
    }
    await bumpDataVersion(db, symbolId);
  }
}, 900_000);

afterAll(async () => {
  await db.pool
    .query(
      `SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;
       DELETE FROM candles_m1 WHERE symbol_id = $1`,
      [symbolId],
    )
    .catch(() => undefined);
  await db.pool.end().catch(() => undefined);
}, 300_000);

describe('a multi-year M1 series', () => {
  it('holds over a million minutes', async () => {
    const counted = await countM1InWindow(db, symbolId, FROM, TO);
    expect(counted.bars).toBeGreaterThan(1_000_000);
  });

  it('aggregates to H1 without materialising the minutes', async () => {
    const counted = await countM1InWindow(db, symbolId, FROM, TO);

    const source = new ResampledM1Source({
      db,
      symbolId: (code) => (code === SYMBOL ? symbolId : undefined),
    });

    const before = process.memoryUsage().heapUsed;
    const candles = await source.readResampled(SYMBOL, 'H1', FROM, TO);
    const growthBytes = process.memoryUsage().heapUsed - before;

    // Right shape: 60 minutes a bar, 24/7.
    expect(candles.length).toBeGreaterThan(25_000);
    expect(candles.length).toBeLessThanOrEqual(Math.ceil(counted.bars / 60) + 1);

    /*
     * The ASSERTION WITH TEETH: growth must be a fraction of what RETAINING the minutes would cost.
     *
     * Not a per-candle ceiling — the first version tried that and failed at 2,000 B/candle, because
     * `heapUsed` at this instant also holds one 100k-row page, pg's own result buffers and whatever
     * garbage has not been collected. Forcing a GC would need `--expose-gc` in the e2e runner.
     *
     * Measured per M1 row on the old path: ~170 bytes (A71). A third of that total is far above the
     * page-plus-garbage noise and far below the ~270MB this range would cost if the minutes were
     * being held, so the assertion is loose about noise and strict about the thing under test.
     */
    const ifMinutesWereRetained = counted.bars * 170;
    expect(growthBytes).toBeLessThan(ifMinutesWereRetained / 3);
  }, 900_000);

  it('is accepted by the pre-flight check at H1', async () => {
    const counted = await countM1InWindow(db, symbolId, FROM, TO);
    const estimate = assertRunFitsMemory({
      m1Bars: counted.bars,
      timeframe: 'H1',
      symbol: SYMBOL,
    });

    expect(estimate.fits).toBe(true);
  });

  it('is REFUSED at M1, rather than killing the worker', async () => {
    const counted = await countM1InWindow(db, symbolId, FROM, TO);

    expect(() =>
      assertRunFitsMemory({ m1Bars: counted.bars, timeframe: 'M1', symbol: SYMBOL }),
    ).toThrow(RunTooLargeError);
  });

  it('the refusal names the bars and a timeframe that would work', async () => {
    const counted = await countM1InWindow(db, symbolId, FROM, TO);

    try {
      assertRunFitsMemory({ m1Bars: counted.bars, timeframe: 'M1', symbol: SYMBOL });
      throw new Error('should have refused');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(RunTooLargeError);
      const message = (error as Error).message;

      expect(message).toMatch(new RegExp(`${SYMBOL} M1`));
      expect(message).toMatch(/stored minutes/);
      expect(message).toMatch(/Run it on M\d+ or higher|Shorten the range/);
    }
  });
});
