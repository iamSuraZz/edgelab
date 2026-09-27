import { describe, expect, it } from 'vitest';

import {
  FX_SESSION,
  deriveSessionFromBars,
  isMarketOpen,
  localClock,
  openMinutesBetween,
  sessionFor,
  type SessionWindow,
  zoneOffsetMs,
} from './sessions';

const M1 = 60_000;
const H1 = 3_600_000;

/* A winter week: 2024-01-15 is a Monday. New York is on EST (UTC-5). */
const W_MON = Date.UTC(2024, 0, 15);
const W_FRI = Date.UTC(2024, 0, 19);
const W_SAT = Date.UTC(2024, 0, 20);
const W_SUN = Date.UTC(2024, 0, 21);
const W_NEXT_MON = Date.UTC(2024, 0, 22);

/* A summer week: 2024-07-15 is a Monday. New York is on EDT (UTC-4). */
const S_MON = Date.UTC(2024, 6, 15);
const S_FRI = Date.UTC(2024, 6, 19);
const S_SUN = Date.UTC(2024, 6, 21);
const S_NEXT_MON = Date.UTC(2024, 6, 22);

describe('zoneOffsetMs', () => {
  it('returns EST in winter and EDT in summer', () => {
    expect(zoneOffsetMs(W_MON, 'America/New_York')).toBe(-5 * H1);
    expect(zoneOffsetMs(S_MON, 'America/New_York')).toBe(-4 * H1);
  });

  it('is a no-op for UTC', () => {
    expect(zoneOffsetMs(W_MON, 'UTC')).toBe(0);
  });

  it('flips exactly at the 2024 US transitions', () => {
    // Spring forward: 2024-03-10 07:00 UTC = 02:00 EST -> 03:00 EDT.
    const springBefore = Date.UTC(2024, 2, 10, 6, 59);
    const springAfter = Date.UTC(2024, 2, 10, 7, 0);
    expect(zoneOffsetMs(springBefore, 'America/New_York')).toBe(-5 * H1);
    expect(zoneOffsetMs(springAfter, 'America/New_York')).toBe(-4 * H1);

    // Fall back: 2024-11-03 06:00 UTC = 02:00 EDT -> 01:00 EST.
    expect(zoneOffsetMs(Date.UTC(2024, 10, 3, 5, 59), 'America/New_York')).toBe(-4 * H1);
    expect(zoneOffsetMs(Date.UTC(2024, 10, 3, 6, 0), 'America/New_York')).toBe(-5 * H1);
  });
});

describe('localClock', () => {
  it('reads New York wall-clock weekday and minute', () => {
    // Monday 00:00 UTC is still Sunday 19:00 in New York.
    expect(localClock(W_MON, 'America/New_York')).toEqual({ dayOfWeek: 0, minuteOfDay: 19 * 60 });
    expect(localClock(W_MON + 12 * H1, 'America/New_York')).toEqual({
      dayOfWeek: 1,
      minuteOfDay: 7 * 60,
    });
  });
});

