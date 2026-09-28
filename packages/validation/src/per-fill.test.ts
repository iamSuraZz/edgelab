import { describe, expect, it } from 'vitest';

import { breakdownByGap, classifyGap, describePerFill, perFillFigures } from './per-fill';

/**
 * The gap classifier is calendar arithmetic done by hand, so it is pinned against known dates
 * rather than against itself. 2022-01-07 was a Friday and 2022-01-10 a Monday.
 */

const SCALE = { mintick: 0.00001, pipSize: 0.0001 };
const H1 = 3_600_000;

const FRI_2200 = Date.UTC(2022, 0, 7, 22, 0);
const MON_0000 = Date.UTC(2022, 0, 10, 0, 0);

describe('classifyGap', () => {
  it('calls one timeframe step normal', () => {
    expect(classifyGap(Date.UTC(2022, 0, 5, 10, 0), Date.UTC(2022, 0, 5, 11, 0), H1)).toBe(
      'normal',
    );
  });

  it('tolerates a bucket landing slightly off its nominal step', () => {
    expect(classifyGap(Date.UTC(2022, 0, 5, 10, 0), Date.UTC(2022, 0, 5, 11, 20), H1)).toBe(
      'normal',
    );
  });

  it('calls a Friday-to-Monday gap a weekend', () => {
    expect(classifyGap(FRI_2200, MON_0000, H1)).toBe('weekend');
  });

  it('calls a mid-week overnight gap a session gap', () => {
    // Tuesday 22:00 to Wednesday 01:00 — three hours on an H1 chart, no Saturday crossed.
    expect(classifyGap(Date.UTC(2022, 0, 4, 22, 0), Date.UTC(2022, 0, 5, 1, 0), H1)).toBe(
      'session',
    );
  });

  it('calls a Friday-to-Monday DAILY step a weekend, which no duration threshold would', () => {
    const D1 = 24 * 60 * 60_000;
    // Three days apart: indistinguishable from an ordinary D1 step by duration alone.
    expect(classifyGap(Date.UTC(2022, 0, 7), Date.UTC(2022, 0, 10), D1)).toBe('weekend');
  });

  it('does not call an ordinary weekday D1 step a weekend', () => {
    const D1 = 24 * 60 * 60_000;
    expect(classifyGap(Date.UTC(2022, 0, 4), Date.UTC(2022, 0, 5), D1)).toBe('normal');
  });
});

describe('perFillFigures', () => {
  it('reports pips and ticks from the price gap, not from money', () => {
    // Two fills, each a 1.3-pip adverse move.
    const f = perFillFigures([0.00013, 0.00013], 25.16, SCALE);
    expect(f.fills).toBe(2);
    expect(f.moneyPerFill).toBeCloseTo(12.58, 6);
    expect(f.pipsPerFill).toBeCloseTo(1.3, 9);
    expect(f.ticksPerFill).toBeCloseTo(13, 9);
  });

  it('lets a signed mean cancel, because that is itself the finding', () => {
    const f = perFillFigures([0.0001, -0.0001], 0, SCALE);
    expect(f.pipsPerFill).toBeCloseTo(0, 12);
  });

  it('returns nulls rather than NaN for no fills', () => {
    const f = perFillFigures([], 0, SCALE);
    expect(f.moneyPerFill).toBeNull();
    expect(f.pipsPerFill).toBeNull();
    expect(describePerFill(f)).toContain('No fills');
  });
});

describe('breakdownByGap', () => {
  it('splits by gap type and drops empty buckets', () => {
    const rows = breakdownByGap(
      [
        { gap: 'normal', priceGap: 0.0001, money: 10 },
        { gap: 'normal', priceGap: 0.0001, money: 10 },
        { gap: 'weekend', priceGap: 0.002, money: 200 },
      ],
      SCALE,
    );

    expect(rows.map((r) => r.type)).toEqual(['normal', 'weekend']);
    expect(rows[0]!.fills).toBe(2);
    expect(rows[0]!.figures.pipsPerFill).toBeCloseTo(1, 9);
    expect(rows[1]!.figures.pipsPerFill).toBeCloseTo(20, 9);
  });

  it('shows when one bucket carries the whole total', () => {
    const rows = breakdownByGap(
      [
        { gap: 'normal', priceGap: 0.00001, money: 1 },
        { gap: 'weekend', priceGap: 0.005, money: 500 },
      ],
      SCALE,
    );
    const weekend = rows.find((r) => r.type === 'weekend')!;
    expect(weekend.totalMoney / (1 + 500)).toBeGreaterThan(0.99);
  });
});
