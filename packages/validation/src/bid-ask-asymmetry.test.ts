import { accountMoney, lots, price } from '@edgelab/shared';
import { describe, expect, it } from 'vitest';

import {
  checkBidAskAsymmetry,
  levelExitIdsFromSource,
  type LevelExitTrade,
} from './bid-ask-asymmetry';

/**
 * The claim under test: the spread never pays you. A target gets harder and a stop gets easier, on
 * both sides and on every basis — and on a BID feed the whole error lands on the shorts.
 */

const SPREAD = 0.0002;
/** One lot of a 5-digit pair: 100,000 units at pointValue 1, so one price unit is $100,000. */
const VALUE_PER_PRICE_PER_LOT = 100_000;

// Exit bar is generous in both directions, so nothing flips unless a test makes it flip.
const BARS = [
  { high: 1.2, low: 1.0 },
  { high: 1.2, low: 1.0 },
];

function trade(over: Partial<LevelExitTrade> = {}): LevelExitTrade {
  return {
    seq: 1,
    side: 'long',
    qty: lots(1),
    entryPrice: price(1.1),
    exitPrice: price(1.11),
    exitBar: 1,
    netPnl: accountMoney(1000),
    ...over,
  };
}

const SCALE = { mintick: 0.00001, pipSize: 0.0001 };

const base = {
  bars: BARS,
  spreadAt: () => SPREAD,
  valuePerPricePerLot: VALUE_PER_PRICE_PER_LOT,
  scale: SCALE,
  isLevelExit: () => true,
};

describe('checkBidAskAsymmetry — bid feed', () => {
  it('leaves long-side levels exact', () => {
    const r = checkBidAskAsymmetry({ ...base, basis: 'bid', trades: [trade()] });
    expect(r.rows[0]!.quoteSide).toBe('bid');
    expect(r.rows[0]!.priceError).toBe(0);
    expect(r.rows[0]!.accountError).toBe(0);
  });

  it('moves every short-side level by a FULL spread', () => {
    const r = checkBidAskAsymmetry({
      ...base,
      basis: 'bid',
      trades: [trade({ side: 'short', entryPrice: price(1.11), exitPrice: price(1.1) })],
    });
    expect(r.rows[0]!.quoteSide).toBe('ask');
    expect(r.rows[0]!.priceError).toBeCloseTo(SPREAD, 12);
    expect(r.rows[0]!.accountError).toBeCloseTo(20, 9);
  });

  it('names the asymmetry in its explanation', () => {
    const r = checkBidAskAsymmetry({ ...base, basis: 'bid', trades: [trade()] });
    expect(r.explanation).toContain('SHORT-side');
  });
});

describe('checkBidAskAsymmetry — mid feed', () => {
  it('moves BOTH sides by half a spread', () => {
    const r = checkBidAskAsymmetry({
      ...base,
      basis: 'mid',
      trades: [
        trade(),
        trade({ seq: 2, side: 'short', entryPrice: price(1.11), exitPrice: price(1.1) }),
      ],
    });
    expect(r.rows[0]!.priceError).toBeCloseTo(SPREAD / 2, 12);
    expect(r.rows[1]!.priceError).toBeCloseTo(SPREAD / 2, 12);
  });

  it('costs the same in total as a bid feed, spread over both sides', () => {
    const pair: LevelExitTrade[] = [
      trade(),
      trade({ seq: 2, side: 'short', entryPrice: price(1.11), exitPrice: price(1.1) }),
    ];
    const bid = checkBidAskAsymmetry({ ...base, basis: 'bid', trades: pair });
    const mid = checkBidAskAsymmetry({ ...base, basis: 'mid', trades: pair });
    expect(mid.totalAccountError).toBeCloseTo(bid.totalAccountError, 9);
  });

  it('treats a last-trade feed as mid', () => {
    const last = checkBidAskAsymmetry({ ...base, basis: 'last', trades: [trade()] });
    const mid = checkBidAskAsymmetry({ ...base, basis: 'mid', trades: [trade()] });
    expect(last.totalAccountError).toBe(mid.totalAccountError);
    expect(last.explanation).toContain('treated as mid');
  });
});

