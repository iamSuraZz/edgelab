import { describe, expect, it } from 'vitest';

import { analyseHoldoutTest } from './holdout-test';
import type { SegmentMetrics } from './oos-split';

const DAY = 24 * 60 * 60_000;

function segment(over: Partial<SegmentMetrics> & { days: number }): SegmentMetrics {
  const { days, ...rest } = over;
  return {
    fromMs: 0,
    toMs: days * DAY,
    trades: 40,
    netProfit: 1_000,
    returnPct: 10,
    profitFactor: 1.5,
    sharpe: 1,
    winRatePct: 55,
    maxDrawdownPct: 5,
    expectancy: 25,
    ...rest,
  };
}

describe('analyseHoldoutTest', () => {
  const inSample = segment({ days: 180, returnPct: 18, netProfit: 1_800 });

  it('passes when the edge holds at a comparable rate on the first look', () => {
    // 18% over 180 days vs 4.5% over 45: the same 0.1%/day, so retention is 1.0.
    const r = analyseHoldoutTest({
      inSample,
      holdout: segment({ days: 45, returnPct: 4.5, netProfit: 450 }),
      viewCountAfter: 1,
    });

    expect(r.verdict).toBe('pass');
    expect(r.retention).toBeCloseTo(1, 5);
  });

  it('compares per calendar day, so a shorter holdout is not scored as decay (A36)', () => {
    // Raw returns would read 4.5/18 = 0.25 and look like a collapse; the rate is unchanged.
    const r = analyseHoldoutTest({
      inSample,
      holdout: segment({ days: 45, returnPct: 4.5, netProfit: 450 }),
      viewCountAfter: 1,
    });

    expect(r.inSamplePerDay).toBeCloseTo(0.1, 6);
    expect(r.holdoutPerDay).toBeCloseTo(0.1, 6);
  });

  it('fails on a sign flip, which is the result a holdout exists to produce', () => {
    const r = analyseHoldoutTest({
      inSample,
      holdout: segment({ days: 45, returnPct: -3, netProfit: -300 }),
      viewCountAfter: 1,
    });

    expect(r.verdict).toBe('fail');
    expect(r.explanation).toMatch(/did not survive/i);
  });

  it('warns when the edge survives at well under half its rate', () => {
    const r = analyseHoldoutTest({
      inSample,
      holdout: segment({ days: 45, returnPct: 1, netProfit: 100 }),
      viewCountAfter: 1,
    });

    expect(r.verdict).toBe('warn');
    expect(r.retention).toBeLessThan(0.5);
  });

  it('downgrades a clean pass to warn once the holdout has been viewed more than once', () => {
    // Identical numbers, different history — the arithmetic cannot tell these apart, so the count
    // has to carry the distinction or it is lost.
    const holdout = segment({ days: 45, returnPct: 4.5, netProfit: 450 });

    expect(analyseHoldoutTest({ inSample, holdout, viewCountAfter: 1 }).verdict).toBe('pass');

    const second = analyseHoldoutTest({ inSample, holdout, viewCountAfter: 2 });
    expect(second.verdict).toBe('warn');
    expect(second.explanation).toMatch(/viewed|looked at 2 times/i);
  });

  it('does not soften a FAIL for a repeat view — a loss is a loss however often you look', () => {
    const r = analyseHoldoutTest({
      inSample,
      holdout: segment({ days: 45, returnPct: -3, netProfit: -300 }),
      viewCountAfter: 5,
    });

    expect(r.verdict).toBe('fail');
  });

  it('is n/a when the strategy made nothing in sample, with nothing to overfit', () => {
    const r = analyseHoldoutTest({
      inSample: segment({ days: 180, returnPct: -4, netProfit: -400 }),
      holdout: segment({ days: 45, returnPct: 2, netProfit: 200 }),
      viewCountAfter: 1,
    });

    expect(r.verdict).toBe('n/a');
    expect(r.inconclusiveReason).toMatch(/nothing was fitted/i);
  });

  it('is n/a on too few trades rather than scoring two small samples', () => {
    const r = analyseHoldoutTest({
      inSample,
      holdout: segment({ days: 45, trades: 3, returnPct: 4.5 }),
      viewCountAfter: 1,
    });

    expect(r.verdict).toBe('n/a');
    expect(r.inconclusiveReason).toMatch(/too few trades/i);
  });

  it('states the cost even when the result is inconclusive', () => {
    // The look was spent whatever came back; reporting it only on success would make the
    // cheapest-looking outcome the one that quietly burned the holdout.
    const r = analyseHoldoutTest({
      inSample,
      holdout: segment({ days: 45, trades: 3 }),
      viewCountAfter: 1,
    });

    expect(r.explanation).toMatch(/spent|first look/i);
  });

  it('withholds the retention rather than reporting a ratio against a non-positive baseline', () => {
    const r = analyseHoldoutTest({
      inSample: segment({ days: 180, returnPct: 0, netProfit: 0 }),
      holdout: segment({ days: 45, returnPct: 4.5 }),
      viewCountAfter: 1,
    });

    expect(r.retention).toBeNull();
    expect(r.verdict).toBe('n/a');
  });
});
