import { describe, expect, it } from 'vitest';

import type { SegmentMetrics } from './oos-split';
import {
  analyseTimeframeMatrix,
  cellAvailability,
  lossCause,
  type MatrixCell,
} from './timeframe-matrix';

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

/** `gross` defaults above net, so an unspecified losing cell reads as sunk by costs. */
function cell(
  timeframe: string,
  netProfit: number,
  trades = 40,
  gross = netProfit + 500,
): MatrixCell {
  const totalCosts = gross - netProfit;
  return {
    timeframe,
    status: 'ok',
    reason: null,
    metrics: seg({ netProfit, trades }),
    costs: {
      grossProfit: gross,
      totalCosts,
      costShareOfGross: gross > 0 ? totalCosts / gross : null,
    },
  };
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
        { timeframe: 'D1', status: 'n/a', reason: 'requests H1', metrics: null, costs: null },
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

describe('gross against net per cell', () => {
  it('distinguishes a cell sunk by COSTS from one with no signal', () => {
    const r = analyseTimeframeMatrix({
      baseTimeframe: 'H1',
      cells: [
        // Made 900 gross, paid 1400 in costs: the edge is real and too small to pay for itself.
        cell('M15', -500, 40, 900),
        // Lost before costs were charged at all.
        cell('M30', -800, 40, -300),
        cell('H1', 1200, 40, 1700),
        cell('H4', 400, 40, 700),
      ],
    });

    expect(r.explanation).toContain('1 had a POSITIVE gross and were sunk by costs (M15)');
    expect(r.explanation).toContain('1 lost money before costs at all (M30)');
    expect(r.explanation).toContain('nothing rescues the second');
  });

  it('shows gross, net and the cost share in the row', () => {
    const r = analyseTimeframeMatrix({
      baseTimeframe: 'H1',
      cells: [cell('H1', 1000, 40, 2000), cell('H4', 500, 40, 1000)],
    });

    expect(r.explanation).toContain('H1 gross 2000 -> net 1000 costs 50% of gross');
  });

  it('classifies the cause per cell', () => {
    expect(lossCause(cell('M15', -500, 40, 900))).toBe('costs');
    expect(lossCause(cell('M15', -500, 40, -100))).toBe('signal');
    expect(lossCause(cell('H1', 500, 40, 900))).toBeNull();
  });

  it('says nothing about causes when every cell made money', () => {
    const r = analyseTimeframeMatrix({
      baseTimeframe: 'H1',
      cells: [cell('H1', 1000), cell('H4', 500)],
    });
    expect(r.explanation).not.toContain('losing cell');
  });

  it('withholds the cost share when gross is not positive', () => {
    // A share against a negative gross flips sign and reads as though costs were a credit.
    expect(cell('H1', -500, 40, 0).costs!.costShareOfGross).toBeNull();
    expect(cell('H1', -500, 40, -300).costs!.costShareOfGross).toBeNull();
    expect(cell('H1', 500, 40, 1000).costs!.costShareOfGross).toBeCloseTo(0.5, 9);
  });

  it('shows the cost amount instead when the share would be undefined', () => {
    const r = analyseTimeframeMatrix({
      baseTimeframe: 'H1',
      cells: [cell('M15', -4374, 40, -3200), cell('H1', 1500, 40, 1855)],
    });
    expect(r.explanation).toContain('M15 gross -3200 -> net -4374 costs 1174');
    expect(r.explanation).not.toContain('-37%');
  });
});
