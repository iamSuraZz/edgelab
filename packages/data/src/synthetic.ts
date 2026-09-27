import type { Bar } from '@edgelab/shared';

/**
 * Deterministic synthetic M1 bars.
 *
 * Exists so CI can run the full e2e and smoke suites without calling a market-data provider.
 * That is not a convenience: Dukascopy is currently rate-limiting us outright, Twelve Data's free
 * tier is 800 requests a day, and a CI job that burns a shared daily budget on every push would
 * make the budget useless for real work. Vendor data is also not ours to commit to a public repo.
 *
 * The shape matters more than it looks. The suites assert that a strategy TRADES — the smoke test
 * clicks a trade and expects the chart to move to it — so a flat or monotonic series would pass the
 * bar-count precondition and then fail everything downstream for reasons that look like engine
 * bugs. Hence two superimposed sines plus a drift: the fast component produces oscillator
 * crossings, the slow one produces trends for the breakout strategies, and the drift keeps long and
 * short from being mirror images.
 *
 * Pure and seeded only by the arguments, so the same window always yields the same bars and a CI
 * failure is reproducible locally.
 */

const MS_PER_MINUTE = 60_000;

export interface SyntheticSeriesParams {
  readonly fromMs: number;
  /** Exclusive. */
  readonly toMs: number;
  /** Mid price the series oscillates around. */
  readonly basePrice?: number;
  /** Price increment the series snaps to, so prices are representable like real quotes. */
  readonly mintick?: number;
  /** Spread in PRICE units written on every bar. */
  readonly spread?: number;
  /**
   * Skip Saturday and Sunday.
   *
   * On by default because forex is closed then, and a series with weekend bars would quietly
   * invalidate every session and completeness check that reads this data.
   */
  readonly skipWeekends?: boolean;
}

/**
 * Generate M1 bars over `[fromMs, toMs)`.
 *
 * Every bar carries non-zero volume and a non-flat range on purpose: the D4 filler rule drops bars
 * that are BOTH flat and zero-volume, so a naive generator produces a series that is silently
 * discarded at import and a coverage count of zero.
 */
export function syntheticM1(params: SyntheticSeriesParams): Bar[] {
  const base = params.basePrice ?? 1.1;
  const mintick = params.mintick ?? 0.00001;
  const spread = params.spread ?? 0.00003;
  const skipWeekends = params.skipWeekends ?? true;

  const snap = (value: number): number => Math.round(value / mintick) * mintick;
  const bars: Bar[] = [];

  let i = 0;
  for (let t = params.fromMs; t < params.toMs; t += MS_PER_MINUTE, i += 1) {
    if (skipWeekends) {
      const day = new Date(t).getUTCDay();
      if (day === 0 || day === 6) continue;
    }

    // Fast oscillation for crossovers, slow for trends, drift so the two sides differ.
    const mid = base + Math.sin(i / 90) * 0.004 + Math.sin(i / 1_500) * 0.012 + i * 4e-8;
    // Varying range, never zero — a flat bar with zero volume is treated as filler and dropped.
    const half = 0.00012 + Math.abs(Math.cos(i / 37)) * 0.00018;
    const close = mid + half * Math.sin(i / 11) * 0.6;

    bars.push({
      time: t,
      open: snap(mid),
      high: snap(Math.max(mid, close) + half),
      low: snap(Math.min(mid, close) - half),
      close: snap(close),
      // Never zero, and varying so volume-weighted arithmetic is exercised.
      volume: 40 + (i % 23),
      spread,
    });
  }

  return bars;
}

/** How many bars `syntheticM1` will produce, without building them. */
export function syntheticBarCount(params: SyntheticSeriesParams): number {
  return syntheticM1(params).length;
}
