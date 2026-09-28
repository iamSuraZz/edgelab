import { describe, expect, it } from 'vitest';

import type { SegmentMetrics } from './oos-split';
import { analyseRollingOos, foldWindows } from './rolling-oos';

/**
 * Walk-forward asks the persistence question repeatedly, so the thing it must not do is let a
 * structurally short fold masquerade as a failure — and it must never divide by a non-positive
 * in-sample return (A24).
 */

function seg(over: Partial<SegmentMetrics> = {}): SegmentMetrics {
  return {
    fromMs: 0,
    toMs: 1,
    trades: 20,
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

/** A fold that trained profitably and kept it. */
const held = { inSample: seg(), outOfSample: seg({ returnPct: 8, netProfit: 800 }) };
/** A fold that trained profitably and reversed. */
const lost = { inSample: seg(), outOfSample: seg({ returnPct: -4, netProfit: -400 }) };

describe('foldWindows', () => {
  it('lays out rolling folds with no gap or overlap between test windows', () => {
    const w = foldWindows(0, 700, 4, 3);

    expect(w).toHaveLength(4);
    expect(w[0]).toEqual({ index: 0, isFromMs: 0, isToMs: 300, oosFromMs: 300, oosToMs: 400 });
    expect(w[1]!.oosFromMs).toBe(w[0]!.oosToMs);
    expect(w[3]!.oosToMs).toBe(700);
  });

  it('keeps every in-sample window the same width, so folds stay comparable', () => {
    const widths = foldWindows(0, 700, 4, 3).map((f) => f.isToMs - f.isFromMs);
    expect(new Set(widths).size).toBe(1);
  });

  it('rolls the training window forward rather than anchoring it', () => {
    const w = foldWindows(0, 700, 4, 3);
    expect(w[1]!.isFromMs).toBeGreaterThan(w[0]!.isFromMs);
  });
});

describe('analyseRollingOos — verdicts', () => {
  it('passes when the edge holds in most folds', () => {
    const r = analyseRollingOos({ folds: [held, held, held, lost] });

    expect(r.verdict).toBe('pass');
    expect(r.foldsWithEdge).toBe(4);
    expect(r.foldsSurviving).toBe(3);
    expect(r.consistency).toBeCloseTo(0.75, 9);
  });

  it('fails when it reverses more often than it holds', () => {
    const r = analyseRollingOos({ folds: [held, lost, lost, lost] });

    expect(r.verdict).toBe('fail');
    expect(r.explanation).toContain('not an edge that rolled forward');
  });

  it('warns when it holds, but not reliably', () => {
    const r = analyseRollingOos({ folds: [held, held, lost, lost, held] });
    expect(r.verdict).toBe('warn');
  });

  it('warns when folds survive but keep little of their in-sample return', () => {
    const thin = { inSample: seg({ returnPct: 10 }), outOfSample: seg({ returnPct: 1 }) };
    const r = analyseRollingOos({ folds: [thin, thin, thin, thin] });

    expect(r.medianRetention).toBeCloseTo(0.1, 9);
    expect(r.verdict).toBe('warn');
  });
});

describe('analyseRollingOos — n/a rather than fail', () => {
  it('is n/a when too few folds produced enough trades', () => {
    const tiny = { inSample: seg({ trades: 2 }), outOfSample: seg({ trades: 1 }) };
    const r = analyseRollingOos({ folds: [held, tiny, tiny, tiny] });

    expect(r.verdict).toBe('n/a');
    expect(r.inconclusiveReason).toContain('too fine for this strategy');
  });

  it('is n/a when no fold trained profitably', () => {
    const noEdge = {
      inSample: seg({ netProfit: -100, returnPct: -1 }),
      outOfSample: seg({ netProfit: -50, returnPct: -0.5 }),
    };
    const r = analyseRollingOos({ folds: [noEdge, noEdge, noEdge] });

    expect(r.verdict).toBe('n/a');
    expect(r.explanation).toContain('nothing was');
  });

  it('does not count an unassessable fold as a failure', () => {
    const tiny = { inSample: seg({ trades: 2 }), outOfSample: seg({ trades: 1 }) };
    const r = analyseRollingOos({ folds: [held, held, tiny] });

    expect(r.foldsWithEdge).toBe(2);
    expect(r.verdict).toBe('pass');
  });
});

describe('analyseRollingOos — WFE', () => {
  it('is null when the in-sample return was not positive', () => {
    const both = {
      inSample: seg({ netProfit: -500, returnPct: -5 }),
      outOfSample: seg({ netProfit: -200, returnPct: -2 }),
    };
    const r = analyseRollingOos({ folds: [both, held, held] });

    // -2 / -5 = 0.4 would read as "kept 40%" for a fold that lost money twice.
    expect(r.folds[0]!.retention).toBeNull();
  });

  it('marks a ratio against a near-zero in-sample return as unstable', () => {
    const tinyEdge = {
      inSample: seg({ returnPct: 0.1, netProfit: 10 }),
      outOfSample: seg({ returnPct: 2, netProfit: 200 }),
    };
    const r = analyseRollingOos({ folds: [tinyEdge, held, held] });

    expect(r.folds[0]!.retention).toBeCloseTo(20, 6);
    expect(r.folds[0]!.retentionStable).toBe(false);
    // A 20x outlier must not drag the median that summarises the run.
    expect(r.medianRetention).toBeCloseTo(0.8, 9);
  });

  it('takes the median across folds, not the mean', () => {
    const a = { inSample: seg({ returnPct: 10 }), outOfSample: seg({ returnPct: 2 }) };
    const b = { inSample: seg({ returnPct: 10 }), outOfSample: seg({ returnPct: 8 }) };
    const c = { inSample: seg({ returnPct: 10 }), outOfSample: seg({ returnPct: 9 }) };

    const r = analyseRollingOos({ folds: [a, b, c] });
    expect(r.medianRetention).toBeCloseTo(0.8, 9);
  });
});
