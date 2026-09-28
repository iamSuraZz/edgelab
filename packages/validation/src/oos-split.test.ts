import { describe, expect, it } from 'vitest';

import { analyseOosSplit, returnPerDay, splitInstant, type SegmentMetrics } from './oos-split';

/**
 * The trap this check has to avoid is the one A24 named for walk-forward efficiency: a ratio
 * against a non-positive baseline. Two losses divide into a flattering positive number, so the
 * denominator has to be guarded rather than the result inspected afterwards.
 */

const FROM = Date.UTC(2022, 0, 1);
const TO = Date.UTC(2024, 0, 1);

function seg(over: Partial<SegmentMetrics> = {}): SegmentMetrics {
  return {
    fromMs: FROM,
    toMs: TO,
    trades: 50,
    netProfit: 1000,
    returnPct: 10,
    profitFactor: 1.5,
    sharpe: 0.8,
    winRatePct: 55,
    maxDrawdownPct: 12,
    expectancy: 20,
    ...over,
  };
}

const split = { splitMs: Date.UTC(2023, 6, 1), splitFraction: 0.7 };

describe('splitInstant', () => {
  it('cuts the window at the given share', () => {
    expect(splitInstant(0, 1000, 0.7)).toBe(700);
  });
});

describe('analyseOosSplit — the edge held', () => {
  it('passes when out-of-sample keeps most of the return', () => {
    const r = analyseOosSplit({
      ...split,
      inSample: seg({ returnPct: 10, netProfit: 1000 }),
      outOfSample: seg({ returnPct: 8, netProfit: 800 }),
    });

    expect(r.verdict).toBe('pass');
    expect(r.degradation.returnRatio).toBeCloseTo(0.8, 9);
  });

  it('passes when out-of-sample beats in-sample', () => {
    const r = analyseOosSplit({
      ...split,
      inSample: seg({ returnPct: 10 }),
      outOfSample: seg({ returnPct: 14 }),
    });
    expect(r.verdict).toBe('pass');
    expect(r.degradation.returnRatio).toBeCloseTo(1.4, 9);
  });
});

describe('analyseOosSplit — the edge did not hold', () => {
  it('fails on a sign flip', () => {
    const r = analyseOosSplit({
      ...split,
      inSample: seg({ netProfit: 1000, returnPct: 10 }),
      outOfSample: seg({ netProfit: -400, returnPct: -4, profitFactor: 0.7 }),
    });

    expect(r.verdict).toBe('fail');
    expect(r.explanation).toContain('did not survive');
    expect(r.explanation).toContain('1.50 -> 0.70');
  });

  it('warns when most of the edge sits in the in-sample half', () => {
    const r = analyseOosSplit({
      ...split,
      inSample: seg({ returnPct: 10, netProfit: 1000 }),
      outOfSample: seg({ returnPct: 3, netProfit: 300 }),
    });

    expect(r.verdict).toBe('warn');
    expect(r.explanation).toContain('30%');
  });
});

describe('analyseOosSplit — nothing to test', () => {
  it('is n/a when the in-sample half lost money', () => {
    const r = analyseOosSplit({
      ...split,
      inSample: seg({ netProfit: -500, returnPct: -5 }),
      outOfSample: seg({ netProfit: -200, returnPct: -2 }),
    });

    expect(r.verdict).toBe('n/a');
    expect(r.explanation).toContain('nothing to overfit to');
  });

  it('never turns two losses into a flattering ratio', () => {
    const r = analyseOosSplit({
      ...split,
      inSample: seg({ netProfit: -500, returnPct: -5 }),
      outOfSample: seg({ netProfit: -200, returnPct: -2 }),
    });

    // -2 / -5 would read as 0.4 "kept", which is meaningless for two losing halves.
    expect(r.degradation.returnRatio).toBeNull();
  });

  it('is n/a when either segment is too small to mean anything', () => {
    const few = analyseOosSplit({
      ...split,
      inSample: seg({ trades: 50 }),
      outOfSample: seg({ trades: 4 }),
    });

    expect(few.verdict).toBe('n/a');
    expect(few.inconclusiveReason).toContain('Too few trades');
  });

  it('respects a caller-set minimum', () => {
    const r = analyseOosSplit({
      ...split,
      inSample: seg({ trades: 8 }),
      outOfSample: seg({ trades: 8 }),
      minTradesPerSegment: 5,
    });
    expect(r.verdict).not.toBe('n/a');
  });
});

