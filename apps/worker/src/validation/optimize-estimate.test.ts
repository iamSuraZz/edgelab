import { describe, expect, it } from 'vitest';

import { estimateOptimization } from './optimize-run';

/**
 * The ETA's honesty, not its accuracy (A56).
 *
 * Its accuracy is known to be poor outside the window it was calibrated on — 14.2s predicted against
 * 84.6s actual on two-year folds — and the decision recorded there is deliberately NOT to re-fit
 * from a single new measurement. What can be asserted, and what these cover, is that the estimate
 * admits when it is out of calibration rather than presenting a floor as a prediction.
 */
describe('estimateOptimization', () => {
  const base = { combinations: 16, folds: 3, threads: 7 };

  it('counts one out-of-sample run per fold on top of the candidates', () => {
    // 3 folds x (16 candidates + 1 winner re-run out of sample).
    expect(estimateOptimization({ ...base, barsPerFold: 3_100 }).totalRuns).toBe(51);
  });

  it('reproduces its calibration runs within a factor of two', () => {
    // 204 runs on 7 threads at the calibrated fold size measured 24.2s.
    const at204 = estimateOptimization({
      combinations: 50,
      folds: 4,
      threads: 7,
      barsPerFold: 3_100,
    });
    expect(at204.estimatedMs).toBeGreaterThan(12_000);
    expect(at204.estimatedMs).toBeLessThan(48_400);
  });

  it('is a prediction inside the calibration', () => {
    expect(estimateOptimization({ ...base, barsPerFold: 3_100 }).isLowerBound).toBe(false);
  });

  it('becomes a lower bound once folds outgrow the calibration', () => {
    // The acceptance run: two years of H1, 8,760-bar in-sample folds.
    const wide = estimateOptimization({ ...base, barsPerFold: 8_760 });
    expect(wide.isLowerBound).toBe(true);
    expect(wide.calibratedBarsPerFold).toBe(3_100);
  });

  it('does not flip on a fold only slightly larger than the calibration', () => {
    // Otherwise every run is caveated, and a caveat on everything is read as noise.
    expect(estimateOptimization({ ...base, barsPerFold: 4_000 }).isLowerBound).toBe(false);
  });

  it('never divides by zero threads', () => {
    expect(
      Number.isFinite(
        estimateOptimization({ ...base, threads: 0, barsPerFold: 3_100 }).estimatedMs,
      ),
    ).toBe(true);
  });
});
