import { describe, expect, it } from 'vitest';

import type { SegmentMetrics } from './oos-split';
import { analyseWfOptimization } from './wf-optimization-report';
import {
  combinations,
  gridSize,
  OptimizationSpecError,
  pickWinner,
  valuesOf,
  type CandidateResult,
  type OptimizationSpec,
} from './wf-optimization';

/**
 * Two things here decide whether the whole check is honest. Sampling above the cap must cover the
 * grid rather than its first corner, and the trade floor must be applied BEFORE ranking — a
 * two-trade parameter set has the best profit factor in almost any grid.
 */

function seg(over: Partial<SegmentMetrics> = {}): SegmentMetrics {
  return {
    fromMs: 0,
    toMs: 1,
    trades: 30,
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

const SPEC: OptimizationSpec = {
  inputs: [
    { name: 'fast', min: 5, max: 20, step: 5 },
    { name: 'slow', min: 20, max: 60, step: 20 },
  ],
  objective: 'netProfit',
  minTrades: 10,
};

describe('valuesOf', () => {
  it('includes both ends of the range', () => {
    expect(valuesOf({ name: 'x', min: 5, max: 20, step: 5 })).toEqual([5, 10, 15, 20]);
  });

  it('does not drift on a fractional step', () => {
    expect(valuesOf({ name: 'x', min: 0.1, max: 0.5, step: 0.1 })).toEqual([
      0.1, 0.2, 0.3, 0.4, 0.5,
    ]);
  });

  it('refuses a non-positive step rather than looping forever', () => {
    expect(() => valuesOf({ name: 'x', min: 1, max: 5, step: 0 })).toThrow(OptimizationSpecError);
  });

  it('refuses an inverted range', () => {
    expect(() => valuesOf({ name: 'x', min: 5, max: 1, step: 1 })).toThrow(OptimizationSpecError);
  });
});

describe('combinations', () => {
  it('enumerates the full grid below the cap', () => {
    const c = combinations(SPEC);
    expect(gridSize(SPEC)).toBe(12);
    expect(c).toHaveLength(12);
    expect(new Set(c.map((p) => JSON.stringify(p))).size).toBe(12);
  });

  it('refuses more than three inputs', () => {
    const four: OptimizationSpec = {
      ...SPEC,
      inputs: ['a', 'b', 'c', 'd'].map((name) => ({ name, min: 1, max: 3, step: 1 })),
    };
    expect(() => combinations(four)).toThrow(OptimizationSpecError);
  });

  it('refuses an empty input list', () => {
    expect(() => combinations({ ...SPEC, inputs: [] })).toThrow(OptimizationSpecError);
  });

  it('SAMPLES the whole grid above the cap rather than taking its first corner', () => {
    const wide: OptimizationSpec = {
      inputs: [
        { name: 'a', min: 1, max: 100, step: 1 },
        { name: 'b', min: 1, max: 100, step: 1 },
      ],
      objective: 'netProfit',
      minTrades: 10,
      maxCombinations: 200,
    };

    const c = combinations(wide);
    expect(c).toHaveLength(200);

    // Truncating an enumerated grid would sweep `a` fully and leave `b` at its first value.
    const distinctB = new Set(c.map((p) => p['b'])).size;
    expect(distinctB).toBeGreaterThan(50);

    // And it must reach the far end of both axes, not just the start.
    expect(Math.max(...c.map((p) => p['a'] as number))).toBeGreaterThan(80);
    expect(Math.max(...c.map((p) => p['b'] as number))).toBeGreaterThan(80);
  });

  it('is deterministic for a given seed', () => {
    const wide: OptimizationSpec = {
      inputs: [
        { name: 'a', min: 1, max: 50, step: 1 },
        { name: 'b', min: 1, max: 50, step: 1 },
      ],
      objective: 'netProfit',
      minTrades: 10,
      maxCombinations: 100,
    };
    expect(JSON.stringify(combinations(wide, 7))).toBe(JSON.stringify(combinations(wide, 7)));
    expect(JSON.stringify(combinations(wide, 7))).not.toBe(JSON.stringify(combinations(wide, 8)));
  });
});

describe('pickWinner', () => {
  const cand = (
    parameters: Record<string, number>,
    m: Partial<SegmentMetrics>,
  ): CandidateResult => ({
    parameters,
    metrics: seg(m),
  });

  it('applies the trade floor BEFORE ranking, not as a tiebreak', () => {
    const winner = pickWinner(
      [
        cand({ fast: 5, slow: 20 }, { netProfit: 10_000, trades: 2 }),
        cand({ fast: 10, slow: 40 }, { netProfit: 1_000, trades: 40 }),
      ],
      SPEC,
    );

    // The two-trade set has ten times the profit and has established nothing.
    expect(winner!.parameters).toEqual({ fast: 10, slow: 40 });
  });

  it('returns null when nothing clears the floor', () => {
    const winner = pickWinner([cand({ fast: 5, slow: 20 }, { trades: 3 })], SPEC);
    expect(winner).toBeNull();
  });

  it('ignores a candidate whose objective is undefined', () => {
    const winner = pickWinner(
      [
        cand({ fast: 5, slow: 20 }, { profitFactor: null }),
        cand({ fast: 10, slow: 40 }, { profitFactor: 2 }),
      ],
      { ...SPEC, objective: 'profitFactor' },
    );
    expect(winner!.parameters).toEqual({ fast: 10, slow: 40 });
  });

  it('breaks a tie towards the middle of the ranges, not an edge', () => {
    const winner = pickWinner(
      [
        cand({ fast: 5, slow: 20 }, { netProfit: 1000 }),
        cand({ fast: 10, slow: 40 }, { netProfit: 1000 }),
      ],
      SPEC,
    );
    // An extreme of a swept range is more likely a boundary artefact than a real optimum.
    expect(winner!.parameters).toEqual({ fast: 10, slow: 40 });
  });
});

describe('analyseWfOptimization', () => {
  const DAY = 24 * 60 * 60_000;
  const IS_DAYS = 90;
  const OOS_DAYS = 30;

  /**
   * Folds are expressed by the WFE they should produce, not by raw returns.
   *
   * The in-sample window is three times the out-of-sample one, so a raw-return ratio would score a
   * perfectly generalising procedure at 1/3. Stating the intended WFE and deriving the out-of-sample
   * return from it keeps these tests about the check rather than about the fold layout.
   */
  const fold = (winner: Record<string, number>, isPct: number, wfe: number) => {
    const oosPct = (wfe * isPct * OOS_DAYS) / IS_DAYS;
    return {
      winner,
      inSample: seg({ fromMs: 0, toMs: IS_DAYS * DAY, returnPct: isPct, netProfit: isPct * 100 }),
      outOfSample: seg({
        fromMs: IS_DAYS * DAY,
        toMs: (IS_DAYS + OOS_DAYS) * DAY,
        returnPct: oosPct,
        netProfit: oosPct * 100,
      }),
    };
  };

  const stable = [
    fold({ fast: 10, slow: 40 }, 10, 0.8),
    fold({ fast: 10, slow: 40 }, 10, 0.7),
    fold({ fast: 15, slow: 40 }, 10, 0.9),
    fold({ fast: 10, slow: 40 }, 10, 0.8),
  ];

  it('passes when the procedure generalises and the optimum stays put', () => {
    const r = analyseWfOptimization({
      spec: SPEC,
      folds: stable,
      combinationsRun: 12,
      gridSize: 12,
    });

    expect(r.verdict).toBe('pass');
    expect(r.foldsSurviving).toBe(4);
    expect(r.medianWfe).toBeCloseTo(0.8, 9);
    expect(r.sampled).toBe(false);
  });

  it('FAILS a profitable run whose optimum jumps across its range', () => {
    const jumpy = [
      fold({ fast: 5, slow: 20 }, 10, 0.8),
      fold({ fast: 20, slow: 60 }, 10, 0.9),
      fold({ fast: 5, slow: 20 }, 10, 0.7),
      fold({ fast: 20, slow: 60 }, 10, 0.8),
    ];
    const r = analyseWfOptimization({
      spec: SPEC,
      folds: jumpy,
      combinationsRun: 12,
      gridSize: 12,
    });

    // Every fold made money out of sample, and it still fails.
    expect(r.foldsSurviving).toBe(4);
    expect(r.verdict).toBe('fail');
    expect(r.explanation).toContain('whatever the last window happened to reward');
  });

  it('compounds the stitched curve rather than summing it', () => {
    const r = analyseWfOptimization({
      spec: SPEC,
      folds: [fold({ fast: 10, slow: 40 }, 30, 1), fold({ fast: 10, slow: 40 }, 30, 1)],
      combinationsRun: 12,
      gridSize: 12,
    });

    // Each fold returns 10% out of sample: 1.10 x 1.10 = 1.21, not 20%.
    expect(r.finalOosReturnPct).toBeCloseTo(21, 6);
  });

  it('is n/a when too few folds produced a winner', () => {
    const r = analyseWfOptimization({
      spec: SPEC,
      folds: [stable[0]!, { winner: null, inSample: null, outOfSample: null }],
      combinationsRun: 12,
      gridSize: 12,
    });

    expect(r.verdict).toBe('n/a');
    expect(r.inconclusiveReason).toContain('trade floor');
  });

  it('is n/a when the optimiser found no in-sample edge at all', () => {
    const losing = [
      fold({ fast: 10, slow: 40 }, -5, 0.6),
      fold({ fast: 10, slow: 40 }, -4, 0.5),
      fold({ fast: 10, slow: 40 }, -6, 0.2),
    ];
    const r = analyseWfOptimization({
      spec: SPEC,
      folds: losing,
      combinationsRun: 12,
      gridSize: 12,
    });

    expect(r.verdict).toBe('n/a');
    expect(r.explanation).toContain('no edge to carry forward');
    // A24: never a ratio against a non-positive in-sample return.
    expect(r.folds[0]!.wfe).toBeNull();
  });

  it('reports drift per input, with the values it saw', () => {
    const r = analyseWfOptimization({
      spec: SPEC,
      folds: stable,
      combinationsRun: 12,
      gridSize: 12,
    });
    const fast = r.drift.find((d) => d.name === 'fast')!;

    expect(fast.values).toEqual([10, 10, 15, 10]);
    expect(fast.distinctValues).toBe(2);
    expect(fast.meanStepFraction).toBeGreaterThan(0);
  });

  it('marks the result as sampled when the grid was bigger than the run', () => {
    const r = analyseWfOptimization({
      spec: SPEC,
      folds: stable,
      combinationsRun: 300,
      gridSize: 10_000,
    });
    expect(r.sampled).toBe(true);
  });

  it('builds a sensitivity grid from one fold’s candidates', () => {
    const candidates: CandidateResult[] = [
      { parameters: { fast: 5, slow: 20 }, metrics: seg({ netProfit: 100 }) },
      { parameters: { fast: 5, slow: 40 }, metrics: seg({ netProfit: 400 }) },
      { parameters: { fast: 10, slow: 20 }, metrics: seg({ netProfit: 200 }) },
    ];
    const r = analyseWfOptimization({
      spec: SPEC,
      folds: stable,
      combinationsRun: 12,
      gridSize: 12,
      sensitivityFold: candidates,
    });

    expect(r.sensitivity!.inputA).toBe('fast');
    expect(r.sensitivity!.cells).toHaveLength(3);
    expect(r.sensitivity!.cells.find((c) => c.a === 5 && c.b === 40)!.value).toBe(400);
    expect(r.sensitivity!.collapsed).toBe(false);
  });
});
