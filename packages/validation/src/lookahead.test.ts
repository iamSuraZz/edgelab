import { describe, expect, it } from 'vitest';
import type { Candle } from '@edgelab/shared';

import { bucketsFromCandles, checkCausality, type SecurityObservation } from './lookahead';

/**
 * The causality check has to get two things right that a naive version gets wrong: judging at the
 * bar's CLOSE (or every clean `lookahead_off` script is flagged), and treating ties as causal (or
 * ambiguous series invent leaks). Both have dedicated tests below.
 */

const H1 = 3_600_000;
const M15 = 900_000;
const T0 = Date.UTC(2024, 0, 2, 0, 0);

/** H1 buckets with a distinct close per bucket, so attribution is unambiguous by default. */
function htf(count: number, closes?: readonly number[]): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    time: T0 + i * H1,
    closeTime: T0 + (i + 1) * H1,
    open: 1.1 + i * 0.01,
    high: 1.1 + i * 0.01 + 0.005,
    low: 1.1 + i * 0.01 - 0.005,
    close: closes?.[i] ?? 2 + i, // deliberately far from OHLC so matches are exact
    volume: 100,
    spread: null,
    spreadSamples: 0,
  }));
}

function obs(bar: number, value: number | null): SecurityObservation {
  return {
    bar,
    barTime: T0 + bar * M15,
    timeframe: '60',
    lookaheadOn: false,
    value,
    callIndex: 0,
  };
}

const OPTIONS = { chartBarMs: M15 };

describe('judging at the bar close', () => {
  it('accepts a bucket returned on the M15 bar where that bucket CLOSES', () => {
    // Bucket 0 spans 00:00–01:00 and closes at 01:00, which is the close of M15 bar 3
    // (00:45–01:00). `lookahead_off` legitimately delivers its value there, and a check that
    // judged at the bar's OPEN would call this a leak on every clean script.
    const result = checkCausality([obs(3, 2)], bucketsFromCandles(htf(3)), OPTIONS);

    expect(result.verdict).toBe('causal');
    expect(result.leaks).toHaveLength(0);
    expect(result.barsCausal).toBe(1);
  });

  it('flags the SAME bucket one bar earlier, where it has not closed yet', () => {
    // M15 bar 2 closes at 00:45, before bucket 0 closes at 01:00.
    const result = checkCausality([obs(2, 2)], bucketsFromCandles(htf(3)), OPTIONS);

    expect(result.verdict).toBe('leaky');
    expect(result.leaks).toHaveLength(1);
    expect(result.leaks[0]!.bar).toBe(2);
    expect(result.leaks[0]!.aheadByMs).toBe(M15);
  });

  it('accepts a bucket on any later bar, not just the one where it closed', () => {
    const result = checkCausality([obs(5, 2), obs(9, 2)], bucketsFromCandles(htf(3)), OPTIONS);
    expect(result.verdict).toBe('causal');
    expect(result.barsCausal).toBe(2);
  });
});

describe('a real leak', () => {
  it('catches a value from a bucket far in the future and says how far', () => {
    // Bucket 2 closes at 03:00; bar 1 closes at 00:30.
    const result = checkCausality([obs(1, 4)], bucketsFromCandles(htf(4)), OPTIONS);

    expect(result.verdict).toBe('leaky');
    const leak = result.leaks[0]!;
    expect(leak.bucketCloseTime).toBe(T0 + 3 * H1);
    expect(leak.aheadByMs).toBe(T0 + 3 * H1 - (T0 + 2 * M15));
    expect(result.headline).toMatch(/not closed yet/);
    expect(result.headline).toMatch(/bar 1/);
  });

  it('reports the EARLIEST explaining bucket, the least alarming honest reading', () => {
    // The same value in two future buckets: the leak is reported as the nearer one.
    const buckets = bucketsFromCandles(htf(6, [2, 9, 9, 9, 9, 9]));
    const result = checkCausality([obs(0, 9)], buckets, OPTIONS);

    expect(result.verdict).toBe('leaky');
    expect(result.leaks[0]!.bucketCloseTime).toBe(T0 + 2 * H1);
  });

  it('one leak among many causal bars is still a leak', () => {
    const buckets = bucketsFromCandles(htf(4));
    const result = checkCausality([obs(4, 2), obs(8, 3), obs(1, 4), obs(12, 4)], buckets, OPTIONS);

    expect(result.verdict).toBe('leaky');
    expect(result.leaks).toHaveLength(1);
    expect(result.barsCausal).toBe(3);
  });
});

