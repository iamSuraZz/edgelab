import { describe, expect, it } from 'vitest';

import { SpliceNotPossibleError, pickDonor, spliceFuture, type SpliceBar } from './future-splice';

/**
 * Future splicing.
 *
 * The properties that make this test able to catch what truncation cannot are: nothing is removed,
 * the timestamps are untouched, and the graft continues from the cutoff price. Each is asserted,
 * because losing any one of them turns the check back into truncation with extra steps.
 */

const M1 = 60_000;
const T0 = Date.UTC(2024, 0, 2);

function series(count: number, start: number, step: number): SpliceBar[] {
  return Array.from({ length: count }, (_, i) => ({
    time: T0 + i * M1,
    open: start + i * step,
    high: start + i * step + 0.0002,
    low: start + i * step - 0.0002,
    close: start + i * step + 0.0001,
    volume: 100 + i,
    spread: 0.00003,
  }));
}

describe('spliceFuture', () => {
  const bars = series(100, 1.1, 0.0001);
  const donor = series(100, 2.5, -0.0003); // a different level AND a different direction

  it('keeps every timestamp and the exact length', () => {
    // The defining difference from truncation. If this fails, the check has become truncation.
    const out = spliceFuture({ bars, cutoffMs: bars[49]!.time, donor });

    expect(out.bars).toHaveLength(bars.length);
    expect(out.bars.map((b) => b.time)).toEqual(bars.map((b) => b.time));
  });

  it('leaves bars at or before the cutoff byte-identical', () => {
    // This is what makes a divergence attributable: a causal strategy read nothing else.
    const cutoff = bars[49]!.time;
    const out = spliceFuture({ bars, cutoffMs: cutoff, donor });

    expect(out.bars.slice(0, 50)).toEqual(bars.slice(0, 50));
    expect(out.kept).toBe(50);
    expect(out.spliced).toBe(50);
  });

  it('replaces every bar after the cutoff', () => {
    const out = spliceFuture({ bars, cutoffMs: bars[49]!.time, donor });

    for (let i = 50; i < bars.length; i += 1) {
      expect(out.bars[i]!.close).not.toBeCloseTo(bars[i]!.close, 9);
    }
  });

  it('continues from the cutoff price rather than jumping', () => {
    // A graft that opened at the donor's own level would be a gap no instrument made, and a
    // strategy could react to the gap instead of to the leak.
    const cutoff = bars[49]!.time;
    const out = spliceFuture({ bars, cutoffMs: cutoff, donor });

    const anchor = bars[49]!.close;
    expect(out.bars[50]!.open).toBeCloseTo(anchor, 9);
    expect(out.scale).toBeCloseTo(anchor / donor[0]!.open, 12);
  });

  it('rescales multiplicatively, preserving the donor’s relative moves', () => {
    const out = spliceFuture({ bars, cutoffMs: bars[49]!.time, donor });

    // Bar-to-bar RATIOS in the grafted region must match the donor's exactly.
    const donorRatio = donor[5]!.close / donor[4]!.close;
    const graftRatio = out.bars[55]!.close / out.bars[54]!.close;
    expect(graftRatio).toBeCloseTo(donorRatio, 12);
  });

  it('keeps high >= low and the bar internally coherent after rescaling', () => {
    const out = spliceFuture({ bars, cutoffMs: bars[49]!.time, donor });

    for (const b of out.bars) {
      expect(b.high).toBeGreaterThanOrEqual(b.low);
      expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
      expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
    }
  });

  it('takes the spread from the donor, not the original', () => {
    // The original's spread is a real number from the future being hidden; carrying it over would
    // leak one field of exactly what the test conceals.
    const spreadyDonor = donor.map((d) => ({ ...d, spread: 0.00009 }));
    const out = spliceFuture({ bars, cutoffMs: bars[49]!.time, donor: spreadyDonor });

    expect(out.bars[50]!.spread).toBe(0.00009);
    expect(out.bars[49]!.spread).toBe(0.00003);
  });

  it('splices nothing when the cutoff is at or past the end', () => {
    const out = spliceFuture({ bars, cutoffMs: bars[bars.length - 1]!.time, donor });

    expect(out.spliced).toBe(0);
    expect(out.bars).toEqual(bars);
  });

  it('refuses a donor shorter than the tail', () => {
    // Repeating a short donor would create a periodic future, which is a pattern a strategy could
    // legitimately detect — and then the "leak" it reports would be our own artefact.
    expect(() =>
      spliceFuture({ bars, cutoffMs: bars[10]!.time, donor: series(5, 2.5, 0.0001) }),
    ).toThrow(SpliceNotPossibleError);
  });

  it('refuses a cutoff before the series starts', () => {
    expect(() => spliceFuture({ bars, cutoffMs: T0 - M1, donor })).toThrow(SpliceNotPossibleError);
  });

  it('refuses to rescale from a non-positive price', () => {
    const zeroDonor = [{ ...donor[0]!, open: 0 }, ...donor.slice(1)];
    expect(() => spliceFuture({ bars, cutoffMs: bars[10]!.time, donor: zeroDonor })).toThrow(
      SpliceNotPossibleError,
    );
  });
});

describe('pickDonor', () => {
  const bars = series(100, 1.1, 0.0001);

  it('returns a window disjoint from everything at or after the cutoff', () => {
    const cutoff = bars[60]!.time;
    const donor = pickDonor(bars, cutoff, 20);

    expect(donor).not.toBeNull();
    // Every donor bar must predate the cutoff, or the donor IS the future it stands in for and the
    // test is silently vacuous.
    for (const d of donor!) expect(d.time).toBeLessThan(cutoff);
  });

  it('takes the oldest bars available', () => {
    const donor = pickDonor(bars, bars[60]!.time, 10);
    expect(donor![0]!.time).toBe(bars[0]!.time);
  });

  it('returns null when history cannot spare a disjoint window', () => {
    // Better to report n/a than to splice with data that overlaps the tested region.
    expect(pickDonor(bars, bars[5]!.time, 50)).toBeNull();
    expect(pickDonor(bars, T0 - M1, 10)).toBeNull();
  });

  it('produces a donor that spliceFuture accepts', () => {
    const cutoff = bars[49]!.time;
    const needed = bars.length - 50;
    const donor = pickDonor(bars, cutoff, needed);

    expect(donor).not.toBeNull();
    expect(() => spliceFuture({ bars, cutoffMs: cutoff, donor: donor! })).not.toThrow();
  });
});
