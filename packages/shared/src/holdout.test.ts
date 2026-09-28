import { describe, expect, it } from 'vitest';

import { describeHoldout, effectiveWindow, sealInstant, type Holdout } from './holdout';

/**
 * The seal has one job: never hand back a sealed bar while reporting the requested range. Everything
 * else about it is bookkeeping.
 */

const DAY = 24 * 60 * 60_000;
const SEAL_AT = Date.UTC(2023, 6, 1);

const HOLDOUT: Holdout = {
  symbolId: 's1',
  sealedFromMs: SEAL_AT,
  createdAtMs: 0,
  viewCount: 0,
  lastViewedAtMs: null,
};

describe('effectiveWindow', () => {
  it('leaves a request entirely before the seal alone', () => {
    const w = effectiveWindow(SEAL_AT - 30 * DAY, SEAL_AT - DAY, HOLDOUT);
    expect(w.truncated).toBe(false);
    expect(w.toMs).toBe(SEAL_AT - DAY);
  });

  it('treats a request ending exactly at the seal as untouched', () => {
    // The sealed region starts AT the instant, so a half-open window ending there takes no bar.
    const w = effectiveWindow(SEAL_AT - 30 * DAY, SEAL_AT, HOLDOUT);
    expect(w.truncated).toBe(false);
  });

  it('truncates a request that reaches past the seal', () => {
    const w = effectiveWindow(SEAL_AT - 10 * DAY, SEAL_AT + 20 * DAY, HOLDOUT);

    expect(w.truncated).toBe(true);
    expect(w.toMs).toBe(SEAL_AT);
    expect(w.withheldMs).toBe(20 * DAY);
    expect(w.empty).toBe(false);
  });

  it('returns an EMPTY window, never a negative one, for a request wholly inside the seal', () => {
    const w = effectiveWindow(SEAL_AT + DAY, SEAL_AT + 10 * DAY, HOLDOUT);

    expect(w.empty).toBe(true);
    expect(w.toMs).toBe(w.fromMs);
    expect(w.toMs - w.fromMs).toBe(0);
    expect(w.withheldMs).toBe(9 * DAY);
  });

  it('passes everything through when no holdout is sealed', () => {
    const w = effectiveWindow(0, SEAL_AT + 100 * DAY, null);
    expect(w.truncated).toBe(false);
    expect(w.toMs).toBe(SEAL_AT + 100 * DAY);
  });
});

describe('sealInstant', () => {
  it('reserves the requested share of the stored range', () => {
    const earliest = Date.UTC(2022, 0, 1);
    const latest = Date.UTC(2024, 0, 1);
    const at = sealInstant(earliest, latest, 0.2);

    expect(at).toBe(Math.round(latest - (latest - earliest) * 0.2));
    expect(at).toBeGreaterThan(earliest);
    expect(at).toBeLessThan(latest);
  });

  it('refuses a fraction outside (0, 1)', () => {
    expect(() => sealInstant(0, 100, 0)).toThrow(RangeError);
    expect(() => sealInstant(0, 100, 1)).toThrow(RangeError);
    expect(() => sealInstant(0, 100, 1.5)).toThrow(RangeError);
  });
});

describe('describeHoldout', () => {
  it('says plainly when a holdout has never been viewed', () => {
    expect(describeHoldout(HOLDOUT)).toContain('never viewed');
  });

  it('says plainly that each view weakens it', () => {
    const viewed = { ...HOLDOUT, viewCount: 3, lastViewedAtMs: SEAL_AT };
    const text = describeHoldout(viewed);

    expect(text).toContain('viewed 3 time(s)');
    expect(text).toContain('in-sample data');
  });

  it('does not invent a holdout that was never sealed', () => {
    expect(describeHoldout(null)).toContain('No holdout');
  });
});
