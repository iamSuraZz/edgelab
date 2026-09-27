import type { SessionType } from '@edgelab/shared';

/**
 * Trading sessions, defined in EXCHANGE LOCAL TIME via the tz database (decision D3).
 *
 * Never fixed UTC hours. The FX week opens Sunday 17:00 and closes Friday 17:00 in
 * America/New_York, which is 21:00 UTC in summer and 22:00 UTC in winter — a fixed-UTC
 * boundary is therefore wrong for half the year, and produces a phantom one-hour gap every
 * week in whichever half you did not calibrate against.
 *
 * Implementation note: the offset is derived from Intl rather than hardcoded, so DST rule
 * changes arrive with the platform's tz data instead of needing a code change.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** 1970-01-01 was a Thursday; index 4 when 0 = Sunday. */
const EPOCH_DAY_OF_WEEK = 4;

export interface SessionWindow {
  /** IANA zone the boundaries are expressed in. */
  readonly timeZone: string;
  /** Local weekday the week opens on. 0 = Sunday. */
  readonly openDay: number;
  /** Minutes after local midnight when the week opens. */
  readonly openMinute: number;
  readonly closeDay: number;
  readonly closeMinute: number;
  /**
   * Daily maintenance breaks, as local minute-of-day ranges [from, to). Empty for FX on
   * Exness; metals/indices/energies get theirs derived from the data and stored here.
   */
  readonly dailyBreaks: readonly { readonly fromMinute: number; readonly toMinute: number }[];
}

/**
 * FX: Sunday 17:00 -> Friday 17:00 New York. Exness servers run GMT+0, but the session is a
 * New York concept and must be stored as one.
 */
export const FX_SESSION: SessionWindow = {
  timeZone: 'America/New_York',
  openDay: 0,
  openMinute: 17 * 60,
  closeDay: 5,
  closeMinute: 17 * 60,
  dailyBreaks: [],
};

/** Crypto never closes. Present so every symbol resolves to a window. */
export const CRYPTO_SESSION: SessionWindow = {
  timeZone: 'UTC',
  openDay: 0,
  openMinute: 0,
  closeDay: 0,
  closeMinute: 0,
  dailyBreaks: [],
};

export function sessionFor(sessionType: SessionType): SessionWindow {
  return sessionType === 'crypto24x7' ? CRYPTO_SESSION : FX_SESSION;
}

/* ------------------------------------------------------- timezone plumbing */

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = FORMATTERS.get(timeZone);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATTERS.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * Offset in ms to ADD to a UTC instant to get local wall-clock time.
 *
 * Cached per zone per UTC hour. Per-hour rather than per-day because a DST transition day
 * contains two different offsets, and per-hour is still cheap enough for a per-bar call.
 */
const OFFSET_CACHE = new Map<string, number>();

export function zoneOffsetMs(timeMs: number, timeZone: string): number {
  if (timeZone === 'UTC') return 0;

  const hourKey = `${timeZone}|${String(Math.floor(timeMs / MS_PER_HOUR))}`;
  const cached = OFFSET_CACHE.get(hourKey);
  if (cached !== undefined) return cached;

  const parts = formatterFor(timeZone).formatToParts(new Date(timeMs));
  const pick = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found === undefined ? 0 : Number(found.value);
  };

  // Re-interpret the local wall clock AS IF it were UTC; the difference is the offset.
  const asUtc = Date.UTC(
    pick('year'),
    pick('month') - 1,
    pick('day'),
    pick('hour'),
    pick('minute'),
    pick('second'),
  );
  const offset = asUtc - Math.floor(timeMs / 1000) * 1000;

  // Bounded so a long ingest cannot grow it without limit.
  if (OFFSET_CACHE.size > 50_000) OFFSET_CACHE.clear();
  OFFSET_CACHE.set(hourKey, offset);
  return offset;
}

export interface LocalClock {
  /** 0 = Sunday. */
  readonly dayOfWeek: number;
  readonly minuteOfDay: number;
}

