import {
  type Bar,
  type Candle,
  MS_PER_DAY,
  MS_PER_MINUTE,
  type Timeframe,
  getTimeframe,
} from '@edgelab/shared';

/** 0 = Sunday … 6 = Saturday, matching Date#getUTCDay. */
export type WeekDay = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ResampleOptions {
  /**
   * Where the D1 (and W1/MN1) boundary sits, as minutes after 00:00 UTC.
   * 0 (default) = midnight UTC. Brokers that roll the day at the New York close use
   * 1320 (22:00 UTC) or 1260 (21:00 UTC) depending on US daylight saving.
   *
   * Intraday timeframes are ALWAYS aligned to the UTC epoch and ignore this, so that
   * an H4 bar means the same thing regardless of broker convention.
   */
  readonly dayStartOffsetMinutes?: number;
  /** Which day a W1 bar opens on. Default 1 (Monday). */
  readonly weekStartDay?: WeekDay;
}

interface ResolvedOptions {
  readonly dayStartOffsetMs: number;
  readonly weekStartDay: WeekDay;
}

/** Epoch day 0 (1970-01-01) was a Thursday, which is index 4 when 0 = Sunday. */
const EPOCH_DAY_OF_WEEK = 4;

function resolveOptions(opts: ResampleOptions | undefined): ResolvedOptions {
  const rawOffset = opts?.dayStartOffsetMinutes ?? 0;
  if (!Number.isInteger(rawOffset)) {
    throw new RangeError(`dayStartOffsetMinutes must be an integer, received ${String(rawOffset)}`);
  }
  // Normalise into [0, 1440) so a negative or oversized offset is still well defined.
  const minutesInDay = MS_PER_DAY / MS_PER_MINUTE;
  const offset = ((rawOffset % minutesInDay) + minutesInDay) % minutesInDay;

  // D2: Exness MT5 weekly bars open Sunday 00:00 (their servers run GMT+0), not Monday.
  // Monday stays available for brokers that roll the week differently.
  const weekStartDay = opts?.weekStartDay ?? 0;
  if (!Number.isInteger(weekStartDay) || weekStartDay < 0 || weekStartDay > 6) {
    throw new RangeError(`weekStartDay must be 0..6, received ${String(weekStartDay)}`);
  }

  return { dayStartOffsetMs: offset * MS_PER_MINUTE, weekStartDay: weekStartDay as WeekDay };
}

/**
 * The UTC open time of the bucket that `timeMs` belongs to.
 *
 * Anchoring:
 *   intraday — floored from the UTC epoch, so H4 lands on 00:00, 04:00, …
 *   daily    — floored to the day boundary implied by dayStartOffsetMinutes
 *   weekly   — the most recent `weekStartDay` at that same day boundary
 *   monthly  — the 1st of the calendar month at that same day boundary
 */
export function bucketStart(timeMs: number, tf: Timeframe, opts?: ResampleOptions): number {
  if (!Number.isInteger(timeMs) || timeMs < 0) {
    throw new RangeError(`Expected a non-negative integer epoch-ms, received ${String(timeMs)}`);
  }
  return bucketStartResolved(timeMs, tf, resolveOptions(opts));
}

function bucketStartResolved(timeMs: number, tf: Timeframe, o: ResolvedOptions): number {
  const def = getTimeframe(tf);

  switch (def.kind) {
    case 'intraday': {
      // minutes is non-null for every intraday timeframe.
      const size = (def.minutes as number) * MS_PER_MINUTE;
      return Math.floor(timeMs / size) * size;
    }

    case 'daily': {
      const shifted = timeMs - o.dayStartOffsetMs;
      return Math.floor(shifted / MS_PER_DAY) * MS_PER_DAY + o.dayStartOffsetMs;
    }

    case 'weekly': {
      const shifted = timeMs - o.dayStartOffsetMs;
      const dayIndex = Math.floor(shifted / MS_PER_DAY);
      const dayOfWeek = (((dayIndex + EPOCH_DAY_OF_WEEK) % 7) + 7) % 7;
      const daysIntoWeek = (dayOfWeek - o.weekStartDay + 7) % 7;
      return (dayIndex - daysIntoWeek) * MS_PER_DAY + o.dayStartOffsetMs;
    }

    case 'monthly': {
      const shifted = new Date(timeMs - o.dayStartOffsetMs);
      return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) + o.dayStartOffsetMs;
    }
  }
}

/**
 * The EXCLUSIVE end of the bucket that opens at `startMs` — i.e. the next bucket's open
 * time. A bar covers [startMs, bucketEnd).
 */
export function bucketEnd(startMs: number, tf: Timeframe, opts?: ResampleOptions): number {
  return bucketEndResolved(startMs, tf, resolveOptions(opts));
}

function bucketEndResolved(startMs: number, tf: Timeframe, o: ResolvedOptions): number {
  const def = getTimeframe(tf);

  if (def.kind === 'monthly') {
    const shifted = new Date(startMs - o.dayStartOffsetMs);
    // Month + 1 with Date.UTC handles the December -> January year roll for us.
    return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1) + o.dayStartOffsetMs;
  }

  return startMs + (def.minutes as number) * MS_PER_MINUTE;
}

/**
 * Either a raw M1 bar or an already-resampled candle. Candles carry `spreadSamples`, so
 * feeding them back in recombines spread means exactly by weight.
 */
export type ResampleInput = Bar | Candle;

