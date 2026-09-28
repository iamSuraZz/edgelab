import { describe, expect, it } from 'vitest';

import { ExitLevelIndex, resolveExitLevels, type ExitOrderRow } from './exit-levels';

/**
 * The three traps: ticks are not prices, a level set on a bar applies to the NEXT one, and an exit
 * call that updates an existing order reports `noop` rather than `placed`.
 */

const MINTICK = 0.00001;
const LONG = { side: 'long' as const, entryPrice: 1.1, mintick: MINTICK };
const SHORT = { side: 'short' as const, entryPrice: 1.1, mintick: MINTICK };

function row(args: Record<string, unknown>, bar = 0, outcome = 'placed'): ExitOrderRow {
  return { method: 'exit', bar, outcome, args };
}

describe('resolveExitLevels — ticks', () => {
  it('resolves profit and loss against the entry price, for a long', () => {
    const r = resolveExitLevels(row({ profit: 200, loss: 100 }), LONG);
    expect(r.target).toBeCloseTo(1.102, 9);
    expect(r.stop).toBeCloseTo(1.099, 9);
  });

  it('mirrors them for a short', () => {
    const r = resolveExitLevels(row({ profit: 200, loss: 100 }), SHORT);
    expect(r.target).toBeCloseTo(1.098, 9);
    expect(r.stop).toBeCloseTo(1.101, 9);
  });

  it('resolves against the TRADE entry, not a fixed reference', () => {
    const r = resolveExitLevels(row({ loss: 100 }), { ...LONG, entryPrice: 0.9876 });
    expect(r.stop).toBeCloseTo(0.9866, 9);
  });
});

describe('resolveExitLevels — prices', () => {
  it('takes stop and limit as absolute prices', () => {
    const r = resolveExitLevels(row({ stop: 1.0955, limit: 1.1123 }), LONG);
    expect(r.stop).toBe(1.0955);
    expect(r.target).toBe(1.1123);
  });

  it('prefers an absolute price over a tick distance', () => {
    const r = resolveExitLevels(row({ stop: 1.0955, loss: 100 }), LONG);
    expect(r.stop).toBe(1.0955);
  });

  it('leaves a missing side null rather than inventing one', () => {
    const r = resolveExitLevels(row({ loss: 100 }), LONG);
    expect(r.stop).not.toBeNull();
    expect(r.target).toBeNull();
  });
});

describe('resolveExitLevels — trailing', () => {
  it('flags any trail argument', () => {
    expect(resolveExitLevels(row({ trail_points: 50, trail_offset: 20 }), LONG).trailing).toBe(
      true,
    );
    expect(resolveExitLevels(row({ trail_price: 1.105 }), LONG).trailing).toBe(true);
  });

  it('does not flag a plain bracket', () => {
    expect(resolveExitLevels(row({ profit: 200, loss: 100 }), LONG).trailing).toBe(false);
  });
});

describe('ExitLevelIndex', () => {
  it('applies a level set on bar N from bar N+1, not on N itself', () => {
    const index = new ExitLevelIndex([row({ loss: 100 }, 5)]);

    expect(index.levelsOnBar(5, LONG)).toBeNull();
    expect(index.levelsOnBar(6, LONG)?.stop).toBeCloseTo(1.099, 9);
  });

  it('tracks a level that moves every bar, as an ATR stop does', () => {
    const index = new ExitLevelIndex([
      row({ stop: 1.0955 }, 1),
      row({ stop: 1.0962 }, 2),
      row({ stop: 1.0978 }, 3),
    ]);

    expect(index.levelsOnBar(2, LONG)?.stop).toBe(1.0955);
    expect(index.levelsOnBar(3, LONG)?.stop).toBe(1.0962);
    expect(index.levelsOnBar(4, LONG)?.stop).toBe(1.0978);
    // Still the last known level after the calls stop.
    expect(index.levelsOnBar(99, LONG)?.stop).toBe(1.0978);
  });

  it('keeps noop rows, because an exit that UPDATES an order does not grow pending_orders', () => {
    const index = new ExitLevelIndex([
      row({ stop: 1.0955 }, 1, 'placed'),
      row({ stop: 1.0988 }, 2, 'noop'),
    ]);
    expect(index.size).toBe(2);
    expect(index.levelsOnBar(3, LONG)?.stop).toBe(1.0988);
  });

  it('drops rows our own gate suppressed', () => {
    const index = new ExitLevelIndex([
      row({ stop: 1.0955 }, 1, 'placed'),
      row({ stop: 1.0988 }, 2, 'suppressed'),
    ]);
    expect(index.size).toBe(1);
    expect(index.levelsOnBar(3, LONG)?.stop).toBe(1.0955);
  });

  it('ignores methods other than exit', () => {
    const index = new ExitLevelIndex([
      { method: 'entry', bar: 1, outcome: 'placed', args: { stop: 1.05 } },
      row({ stop: 1.0955 }, 2),
    ]);
    expect(index.size).toBe(1);
  });

  it('counts distinct exit ids, so a multi-bracket script is visible', () => {
    const index = new ExitLevelIndex([
      row({ id: 'TP', stop: 1.0955 }, 1),
      row({ id: 'SL', stop: 1.0988 }, 2),
    ]);
    expect(index.distinctIds).toBe(2);
  });
});

