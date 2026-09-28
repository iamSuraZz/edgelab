import { lots, price, type Bar } from '@edgelab/shared';
import { describe, expect, it } from 'vitest';

import { inferBracketLevels, replayIntrabar, type ReplayTrade } from './intrabar-replay';

/**
 * The case this exists for: a stop crossed on the correct side of the book, on a bar where the
 * stored prices never reached it, before the engine's target. No check that looks only at exits
 * that happened can see that, because the evidence sits on a bar where nothing occurred.
 */

const SCALE = { mintick: 0.00001, pipSize: 0.0001 };
const VALUE_PER_PRICE_PER_LOT = 100_000;
const MINUTE = 60_000;
const T0 = Date.UTC(2022, 0, 5, 10, 0);

function m1(offsetMinutes: number, high: number, low: number): Bar {
  return {
    time: T0 + offsetMinutes * MINUTE,
    open: (high + low) / 2,
    high,
    low,
    close: (high + low) / 2,
    volume: 0,
  };
}

function trade(over: Partial<ReplayTrade> = {}): ReplayTrade {
  return {
    seq: 1,
    side: 'long',
    qty: lots(1),
    entryPrice: price(1.1),
    entryMs: T0,
    exitPrice: price(1.102),
    exitMs: T0 + 10 * MINUTE,
    netPnl: 200,
    ...over,
  };
}

// Stop 10 pips below entry, target 20 above — the shape the fixtures actually produce.
const LEVELS = { stopDistance: 0.001, targetDistance: 0.002, inferredFrom: 2, outliers: 0 };

const base = {
  basis: 'bid' as const,
  spreadAt: () => 0.0002,
  valuePerPricePerLot: VALUE_PER_PRICE_PER_LOT,
  scale: SCALE,
  levels: LEVELS,
  // The fixtures index M1 directly, so a one-minute "chart bar" keeps the window exactly the
  // holding period.
  chartBarMs: MINUTE,
};

describe('inferBracketLevels', () => {
  it('recovers both distances from the run', () => {
    const levels = inferBracketLevels(
      [
        trade({ seq: 1, exitPrice: price(1.102) }), // +20 pips, target
        trade({ seq: 2, exitPrice: price(1.102) }),
        trade({ seq: 3, exitPrice: price(1.099) }), // -10 pips, stop
        trade({ seq: 4, exitPrice: price(1.099) }),
      ],
      SCALE.mintick * 2,
    );

    expect(levels).not.toBeNull();
    expect(levels!.targetDistance).toBeCloseTo(0.002, 9);
    expect(levels!.stopDistance).toBeCloseTo(0.001, 9);
    expect(levels!.outliers).toBe(0);
  });

  it('counts an odd exit as an outlier without moving the level', () => {
    const levels = inferBracketLevels(
      [
        trade({ seq: 1, exitPrice: price(1.099) }),
        trade({ seq: 2, exitPrice: price(1.099) }),
        trade({ seq: 3, exitPrice: price(1.099) }),
        trade({ seq: 4, exitPrice: price(1.099) }),
        trade({ seq: 5, exitPrice: price(1.0985) }), // a gap fill through the stop
        trade({ seq: 6, exitPrice: price(1.102) }),
      ],
      SCALE.mintick * 2,
    );

    expect(levels!.stopDistance).toBeCloseTo(0.001, 9);
    expect(levels!.outliers).toBe(1);
  });

  it('declines when exits do not cluster, rather than inventing a level', () => {
    const scattered = [1.0991, 1.0994, 1.0997, 1.1002, 1.1009, 1.1015].map((p, i) =>
      trade({ seq: i + 1, exitPrice: price(p) }),
    );
    expect(inferBracketLevels(scattered, SCALE.mintick * 2)).toBeNull();
  });
});

describe('replayIntrabar — missed stops', () => {
  it('finds a stop crossed before the engine reached its target', () => {
    // Engine closed this long at its 1.102 target. On M1 the bid dipped to 1.0989 first — through
    // the 1.099 stop — on a minute the H1 bar's own low never showed.
    const bars = [m1(0, 1.1005, 1.0995), m1(1, 1.1002, 1.0989), m1(2, 1.1025, 1.1)];

    const r = replayIntrabar({ ...base, trades: [trade()], m1: bars });

    expect(r.missedStops).toBe(1);
    expect(r.phantomTargets).toBe(0);
    expect(r.rows[0]!.flip).toBe('missed-stop');
    expect(r.rows[0]!.truePrice).toBeCloseTo(1.099, 9);
    // A +$200 win becomes a -$100 loss: 10 pips against instead of 20 for.
    expect(r.rows[0]!.netPnlCorrected).toBeCloseTo(-100, 6);
    expect(r.netPnlDelta).toBeCloseTo(-300, 6);
  });

  it('finds a short stop crossed on the ASK, which the stored high never reached', () => {
    // A short entered at 1.1 with its stop at 1.101. The stored high stops at 1.1009, but the ask
    // sits a full spread above it on a bid feed, so the stop really went.
    const bars = [m1(0, 1.1009, 1.0995), m1(1, 1.0995, 1.098)];

    const r = replayIntrabar({
      ...base,
      trades: [trade({ side: 'short', exitPrice: price(1.098) })],
      m1: bars,
    });

    expect(r.missedStops).toBe(1);
    expect(r.rows[0]!.truePrice).toBeCloseTo(1.101, 9);
  });

  it('does not flag a short stop the ask never reached', () => {
    const bars = [m1(0, 1.1006, 1.0995), m1(1, 1.0995, 1.098)];
    const r = replayIntrabar({
      ...base,
      trades: [trade({ side: 'short', exitPrice: price(1.098) })],
      m1: bars,
    });
    expect(r.missedStops).toBe(0);
  });

  it('takes the STOP when one minute touches both levels', () => {
    const bars = [m1(0, 1.1025, 1.0985)];
    const r = replayIntrabar({ ...base, trades: [trade()], m1: bars });
    expect(r.rows[0]!.flip).toBe('missed-stop');
  });
});

