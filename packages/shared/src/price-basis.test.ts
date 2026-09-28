import { describe, expect, it } from 'vitest';

import type { Bar } from './market';
import {
  deriveQuotes,
  describeBasis,
  fillSide,
  isBasisDeclared,
  priceBasisForSource,
  quoteFor,
  spreadShare,
} from './price-basis';

/**
 * The basis decides where a trade can actually happen. The invariant that matters across all of it:
 * ask - bid == spread, whatever the basis, and a round trip costs exactly one spread.
 */

const BAR: Bar = { time: 0, open: 1.1, high: 1.105, low: 1.095, close: 1.102, volume: 0 };
const SPREAD = 0.0001;

describe('priceBasisForSource', () => {
  it('declares bid for the quote feeds', () => {
    expect(priceBasisForSource('dukascopy')).toBe('bid');
    expect(priceBasisForSource('mt5')).toBe('bid');
  });

  it('declares mid for Twelve Data', () => {
    expect(priceBasisForSource('twelvedata')).toBe('mid');
  });

  it('declares last for Binance, which prints trades rather than quotes', () => {
    expect(priceBasisForSource('binance')).toBe('last');
  });

  it('assumes bid for an unknown feed, and says so', () => {
    expect(priceBasisForSource('some-new-vendor')).toBe('bid');
    expect(isBasisDeclared('some-new-vendor')).toBe(false);
    expect(describeBasis('some-new-vendor')).toContain('not declared');
  });

  it('does not claim a quote it never received', () => {
    expect(describeBasis('binance')).toContain('treated as mid');
  });
});

describe('spreadShare', () => {
  it('charges a bid-feed buyer everything and a seller nothing', () => {
    expect(spreadShare('bid', 'buy')).toBe(1);
    expect(spreadShare('bid', 'sell')).toBe(0);
  });

  it('charges both sides half on a mid feed', () => {
    expect(spreadShare('mid', 'buy')).toBe(0.5);
    expect(spreadShare('mid', 'sell')).toBe(0.5);
  });

  it('costs exactly one spread per round trip on every basis', () => {
    for (const basis of ['bid', 'mid', 'last'] as const) {
      expect(spreadShare(basis, 'buy') + spreadShare(basis, 'sell')).toBe(1);
    }
  });
});

describe('quoteFor', () => {
  it('leaves the bid alone on a bid feed', () => {
    const q = quoteFor(1.1, 'bid', SPREAD);
    expect(q.bid).toBe(1.1);
    expect(q.ask).toBeCloseTo(1.1001, 10);
  });

  it('straddles a mid', () => {
    const q = quoteFor(1.1, 'mid', SPREAD);
    expect(q.bid).toBeCloseTo(1.09995, 10);
    expect(q.ask).toBeCloseTo(1.10005, 10);
  });

  it('keeps ask - bid equal to the spread on every basis', () => {
    for (const basis of ['bid', 'mid', 'last'] as const) {
      const q = quoteFor(1.1, basis, SPREAD);
      expect(q.ask - q.bid).toBeCloseTo(SPREAD, 12);
    }
  });
});

describe('deriveQuotes', () => {
  it('returns the bar unchanged as the bid on a bid feed', () => {
    const q = deriveQuotes(BAR, 'bid', SPREAD);
    expect(q.bid).toEqual({ open: 1.1, high: 1.105, low: 1.095, close: 1.102 });
    expect(q.ask.high).toBeCloseTo(1.1051, 10);
  });

  it('shifts both sides half a spread apart around a mid bar', () => {
    const q = deriveQuotes(BAR, 'mid', SPREAD);
    expect(q.bid.high).toBeCloseTo(1.10495, 10);
    expect(q.ask.high).toBeCloseTo(1.10505, 10);
  });

  it('preserves the spread across every field', () => {
    for (const basis of ['bid', 'mid', 'last'] as const) {
      const q = deriveQuotes(BAR, basis, SPREAD);
      for (const f of ['open', 'high', 'low', 'close'] as const) {
        expect(q.ask[f] - q.bid[f]).toBeCloseTo(SPREAD, 12);
      }
    }
  });

  it('is the identity on both sides when the spread is zero', () => {
    const q = deriveQuotes(BAR, 'mid', 0);
    expect(q.bid).toEqual(q.ask);
    expect(q.bid.close).toBe(BAR.close);
  });
});

describe('fillSide', () => {
  it('lifts the ask to buy and hits the bid to sell', () => {
    expect(fillSide('buy')).toBe('ask');
    expect(fillSide('sell')).toBe('bid');
  });
});
