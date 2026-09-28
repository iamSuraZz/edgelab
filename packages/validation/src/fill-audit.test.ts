import { describe, expect, it } from 'vitest';

import { accountMoney, lots, price } from '@edgelab/shared';

import { auditFills, type AuditBar, type AuditTrade } from './fill-audit';

/**
 * The fill audit.
 *
 * The distinctions that matter: a fill outside the bar is a BUG, a fill mid-bar is ordinary, and a
 * fill exactly on an extreme is a fill that may never have happened. Conflating any two of those
 * would make the check either alarmist or useless.
 */

const MINTICK = 0.00001;
/** One tick on one lot of a 5-digit pair at 100,000 per lot: mintick x contractSize x pointValue. */
const TICK_VALUE = 1;

function bar(open: number, high: number, low: number, close: number): AuditBar {
  return { open, high, low, close };
}

function trade(over: Partial<AuditTrade> = {}): AuditTrade {
  return {
    seq: 1,
    side: 'long',
    qty: lots(1),
    entryBar: 1,
    entryPrice: price(1.1),
    exitBar: 2,
    exitPrice: price(1.11),
    netPnl: accountMoney(100),
    ...over,
  };
}

// bar 0 unused, bar 1 spans 1.0990..1.1010 opening at 1.1000, bar 2 spans 1.1090..1.1110.
const BARS: AuditBar[] = [
  bar(1.0, 1.01, 0.99, 1.0),
  bar(1.1, 1.101, 1.099, 1.1005),
  bar(1.11, 1.111, 1.109, 1.1105),
];

describe('auditFills — range', () => {
  it('accepts fills inside the bar', () => {
    const r = auditFills({
      trades: [trade()],
      bars: BARS,
      mintick: MINTICK,
      valuePerTickPerLot: TICK_VALUE,
    });

    expect(r.outOfRange).toEqual([]);
    expect(r.fillsChecked).toBe(2);
  });

  it('flags a fill below the bar low, with how far outside', () => {
    const r = auditFills({
      trades: [trade({ entryPrice: price(1.098) })],
      bars: BARS,
      mintick: MINTICK,
      valuePerTickPerLot: TICK_VALUE,
    });

    expect(r.outOfRange).toHaveLength(1);
    expect(r.outOfRange[0]!.leg).toBe('entry');
    expect(r.outOfRange[0]!.byPrice).toBeCloseTo(1.099 - 1.098, 9);
  });

  it('flags a fill above the bar high', () => {
    const r = auditFills({
      trades: [trade({ exitPrice: price(1.2) })],
      bars: BARS,
      mintick: MINTICK,
      valuePerTickPerLot: TICK_VALUE,
    });

    expect(r.outOfRange).toHaveLength(1);
    expect(r.outOfRange[0]!.leg).toBe('exit');
  });

  it('tolerates float noise at the extreme rather than calling it a bug', () => {
    // Prices pass through resampling and a transpiler; bit-exact comparison would report noise as
    // an engine defect and the check would be ignored within a day.
    const r = auditFills({
      trades: [trade({ entryPrice: price(1.099 - MINTICK / 4) })],
      bars: BARS,
      mintick: MINTICK,
      valuePerTickPerLot: TICK_VALUE,
    });

    expect(r.outOfRange).toEqual([]);
  });

  it('counts fills it cannot locate a bar for instead of ignoring them', () => {
    const r = auditFills({
      trades: [trade({ entryBar: 99, exitBar: 2 })],
      bars: BARS,
      mintick: MINTICK,
      valuePerTickPerLot: TICK_VALUE,
    });

    expect(r.fillsUnlocatable).toBe(1);
    expect(r.fillsChecked).toBe(1);
  });
});

describe('auditFills — market fills at the open', () => {
  it('counts a fill at the bar open', () => {
    // Our engine fills market orders at the next bar's open, so this is the expected shape.
    const r = auditFills({
      trades: [trade({ entryPrice: price(1.1), exitPrice: price(1.11) })],
      bars: BARS,
      mintick: MINTICK,
      valuePerTickPerLot: TICK_VALUE,
    });

    expect(r.atOpen).toBe(2);
  });

  it('does not count a mid-bar fill as an open fill', () => {
    const r = auditFills({
      trades: [trade({ entryPrice: price(1.1004), exitPrice: price(1.1104) })],
      bars: BARS,
      mintick: MINTICK,
      valuePerTickPerLot: TICK_VALUE,
    });

    expect(r.atOpen).toBe(0);
    // Mid-bar is ordinary — a stop or limit — so nothing is flagged.
    expect(r.outOfRange).toEqual([]);
    expect(r.touches).toEqual([]);
  });
});