describe('ExitLevelIndex — trade scoping', () => {
  it('never inherits the previous position’s absolute levels', () => {
    // Bar 3 belongs to an earlier trade, bar 9 to this one.
    const index = new ExitLevelIndex([row({ stop: 1.05 }, 3), row({ stop: 1.2 }, 9)]);

    // This trade entered at bar 8, so bar 3's level is not its own.
    expect(index.levelsOnBar(9, LONG, 8)).toBeNull();
    expect(index.levelsOnBar(10, LONG, 8)?.stop).toBe(1.2);
  });

  it('does NOT bound tick levels, which are relative to this trade’s own entry', () => {
    // The call on bar 3 predates the trade, and a tick distance is still correct for it: a bracket
    // armed before the fill rests from the entry bar, and TradingView fills it there.
    const index = new ExitLevelIndex([row({ loss: 100 }, 3)]);
    expect(index.levelsOnBar(9, LONG, 8)?.stop).toBeCloseTo(1.099, 9);
  });

  it('has no ABSOLUTE levels on the entry bar, because the order rests from the next bar', () => {
    const index = new ExitLevelIndex([row({ stop: 1.05 }, 8)]);
    expect(index.levelsOnBar(8, LONG, 8)).toBeNull();
    expect(index.levelsOnBar(9, LONG, 8)?.stop).toBe(1.05);
  });
});

describe('ExitLevelIndex — several exit ids', () => {
  const two = [row({ id: 'TP1', profit: 100 }, 1), row({ id: 'TP2', profit: 300 }, 2)];

  it('pairs a trade with the bracket that closed it', () => {
    const index = new ExitLevelIndex(two);

    expect(index.levelsOnBar(5, LONG, 0, 'TP1')?.target).toBeCloseTo(1.101, 9);
    expect(index.levelsOnBar(5, LONG, 0, 'TP2')?.target).toBeCloseTo(1.103, 9);
  });

  it('marks a trade ambiguous when the closing id is unknown', () => {
    const index = new ExitLevelIndex(two);

    expect(index.levelsOnBar(5, LONG, 0, null)?.ambiguous).toBe(true);
    expect(index.levelsOnBar(5, LONG, 0, undefined)?.ambiguous).toBe(true);
  });

  it('marks a trade ambiguous when its id matches no exit call', () => {
    // A reversal closes with the opposing ENTRY's id, which is no bracket at all.
    const index = new ExitLevelIndex(two);
    expect(index.levelsOnBar(5, LONG, 0, 'Short')?.ambiguous).toBe(true);
  });

  it('does not demand an id when only one bracket is in play', () => {
    const index = new ExitLevelIndex([row({ id: 'Bracket', profit: 200 }, 1)]);

    expect(index.levelsOnBar(5, LONG, 0, null)?.ambiguous).toBe(false);
    expect(index.levelsOnBar(5, LONG, 0, null)?.target).toBeCloseTo(1.102, 9);
  });

  it('never returns another bracket’s level as if it were this one’s', () => {
    const index = new ExitLevelIndex(two);
    const levels = index.levelsOnBar(5, LONG, 0, null);
    expect(levels?.stop).toBeNull();
    expect(levels?.target).toBeNull();
  });
});
