import { describe, expect, it } from 'vitest';

import {
  comparePrefix,
  cutoffsFor,
  runPrefixInvariance,
  type ComparableTrade,
} from './prefix-invariance';

/**
 * Prefix invariance.
 *
 * Two failure modes to guard against, and they pull in opposite directions: missing a real leak,
 * and reporting one on a clean strategy because the bucket straddling the cutoff differs. The
 * margin exists for the second, so most of these tests are about it.
 */

const HOUR = 3_600_000;
const H4 = 4 * HOUR;
const T0 = Date.UTC(2024, 0, 2);

function trade(overrides: Partial<ComparableTrade> = {}): ComparableTrade {
  return {
    side: 'long',
    qty: 1,
    entryBar: 10,
    entryTime: T0 + 10 * HOUR,
    entryPrice: 1.1,
    exitBar: 14,
    exitTime: T0 + 14 * HOUR,
    exitPrice: 1.11,
    ...overrides,
  };
}

describe('comparePrefix', () => {
  it('agrees when the runs are identical', () => {
    const trades = [trade(), trade({ entryBar: 20, entryTime: T0 + 20 * HOUR })];

    const result = comparePrefix({
      full: { trades },
      truncated: { trades },
      cutoffMs: T0 + 40 * HOUR,
      marginMs: H4,
    });

    expect(result.divergence).toBeNull();
    expect(result.compared).toBe(2);
  });

  it('reports a changed entry bar with both values', () => {
    const result = comparePrefix({
      full: { trades: [trade({ entryBar: 10 })] },
      truncated: { trades: [trade({ entryBar: 11 })] },
      cutoffMs: T0 + 40 * HOUR,
      marginMs: H4,
    });

    expect(result.divergence).not.toBeNull();
    expect(result.divergence!.field).toBe('entryBar');
    expect(result.divergence!.fullValue).toBe(10);
    expect(result.divergence!.truncatedValue).toBe(11);
    expect(result.divergence!.tradeSeq).toBe(1);
  });

  it('reports a flipped side', () => {
    const result = comparePrefix({
      full: { trades: [trade({ side: 'long' })] },
      truncated: { trades: [trade({ side: 'short' })] },
      cutoffMs: T0 + 40 * HOUR,
      marginMs: H4,
    });

    expect(result.divergence!.field).toBe('side');
  });

  it('reports a different number of decisions', () => {
    const result = comparePrefix({
      full: { trades: [trade(), trade({ entryBar: 20, entryTime: T0 + 20 * HOUR })] },
      truncated: { trades: [trade()] },
      cutoffMs: T0 + 40 * HOUR,
      marginMs: H4,
    });

    expect(result.divergence!.field).toBe('trade count before cutoff');
    expect(result.divergence!.fullValue).toBe(2);
    expect(result.divergence!.truncatedValue).toBe(1);
  });

  it('treats a price difference beyond 1e-9 as a divergence', () => {
    const result = comparePrefix({
      full: { trades: [trade({ entryPrice: 1.1 })] },
      truncated: { trades: [trade({ entryPrice: 1.1 + 1e-6 })] },
      cutoffMs: T0 + 40 * HOUR,
      marginMs: H4,
    });

    expect(result.divergence!.field).toBe('entryPrice');
  });

  it('tolerates float noise below 1e-9', () => {
    const result = comparePrefix({
      full: { trades: [trade({ entryPrice: 1.1 })] },
      truncated: { trades: [trade({ entryPrice: 1.1 + 1e-12 })] },
      cutoffMs: T0 + 40 * HOUR,
      marginMs: H4,
    });

    expect(result.divergence).toBeNull();
  });

  it('IGNORES decisions inside the margin — the clean-strategy case', () => {
    // A trade entered one hour before the cutoff sits inside the H4 bucket that truncation drops.
    // Differing there is expected, and reporting it would fail every honest HTF strategy.
    const cutoffMs = T0 + 40 * HOUR;
    const insideMargin = { entryBar: 39, entryTime: cutoffMs - HOUR };

    const result = comparePrefix({
      full: { trades: [trade(), trade({ ...insideMargin, side: 'long' })] },
      truncated: { trades: [trade(), trade({ ...insideMargin, side: 'short' })] },
      cutoffMs,
      marginMs: H4,
    });

    expect(result.divergence).toBeNull();
    expect(result.compared).toBe(1);
  });

  it('still catches a divergence just OUTSIDE the margin', () => {
    const cutoffMs = T0 + 40 * HOUR;
    const outsideMargin = { entryBar: 30, entryTime: cutoffMs - 10 * HOUR };

    const result = comparePrefix({
      full: { trades: [trade({ ...outsideMargin, side: 'long' })] },
      truncated: { trades: [trade({ ...outsideMargin, side: 'short' })] },
      cutoffMs,
      marginMs: H4,
    });

    expect(result.divergence!.field).toBe('side');
  });

  it('does not fault a truncated run for a position it had no data to close', () => {
    // Entry well before the boundary so it IS compared, but the exit lands after the cutoff.
    const cutoffMs = T0 + 30 * HOUR;
    const entry = { entryBar: 5, entryTime: T0 + 5 * HOUR };

    const result = comparePrefix({
      full: {
        trades: [trade({ ...entry, exitBar: 40, exitTime: T0 + 40 * HOUR, exitPrice: 1.11 })],
      },
      truncated: { trades: [trade({ ...entry, exitBar: null, exitTime: null, exitPrice: null })] },
      cutoffMs,
      marginMs: H4,
    });

    expect(result.compared).toBe(1);
    expect(result.divergence).toBeNull();
  });

  it('DOES fault a truncated run that failed to reproduce an exit it had data for', () => {
    const cutoffMs = T0 + 40 * HOUR;
    const entry = { entryBar: 5, entryTime: T0 + 5 * HOUR };
    const closed = { exitBar: 14, exitTime: T0 + 14 * HOUR, exitPrice: 1.11 };

    const result = comparePrefix({
      full: { trades: [trade({ ...entry, ...closed })] },
      truncated: {
        trades: [trade({ ...entry, exitBar: null, exitTime: null, exitPrice: null })],
      },
      cutoffMs,
      marginMs: H4,
    });

    expect(result.divergence!.field).toBe('exitBar');
    expect(result.divergence!.truncatedValue).toBe('still open');
  });
});

