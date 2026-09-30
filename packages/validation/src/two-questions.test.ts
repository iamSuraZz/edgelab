import { describe, expect, it } from 'vitest';

import type { CheckResult } from './check';
import { questionFor, splitByQuestion } from './two-questions';

/**
 * The property that matters: a losing strategy with clean execution must NOT produce a single
 * "Pass" badge, because that reads as an endorsement of the strategy rather than of the numbers.
 */

function check(over: Partial<CheckResult> & { id: string }): CheckResult {
  return {
    label: over.id,
    severity: 'critical',
    status: 'pass',
    detail: '',
    ...over,
  } as CheckResult;
}

describe('questionFor', () => {
  it('routes look-ahead and execution to honesty', () => {
    expect(questionFor('lookahead-static')).toBe('honesty');
    expect(questionFor('execution-cost-stress')).toBe('honesty');
  });

  it('routes the overfitting family to robustness', () => {
    expect(questionFor('overfitting-oos-split')).toBe('robustness');
    expect(questionFor('overfitting-monte-carlo')).toBe('robustness');
  });

  it('puts the HOLDOUT under honesty despite its prefix', () => {
    // A viewed holdout does not mean the edge is fragile — it means this claim is weaker evidence
    // than it looks, which is a statement about the result rather than about the strategy.
    expect(questionFor('overfitting-holdout')).toBe('honesty');
  });

  it('routes the data-integrity checks to honesty', () => {
    expect(questionFor('bar-integrity')).toBe('honesty');
    expect(questionFor('trade-window')).toBe('honesty');
    expect(questionFor('sample-size')).toBe('honesty');
  });

  it('surfaces an unrecognised id rather than dropping it', () => {
    expect(questionFor('something-new')).toBe('unclassified');
  });
});

describe('splitByQuestion — the two answers', () => {
  it('does NOT let clean execution endorse a failing strategy', () => {
    const r = splitByQuestion([
      check({ id: 'lookahead-static' }),
      check({ id: 'execution-fill-audit' }),
      check({ id: 'overfitting-oos-split', status: 'fail' }),
      check({ id: 'overfitting-monte-carlo', status: 'fail' }),
    ]);

    // The honesty question passes — nothing is lying about these numbers.
    expect(r.honesty.verdict).toBe('pass');
    // And the robustness side says plainly that the edge did not hold.
    expect(r.robustness.counts.fail).toBe(2);
    expect(r.robustness.counts.pass).toBe(0);
    // Crucially there is no combined score to mistake for an endorsement.
    expect(Object.keys(r.robustness)).not.toContain('verdict');
    expect(Object.keys(r.robustness)).not.toContain('score');
  });

  it('says what a passing honesty verdict does NOT mean', () => {
    const r = splitByQuestion([check({ id: 'lookahead-static' })]);
    expect(r.honesty.headline).toContain('says nothing about whether the strategy is any good');
  });

  it('is Inconclusive when a critical honesty check is n/a', () => {
    const r = splitByQuestion([
      check({ id: 'lookahead-static' }),
      check({ id: 'execution-intrabar-replay', status: 'n/a' }),
    ]);

    expect(r.honesty.verdict).toBe('inconclusive');
    expect(r.honesty.headline).toContain('nothing here is cleared');
  });

  it('is NOT made inconclusive by a robustness check that could not run', () => {
    // A regime breakdown with no lookback says nothing about whether the numbers are honest.
    const r = splitByQuestion([
      check({ id: 'lookahead-static' }),
      check({ id: 'overfitting-regimes', status: 'n/a' }),
    ]);

    expect(r.honesty.verdict).toBe('pass');
    expect(r.robustness.counts.na).toBe(1);
  });

  it('fails honesty on a critical look-ahead failure', () => {
    const r = splitByQuestion([
      check({ id: 'lookahead-future-splice', status: 'fail' }),
      check({ id: 'overfitting-oos-split', status: 'pass' }),
    ]);

    expect(r.honesty.verdict).toBe('fail');
    expect(r.honesty.headline).toContain('invalidates these numbers');
  });

  it('warns honesty on a non-critical problem without failing it', () => {
    const r = splitByQuestion([
      check({ id: 'lookahead-static' }),
      check({ id: 'execution-bid-ask-asymmetry', severity: 'warning', status: 'warn' }),
    ]);

    expect(r.honesty.verdict).toBe('warn');
  });

  it('counts robustness without ranking it', () => {
    const r = splitByQuestion([
      check({ id: 'overfitting-oos-split', status: 'pass' }),
      check({ id: 'overfitting-rolling-oos', status: 'warn' }),
      check({ id: 'overfitting-timeframe-matrix', status: 'warn' }),
      check({ id: 'overfitting-monte-carlo', status: 'fail' }),
      check({ id: 'overfitting-regimes', status: 'n/a' }),
    ]);

    expect(r.robustness.counts).toEqual({ pass: 1, warn: 2, fail: 1, na: 1 });
    expect(r.robustness.headline).toContain('no combined score');
  });

  it('keeps an unclassified check visible', () => {
    const r = splitByQuestion([check({ id: 'brand-new-check' })]);

    expect(r.unclassified).toHaveLength(1);
    expect(r.honesty.checks).toHaveLength(0);
    expect(r.robustness.checks).toHaveLength(0);
  });
});