function spreadContribution(bar: ResampleInput): { sum: number; count: number } {
  const spread = bar.spread;
  if (spread == null || !Number.isFinite(spread)) return { sum: 0, count: 0 };

  const samples = 'spreadSamples' in bar ? bar.spreadSamples : 1;
  if (!Number.isFinite(samples) || samples <= 0) return { sum: 0, count: 0 };

  return { sum: spread * samples, count: samples };
}

/** Mutable accumulator for the bucket currently being built. */
interface Accumulator {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  spreadSum: number;
  spreadCount: number;
}

/**
 * Aggregate M1 bars up to `tf`.
 *
 * Pure: no I/O, no clock access. Buckets with no underlying M1 bars are omitted rather
 * than emitted as flat bars, which matches how MT5 and TradingView render weekends and
 * closed sessions.
 *
 * Input must be sorted strictly ascending by time; duplicate timestamps indicate a data
 * integrity problem and throw rather than being silently merged.
 */
/**
 * Incremental resampling: push M1 bars, collect finished candles.
 *
 * Exists so a multi-year M1 series never has to be resident. The whole series as JS objects is what
 * made a BTC backtest die — 4.77M rows at ~176 bytes each is 800MB before the engine has run a single
 * bar (A71). Fed from a chunked read, peak memory becomes one chunk plus the resampled output.
 *
 * `resample()` is implemented IN TERMS OF this, so there is exactly one bucketing implementation. Two
 * would drift, and the one that drifted would be the streaming one nobody reads.
 */
export class ResampleStream {
  private acc: Accumulator | null = null;
  private lastTime = -Infinity;
  /** Position in the stream, so an error names the same index the array form would. */
  private index = 0;
  private readonly o: ResolvedOptions;

  constructor(
    private readonly tf: Timeframe,
    opts?: ResampleOptions,
  ) {
    this.o = resolveOptions(opts);
  }

  /**
   * Add one M1 bar. Returns the candle that just COMPLETED, if this bar opened a new bucket.
   *
   * Monotonicity is checked across the whole stream, not per chunk: a chunked reader that returned
   * overlapping or out-of-order pages would otherwise produce silently wrong buckets, and the array
   * version's `assertStrictlyAscending` cannot see across calls.
   */
  push(bar: ResampleInput): Candle | null {
    // The two cases stay DISTINCT. A duplicate timestamp means the read overlapped a page boundary;
    // a backwards one means it was ordered wrongly. Those have different fixes, so they keep
    // different messages — the same two the array form has always produced.
    if (bar.time === this.lastTime) {
      throw new Error(
        `Duplicate bar timestamp at index ${String(this.index)}: ${String(bar.time)}`,
      );
    }
    if (bar.time < this.lastTime) {
      throw new Error(
        `Bars must be sorted ascending by time; index ${String(this.index)} goes backwards`,
      );
    }
    this.lastTime = bar.time;
    this.index += 1;

    const start = bucketStartResolved(bar.time, this.tf, this.o);
    let completed: Candle | null = null;

    if (this.acc === null || this.acc.time !== start) {
      if (this.acc !== null) completed = finalise(this.acc, this.tf, this.o);
      this.acc = {
        time: start,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        spreadSum: 0,
        spreadCount: 0,
      };
    } else {
      if (bar.high > this.acc.high) this.acc.high = bar.high;
      if (bar.low < this.acc.low) this.acc.low = bar.low;
      this.acc.close = bar.close;
      this.acc.volume += bar.volume;
    }

    const { sum, count } = spreadContribution(bar);
    this.acc.spreadSum += sum;
    this.acc.spreadCount += count;

    return completed;
  }

  /** The final, partially filled bucket. Call once, after the last `push`. */
  flush(): Candle | null {
    if (this.acc === null) return null;
    const last = finalise(this.acc, this.tf, this.o);
    this.acc = null;
    return last;
  }
}

/**
 * Aggregate M1 bars up to `tf`.
 *
 * The array form, for callers that already hold the series. Delegates to `ResampleStream` so the
 * bucketing rules live in exactly one place.
 */
export function resample(
  m1Bars: readonly ResampleInput[],
  tf: Timeframe,
  opts?: ResampleOptions,
): Candle[] {
  const stream = new ResampleStream(tf, opts);
  const out: Candle[] = [];

  for (const bar of m1Bars) {
    const completed = stream.push(bar);
    if (completed !== null) out.push(completed);
  }

  const last = stream.flush();
  if (last !== null) out.push(last);

  return out;
}

function finalise(acc: Accumulator, tf: Timeframe, o: ResolvedOptions): Candle {
  return {
    time: acc.time,
    closeTime: bucketEndResolved(acc.time, tf, o),
    open: acc.open,
    high: acc.high,
    low: acc.low,
    close: acc.close,
    volume: acc.volume,
    spread: acc.spreadCount > 0 ? acc.spreadSum / acc.spreadCount : null,
    spreadSamples: acc.spreadCount,
  };
}

/**
 * Resample an already-resampled series further, e.g. M5 -> M15. Valid only when `from`
 * nests exactly inside `to` (see divisorsOf in @edgelab/shared); the candle cache uses
 * this to avoid re-reading M1.
 */
export function resampleCandles(
  candles: readonly Candle[],
  tf: Timeframe,
  opts?: ResampleOptions,
): Candle[] {
  // Candles carry spreadSamples, so this recombines spread means exactly by weight.
  return resample(candles, tf, opts);
}
