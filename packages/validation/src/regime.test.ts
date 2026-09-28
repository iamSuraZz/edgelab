import type { Bar } from '@edgelab/shared';
import { describe, expect, it } from 'vitest';

import {
  atr,
  breakdownByRegime,
  dailySessions,
  fxSessionBoundaries,
  labelDays,
  regimeAtEntry,
  trailingPercentile,
  type DailyBar,
} from './regime';

/**
 * The three things this has to get right are the session boundary, the refusal to label without a
 * full lookback, and using only the PREVIOUS session's close to describe a trade.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

function m1(timeMs: number, price: number, high = price, low = price): Bar {
  return { time: timeMs, open: price, high, low, close: price, volume: 0 };
}

describe('dailySessions', () => {
  const T = Date.UTC(2023, 0, 2, 0, 0);
  const boundaries = [T + 12 * HOUR, T + 36 * HOUR];

  it('puts a bar exactly AT the close into the session ending there', () => {
    const bars = [m1(T, 1), m1(T + 12 * HOUR, 2)];
    const out = dailySessions(bars, boundaries);

    expect(out[0]!.close).toBe(2);
    expect(out).toHaveLength(1);
  });

  it('starts the next session strictly after the boundary', () => {
    const bars = [m1(T + 12 * HOUR, 2), m1(T + 13 * HOUR, 3)];
    const out = dailySessions(bars, boundaries);

    expect(out[0]!.close).toBe(2);
    expect(out[1]!.open).toBe(3);
  });

  it('takes the true high and low across the session', () => {
    const bars = [m1(T + HOUR, 1, 5, 0.5), m1(T + 2 * HOUR, 2, 4, 0.2)];
    const out = dailySessions(bars, boundaries);

    expect(out[0]!.high).toBe(5);
    expect(out[0]!.low).toBe(0.2);
  });

  it('DROPS an empty session rather than emitting a flat bar', () => {
    // A weekend has no trading; a flat placeholder would add a zero-range bar to every ATR window.
    const bars = [m1(T + HOUR, 1)];
    const out = dailySessions(bars, boundaries);

    expect(out).toHaveLength(1);
    expect(out[0]!.closeMs).toBe(boundaries[0]);
  });
});

describe('atr', () => {
  const bars: DailyBar[] = Array.from({ length: 20 }, (_u, i) => ({
    closeMs: i,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
  }));

  it('has no value before the period is satisfied', () => {
    const out = atr(bars, 14);
    expect(out[0]).toBeNull();
    expect(out[13]).toBeNull();
    expect(out[14]).not.toBeNull();
  });

  it('measures a constant 2-point range as 2', () => {
    expect(atr(bars, 14)[14]).toBeCloseTo(2, 9);
  });

  it('includes the gap from the previous close in true range', () => {
    const gapped = [...bars];
    gapped[15] = { closeMs: 15, open: 110, high: 111, low: 109, close: 110 };
    const out = atr(gapped, 14);

    // The 9-point gap dwarfs the 2-point bar range, so ATR must rise.
    expect(out[15]!).toBeGreaterThan(out[14]!);
  });
});

describe('trailingPercentile', () => {
  const values = Array.from({ length: 300 }, (_u, i) => i);

  it('is null before the lookback is satisfied', () => {
    expect(trailingPercentile(values, 250, 252)).toBeNull();
    expect(trailingPercentile(values, 251, 252)).not.toBeNull();
  });

  it('puts the largest value in the window at the top', () => {
    expect(trailingPercentile(values, 299, 252)).toBeCloseTo(251 / 252, 6);
  });

  it('refuses a window that is mostly holes', () => {
    const sparse: (number | null)[] = Array.from({ length: 300 }, (_u, i) =>
      i % 3 === 0 ? i : null,
    );
    expect(trailingPercentile(sparse, 299, 252)).toBeNull();
  });
});

describe('labelDays — the full lookback or nothing', () => {
  function series(count: number, priceAt: (i: number) => number): DailyBar[] {
    return Array.from({ length: count }, (_u, i) => {
      const p = priceAt(i);
      return { closeMs: i * 86_400_000, open: p, high: p * 1.01, low: p * 0.99, close: p };
    });
  }

  it('labels everything unclassified below 200 bars', () => {
    const labels = labelDays(series(150, () => 1.1));
    expect(labels.every((l) => l.regime === 'unclassified')).toBe(true);
  });

  it('never computes a direction from a shorter window', () => {
    const labels = labelDays(series(260, (i) => 1 + i * 0.001));
    // Bar 198 has 199 bars of history: still unclassified, not "trending on 199".
    expect(labels[198]!.regime).toBe('unclassified');
    expect(labels[199]!.regime).not.toBe('unclassified');
  });

  it('calls a steady climb trending-up and a flat market ranging', () => {
    const climbing = labelDays(series(260, (i) => 1 + i * 0.002));
    const flat = labelDays(series(260, () => 1.1));

    expect(climbing[259]!.regime).toBe('trending-up');
    expect(flat[259]!.regime).toBe('ranging');
  });

  it('calls a steady fall trending-down', () => {
    const falling = labelDays(series(260, (i) => 2 - i * 0.002));
    expect(falling[259]!.regime).toBe('trending-down');
  });

  it('withholds the volatility band until 252 bars exist', () => {
    const labels = labelDays(series(260, (i) => 1 + i * 0.002));
    expect(labels[250]!.volatility).toBe('unclassified');
    expect(labels[259]!.volatility).not.toBe('unclassified');
  });
});

describe('regimeAtEntry — no peeking at the running day', () => {
  const labels = [
    {
      closeMs: 100,
      regime: 'ranging' as const,
      volatility: 'normal' as const,
      smaDistancePct: 0,
      atrPercentile: 0.5,
    },
    {
      closeMs: 200,
      regime: 'trending-up' as const,
      volatility: 'high' as const,
      smaDistancePct: 0.05,
      atrPercentile: 0.9,
    },
  ];

  it('uses the last session that closed BEFORE the entry', () => {
    expect(regimeAtEntry(labels, 150)!.regime).toBe('ranging');
    expect(regimeAtEntry(labels, 250)!.regime).toBe('trending-up');
  });

  it('will not use a session closing exactly at the entry', () => {
    // That close is not yet known to a decision taken at that instant.
    expect(regimeAtEntry(labels, 200)!.regime).toBe('ranging');
  });

  it('is null before any session has closed', () => {
    expect(regimeAtEntry(labels, 50)).toBeNull();
  });
});

describe('breakdownByRegime', () => {
  const labels = labelDays(
    Array.from({ length: 260 }, (_u, i) => {
      const p = 1 + i * 0.002;
      return { closeMs: i * 86_400_000, open: p, high: p * 1.01, low: p * 0.99, close: p };
    }),
  );

  it('reports the unclassified share rather than hiding it', () => {
    const early = 10 * 86_400_000;
    const r = breakdownByRegime([{ entryMs: early, netPnl: 100 }], labels);

    expect(r.unclassifiedPct).toBe(100);
    expect(r.explanation).toContain('different measurements');
  });

  it('splits profit by the regime in force at entry', () => {
    const late = 255 * 86_400_000;
    const early = 10 * 86_400_000;

    const r = breakdownByRegime(
      [
        { entryMs: late, netPnl: 300 },
        { entryMs: late, netPnl: -100 },
        { entryMs: early, netPnl: 50 },
      ],
      labels,
    );

    const trending = r.buckets.find((b) => b.regime === 'trending-up')!;
    expect(trending.trades).toBe(2);
    expect(trending.netProfit).toBe(200);
    expect(trending.winRatePct).toBe(50);
    expect(r.unclassifiedPct).toBeCloseTo(100 / 3, 6);
  });

  it('omits buckets with no trades rather than showing empty rows', () => {
    const r = breakdownByRegime([{ entryMs: 255 * 86_400_000, netPnl: 1 }], labels);
    expect(r.buckets.every((b) => b.trades > 0)).toBe(true);
  });
});

describe('fxSessionBoundaries', () => {
  // 0 = Sunday, matching localClock's convention.
  const dow = (ms: number) => new Date(ms).getUTCDay();

  it('removes Sunday boundaries, which is what yields five sessions a week', () => {
    // A full week of daily instants, Sunday through Saturday.
    const week = Array.from({ length: 7 }, (_u, i) => Date.UTC(2023, 0, 1 + i));
    const kept = fxSessionBoundaries(week, dow);

    expect(kept).toHaveLength(6);
    expect(kept.some((b) => dow(b) === 0)).toBe(false);
  });

  it('leaves every other day alone', () => {
    const week = Array.from({ length: 7 }, (_u, i) => Date.UTC(2023, 0, 2 + i));
    expect(fxSessionBoundaries(week, dow).map(dow)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('is what stops a Sunday-evening open becoming its own one-bar session', () => {
    // Measured on the real feed: without this, 41 sessions of a single bar each per year.
    const sunday = Date.UTC(2023, 0, 1);
    const monday = Date.UTC(2023, 0, 2);
    expect(fxSessionBoundaries([sunday, monday], dow)).toEqual([monday]);
  });
});
