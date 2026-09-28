import { describe, expect, it } from 'vitest';

import type { SegmentMetrics } from './oos-split';
import { analyseTimeframeMatrix, cellAvailability, type MatrixCell } from './timeframe-matrix';

/**
 * The finding this exists for is a base timeframe that stands alone. The trap is treating the matrix
 * as a menu — which is why the check reports the shape of the row and never its maximum.
 */

const MIN = 60_000;

function seg(over: Partial<SegmentMetrics> = {}): SegmentMetrics {
  return {
    fromMs: 0,
    toMs: 1,
    trades: 40,
    netProfit: 1000,
    returnPct: 10,
    profitFactor: 1.4,
    sharpe: 0.6,
    winRatePct: 52,
    maxDrawdownPct: 15,
    expectancy: 25,
    ...over,
  };
}

function cell(timeframe: string, netProfit: number, trades = 40): MatrixCell {
  return { timeframe, status: 'ok', reason: null, metrics: seg({ netProfit, trades }) };
}

describe('cellAvailability', () => {
  const h1 = { timeframe: 'H1', ms: 60 * MIN };
  const m15 = { timeframe: 'M15', ms: 15 * MIN };

  it('allows a chart FINER than everything the script requests', () => {
    // An M15 chart reading H1 is the normal direction.
    expect(cellAvailability('M15', 15 * MIN, [h1]).status).toBe('ok');
  });

  it('allows a chart equal to what the script requests', () => {
    expect(cellAvailability('H1', 60 * MIN, [h1]).status).toBe('ok');
  });

  it('refuses a chart COARSER than a requested timeframe, and says why', () => {
    const r = cellAvailability('D1', 1440 * MIN, [h1]);

    expect(r.status).toBe('n/a');
    expect(r.reason).toContain('H1');
    expect(r.reason).toContain('FINER');
  });

  it('names every offending timeframe', () => {
    const r = cellAvailability('D1', 1440 * MIN, [h1, m15]);
    expect(r.reason).toContain('H1');
    expect(r.reason).toContain('M15');
  });

  it('allows everything when the script requests nothing', () => {
    expect(cellAvailability('MN1', 30 * 1440 * MIN, []).status).toBe('ok');
  });

  it('ignores a requested timeframe of unknown length rather than refusing on it', () => {
    expect(cellAvailability('D1', 1440 * MIN, [{ timeframe: '?', ms: 0 }]).status).toBe('ok');
  });
});

describe('analyseTimeframeMatrix', () => {
  it('FAILS when the base timeframe is the only one that makes money', () => {
    const r = analyseTimeframeMatrix({
      baseTimeframe: 'H1',
      cells: [cell('M15', -400), cell('M30', -200), cell('H1', 1200), cell('H4', -300)],
    });

    expect(r.verdict).toBe('fail');
    expect(r.explanation).toContain('ONLY timeframe');
    expect(r.explanation).toContain('not of the market');
  });

  it('passes when the edge carries across bar sizes', () => {
    const r = analyseTimeframeMatrix({
      baseTimeframe: 'H1',
      cells: [cell('M15', 300), cell('M30', 700), cell('H1', 1200), cell('H4', 400)],
    });

    expect(r.verdict).toBe('pass');
    expect(r.profitable).toBe(4);
  });

  it('warns when it carries to some neighbours but not most', () => {
    const r = analyseTimeframeMatrix({
      baseTimeframe: 'H1',
      cells: [cell('M15', -400), cell('M30', 200), cell('H1', 1200), cell('H4', -300)],
    });

    expect(r.verdict).toBe('warn');
    expect(r.explanation).toContain('does not carry across');
  });

  it('does not call a losing base isolated', () => {
    // One profitable cell that is NOT the base is a different finding, and not this one.
    const r = analyseTimeframeMatrix({
      baseTimeframe: 'H1',
      cells: [cell('M15', 900), cell('M30', -200), cell('H1', -500), cell('H4', -300)],
    });
    expect(r.verdict).toBe('warn');
  });

  it('counts an n/a cell as skipped rather than as a loss', () => {
    const r = analyseTimeframeMatrix({
      baseTimeframe: 'H1',
      cells: [
        { timeframe: 'D1', status: 'n/a', reason: 'requests H1', metrics: null },
        cell('M30', 700),
        cell('H1', 1200),
      ],
    });

    expect(r.skipped).toBe(1);
    expect(r.assessable).toBe(2);
    expect(r.verdict).toBe('pass');
  });

  it('ignores a cell with too few trades rather than reading it as a loss', () => {
    const r = analyseTimeframeMatrix({
      baseTimeframe: 'H1',
      cells: [cell('M15', -50, 2), cell('M30', 700), cell('H1', 1200)],
    });

    expect(r.assessable).toBe(2);
    expect(r.verdict).toBe('pass');
  });

  it('is n/a when fewer than two cells can be judged', () => {
    const r = analyseTimeframeMatrix({
      baseTimeframe: 'H1',
      cells: [cell('H1', 1200), cell('M15', 10, 1)],
    });

    expect(r.verdict).toBe('n/a');
    expect(r.inconclusiveReason).toContain('one cell is just the original run');
  });
});
