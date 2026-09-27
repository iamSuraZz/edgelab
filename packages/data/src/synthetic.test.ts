import { describe, expect, it } from 'vitest';

import { syntheticM1 } from './synthetic';

/**
 * The synthetic generator CI depends on.
 *
 * Each assertion here corresponds to a way the series could pass the bar-count precondition and
 * then break something downstream for reasons that look like an engine bug.
 */

const JAN = Date.UTC(2024, 0, 1);
const FEB = Date.UTC(2024, 1, 1);

describe('syntheticM1', () => {
  it('produces enough bars for the e2e and smoke preconditions', () => {
    // Both suites assert EURUSD has more than 10,000 stored bars.
    expect(syntheticM1({ fromMs: JAN, toMs: FEB }).length).toBeGreaterThan(10_000);
  });

  it('is deterministic', () => {
    // A CI failure has to be reproducible locally, which it is not if the series moves.
    const a = syntheticM1({ fromMs: JAN, toMs: FEB });
    const b = syntheticM1({ fromMs: JAN, toMs: FEB });
    expect(a).toEqual(b);
  });

  it('emits no bar that the filler rule would drop', () => {
    // D4 drops bars that are BOTH flat and zero-volume. A generator that emitted them would be
    // silently discarded at import and leave coverage at zero.
    const bars = syntheticM1({ fromMs: JAN, toMs: FEB });
    expect(bars.filter((b) => b.high === b.low && b.volume === 0)).toEqual([]);
    expect(bars.every((b) => b.volume > 0)).toBe(true);
  });

  it('skips weekends, because forex is closed', () => {
    const bars = syntheticM1({ fromMs: JAN, toMs: FEB });
    const days = new Set(bars.map((b) => new Date(b.time).getUTCDay()));
    expect(days.has(0)).toBe(false);
    expect(days.has(6)).toBe(false);
  });

  it('is strictly ascending with no duplicate timestamps', () => {
    // The resampler throws on duplicates rather than merging them.
    const bars = syntheticM1({ fromMs: JAN, toMs: FEB });
    for (let i = 1; i < bars.length; i += 1) {
      expect(bars[i]!.time).toBeGreaterThan(bars[i - 1]!.time);
    }
  });

  it('keeps every bar internally coherent', () => {
    // high >= max(open, close) and low <= min(open, close), or the bar-integrity check fails.
    for (const b of syntheticM1({ fromMs: JAN, toMs: FEB })) {
      expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
      expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
    }
  });

  it('actually moves, so a strategy has something to trade', () => {
    // The smoke test clicks a trade. A flat series produces none and the failure looks like a
    // broken engine rather than a lifeless fixture.
    const closes = syntheticM1({ fromMs: JAN, toMs: FEB }).map((b) => b.close);
    const spread = Math.max(...closes) - Math.min(...closes);
    // Well over 100 pips of range across the month.
    expect(spread).toBeGreaterThan(0.01);
  });

  it('carries a spread that is distinguishable from the symbol default', () => {
    // EURUSD's default is 8 points. Using 3 means a run that silently falls back to the default is
    // detectable rather than coincidentally identical — the exact bug that hid for weeks.
    const bars = syntheticM1({ fromMs: JAN, toMs: FEB, mintick: 0.00001, spread: 0.00003 });
    expect(bars.every((b) => b.spread === 0.00003)).toBe(true);
  });

  it('snaps prices to the instrument tick', () => {
    const bars = syntheticM1({ fromMs: JAN, toMs: JAN + 60 * 60_000, mintick: 0.001 });
    for (const b of bars) {
      expect(Math.abs(Math.round(b.open / 0.001) * 0.001 - b.open)).toBeLessThan(1e-9);
    }
  });

  it('returns nothing for an empty or inverted window', () => {
    expect(syntheticM1({ fromMs: FEB, toMs: JAN })).toEqual([]);
    expect(syntheticM1({ fromMs: JAN, toMs: JAN })).toEqual([]);
  });
});