describe('ties are causal', () => {
  it('passes when a value matches both a closed and an unclosed bucket', () => {
    // Attributing the value to the LATEST match would invent a leak here.
    const buckets = bucketsFromCandles(htf(4, [7, 7, 7, 7]));
    const result = checkCausality([obs(5, 7)], buckets, OPTIONS);

    expect(result.verdict).not.toBe('leaky');
    expect(result.barsCausal).toBe(1);
  });

  it('only flags when EVERY candidate is still open', () => {
    const buckets = bucketsFromCandles(htf(4, [7, 7, 7, 7]));
    // Bar 0 closes at 00:15, before even bucket 0 closes.
    const result = checkCausality([obs(0, 7)], buckets, OPTIONS);
    expect(result.verdict).toBe('leaky');
  });
});

describe('inconclusive rather than a false pass', () => {
  it('reports inconclusive when most bars match too many buckets', () => {
    // A boolean-like series: every bucket carries the same value, so attribution says nothing.
    const buckets = bucketsFromCandles(
      htf(
        10,
        Array.from({ length: 10 }, () => 1),
      ),
    );
    const observations = Array.from({ length: 10 }, (_, i) => obs(i + 20, 1));

    const result = checkCausality(observations, buckets, OPTIONS);

    expect(result.verdict).toBe('inconclusive');
    expect(result.barsAmbiguous).toBeGreaterThan(result.barsJudged / 2);
    expect(result.headline).toMatch(/several/);
    // The distinction that matters: no leak was found, and none would have been visible.
    expect(result.headline).toMatch(/none would have been visible/);
  });

  it('reports inconclusive when nothing could be matched at all', () => {
    const result = checkCausality(
      [obs(1, null), obs(2, null)],
      bucketsFromCandles(htf(3)),
      OPTIONS,
    );

    expect(result.verdict).toBe('inconclusive');
    expect(result.barsJudged).toBe(0);
    expect(result.barsUnmatched).toBe(2);
  });

  it('still reports a leak even when the rest of the run is ambiguous', () => {
    // Ambiguity must never excuse a bar that could only have come from the future.
    const buckets = bucketsFromCandles(
      htf(
        10,
        Array.from({ length: 10 }, () => 1),
      ),
    );
    const observations = [...Array.from({ length: 10 }, (_, i) => obs(i + 20, 1)), obs(0, 1)];

    expect(checkCausality(observations, buckets, OPTIONS).verdict).toBe('leaky');
  });

  it('counts warmup na as unmatched, not as a failure', () => {
    const result = checkCausality(
      [obs(0, null), obs(1, null), obs(5, 2)],
      bucketsFromCandles(htf(3)),
      OPTIONS,
    );

    expect(result.verdict).toBe('causal');
    expect(result.barsUnmatched).toBe(2);
    expect(result.headline).toMatch(/warmup/);
  });
});

describe('tolerance', () => {
  it('matches a value that survived resampling and transpilation', () => {
    const buckets = bucketsFromCandles(htf(3));
    const result = checkCausality([obs(5, 2 + 1e-12)], buckets, { ...OPTIONS, tolerance: 1e-9 });
    expect(result.barsCausal).toBe(1);
  });

  it('does not match a genuinely different value', () => {
    const buckets = bucketsFromCandles(htf(3));
    const result = checkCausality([obs(5, 2.5)], buckets, OPTIONS);
    expect(result.barsUnmatched).toBe(1);
    expect(result.barsJudged).toBe(0);
  });
});
