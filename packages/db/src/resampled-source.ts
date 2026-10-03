import { ResampleStream, type ResampleOptions } from '@edgelab/data';
import type { Bar, Candle, Timeframe } from '@edgelab/shared';

import type { DbClient } from './client';
import { countM1InWindow, streamM1, type SealTruncation } from './candles';

/**
 * An `M1Source` that aggregates as it reads, so the M1 series is never resident.
 *
 * This is the fix for A71: `readM1` returns every row in the range as a JS object, ~170 bytes each,
 * and whoever holds that array pins it for the run. Nine years of BTC is 4.77M rows — 800MB on the
 * heap before the engine runs a bar, against a 1024MB task limit.
 *
 * It lives HERE, in `db`, rather than in the worker — which was the first attempt, on the reasoning
 * that storage should not know about aggregation. The pool task imports it, and a piscina thread
 * resolves package specifiers but not relative `.ts` ones, so a worker-local module simply cannot be
 * loaded from a task (A75). `db` therefore gains a dependency on `data`; `data` still does not depend
 * on `db`, so the one-way property the architecture asks for holds.
 *
 * `readM1` is still implemented, because some paths genuinely need the minutes: the M1 intrabar replay
 * walks them one by one, and FX conversion reads the pair's bars. Those are separate reads with their
 * own ranges, and neither is the multi-year chart read that caused the failure.
 */

export interface ResampledSourceOptions {
  readonly db: DbClient;
  /** Symbol code -> row id. Resolved by the caller, which already looked the symbol up. */
  readonly symbolId: (symbol: string) => string | undefined;
  readonly resampleOptions?: ResampleOptions;
  /** Called when a seal cut a read short, so the caller can report it exactly as before. */
  readonly onTruncation?: (truncation: SealTruncation) => void;
  /** Called with the M1 rows each aggregated read consumed, for instrumentation. */
  readonly onBarsRead?: (m1Bars: number) => void;
  /**
   * Read THROUGH an active seal, counting the view (A59).
   *
   * Off for every ordinary run. The holdout test is the one deliberate exception, and the view is
   * recorded inside `streamM1` before any page comes back.
   */
  readonly unsealed?: boolean;
}

export class ResampledM1Source {
  constructor(private readonly options: ResampledSourceOptions) {}

  /**
   * The minutes themselves, for the callers that need them.
   *
   * Still a materialising read: a caller asking for M1 has asked for the minutes, and the ranges that
   * do so are bounded (one trade's holding period for the replay, the run's window for FX).
   */
  async readM1(symbol: string, fromMs: number, toMs: number): Promise<Bar[]> {
    const id = this.options.symbolId(symbol);
    if (id === undefined) return [];

    const bars: Bar[] = [];
    const result = await streamM1(this.options.db, id, fromMs, toMs, (bar) => bars.push(bar), {
      unsealed: this.options.unsealed === true,
    });
    if (result.truncation !== null) this.options.onTruncation?.(result.truncation);
    this.options.onBarsRead?.(result.barsRead);

    return bars;
  }

  /** Candles for `tf`, folded from a paged M1 read. Never holds more than one page of minutes. */
  async readResampled(
    symbol: string,
    tf: Timeframe,
    fromMs: number,
    toMs: number,
  ): Promise<Candle[]> {
    const id = this.options.symbolId(symbol);
    if (id === undefined) return [];

    const stream = new ResampleStream(tf, this.options.resampleOptions);
    const candles: Candle[] = [];

    const result = await streamM1(
      this.options.db,
      id,
      fromMs,
      toMs,
      (bar) => {
        const completed = stream.push(bar);
        if (completed !== null) candles.push(completed);
      },
      { unsealed: this.options.unsealed === true },
    );

    const last = stream.flush();
    if (last !== null) candles.push(last);

    if (result.truncation !== null) this.options.onTruncation?.(result.truncation);
    this.options.onBarsRead?.(result.barsRead);

    return candles;
  }
}

/** M1 rows a window holds, without reading them — the input to the pre-flight estimate. */
export async function countBarsForRun(
  db: DbClient,
  symbolId: string,
  fromMs: number,
  toMs: number,
): Promise<{ bars: number; truncatedAtMs: number | null }> {
  return countM1InWindow(db, symbolId, fromMs, toMs);
}
