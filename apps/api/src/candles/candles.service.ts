import { Inject, Injectable } from '@nestjs/common';
import { LRUCache } from 'lru-cache';
import { readM1, readM1Bars, type DbClient, type StoredSymbol } from '@edgelab/db';
import { analyseQuality, resample, type QualityReport, type ResampleOptions } from '@edgelab/data';
import { type Candle, type Timeframe, timeframeMs } from '@edgelab/shared';
import { DB_CLIENT } from '../infra/infra.module';

/**
 * Serves resampled candles from stored M1.
 *
 * Only M1 is persisted, so every other timeframe is computed on read. That is cheap for a
 * few thousand bars and ruinous for a three-month M1 range requested repeatedly, hence the
 * LRU cache.
 *
 * The cache key includes the symbol's `dataVersion`, which the ingest pipeline bumps on
 * every successful write. A re-download therefore invalidates every cached timeframe for
 * that symbol without having to enumerate or flush individual entries.
 */

export interface CandleQuery {
  readonly symbol: StoredSymbol;
  readonly timeframe: Timeframe;
  readonly fromMs: number;
  readonly toMs: number;
  readonly options?: ResampleOptions;
}

export interface CandleResponse {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly from: number;
  readonly to: number;
  readonly count: number;
  readonly candles: readonly Candle[];
  readonly cached: boolean;
  readonly dataVersion: number;
}

/** Guard against a request for 20 years of M1 flattening the process. */
const MAX_CANDLES = 200_000;

@Injectable()
export class CandlesService {
  /**
   * Sized by entry count rather than bytes: a handful of large series is the realistic
   * access pattern, and measuring retained size per entry is not worth the complexity.
   */
  private readonly cache = new LRUCache<string, Candle[]>({
    max: 64,
    ttl: 10 * 60_000,
  });

  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private static key(q: CandleQuery): string {
    const opts = q.options ?? {};
    return [
      q.symbol.symbol,
      q.timeframe,
      q.fromMs,
      q.toMs,
      q.symbol.dataVersion,
      opts.dayStartOffsetMinutes ?? 0,
      opts.weekStartDay ?? 1,
    ].join('|');
  }

  async get(q: CandleQuery): Promise<CandleResponse> {
    const key = CandlesService.key(q);
    const hit = this.cache.get(key);

    if (hit !== undefined) {
      return {
        symbol: q.symbol.symbol,
        timeframe: q.timeframe,
        from: q.fromMs,
        to: q.toMs,
        count: hit.length,
        candles: hit,
        cached: true,
        dataVersion: q.symbol.dataVersion,
      };
    }

    this.assertRangeIsSane(q);

    // A seal cutting the range short is ANNOUNCED, never silent: a run that covers less than it
    // appears to is worse than one that refuses, because its numbers look like an answer.
    const m1Read = await readM1(this.db, q.symbol.id, q.fromMs, q.toMs);
    const m1 = m1Read.bars;
    const candles = resample(m1, q.timeframe, q.options);

    this.cache.set(key, candles);

    return {
      symbol: q.symbol.symbol,
      timeframe: q.timeframe,
      from: q.fromMs,
      to: q.toMs,
      count: candles.length,
      candles,
      cached: false,
      dataVersion: q.symbol.dataVersion,
    };
  }

  /** Data-quality report over the same stored range. */
  async quality(symbol: StoredSymbol, fromMs: number, toMs: number): Promise<QualityReport> {
    const m1 = await readM1Bars(this.db, symbol.id, fromMs, toMs);
    return analyseQuality(m1, { sessionType: symbol.sessionType });
  }

  /**
   * Reject a request whose result could not fit in memory, rather than discovering it by
   * running out. Estimated from the timeframe, before reading anything.
   */
  private assertRangeIsSane(q: CandleQuery): void {
    const bucketMs = timeframeMs(q.timeframe);
    if (bucketMs === null) return; // MN1 can never be large enough to matter
    const estimate = (q.toMs - q.fromMs) / bucketMs;
    if (estimate > MAX_CANDLES) {
      throw new Error(
        `That range would produce about ${String(Math.round(estimate))} ${q.timeframe} candles ` +
          `(limit ${String(MAX_CANDLES)}). Narrow the range or pick a higher timeframe.`,
      );
    }
  }

  clear(): void {
    this.cache.clear();
  }

  stats(): { size: number; max: number } {
    return { size: this.cache.size, max: 64 };
  }
}