describe('isMarketOpen — D3, sessions in America/New_York', () => {
  it('is always open for crypto', () => {
    for (const t of [W_SAT, W_SUN, W_FRI + 23 * H1]) {
      expect(isMarketOpen(t, 'crypto24x7')).toBe(true);
    }
  });

  it('closes fx all of Saturday', () => {
    for (const h of [0, 6, 12, 18, 23]) {
      expect(isMarketOpen(W_SAT + h * H1, 'fx24x5')).toBe(false);
    }
  });

  it('is open midweek', () => {
    expect(isMarketOpen(W_MON + 9 * H1, 'fx24x5')).toBe(true);
    expect(isMarketOpen(S_MON + 9 * H1, 'fx24x5')).toBe(true);
  });

  /* The point of D3: the same 17:00 New York boundary lands on two different UTC hours. */

  it('closes Friday 17:00 NY = 22:00 UTC in winter', () => {
    expect(isMarketOpen(W_FRI + 21 * H1 + 59 * M1, 'fx24x5')).toBe(true);
    expect(isMarketOpen(W_FRI + 22 * H1, 'fx24x5')).toBe(false);
  });

  it('closes Friday 17:00 NY = 21:00 UTC in summer', () => {
    expect(isMarketOpen(S_FRI + 20 * H1 + 59 * M1, 'fx24x5')).toBe(true);
    expect(isMarketOpen(S_FRI + 21 * H1, 'fx24x5')).toBe(false);
    // The old fixed-22:00-UTC rule called this minute open. It is not.
    expect(isMarketOpen(S_FRI + 21 * H1 + 30 * M1, 'fx24x5')).toBe(false);
  });

  it('reopens Sunday 17:00 NY = 22:00 UTC in winter', () => {
    expect(isMarketOpen(W_SUN + 21 * H1 + 59 * M1, 'fx24x5')).toBe(false);
    expect(isMarketOpen(W_SUN + 22 * H1, 'fx24x5')).toBe(true);
  });

  it('reopens Sunday 17:00 NY = 21:00 UTC in summer', () => {
    expect(isMarketOpen(S_SUN + 20 * H1 + 59 * M1, 'fx24x5')).toBe(false);
    expect(isMarketOpen(S_SUN + 21 * H1, 'fx24x5')).toBe(true);
    // An hour of real trading the fixed-UTC rule used to discard as "closed".
    expect(isMarketOpen(S_SUN + 21 * H1 + 30 * M1, 'fx24x5')).toBe(true);
  });

  it('honours daily breaks from a custom window', () => {
    const withBreak: SessionWindow = {
      ...FX_SESSION,
      dailyBreaks: [{ fromMinute: 17 * 60, toMinute: 18 * 60 }],
    };
    // Wednesday 16:30 NY (21:30 UTC winter) is open; 17:30 NY is inside the break.
    expect(isMarketOpen(W_MON + 2 * 24 * H1 + 21 * H1 + 30 * M1, 'fx24x5', withBreak)).toBe(true);
    expect(isMarketOpen(W_MON + 2 * 24 * H1 + 22 * H1 + 30 * M1, 'fx24x5', withBreak)).toBe(false);
  });

  it('resolves a window for every session type', () => {
    expect(sessionFor('fx24x5')).toBe(FX_SESSION);
    expect(sessionFor('crypto24x7').timeZone).toBe('UTC');
  });
});

