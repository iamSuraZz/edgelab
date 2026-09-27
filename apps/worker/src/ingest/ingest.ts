import {
  bumpDataVersion,
  copyBarsIgnoreDuplicates,
  recompressAfterBackfill,
  contiguousEndWithin,
  type DbClient,
} from '@edgelab/db';
import { MS_PER_MINUTE, type ProviderId } from '@edgelab/shared';

import type { StoredSymbol } from '@edgelab/db';
import type { ProviderRegistry } from './providers';

/**
 * The ingest pipeline: provider -> normalize -> COPY -> bump data version.
 *
 * Resumable: unless `force` is set, the start cursor advances to the end of the stored run that
 * COVERS the requested start, so a cancelled or failed job re-run does not re-download what it
 * already has. Duplicates are harmless anyway (ON CONFLICT DO NOTHING), but re-downloading
 * three months of ticks is not.
 */
/**
 * How far past the requested start stored data may begin and still count as covering it.
 *
 * Four days. Forex closes Friday evening and reopens Sunday evening, so a window opening on a
 * Saturday legitimately has its first bar two days later — and a Christmas or Easter weekend
 * stretches that further. Treating those as gaps would re-download the whole range every time
 * and make resume pointless.
 *
 * Four days is still nowhere near enough to hide the failure this guard exists for, which is
 * measured in months.
 */
const RESUME_START_SLACK_MS = 4 * 24 * 60 * 60 * 1_000;

export interface IngestRequest {
  readonly symbol: StoredSymbol;
  readonly provider: ProviderId;
  readonly fromMs: number;
  readonly toMs: number;
  /** Ignore the resume watermark and re-fetch the whole range. */
  readonly force?: boolean;
}

export interface IngestProgress {
  readonly percent: number;
  readonly message: string;
  readonly barsWritten: number;
}

export interface IngestResult {
  readonly symbol: string;
  readonly provider: ProviderId;
  readonly requestedFrom: number;
  readonly effectiveFrom: number;
  readonly toMs: number;
  readonly barsStaged: number;
  readonly barsInserted: number;
  readonly duplicates: number;
  readonly batches: number;
  readonly dataVersion: number;
  readonly resumed: boolean;
}

export async function runIngest(
  db: DbClient,
  registry: ProviderRegistry,
  request: IngestRequest,
  onProgress?: (p: IngestProgress) => void | Promise<void>,
): Promise<IngestResult> {
  const provider = registry.get(request.provider);
  if (provider === undefined) {
    throw new Error(`Unknown provider: ${request.provider}`);
  }

  const caps = provider.capabilities();
  if (!caps.enabled) {
    throw new Error(`Provider ${caps.label} is disabled: ${caps.disabledReason ?? 'unavailable'}`);
  }

  let effectiveFrom = request.fromMs;
  let resumed = false;

  if (request.force !== true) {
    /*
     * Resume ONLY when the stored data reaches the start of the requested window.
     *
     * The watermark used to be the newest bar anywhere for the symbol, which breaks backfills
     * of an EARLIER period: with January 2024 stored, a request for 2022-01-01 → 2024-02-01
     * resolved its cursor to 2024-02-01, tripped the `effectiveFrom >= toMs` early return, and
     * reported success having downloaded nothing. Two years of missing data, silently.
     *
     * Restricting the question to the window is not enough either: once a partial backfill
     * leaves a hole, `max(ts)` inside the window is on the far side of it.
     *
     * So the question is not "what is the newest bar" but "how far does the run that starts
     * where this request starts actually reach". A hole in the middle stops it — see
     * contiguousEndWithin, which hit both failure modes on real data.
     *
     * When it does not line up we re-fetch from the requested start. That can re-download bars
     * we already hold, which costs time; the alternative costs correctness, and duplicates are
     * dropped by ON CONFLICT anyway.
     */
    const stored = await contiguousEndWithin(
      db,
      request.symbol.id,
      request.fromMs,
      request.toMs,
      RESUME_START_SLACK_MS,
    );
    const coversStart = stored !== null && stored.first <= request.fromMs + RESUME_START_SLACK_MS;

    if (coversStart && stored.last + MS_PER_MINUTE > effectiveFrom) {
      effectiveFrom = stored.last + MS_PER_MINUTE;
      resumed = true;
    }
  }

  if (effectiveFrom >= request.toMs) {
    return {
      symbol: request.symbol.symbol,
      provider: request.provider,
      requestedFrom: request.fromMs,
      effectiveFrom,
      toMs: request.toMs,
      barsStaged: 0,
      barsInserted: 0,
      duplicates: 0,
      batches: 0,
      dataVersion: request.symbol.dataVersion,
      resumed,
    };
  }

  let barsStaged = 0;
  let barsInserted = 0;
  let duplicates = 0;
  let batches = 0;

  const iterator = provider.fetchM1(request.symbol, effectiveFrom, request.toMs, (p) => {
    void onProgress?.({
      // Reserve the last 5% for the recompress/finalise step.
      percent: Math.min(95, Math.round(p.percent * 0.95)),
      message: p.message,
      barsWritten: barsInserted,
    });
  });

  for await (const batch of iterator) {
    if (batch.length === 0) continue;

    const result = await copyBarsIgnoreDuplicates(db, {
      symbolId: request.symbol.id,
      source: request.provider,
      bars: batch,
    });

    barsStaged += result.staged;
    barsInserted += result.inserted;
    duplicates += result.duplicates;
    batches += 1;

    await onProgress?.({
      percent: 95,
      message: `stored ${String(barsInserted)} bars`,
      barsWritten: barsInserted,
    });
  }

  let dataVersion = request.symbol.dataVersion;

  if (barsInserted > 0) {
    dataVersion = await bumpDataVersion(db, request.symbol.id);

    // Backfilling into already-compressed chunks leaves them partially compressed, which
    // is invisible in timescaledb_information.chunks. Put them back.
    await onProgress?.({ percent: 97, message: 'recompressing chunks', barsWritten: barsInserted });
    const recompressed = await recompressAfterBackfill(db);
    if (recompressed > 0) {
      await onProgress?.({
        percent: 99,
        message: `recompressed ${String(recompressed)} chunks`,
        barsWritten: barsInserted,
      });
    }
  }

  await onProgress?.({
    percent: 100,
    message: `done: ${String(barsInserted)} new bars`,
    barsWritten: barsInserted,
  });

  return {
    symbol: request.symbol.symbol,
    provider: request.provider,
    requestedFrom: request.fromMs,
    effectiveFrom,
    toMs: request.toMs,
    barsStaged,
    barsInserted,
    duplicates,
    batches,
    dataVersion,
    resumed,
  };
}