describe('auditFills — touch fills', () => {
  it('flags a fill exactly on the bar high', () => {
    const r = auditFills({
      trades: [trade({ exitPrice: price(1.111) })],
      bars: BARS,
      mintick: MINTICK,
      valuePerTickPerLot: TICK_VALUE,
    });

    expect(r.touches).toHaveLength(1);
    expect(r.touches[0]!.extreme).toBe('high');
    expect(r.touches[0]!.leg).toBe('exit');
  });

  it('flags a fill exactly on the bar low', () => {
    const r = auditFills({
      trades: [trade({ entryPrice: price(1.099) })],
      bars: BARS,
      mintick: MINTICK,
      valuePerTickPerLot: TICK_VALUE,
    });

    expect(r.touches).toHaveLength(1);
    expect(r.touches[0]!.extreme).toBe('low');
  });

  it('does NOT treat an open that happens to equal an extreme as a touch', () => {
    // A market order filled at the open regardless of where the extreme fell. Counting it would
    // inflate the touch figure on every gap bar.
    const gapBar = bar(1.1, 1.1, 1.095, 1.096); // open === high
    const r = auditFills({
      trades: [trade({ entryBar: 0, entryPrice: price(1.1), exitBar: 0, exitPrice: price(1.1) })],
      bars: [gapBar],
      mintick: MINTICK,
      valuePerTickPerLot: TICK_VALUE,
    });

    expect(r.touches).toEqual([]);
    expect(r.atOpen).toBe(2);
  });

  it('recomputes P&L as if one tick of penetration were required', () => {
    // The question being answered: how much of this result rests on fills that may never have
    // happened. Always adverse, so the adjusted figure is never flattering.
    const r = auditFills({
      trades: [trade({ qty: lots(2), exitPrice: price(1.111), netPnl: accountMoney(500) })],
      bars: BARS,
      mintick: MINTICK,
      valuePerTickPerLot: TICK_VALUE,
    });

    expect(r.netPnlReported).toBe(500);
    // A dollar per touch fill on one lot, not a rounding error: 1 tick x 2 lots x $1.
    expect(r.netPnlIfPenetrationRequired).toBeCloseTo(500 - TICK_VALUE * 2, 9);
    expect(r.netPnlIfPenetrationRequired).toBeLessThan(r.netPnlReported);
  });

  it('leaves P&L untouched when there are no touch fills', () => {
    const r = auditFills({
      trades: [
        trade({ entryPrice: price(1.1004), exitPrice: price(1.1104), netPnl: accountMoney(250) }),
      ],
      bars: BARS,
      mintick: MINTICK,
      valuePerTickPerLot: TICK_VALUE,
    });

    expect(r.netPnlIfPenetrationRequired).toBe(250);
  });

  it('scales the adjustment by quantity and counts both legs', () => {
    const r = auditFills({
      trades: [
        trade({
          qty: lots(3),
          entryPrice: price(1.099),
          exitPrice: price(1.111),
          netPnl: accountMoney(0),
        }),
      ],
      bars: BARS,
      mintick: MINTICK,
      valuePerTickPerLot: TICK_VALUE,
    });

    expect(r.touches).toHaveLength(2);
    expect(r.netPnlIfPenetrationRequired).toBeCloseTo(-2 * TICK_VALUE * 3, 9);
  });
});

describe('auditFills — empty input', () => {
  it('reports nothing rather than throwing', () => {
    const r = auditFills({
      trades: [],
      bars: BARS,
      mintick: MINTICK,
      valuePerTickPerLot: TICK_VALUE,
    });

    expect(r.fillsChecked).toBe(0);
    expect(r.outOfRange).toEqual([]);
    expect(r.netPnlReported).toBe(0);
    expect(r.netPnlIfPenetrationRequired).toBe(0);
  });
});
