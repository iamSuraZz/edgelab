import { describe, expect, it } from 'vitest';
import type { EquityPoint, EquitySample } from '@edgelab/shared';

import {
  SERIES_FORMAT,
  SeriesFormatError,
  decodeEquityCurve,
  decodeSamples,
  encodeEquityCurve,
  encodeSamples,
} from './series-codec';

/**
 * A curve built the way `reconstructEquity` builds one, so the round-trip test is checking the
 * real shape rather than a convenient one.
 */
function curve(equities: readonly number[], initialCapital = 10_000): EquityPoint[] {
  let peak = initialCapital;
  return equities.map((equity, i) => {
    if (equity > peak) peak = equity;
    const drawdown = Math.max(0, peak - equity);
    return {
      time: Date.UTC(2024, 0, 2) + i * 3_600_000,
      equity,
      peak,
      drawdown,
      drawdownPct: peak > 0 ? (drawdown / peak) * 100 : 0,
    };
  });
}

describe('equity curve round-trip', () => {
  it('restores time, equity, peak and drawdown exactly', () => {
    const original = curve([10_100, 10_400, 10_200, 10_600, 10_300]);
    const encoded = encodeEquityCurve(original);
    expect(encoded.format).toBe(SERIES_FORMAT);
    expect(encoded.pointCount).toBe(5);

    expect(decodeEquityCurve(encoded.payload, encoded.format)).toEqual(original);
  });

  it('restores the seeded peak for a curve that starts underwater', () => {
    // This is the case that a naive decoder gets wrong: it would set peak = 9,800 from the
    // first point and report no drawdown, when the account is actually 200 down from its
    // starting capital.
    const original = curve([9_800, 9_900, 10_050]);
    expect(original[0]!.peak).toBe(10_000);
    expect(original[0]!.drawdown).toBe(200);

    const decoded = decodeEquityCurve(encodeEquityCurve(original).payload, SERIES_FORMAT);
    expect(decoded[0]!.peak).toBe(10_000);
    expect(decoded[0]!.drawdown).toBe(200);
    expect(decoded).toEqual(original);
  });

  it('handles a monotonically rising curve, where drawdown is always zero', () => {
    const original = curve([10_100, 10_200, 10_300]);
    expect(decodeEquityCurve(encodeEquityCurve(original).payload, SERIES_FORMAT)).toEqual(original);
  });

  it('handles an empty curve', () => {
    const encoded = encodeEquityCurve([]);
    expect(encoded.pointCount).toBe(0);
    expect(decodeEquityCurve(encoded.payload, encoded.format)).toEqual([]);
  });

  it('survives a single point', () => {
    const original = curve([9_500]);
    expect(decodeEquityCurve(encodeEquityCurve(original).payload, SERIES_FORMAT)).toEqual(original);
  });
});

describe('sample round-trip', () => {
  it('restores daily and monthly samples', () => {
    const samples: EquitySample[] = [
      { time: Date.UTC(2024, 0, 2), equity: 10_400 },
      { time: Date.UTC(2024, 0, 3), equity: 10_250 },
      { time: Date.UTC(2024, 1, 1), equity: 10_900 },
    ];
    const encoded = encodeSamples(samples);
    expect(decodeSamples(encoded.payload, encoded.format)).toEqual(samples);
  });

  it('handles no samples', () => {
    const encoded = encodeSamples([]);
    expect(decodeSamples(encoded.payload, encoded.format)).toEqual([]);
  });
});

describe('compression', () => {
  it('actually shrinks a realistic curve', () => {
    // A year of M5 is roughly this size, and it is the reason spec 04 wants blobs rather than
    // a row per bar.
    const equities = Array.from({ length: 75_000 }, (_, i) => 10_000 + Math.sin(i / 500) * 800);
    const encoded = encodeEquityCurve(curve(equities));

    expect(encoded.pointCount).toBe(75_000);
    expect(encoded.payload.byteLength).toBeLessThan(encoded.uncompressedBytes);
    // Comfortably under a megabyte, versus 75,000 rows.
    expect(encoded.payload.byteLength).toBeLessThan(1_000_000);
  });

  it('reports the uncompressed size, so storage can be reasoned about', () => {
    const encoded = encodeEquityCurve(curve([1, 2, 3]));
    expect(encoded.uncompressedBytes).toBeGreaterThan(0);
  });
});

describe('format guard', () => {
  it('refuses a blob written by an unknown codec instead of returning garbage', () => {
    const encoded = encodeEquityCurve(curve([10_100]));
    expect(() => decodeEquityCurve(encoded.payload, 'some-future-format')).toThrow(
      SeriesFormatError,
    );
    expect(() => decodeSamples(encoded.payload, 'some-future-format')).toThrow(SeriesFormatError);
  });

  it('names the offending format in the message', () => {
    try {
      decodeSamples(Buffer.alloc(0), 'v99');
      expect.unreachable();
    } catch (error: unknown) {
      expect((error as Error).message).toContain('v99');
    }
  });
});