describe('openMinutesBetween', () => {
  it('counts every minute for crypto', () => {
    expect(openMinutesBetween(W_FRI + 20 * H1, W_NEXT_MON, 'crypto24x7')).toBe(3120);
  });

  it('is zero or negative-safe for an empty or inverted range', () => {
    expect(openMinutesBetween(W_MON, W_MON, 'fx24x5')).toBe(0);
    expect(openMinutesBetween(W_MON + M1, W_MON, 'fx24x5')).toBe(0);
  });

  it('counts a plain weekday exactly', () => {
    expect(openMinutesBetween(W_MON, W_MON + 24 * H1, 'fx24x5')).toBe(1440);
  });

  it('is zero across a fully closed weekend', () => {
    expect(openMinutesBetween(W_FRI + 22 * H1, W_SUN + 22 * H1, 'fx24x5')).toBe(0);
    expect(openMinutesBetween(S_FRI + 21 * H1, S_SUN + 21 * H1, 'fx24x5')).toBe(0);
  });

  it('skips the fx weekend, at the right UTC hour in each season', () => {
    // Winter: Fri 20:00 -> Fri 22:00 = 120 open, plus Sun 22:00 -> Mon 00:00 = 120.
    expect(openMinutesBetween(W_FRI + 20 * H1, W_NEXT_MON, 'fx24x5')).toBe(240);
    // Summer: the same clock hours give 60 + 180, because the boundary is an hour earlier.
    expect(openMinutesBetween(S_FRI + 20 * H1, S_NEXT_MON, 'fx24x5')).toBe(240);
    expect(openMinutesBetween(S_FRI + 20 * H1, S_FRI + 22 * H1, 'fx24x5')).toBe(60);
  });

  it('gives every fx week exactly five days of open time, in both seasons', () => {
    expect(openMinutesBetween(W_SUN + 22 * H1, W_SUN + 22 * H1 + 7 * 24 * H1, 'fx24x5')).toBe(7200);
    expect(openMinutesBetween(S_SUN + 21 * H1, S_SUN + 21 * H1 + 7 * 24 * H1, 'fx24x5')).toBe(7200);
  });

  it('makes the spring-forward weekend an hour shorter than a normal one', () => {
    // Fri 2024-03-08 22:00 UTC (17:00 EST) -> Sun 2024-03-10 21:00 UTC (17:00 EDT) is
    // 47 real hours of closed market, not 48. A fixed-UTC session cannot express that.
    const friClose = Date.UTC(2024, 2, 8, 22);
    const sunOpen = Date.UTC(2024, 2, 10, 21);
    expect(sunOpen - friClose).toBe(47 * H1);
    expect(openMinutesBetween(friClose, sunOpen, 'fx24x5')).toBe(0);
    expect(isMarketOpen(sunOpen - M1, 'fx24x5')).toBe(false);
    expect(isMarketOpen(sunOpen, 'fx24x5')).toBe(true);
  });

  it('agrees with a brute-force minute count over a full week', () => {
    for (const weekStart of [W_MON, S_MON]) {
      let brute = 0;
      for (let t = weekStart; t < weekStart + 7 * 24 * H1; t += M1) {
        if (isMarketOpen(t, 'fx24x5')) brute += 1;
      }
      expect(openMinutesBetween(weekStart, weekStart + 7 * 24 * H1, 'fx24x5')).toBe(brute);
    }
  });

  it('agrees with brute force across both DST transitions', () => {
    // The hour-stepping fast path must not drift where the local day is 23 or 25 hours long.
    for (const start of [Date.UTC(2024, 2, 8), Date.UTC(2024, 10, 1)]) {
      let brute = 0;
      for (let t = start; t < start + 5 * 24 * H1; t += M1) {
        if (isMarketOpen(t, 'fx24x5')) brute += 1;
      }
      expect(openMinutesBetween(start, start + 5 * 24 * H1, 'fx24x5')).toBe(brute);
    }
  });

  it('agrees with brute force on a sub-hour, unaligned range spanning the Friday close', () => {
    const from = W_FRI + 21 * H1 + 37 * M1;
    const to = W_FRI + 22 * H1 + 11 * M1;
    let brute = 0;
    for (let t = from; t < to; t += M1) if (isMarketOpen(t, 'fx24x5')) brute += 1;
    expect(openMinutesBetween(from, to, 'fx24x5')).toBe(brute);
    expect(brute).toBe(23);
  });
});

describe('deriveSessionFromBars', () => {
  it('refuses to guess from too little data', () => {
    expect(deriveSessionFromBars([W_MON, W_MON + M1])).toBeNull();
  });

  it('recovers the fx week from bars generated by the session itself', () => {
    const times: number[] = [];
    for (let t = W_SUN + 22 * H1; t < W_SUN + 22 * H1 + 7 * 24 * H1; t += M1) {
      if (isMarketOpen(t, 'fx24x5')) times.push(t);
    }
    const derived = deriveSessionFromBars(times);
    expect(derived).not.toBeNull();
    expect(derived).toEqual({
      openDay: 0,
      openMinute: 17 * 60,
      closeDay: 5,
      // The last bar OPENS at 16:59 and covers the minute to 17:00.
      closeMinute: 17 * 60,
    });
  });
});