export function localClock(timeMs: number, timeZone: string): LocalClock {
  const shifted = timeMs + zoneOffsetMs(timeMs, timeZone);
  const dayIndex = Math.floor(shifted / MS_PER_DAY);
  return {
    dayOfWeek: (((dayIndex + EPOCH_DAY_OF_WEEK) % 7) + 7) % 7,
    minuteOfDay: Math.floor((shifted - dayIndex * MS_PER_DAY) / MS_PER_MINUTE),
  };
}

/* ---------------------------------------------- local wall clock -> UTC */

export interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export function localDateAt(timeMs: number, timeZone: string): LocalDate {
  const shifted = new Date(timeMs + zoneOffsetMs(timeMs, timeZone));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * The UTC instant at which a given local wall-clock time occurs.
 *
 * The inverse of {@link zoneOffsetMs}, and it has to be solved rather than computed: the
 * offset depends on the instant, and the instant is what we are looking for. Two passes
 * converge because the offset is locally constant — the first pass lands within an hour of the
 * answer, which is close enough to read the correct offset unless the target time sits inside
 * a DST transition.
 *
 * For a time that does not exist (02:30 on a spring-forward day) this returns the instant an
 * hour later, which is the conventional resolution. Financing rolls at 17:00, so it never
 * meets that case.
 */
export function utcForLocalWallTime(
  date: LocalDate,
  minuteOfDay: number,
  timeZone: string,
): number {
  const wallAsUtc = Date.UTC(date.year, date.month - 1, date.day) + minuteOfDay * MS_PER_MINUTE;
  if (timeZone === 'UTC') return wallAsUtc;

  let instant = wallAsUtc - zoneOffsetMs(wallAsUtc, timeZone);
  instant = wallAsUtc - zoneOffsetMs(instant, timeZone);
  return instant;
}

/**
 * Every instant in `(fromMs, toMs]` at which the local clock reads `minuteOfDay`.
 *
 * Used for financing rollovers (D5). Iterates local CALENDAR days rather than adding 24 hours
 * repeatedly, because a DST day is 23 or 25 hours long and the fixed-stride version drifts an
 * hour twice a year — which would move a rollover onto the wrong side of a trade's exit.
 */
export function dailyLocalInstants(
  fromMs: number,
  toMs: number,
  timeZone: string,
  minuteOfDay: number,
): number[] {
  if (toMs <= fromMs) return [];

  const out: number[] = [];
  // Start a day early: the first local day's instant can still fall after `fromMs`.
  const start = localDateAt(fromMs - MS_PER_DAY, timeZone);
  let cursor = Date.UTC(start.year, start.month - 1, start.day);

  // +2 days of slack for the same reason at the far end.
  const limit = toMs + 2 * MS_PER_DAY;

  while (cursor <= limit) {
    const asDate = new Date(cursor);
    const instant = utcForLocalWallTime(
      {
        year: asDate.getUTCFullYear(),
        month: asDate.getUTCMonth() + 1,
        day: asDate.getUTCDate(),
      },
      minuteOfDay,
      timeZone,
    );
    if (instant > fromMs && instant <= toMs) out.push(instant);
    cursor += MS_PER_DAY;
  }

  return out;
}

/* ------------------------------------------------------------- open/closed */

/**
 * Whether the market is open at `timeMs`.
 *
 * The week is treated as one continuous open span from (openDay, openMinute) to
 * (closeDay, closeMinute) in local time, minus any daily breaks.
 */
export function isMarketOpen(
  timeMs: number,
  sessionType: SessionType,
  session: SessionWindow = sessionFor(sessionType),
): boolean {
  if (sessionType === 'crypto24x7') return true;

  const { dayOfWeek, minuteOfDay } = localClock(timeMs, session.timeZone);

  for (const brk of session.dailyBreaks) {
    if (minuteOfDay >= brk.fromMinute && minuteOfDay < brk.toMinute) return false;
  }

  // Minutes elapsed since the week's open, modulo a week.
  const openAt = session.openDay * 1440 + session.openMinute;
  const closeAt = session.closeDay * 1440 + session.closeMinute;
  const now = dayOfWeek * 1440 + minuteOfDay;

  const span = (closeAt - openAt + 7 * 1440) % (7 * 1440);
  const since = (now - openAt + 7 * 1440) % (7 * 1440);

  return since < span;
}

/**
 * Minutes of OPEN market time in [fromMs, toMs). Exact.
 *
 * Walks whole UTC hours and only descends to minutes for the handful of hours that straddle
 * a boundary, so a decade of history costs ~88k cheap checks instead of 5M.
 *
 * It deliberately does NOT take the shortcut of multiplying whole weeks by a per-week
 * constant. A 168-hour UTC window spans 169 local hours in the spring-forward week and 167
 * in the autumn one, so that shortcut is off by an hour twice a year — small, but it would
 * be wrong arithmetic feeding the completeness figure, which exists to be trusted.
 */
export function openMinutesBetween(
  fromMs: number,
  toMs: number,
  sessionType: SessionType,
  session: SessionWindow = sessionFor(sessionType),
): number {
  if (toMs <= fromMs) return 0;
  if (sessionType === 'crypto24x7') return Math.floor((toMs - fromMs) / MS_PER_MINUTE);

  const start = Math.floor(fromMs / MS_PER_MINUTE) * MS_PER_MINUTE;
  let open = 0;

  for (let t = start; t < toMs;) {
    const hourEnd = Math.min((Math.floor(t / MS_PER_HOUR) + 1) * MS_PER_HOUR, toMs);
    const minutes = Math.round((hourEnd - t) / MS_PER_MINUTE);

    // A whole hour is uniform unless it contains a session edge, which the first and last
    // minute disagreeing reveals.
    if (
      minutes === 60 &&
      isMarketOpen(t, sessionType, session) ===
        isMarketOpen(hourEnd - MS_PER_MINUTE, sessionType, session)
    ) {
      if (isMarketOpen(t, sessionType, session)) open += 60;
    } else {
      for (let m = t; m < hourEnd; m += MS_PER_MINUTE) {
        if (isMarketOpen(m, sessionType, session)) open += 1;
      }
    }

    t = hourEnd;
  }

  return open;
}

/**
 * Derive a weekly open/close from stored bars, the way the Friday close was established for
 * Dukascopy. Returns null when there is not enough data to be confident.
 *
 * Used for metals, indices and energies, whose boundaries differ from FX and are not
 * documented anywhere we can rely on.
 */
export function deriveSessionFromBars(
  barTimes: readonly number[],
  timeZone = 'America/New_York',
): { openDay: number; openMinute: number; closeDay: number; closeMinute: number } | null {
  if (barTimes.length < 500) return null;

  // Latest local minute seen on each weekday, and the earliest.
  const latest = new Map<number, number>();
  const earliest = new Map<number, number>();
  const counts = new Map<number, number>();

  for (const t of barTimes) {
    const { dayOfWeek, minuteOfDay } = localClock(t, timeZone);
    counts.set(dayOfWeek, (counts.get(dayOfWeek) ?? 0) + 1);
    const hi = latest.get(dayOfWeek);
    if (hi === undefined || minuteOfDay > hi) latest.set(dayOfWeek, minuteOfDay);
    const lo = earliest.get(dayOfWeek);
    if (lo === undefined || minuteOfDay < lo) earliest.set(dayOfWeek, minuteOfDay);
  }

  // The closing day is the last weekday with substantial activity before a quiet day.
  const active = [...counts.entries()]
    .filter(([, n]) => n > barTimes.length / 50)
    .map(([d]) => d)
    .sort((a, b) => a - b);
  if (active.length < 3) return null;

  const closeDay = active[active.length - 1] ?? 5;
  const openDay = active[0] ?? 0;

  return {
    openDay,
    openMinute: earliest.get(openDay) ?? 0,
    closeDay,
    // +1 because the last bar OPENS at that minute and covers the minute after.
    closeMinute: (latest.get(closeDay) ?? 1439) + 1,
  };
}
