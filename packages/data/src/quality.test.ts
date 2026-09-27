import { describe, expect, it } from 'vitest';
import type { Bar } from '@edgelab/shared';

import { analyseQuality, rollingMedian } from './quality';

const M1 = 60_000;

// 2024-01-15 is a Monday, so 19 is Friday and 21 Sunday. A WINTER week, so New York is on
// EST and the 17:00 NY session boundary lands on 22:00 UTC. sessions.test.ts covers summer.
const MON = Date.UTC(2024, 0, 15);
const FRI = Date.UTC(2024, 0, 19);
const SUN = Date.UTC(2024, 0, 21);
const NEXT_MON = Date.UTC(2024, 0, 22);

function bars(startMs: number, count: number, step = M1): Bar[] {
  return Array.from({ length: count }, (_, i) => ({
    time: startMs + i * step,
    open: 1.1,
    high: 1.1005,
    low: 1.0995,
    close: 1.1002,
    volume: 5,
    spread: 0.00008,
  }));
}

describe('rollingMedian', () => {
  it('is null until the window has enough samples', () => {
    const out = rollingMedian([1, 2, 3], 500);
    expect(out.every((v) => v === null)).toBe(true);
  });

  it('computes a trailing median', () => {
    const values = Array.from({ length: 40 }, () => 10);
    const out = rollingMedian(values, 20);
    expect(out[39]).toBe(10);
  });

  it('drops values that leave the window', () => {
    // 20 ones then 20 hundreds: by the end the window holds only hundreds.
    const values = [
      ...Array.from({ length: 20 }, () => 1),
      ...Array.from({ length: 20 }, () => 100),
    ];
    const out = rollingMedian(values, 20);
    expect(out[39]).toBe(100);
  });

  it('averages the middle pair for an even window', () => {
    const out = rollingMedian([...Array.from({ length: 19 }, () => 2), 4], 20);
    expect(out[19]).toBe(2);
  });

  it('rejects a zero window', () => {
    expect(() => rollingMedian([1], 0)).toThrow(RangeError);
  });
});

describe('analyseQuality — gaps', () => {
  it('reports nothing for a contiguous series', () => {
    const report = analyseQuality(bars(MON, 600), { sessionType: 'fx24x5' });
    expect(report.gaps.count).toBe(0);
    expect(report.missingMinutes).toBe(0);
    expect(report.completeness).toBe(1);
  });

  it('reports a midweek hole', () => {
    const series = [...bars(MON, 10), ...bars(MON + 30 * M1, 10)];
    const report = analyseQuality(series, { sessionType: 'fx24x5' });
    expect(report.gaps.count).toBe(1);
    expect(report.gaps.samples[0]?.missingMinutes).toBe(20);
    expect(report.missingMinutes).toBe(20);
    expect(report.completeness).toBeLessThan(1);
  });

  it('does NOT report the fx weekend', () => {
    // Last bar Friday 21:59, next bar Sunday 22:00 — the whole hole is closed time.
    const series = [...bars(FRI + 21 * 3600_000 + 59 * M1, 1), ...bars(SUN + 22 * 3600_000, 5)];
    const report = analyseQuality(series, { sessionType: 'fx24x5' });
    expect(report.gaps.count).toBe(0);
    expect(report.missingMinutes).toBe(0);
  });

  it('DOES report the same hole for crypto, which never closes', () => {
    const series = [...bars(FRI + 21 * 3600_000 + 59 * M1, 1), ...bars(SUN + 22 * 3600_000, 5)];
    const report = analyseQuality(series, { sessionType: 'crypto24x7' });
    expect(report.gaps.count).toBe(1);
    expect(report.missingMinutes).toBeGreaterThan(2000);
  });

  it('reports only the open portion of a hole that straddles the weekend', () => {
    // Friday 20:00 .. Monday 00:00 with nothing in between: 119 open minutes on Friday
    // (20:00-22:00 minus the one bar we do have) plus 120 on Sunday evening.
    const series = [...bars(FRI + 20 * 3600_000, 1), ...bars(NEXT_MON, 1)];
    const report = analyseQuality(series, { sessionType: 'fx24x5' });
    expect(report.gaps.count).toBe(1);
    expect(report.gaps.samples[0]?.missingMinutes).toBe(239);
  });
});

describe('analyseQuality — filler bars (D4)', () => {
  it('separates provider filler from flat bars that carry real volume', () => {
    const flatWithVolume = bars(MON, 1).map((b) => ({
      ...b,
      high: b.open,
      low: b.open,
      close: b.open,
    }));
    const filler = bars(MON + M1, 1).map((b) => ({
      ...b,
      high: b.open,
      low: b.open,
      close: b.open,
      volume: 0,
    }));
    const report = analyseQuality([...flatWithVolume, ...filler], { sessionType: 'fx24x5' });

    // Both are zero-range; only the volume-less one is filler MetaTrader would never form.
    expect(report.zeroRangeBars.count).toBe(2);
    expect(report.fillerBars.count).toBe(1);
    expect(report.fillerBars.samples[0]).toBe(MON + M1);
  });

  it('reports no filler for an ordinary series', () => {
    expect(analyseQuality(bars(MON, 50), { sessionType: 'fx24x5' }).fillerBars.count).toBe(0);
  });
});