describe('cutoffsFor', () => {
  it('spaces cutoffs strictly inside the window', () => {
    const cutoffs = cutoffsFor(0, 1000, 4);

    expect(cutoffs).toEqual([200, 400, 600, 800]);
    expect(Math.min(...cutoffs)).toBeGreaterThan(0);
    expect(Math.max(...cutoffs)).toBeLessThan(1000);
  });

  it('returns six for the spec default', () => {
    expect(cutoffsFor(0, 700, 6)).toHaveLength(6);
  });

  it('returns nothing for a degenerate window', () => {
    expect(cutoffsFor(500, 500, 6)).toEqual([]);
    expect(cutoffsFor(0, 1000, 0)).toEqual([]);
  });
});

describe('runPrefixInvariance', () => {
  const full = {
    trades: [
      trade({ entryBar: 5, entryTime: T0 + 5 * HOUR }),
      trade({ entryBar: 25, entryTime: T0 + 25 * HOUR }),
    ],
  };

  it('passes a strategy that reproduces itself at every cutoff', async () => {
    const result = await runPrefixInvariance({
      full,
      cutoffs: cutoffsFor(T0, T0 + 100 * HOUR, 6),
      marginMs: H4,
      runAt: () => Promise.resolve(full),
    });

    expect(result.firstDivergence).toBeNull();
    expect(result.comparisons).toHaveLength(6);
    expect(result.usableCutoffs).toBeGreaterThan(0);
  });

  it('reports the EARLIEST divergent bar across cutoffs, not the first cutoff', async () => {
    // The later cutoff exposes an early divergence; the earlier cutoff exposes a late one. The
    // report should point at the early bar, because that is where behaviour first differed.
    const cutoffs = [T0 + 40 * HOUR, T0 + 80 * HOUR];

    const result = await runPrefixInvariance({
      full,
      cutoffs,
      marginMs: H4,
      runAt: (cutoffMs) =>
        Promise.resolve(
          cutoffMs === T0 + 80 * HOUR
            ? { trades: [{ ...full.trades[0]!, side: 'short' }, full.trades[1]!] }
            : { trades: [full.trades[0]!, { ...full.trades[1]!, side: 'short' }] },
        ),
    });

    expect(result.firstDivergence).not.toBeNull();
    expect(result.firstDivergence!.bar).toBe(5);
    expect(result.firstDivergence!.cutoffMs).toBe(T0 + 80 * HOUR);
  });

  it('runs one truncated pass per cutoff and no more', async () => {
    const seen: number[] = [];
    const cutoffs = cutoffsFor(T0, T0 + 100 * HOUR, 6);

    await runPrefixInvariance({
      full,
      cutoffs,
      marginMs: H4,
      runAt: (cutoffMs) => {
        seen.push(cutoffMs);
        return Promise.resolve(full);
      },
    });

    expect(seen).toEqual([...cutoffs]);
  });
});
