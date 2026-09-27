/**
 * The full MT5 timeframe set, with the Pine Script timeframe string for each.
 * Only M1 is stored; every other timeframe is resampled from M1 (see @edgelab/data).
 *
 * Convention: a bar's timestamp is its OPEN time, in UTC epoch milliseconds.
 */

export const TIMEFRAME_CODES = [
  'M1',
  'M2',
  'M3',
  'M4',
  'M5',
  'M6',
  'M10',
  'M12',
  'M15',
  'M20',
  'M30',
  'H1',
  'H2',
  'H3',
  'H4',
  'H6',
  'H8',
  'H12',
  'D1',
  'W1',
  'MN1',
] as const;

export type Timeframe = (typeof TIMEFRAME_CODES)[number];

/** Anchoring rule used when flooring a timestamp to a bar boundary. */
export type TimeframeKind = 'intraday' | 'daily' | 'weekly' | 'monthly';

export interface TimeframeDef {
  readonly code: Timeframe;
  readonly label: string;
  /**
   * Bar length in minutes. `null` for calendar-based timeframes whose length
   * varies (MN1), which must be bucketed with calendar arithmetic instead.
   */
  readonly minutes: number | null;
  readonly kind: TimeframeKind;
  /**
   * Pine Script `timeframe.period` string. Intraday timeframes are the minute count
   * as a string; D1/W1/MN1 are 'D'/'W'/'M'.
   */
  readonly pine: string;
}

export const TIMEFRAMES: readonly TimeframeDef[] = [
  { code: 'M1', label: '1 minute', minutes: 1, kind: 'intraday', pine: '1' },
  { code: 'M2', label: '2 minutes', minutes: 2, kind: 'intraday', pine: '2' },
  { code: 'M3', label: '3 minutes', minutes: 3, kind: 'intraday', pine: '3' },
  { code: 'M4', label: '4 minutes', minutes: 4, kind: 'intraday', pine: '4' },
  { code: 'M5', label: '5 minutes', minutes: 5, kind: 'intraday', pine: '5' },
  { code: 'M6', label: '6 minutes', minutes: 6, kind: 'intraday', pine: '6' },
  { code: 'M10', label: '10 minutes', minutes: 10, kind: 'intraday', pine: '10' },
  { code: 'M12', label: '12 minutes', minutes: 12, kind: 'intraday', pine: '12' },
  { code: 'M15', label: '15 minutes', minutes: 15, kind: 'intraday', pine: '15' },
  { code: 'M20', label: '20 minutes', minutes: 20, kind: 'intraday', pine: '20' },
  { code: 'M30', label: '30 minutes', minutes: 30, kind: 'intraday', pine: '30' },
  { code: 'H1', label: '1 hour', minutes: 60, kind: 'intraday', pine: '60' },
  { code: 'H2', label: '2 hours', minutes: 120, kind: 'intraday', pine: '120' },
  { code: 'H3', label: '3 hours', minutes: 180, kind: 'intraday', pine: '180' },
  { code: 'H4', label: '4 hours', minutes: 240, kind: 'intraday', pine: '240' },
  { code: 'H6', label: '6 hours', minutes: 360, kind: 'intraday', pine: '360' },
  { code: 'H8', label: '8 hours', minutes: 480, kind: 'intraday', pine: '480' },
  { code: 'H12', label: '12 hours', minutes: 720, kind: 'intraday', pine: '720' },
  { code: 'D1', label: '1 day', minutes: 1440, kind: 'daily', pine: 'D' },
  { code: 'W1', label: '1 week', minutes: 10080, kind: 'weekly', pine: 'W' },
  { code: 'MN1', label: '1 month', minutes: null, kind: 'monthly', pine: 'M' },
];

const BY_CODE: ReadonlyMap<Timeframe, TimeframeDef> = new Map(
  TIMEFRAMES.map((tf) => [tf.code, tf]),
);

const BY_PINE: ReadonlyMap<string, TimeframeDef> = new Map(
  TIMEFRAMES.map((tf) => [tf.pine.toUpperCase(), tf]),
);

/** The timeframe all stored data is persisted at. */
export const BASE_TIMEFRAME: Timeframe = 'M1';

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;
export const MS_PER_WEEK = 604_800_000;

export function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === 'string' && BY_CODE.has(value as Timeframe);
}

/** Look up a timeframe definition, throwing on an unknown code. */
export function getTimeframe(code: Timeframe): TimeframeDef {
  const def = BY_CODE.get(code);
  if (def === undefined) {
    throw new Error(`Unknown timeframe: ${String(code)}`);
  }
  return def;
}

/** Bar length in milliseconds, or `null` for calendar-based timeframes. */
export function timeframeMs(code: Timeframe): number | null {
  const { minutes } = getTimeframe(code);
  return minutes === null ? null : minutes * MS_PER_MINUTE;
}

/** True when bucketing requires calendar arithmetic rather than fixed division. */
export function isCalendarBased(code: Timeframe): boolean {
  return getTimeframe(code).minutes === null;
}

/**
 * How many M1 bars make up one bar of `code`. Returns `null` for calendar-based
 * timeframes, where the count varies per bucket.
 */
export function m1BarsPer(code: Timeframe): number | null {
  return getTimeframe(code).minutes;
}

/** MT5 code -> Pine Script timeframe string, e.g. 'H4' -> '240'. */
export function timeframeToPine(code: Timeframe): string {
  return getTimeframe(code).pine;
}

/**
 * Pine Script timeframe string -> MT5 code, e.g. '240' -> 'H4'.
 * Returns undefined for a Pine period EdgeLab has no MT5 equivalent for
 * (seconds, '45', '3D', and so on).
 */
export function pineToTimeframe(pine: string): Timeframe | undefined {
  return BY_PINE.get(pine.trim().toUpperCase())?.code;
}

/**
 * Timeframes whose buckets nest exactly inside one bucket of `code`, so resampling
 * M1 -> divisor -> code lands on the same bars as M1 -> code. Used by the resampler's
 * property tests and by the candle cache when it can build a coarse timeframe from a
 * cached finer one.
 *
 * Caveat: this assumes the DEFAULT alignment (day start 00:00 UTC, week start Monday).
 * A non-zero `dayStartOffsetMinutes` only preserves nesting for divisors that the
 * offset is itself a whole multiple of.
 */
export function divisorsOf(code: Timeframe): readonly Timeframe[] {
  const target = getTimeframe(code).minutes;

  // A calendar month has no fixed length, but every month starts at midnight UTC on
  // the 1st. So anything that tiles a DAY exactly nests inside a month — notably W1
  // does NOT, because weeks straddle month boundaries.
  if (target === null) {
    return TIMEFRAMES.filter(
      (tf) =>
        tf.minutes !== null && tf.minutes <= MS_PER_DAY / MS_PER_MINUTE && 1440 % tf.minutes === 0,
    ).map((tf) => tf.code);
  }

  return TIMEFRAMES.filter(
    (tf) => tf.minutes !== null && tf.minutes < target && target % tf.minutes === 0,
  ).map((tf) => tf.code);
}
