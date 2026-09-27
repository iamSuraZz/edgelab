import { gunzipSync, gzipSync } from 'node:zlib';
import type { EquityPoint, EquitySample } from '@edgelab/shared';

/**
 * Encoding for the `run_series` blobs.
 *
 * Shape: columnar JSON, gzipped. Columnar rather than an array of objects because the field
 * names would otherwise repeat once per bar — `{"time":…,"equity":…,"peak":…}` is ~40 bytes of
 * key text per point, and at 75,000 points that is 3 MB of the word "equity". Splitting into
 * parallel arrays removes all of it and compresses far better, since each column is a run of
 * similar numbers.
 *
 * `peak`, `drawdown` and `drawdownPct` are NOT stored: all three are derivable from `equity`
 * by a single pass, so storing them would triple the payload to save an O(n) loop.
 *
 * The format tag is written into every row so a future encoding can be introduced without
 * making existing blobs unreadable.
 */

export const SERIES_FORMAT = 'columnar-json-gzip-v1';

export const SERIES_KINDS = ['close', 'intrabar', 'daily', 'monthly'] as const;
export type SeriesKind = (typeof SERIES_KINDS)[number];

export interface EncodedSeries {
  readonly format: string;
  readonly payload: Buffer;
  readonly pointCount: number;
  readonly uncompressedBytes: number;
}

interface ColumnarPayload {
  readonly t: number[];
  readonly e: number[];
  /**
   * Seed peak. Needed because the running peak starts at the INITIAL CAPITAL, not at the first
   * equity value: a curve whose first bar is already underwater would otherwise decode with a
   * peak equal to that first value and report no drawdown where there was one.
   *
   * Absent on a samples blob, where peak is not reconstructed.
   */
  readonly p?: number;
}

export class SeriesFormatError extends Error {
  constructor(format: string) {
    super(
      `Unknown run_series format "${format}". This blob was written by a newer version than ` +
        'the one reading it.',
    );
    this.name = 'SeriesFormatError';
  }
}

function encodeColumns(times: number[], equities: number[], seedPeak?: number): EncodedSeries {
  const json = JSON.stringify({
    t: times,
    e: equities,
    ...(seedPeak === undefined ? {} : { p: seedPeak }),
  } satisfies ColumnarPayload);
  const raw = Buffer.from(json, 'utf8');
  return {
    format: SERIES_FORMAT,
    payload: gzipSync(raw, { level: 6 }),
    pointCount: times.length,
    uncompressedBytes: raw.byteLength,
  };
}

export function encodeEquityCurve(curve: readonly EquityPoint[]): EncodedSeries {
  const times = new Array<number>(curve.length);
  const equities = new Array<number>(curve.length);
  for (let i = 0; i < curve.length; i += 1) {
    const p = curve[i]!;
    times[i] = p.time;
    equities[i] = p.equity;
  }
  // curve[0].peak is already max(initialCapital, equity[0]) and peak is monotonic, so the
  // first point carries the seed.
  return encodeColumns(times, equities, curve[0]?.peak);
}

export function encodeSamples(samples: readonly EquitySample[]): EncodedSeries {
  const times = new Array<number>(samples.length);
  const equities = new Array<number>(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i]!;
    times[i] = s.time;
    equities[i] = s.equity;
  }
  return encodeColumns(times, equities);
}

function decodeColumns(payload: Buffer, format: string): ColumnarPayload {
  if (format !== SERIES_FORMAT) throw new SeriesFormatError(format);
  const parsed: unknown = JSON.parse(gunzipSync(payload).toString('utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as ColumnarPayload).t) ||
    !Array.isArray((parsed as ColumnarPayload).e)
  ) {
    throw new SeriesFormatError(`${format} (payload is not columnar)`);
  }
  return parsed as ColumnarPayload;
}

export function decodeSamples(payload: Buffer, format: string): EquitySample[] {
  const { t, e } = decodeColumns(payload, format);
  return t.map((time, i) => ({ time, equity: e[i] ?? 0 }));
}

/**
 * Rebuild a full equity curve, recomputing the running peak and drawdown that encoding
 * dropped. The result is identical to what was encoded, which `series-codec.test.ts` asserts
 * against `reconstructEquity`'s own output.
 */
export function decodeEquityCurve(payload: Buffer, format: string): EquityPoint[] {
  const decoded = decodeColumns(payload, format);
  const { t, e } = decoded;
  const out: EquityPoint[] = new Array<EquityPoint>(t.length);

  let peak = decoded.p ?? Number.NEGATIVE_INFINITY;
  for (let i = 0; i < t.length; i += 1) {
    const equity = e[i] ?? 0;
    if (equity > peak) peak = equity;
    const drawdown = Math.max(0, peak - equity);
    out[i] = {
      time: t[i] ?? 0,
      equity,
      peak,
      drawdown,
      drawdownPct: peak > 0 ? (drawdown / peak) * 100 : 0,
    };
  }

  return out;
}
