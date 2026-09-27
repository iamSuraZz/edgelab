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
export function resample(
  m1Bars: readonly ResampleInput[],
  tf: Timeframe,
  opts?: ResampleOptions,
): Candle[] {
  const o = resolveOptions(opts);
  assertStrictlyAscending(m1Bars);

  const out: Candle[] = [];
  let acc: Accumulator | null = null;

  for (const bar of m1Bars) {
    const start = bucketStartResolved(bar.time, tf, o);

    if (acc === null || acc.time !== start) {
      if (acc !== null) out.push(finalise(acc, tf, o));
      acc = {
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
      if (bar.high > acc.high) acc.high = bar.high;
      if (bar.low < acc.low) acc.low = bar.low;
      acc.close = bar.close;
      acc.volume += bar.volume;
    }

    const { sum, count } = spreadContribution(bar);
    acc.spreadSum += sum;
    acc.spreadCount += count;
  }

  if (acc !== null) out.push(finalise(acc, tf, o));
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

function assertStrictlyAscending(bars: readonly ResampleInput[]): void {
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1];
    const cur = bars[i];
    if (prev === undefined || cur === undefined) continue;
    if (cur.time === prev.time) {
      throw new Error(`Duplicate bar timestamp at index ${i}: ${cur.time}`);
    }
    if (cur.time < prev.time) {
      throw new Error(`Bars must be sorted ascending by time; index ${i} goes backwards`);
    }
  }
}