describe('analyseQuality — structural problems', () => {
  it('finds duplicate timestamps', () => {
    const base = bars(MON, 3);
    const dupe = base[1];
    if (dupe === undefined) throw new Error('fixture');
    const report = analyseQuality([base[0]!, dupe, { ...dupe }, base[2]!], {
      sessionType: 'fx24x5',
    });
    expect(report.duplicateTimestamps.count).toBe(1);
    expect(report.duplicateTimestamps.samples[0]).toBe(dupe.time);
  });

  it('finds out-of-order timestamps', () => {
    const b = bars(MON, 3);
    const report = analyseQuality([b[0]!, b[2]!, b[1]!], { sessionType: 'fx24x5' });
    expect(report.outOfOrderTimestamps.count).toBe(1);
  });

  it('finds zero-range bars', () => {
    const flat: Bar = { time: MON, open: 1, high: 1, low: 1, close: 1, volume: 0 };
    const report = analyseQuality([flat, ...bars(MON + M1, 2)], { sessionType: 'fx24x5' });
    expect(report.zeroRangeBars.count).toBe(1);
    expect(report.zeroRangeBars.samples[0]).toBe(MON);
  });

  it('finds incoherent OHLC and does not double-count it as zero-range', () => {
    const bad: Bar = { time: MON, open: 5, high: 1, low: 2, close: 5, volume: 0 };
    const report = analyseQuality([bad, ...bars(MON + M1, 2)], { sessionType: 'fx24x5' });
    expect(report.invalidBars.count).toBe(1);
    expect(report.zeroRangeBars.count).toBe(0);
  });

  it('caps samples but keeps the count exact', () => {
    // 300 alternating flat bars, cap at 10.
    const series: Bar[] = Array.from({ length: 300 }, (_, i) => ({
      time: MON + i * M1,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 0,
    }));
    const report = analyseQuality(series, { sessionType: 'fx24x5', maxSamples: 10 });
    expect(report.zeroRangeBars.count).toBe(300);
    expect(report.zeroRangeBars.samples).toHaveLength(10);
    expect(report.zeroRangeBars.truncated).toBe(true);
  });
});

describe('analyseQuality — spikes and spread outliers', () => {
  it('flags a bar whose true range dwarfs the rolling median', () => {
    const series = bars(MON, 300);
    const spikeIndex = 250;
    const victim = series[spikeIndex];
    if (victim === undefined) throw new Error('fixture');
    series[spikeIndex] = { ...victim, high: victim.high + 0.5, low: victim.low - 0.5 };

    const report = analyseQuality(series, {
      sessionType: 'fx24x5',
      rollingWindow: 100,
      spikeMultiple: 10,
    });
    expect(report.spikes.count).toBeGreaterThanOrEqual(1);
    expect(report.spikes.samples.some((s) => s.time === victim.time)).toBe(true);
  });

  it('does not flag a calm series', () => {
    const report = analyseQuality(bars(MON, 300), { sessionType: 'fx24x5', rollingWindow: 100 });
    expect(report.spikes.count).toBe(0);
    expect(report.spreadOutliers.count).toBe(0);
  });

  it('flags a spread blowout', () => {
    const series = bars(MON, 300);
    const idx = 280;
    const victim = series[idx];
    if (victim === undefined) throw new Error('fixture');
    series[idx] = { ...victim, spread: 0.05 };

    const report = analyseQuality(series, {
      sessionType: 'fx24x5',
      rollingWindow: 100,
      spreadOutlierMultiple: 10,
    });
    expect(report.spreadOutliers.count).toBe(1);
    expect(report.spreadOutliers.samples[0]?.time).toBe(victim.time);
    expect(report.spreadOutliers.samples[0]?.ratio).toBeGreaterThan(10);
  });

  it('ignores bars with no spread rather than treating them as zero', () => {
    const series = bars(MON, 300).map((b, i) => (i % 2 === 0 ? { ...b, spread: null } : b));
    const report = analyseQuality(series, { sessionType: 'fx24x5', rollingWindow: 50 });
    expect(report.spreadOutliers.count).toBe(0);
  });
});

describe('analyseQuality — summary fields', () => {
  it('is empty-safe', () => {
    const report = analyseQuality([], { sessionType: 'fx24x5' });
    expect(report.barCount).toBe(0);
    expect(report.firstBar).toBeNull();
    expect(report.lastBar).toBeNull();
    expect(report.completeness).toBe(1);
  });

  it('reports the observed range', () => {
    const report = analyseQuality(bars(MON, 100), { sessionType: 'fx24x5' });
    expect(report.firstBar).toBe(MON);
    expect(report.lastBar).toBe(MON + 99 * M1);
    expect(report.barCount).toBe(100);
  });
});
