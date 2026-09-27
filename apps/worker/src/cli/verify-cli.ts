import process from 'node:process';
import {
  coverageForAll,
  createDbClient,
  findSymbolByCode,
  describeCompression,
  readM1,
} from '@edgelab/db';
import { analyseQuality, resample } from '@edgelab/data';
import { TIMEFRAME_CODES, timeframeToPine } from '@edgelab/shared';
import { loadDotEnvFile, loadEnv } from '@edgelab/shared/config';

/**
 * Verifies stored data end to end:
 *   pnpm verify EURUSD 2024-01-01 2024-04-01
 *
 * Resamples the stored M1 to every MT5 timeframe and asserts the invariants that matter —
 * volume is conserved, OHLC stays coherent, buckets are ordered and disjoint — then prints
 * the data-quality report. This is what "displays correctly on every timeframe" means
 * before any pixel is involved.
 */
async function main(): Promise<void> {
  const [symbolCode = 'EURUSD', fromIso = '2024-01-01', toIso = '2024-04-01'] =
    process.argv.slice(2);

  loadDotEnvFile();
  const env = loadEnv(process.env);
  const db = createDbClient(env.DATABASE_URL, { max: 2, statementTimeoutMs: 600_000 });

  try {
    const symbol = await findSymbolByCode(db, symbolCode);
    if (symbol === null) throw new Error(`Unknown symbol ${symbolCode}`);

    const fromMs = Date.parse(`${fromIso}T00:00:00Z`);
    const toMs = Date.parse(`${toIso}T00:00:00Z`);

    const m1 = await readM1(db, symbol.id, fromMs, toMs);
    const m1Volume = m1.reduce((s, b) => s + b.volume, 0);

    console.log(`symbol     ${symbol.symbol} (${symbol.assetClass}, ${symbol.sessionType})`);
    console.log(`range      ${fromIso} .. ${toIso}`);
    console.log(`M1 bars    ${m1.length.toLocaleString('en-US')}`);
    if (m1.length === 0) {
      console.log('\nNo stored bars for that range — run `pnpm ingest` first.');
      return;
    }
    console.log(`first      ${new Date(m1[0]!.time).toISOString()}`);
    console.log(`last       ${new Date(m1[m1.length - 1]!.time).toISOString()}`);
    const withSpread = m1.filter((b) => b.spread != null).length;
    console.log(
      `spreads    ${withSpread.toLocaleString('en-US')} of ${m1.length.toLocaleString('en-US')} bars ` +
        `(${((withSpread / m1.length) * 100).toFixed(1)}%)`,
    );

    console.log('\n--- resample to every MT5 timeframe ---');
    console.log('TF     Pine   bars      first bar             last bar              checks');

    let failures = 0;

    for (const tf of TIMEFRAME_CODES) {
      const candles = resample(m1, tf);
      const problems: string[] = [];

      const volume = candles.reduce((s, c) => s + c.volume, 0);
      if (Math.abs(volume - m1Volume) > 1e-6) problems.push('VOLUME MISMATCH');

      for (let i = 0; i < candles.length; i += 1) {
        const c = candles[i]!;
        if (c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)) {
          problems.push(`INCOHERENT@${i}`);
          break;
        }
        if (c.closeTime <= c.time) {
          problems.push(`BAD CLOSETIME@${i}`);
          break;
        }
        const prev = candles[i - 1];
        if (prev !== undefined && (c.time <= prev.time || c.time < prev.closeTime)) {
          problems.push(`OVERLAP@${i}`);
          break;
        }
      }

      if (candles.length === 0) problems.push('EMPTY');
      if (problems.length > 0) failures += 1;

      console.log(
        `${tf.padEnd(6)} ${timeframeToPine(tf).padEnd(6)} ${String(candles.length).padStart(7)}   ` +
          `${new Date(candles[0]?.time ?? 0).toISOString().slice(0, 16)}     ` +
          `${new Date(candles[candles.length - 1]?.time ?? 0).toISOString().slice(0, 16)}     ` +
          `${problems.length === 0 ? 'ok' : problems.join(' ')}`,
      );
    }

    console.log('\n--- data quality ---');
    const q = analyseQuality(m1, { sessionType: symbol.sessionType });
    console.log(`completeness      ${(q.completeness * 100).toFixed(2)}%`);
    console.log(`missing minutes   ${q.missingMinutes.toLocaleString('en-US')}`);
    console.log(`gaps              ${q.gaps.count}`);
    console.log(`duplicates        ${q.duplicateTimestamps.count}`);
    console.log(`out of order      ${q.outOfOrderTimestamps.count}`);
    console.log(`zero-range bars   ${q.zeroRangeBars.count}`);
    // Should always be 0: normalizeBars drops flat zero-volume filler (D4). A non-zero count
    // means filler reached storage by some path that bypassed normalization.
    console.log(
      `filler bars       ${q.fillerBars.count}${q.fillerBars.count > 0 ? '  <-- D4 violation' : ''}`,
    );
    console.log(`invalid bars      ${q.invalidBars.count}`);
    console.log(`spikes            ${q.spikes.count}`);
    console.log(`spread outliers   ${q.spreadOutliers.count}`);
    if (q.gaps.count > 0) {
      console.log('largest gaps:');
      for (const g of [...q.gaps.samples]
        .sort((a, b) => b.missingMinutes - a.missingMinutes)
        .slice(0, 5)) {
        console.log(
          `  ${new Date(g.after).toISOString().slice(0, 16)} -> ` +
            `${new Date(g.before).toISOString().slice(0, 16)}  ${g.missingMinutes} min`,
        );
      }
    }

    console.log('\n--- storage ---');
    const compression = await describeCompression(db);
    console.log(
      `segmentby=[${compression.segmentBy.join(',')}] orderby=[${compression.orderBy.join(',')}] ` +
        `policies=${compression.policyJobs} chunks=${compression.chunkCount} ` +
        `compressed=${compression.compressedChunks}`,
    );

    console.log('\n--- coverage ---');
    for (const c of await coverageForAll(db)) {
      if (c.barCount === 0) continue;
      console.log(
        `${c.symbol.padEnd(8)} ${String(c.barCount).padStart(9)} bars  ` +
          `${new Date(c.firstBar ?? 0).toISOString().slice(0, 10)} .. ` +
          `${new Date(c.lastBar ?? 0).toISOString().slice(0, 10)}  ` +
          `v${c.dataVersion}  [${c.sources.join(',')}]`,
      );
    }

    if (failures > 0) {
      console.error(`\n${failures} timeframe(s) FAILED their invariants`);
      process.exitCode = 1;
    } else {
      console.log('\nAll 21 MT5 timeframes resampled cleanly.');
    }
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error('verify failed:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