describe('analyseOosSplit — degradation figures', () => {
  it('uses signed differences where a ratio would mislead', () => {
    const r = analyseOosSplit({
      ...split,
      inSample: seg({ sharpe: 0.8, winRatePct: 55 }),
      outOfSample: seg({ sharpe: -0.2, winRatePct: 41 }),
    });

    expect(r.degradation.sharpeDelta).toBeCloseTo(-1, 9);
    expect(r.degradation.winRateDelta).toBeCloseTo(-14, 9);
  });

  it('returns null rather than a number when a metric is undefined', () => {
    const r = analyseOosSplit({
      ...split,
      inSample: seg({ profitFactor: null }),
      outOfSample: seg({ profitFactor: 1.2 }),
    });
    expect(r.degradation.profitFactorRatio).toBeNull();
  });
});

describe('analyseOosSplit — unstable ratio', () => {
  it('withholds the ratio when the in-sample return was near zero', () => {
    // Measured on a real fixture: an in-sample return of 0.1% against 1.9% out of sample reads as
    // "kept 1911%", which is a division result rather than a finding.
    const r = analyseOosSplit({
      ...split,
      inSample: seg({ returnPct: 0.1, netProfit: 10, profitFactor: 1.01 }),
      outOfSample: seg({ returnPct: 1.9, netProfit: 190, profitFactor: 1.43 }),
    });

    expect(r.verdict).toBe('pass');
    expect(r.degradation.returnRatioStable).toBe(false);
    expect(r.explanation).not.toContain('1911');
    expect(r.explanation).toContain('not reported');
  });

  it('still reports the ratio when the in-sample return is substantial', () => {
    const r = analyseOosSplit({
      ...split,
      inSample: seg({ returnPct: 10 }),
      outOfSample: seg({ returnPct: 8 }),
    });
    expect(r.degradation.returnRatioStable).toBe(true);
    expect(r.explanation).toContain('80%');
  });
});

describe('returnPerDay and window-length normalisation', () => {
  const DAY = 24 * 60 * 60_000;

  it('scores an unchanged strategy at 1.0, not at the window ratio', () => {
    // 3:1 windows. 12% over 90 days is the same RATE as 4% over 30 days.
    const r = analyseOosSplit({
      ...split,
      inSample: seg({ fromMs: 0, toMs: 90 * DAY, returnPct: 12, netProfit: 1200 }),
      outOfSample: seg({ fromMs: 90 * DAY, toMs: 120 * DAY, returnPct: 4, netProfit: 400 }),
    });

    // Dividing raw returns would give 0.33 and read as severe decay.
    expect(r.degradation.returnRatio).toBeCloseTo(1, 9);
    expect(r.verdict).toBe('pass');
  });

  it('still reports genuine decay', () => {
    const r = analyseOosSplit({
      ...split,
      inSample: seg({ fromMs: 0, toMs: 90 * DAY, returnPct: 12, netProfit: 1200 }),
      outOfSample: seg({ fromMs: 90 * DAY, toMs: 120 * DAY, returnPct: 1, netProfit: 100 }),
    });

    expect(r.degradation.returnRatio).toBeCloseTo(0.25, 9);
    expect(r.verdict).toBe('warn');
  });

  it('divides simply rather than compounding', () => {
    // 12% over 40 days is 0.3%/day. A geometric de-compounding would give ~0.283%/day, and the
    // difference grows with the window's return — which is exactly where a short fold is spikiest.
    expect(returnPerDay(seg({ fromMs: 0, toMs: 40 * DAY, returnPct: 12 }))).toBeCloseTo(0.3, 12);
  });

  it('keeps A24’s guard on the RAW in-sample return, not the normalised one', () => {
    const r = analyseOosSplit({
      ...split,
      inSample: seg({ fromMs: 0, toMs: 90 * DAY, returnPct: -5, netProfit: -500 }),
      outOfSample: seg({ fromMs: 90 * DAY, toMs: 120 * DAY, returnPct: -1, netProfit: -100 }),
    });
    expect(r.degradation.returnRatio).toBeNull();
    expect(r.verdict).toBe('n/a');
  });

  it('is null for a zero-length window rather than infinite', () => {
    expect(returnPerDay(seg({ fromMs: 5, toMs: 5 }))).toBeNull();
  });
});