describe('replayIntrabar — phantom targets', () => {
  it('flags a target no minute ever reached', () => {
    const bars = [m1(0, 1.1005, 1.0995), m1(1, 1.1008, 1.0997)];
    const r = replayIntrabar({ ...base, trades: [trade()], m1: bars });

    expect(r.phantomTargets).toBe(1);
    expect(r.rows[0]!.flip).toBe('phantom-target');
    expect(r.rows[0]!.truePrice).toBeNull();
    // No correction, because where the trade would have ended is unknowable from here.
    expect(r.rows[0]!.netPnlCorrected).toBe(r.rows[0]!.netPnlReported);
  });

  it('does not flag a stop exit that no level confirmed', () => {
    const bars = [m1(0, 1.1005, 1.0995)];
    const r = replayIntrabar({
      ...base,
      trades: [trade({ exitPrice: price(1.099), netPnl: -100 })],
      m1: bars,
    });
    expect(r.phantomTargets).toBe(0);
    expect(r.rows[0]!.flip).toBe('none');
  });
});

describe('replayIntrabar — agreement', () => {
  it('reports no flip when the engine and the replay agree', () => {
    const bars = [m1(0, 1.1005, 1.0995), m1(1, 1.1025, 1.1)];
    const r = replayIntrabar({ ...base, trades: [trade()], m1: bars });

    expect(r.rows[0]!.flip).toBe('none');
    expect(r.netPnlDelta).toBeCloseTo(0, 9);
  });

  it('is basis-sensitive: a mid feed crosses a stop a bid feed does not', () => {
    // The stored low is 1.09905 — above the 1.099 stop, but by less than half a spread, so a mid
    // feed's bid dips through it and a bid feed's does not.
    const bars = [m1(0, 1.1005, 1.09905), m1(1, 1.1025, 1.1)];

    const onBid = replayIntrabar({ ...base, trades: [trade()], m1: bars });
    const onMid = replayIntrabar({ ...base, basis: 'mid', trades: [trade()], m1: bars });

    expect(onBid.missedStops).toBe(0);
    expect(onMid.missedStops).toBe(1);
  });
});

describe('replayIntrabar — n/a', () => {
  it('declines when the levels cannot be recovered', () => {
    const scattered = [1.0991, 1.0994, 1.0997, 1.1002, 1.1009, 1.1015].map((p, i) =>
      trade({ seq: i + 1, exitPrice: price(p) }),
    );
    const r = replayIntrabar({
      ...base,
      levels: undefined,
      trades: scattered,
      m1: [m1(0, 1.11, 1.09)],
    });

    expect(r.assessed).toBe(0);
    expect(r.explanation).toContain('cannot be recovered');
  });

  it('declines when nothing was a resting order', () => {
    const r = replayIntrabar({
      ...base,
      levels: undefined,
      trades: [trade()],
      m1: [m1(0, 1.11, 1.09)],
      isLevelExit: () => false,
    });

    expect(r.assessed).toBe(0);
    expect(r.explanation).toContain('closes at market');
  });

  it('skips a trade the M1 series does not cover', () => {
    const r = replayIntrabar({
      ...base,
      trades: [trade({ entryMs: T0 + 500 * MINUTE, exitMs: T0 + 510 * MINUTE })],
      m1: [m1(0, 1.1005, 1.0995)],
    });
    expect(r.assessed).toBe(0);
    expect(r.skipped).toBe(1);
  });
});

describe('replayIntrabar — several exit ids', () => {
  it('reports a trade n/a rather than pairing it with the wrong bracket', () => {
    // The target would be reached, but which bracket owns it is unknown.
    const bars = [m1(0, 1.1005, 1.0995), m1(1, 1.1025, 1.1)];

    const r = replayIntrabar({
      ...base,
      levels: undefined,
      levelsAt: () => ({
        stop: null,
        target: null,
        trailing: false,
        ambiguous: true,
        setOnBar: 0,
      }),
      trades: [trade()],
      m1: bars,
    });

    expect(r.assessed).toBe(0);
    expect(r.ambiguous).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.explanation).toContain('several exit ids');
  });

  it('replays normally once the closing bracket is known', () => {
    const bars = [m1(0, 1.1005, 1.0995), m1(1, 1.1025, 1.1)];

    const r = replayIntrabar({
      ...base,
      levels: undefined,
      levelsAt: () => ({
        stop: 1.099,
        target: 1.102,
        trailing: false,
        ambiguous: false,
        setOnBar: 0,
      }),
      trades: [trade()],
      m1: bars,
    });

    expect(r.assessed).toBe(1);
    expect(r.ambiguous).toBe(0);
    expect(r.rows[0]!.flip).toBe('none');
  });
});