describe('checkBidAskAsymmetry — direction of the error', () => {
  it('makes a long target harder to reach', () => {
    const r = checkBidAskAsymmetry({ ...base, basis: 'mid', trades: [trade()] });
    const row = r.rows[0]!;
    expect(row.kind).toBe('target');
    // The bid is BELOW the mid, so the stored high must run further up to get there.
    expect(row.requiredStoredPrice).toBeGreaterThan(row.modelledPrice);
  });

  it('makes a long stop trigger EARLIER, which is also adverse', () => {
    const r = checkBidAskAsymmetry({
      ...base,
      basis: 'mid',
      trades: [trade({ exitPrice: price(1.09) })],
    });
    const row = r.rows[0]!;
    expect(row.kind).toBe('stop');
    expect(row.requiredStoredPrice).toBeGreaterThan(row.modelledPrice);
    expect(row.outcomeFlips).toBe(false);
  });

  it('makes a short target harder to reach', () => {
    const r = checkBidAskAsymmetry({
      ...base,
      basis: 'bid',
      trades: [trade({ side: 'short', entryPrice: price(1.11), exitPrice: price(1.1) })],
    });
    const row = r.rows[0]!;
    expect(row.kind).toBe('target');
    // The ask is ABOVE the bid, so the stored low must run further down.
    expect(row.requiredStoredPrice).toBeLessThan(row.modelledPrice);
  });
});

describe('checkBidAskAsymmetry — flips', () => {
  it('flags a target the bar only just reached', () => {
    // Bar high is exactly the modelled target, so on a mid feed the bid never got there.
    const r = checkBidAskAsymmetry({
      ...base,
      bars: [
        { high: 1.2, low: 1.0 },
        { high: 1.11, low: 1.0 },
      ],
      basis: 'mid',
      trades: [trade()],
    });
    expect(r.rows[0]!.outcomeFlips).toBe(true);
    expect(r.flips).toBe(1);
  });

  it('does not flag a target the bar cleared by more than the spread', () => {
    const r = checkBidAskAsymmetry({ ...base, basis: 'mid', trades: [trade()] });
    expect(r.flips).toBe(0);
  });

  it('never flips on a bid feed for a long, because the level is exact', () => {
    const r = checkBidAskAsymmetry({
      ...base,
      bars: [
        { high: 1.2, low: 1.0 },
        { high: 1.11, low: 1.0 },
      ],
      basis: 'bid',
      trades: [trade()],
    });
    expect(r.flips).toBe(0);
  });
});

describe('checkBidAskAsymmetry — n/a', () => {
  it('assesses nothing without a level-exit classifier', () => {
    const r = checkBidAskAsymmetry({
      bars: BARS,
      spreadAt: () => SPREAD,
      valuePerPricePerLot: VALUE_PER_PRICE_PER_LOT,
      scale: SCALE,
      basis: 'mid',
      trades: [trade()],
    });
    expect(r.assessed).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.meanAccountError).toBeNull();
    expect(r.explanation).toContain('nothing is assumed');
  });

  it('skips market exits', () => {
    const r = checkBidAskAsymmetry({
      ...base,
      basis: 'mid',
      trades: [trade(), trade({ seq: 2 })],
      isLevelExit: (seq) => seq === 1,
    });
    expect(r.assessed).toBe(1);
    expect(r.skipped).toBe(1);
  });
});

describe('levelExitIdsFromSource', () => {
  it('finds a positional id', () => {
    expect(levelExitIdsFromSource('strategy.exit("Bracket", profit=10, loss=5)')).toEqual(
      new Set(['Bracket']),
    );
  });

  it('finds a named id', () => {
    expect(levelExitIdsFromSource("strategy.exit(id='TP', profit=10)")).toEqual(new Set(['TP']));
  });

  it('ignores a call inside a comment', () => {
    expect(levelExitIdsFromSource('// strategy.exit("Ghost", profit=1)')).toEqual(new Set());
  });

  it('does not treat an entry as a resting order', () => {
    expect(levelExitIdsFromSource('strategy.entry("Long", strategy.long)')).toEqual(new Set());
  });

  it('skips an id it cannot resolve statically', () => {
    // A variable id is unknowable here, so the exit is left unclassified and gets skipped
    // downstream rather than being assumed to be a level.
    expect(levelExitIdsFromSource('strategy.exit(myId, profit=10)')).toEqual(new Set());
  });

  it('collects every distinct exit in a script', () => {
    const src = ['strategy.exit("A", loss=1)', 'strategy.exit("B", profit=2)'].join('\n');
    expect(levelExitIdsFromSource(src)).toEqual(new Set(['A', 'B']));
  });
});
