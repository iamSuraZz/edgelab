import { describe, expect, it } from 'vitest';

import { analyseCostStress, type StressPoint } from './cost-stress';

/**
 * The identity under test: when costs scale linearly and the trade set holds still, the empirical
 * break-even equals the analytical one. Every disagreement is therefore evidence of one of the two
 * things this check exists to surface.
 */

const SCALE = { mintick: 0.00001, pipSize: 0.0001 };

/** 100 trades of one lot: 2 x 100 x 100,000 units x pointValue 1. */
const TWO_SIDED = 2 * 100 * 100_000;

function point(
  multiplier: number,
  netProfit: number,
  totalCosts: number,
  trades = 100,
): StressPoint {
  return { multiplier, netProfit, totalCosts, trades };
}

describe('analyseCostStress — break-even multiplier', () => {
  it('interpolates the crossing between two points', () => {
    // Gross 3000, costs 1000 per multiplier: zero net at 3x.
    const r = analyseCostStress({
      points: [point(1, 2000, 1000), point(2, 1000, 2000), point(4, -1000, 4000)],
      twoSidedUnitValue: TWO_SIDED,
      analyticalPerSidePrice: null,
      scale: SCALE,
    });

    expect(r.breakEvenMultiplier).toBeCloseTo(3, 6);
  });

  it('reproduces the analytical break-even exactly under linear scaling', () => {
    // netProfit(1) = 2000, costs(1) = 1000. Break-even at 3x adds 2 x 1000 = 2000 of cost.
    // Per side: 2000 / (2 x 100 x 100,000) = 0.0001 — which is netProfit / twoSided, the
    // analytical form.
    const analytical = 2000 / TWO_SIDED;

    const r = analyseCostStress({
      points: [point(1, 2000, 1000), point(2, 1000, 2000), point(4, -1000, 4000)],
      twoSidedUnitValue: TWO_SIDED,
      analyticalPerSidePrice: analytical,
      scale: SCALE,
    });

    expect(r.empiricalPerSidePrice).toBeCloseTo(analytical, 12);
    expect(r.agrees).toBe(true);
    expect(r.explanation).toContain('Matches');
  });

  it('reports a break-even below 1 for a strategy already past it', () => {
    const r = analyseCostStress({
      points: [point(0, 500, 0), point(1, -500, 1000)],
      twoSidedUnitValue: TWO_SIDED,
      analyticalPerSidePrice: null,
      scale: SCALE,
    });

    expect(r.breakEvenMultiplier).toBeCloseTo(0.5, 6);
    expect(r.explanation).toContain('already past');
  });
});

describe('analyseCostStress — no crossing', () => {
  it('says so when the strategy loses money at zero cost', () => {
    const r = analyseCostStress({
      points: [point(0, -1950, 0), point(1, -4838, 2888), point(2, -7726, 5776)],
      twoSidedUnitValue: TWO_SIDED,
      analyticalPerSidePrice: -0.0001,
      scale: SCALE,
    });

    expect(r.breakEvenMultiplier).toBeNull();
    expect(r.empiricalPerSidePrice).toBeNull();
    expect(r.explanation).toContain('execution switched off');
  });

  it('says so when the edge survives the whole range', () => {
    const r = analyseCostStress({
      points: [point(1, 5000, 100), point(3, 4800, 300)],
      twoSidedUnitValue: TWO_SIDED,
      analyticalPerSidePrice: null,
      scale: SCALE,
    });

    expect(r.breakEvenMultiplier).toBeNull();
    expect(r.explanation).toContain('survives');
  });
});

describe('analyseCostStress — why they disagree', () => {
  it('blames a moving trade set when scaling changed the trade count', () => {
    const r = analyseCostStress({
      points: [point(1, 2000, 1000, 100), point(4, -1000, 4000, 91)],
      twoSidedUnitValue: TWO_SIDED,
      analyticalPerSidePrice: 0.00005,
      scale: SCALE,
    });

    expect(r.tradeSetMoved).toBe(true);
    expect(r.agrees).toBe(false);
    expect(r.explanation).toContain('margin check');
  });

  it('blames the fill mix when limit orders skip slippage', () => {
    const r = analyseCostStress({
      points: [point(1, 2000, 1000), point(4, -1000, 4000)],
      twoSidedUnitValue: TWO_SIDED,
      analyticalPerSidePrice: 0.00005,
      scale: SCALE,
      slippageFills: 100,
      totalFills: 200,
    });

    expect(r.explanation).toContain('fills (50%) pay slippage');
  });

  it('does not blame the fill mix when every fill pays slippage', () => {
    const r = analyseCostStress({
      points: [point(1, 2000, 1000), point(4, -1000, 4000)],
      twoSidedUnitValue: TWO_SIDED,
      analyticalPerSidePrice: 0.00005,
      scale: SCALE,
      slippageFills: 200,
      totalFills: 200,
    });

    expect(r.explanation).not.toContain('pay slippage');
  });

  it('reports the gap as a percentage of the analytical figure', () => {
    const analytical = 2000 / TWO_SIDED;
    const r = analyseCostStress({
      points: [point(1, 2000, 1000), point(2, 1000, 2000), point(5, -2000, 5000)],
      twoSidedUnitValue: TWO_SIDED,
      analyticalPerSidePrice: analytical / 2,
      scale: SCALE,
    });

    expect(r.deltaPct).toBeCloseTo(100, 6);
    expect(r.agrees).toBe(false);
  });
});
