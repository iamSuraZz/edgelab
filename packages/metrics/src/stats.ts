/**
 * Small numeric helpers. Pure and allocation-light — these run over long equity series.
 *
 * Every function returns `null` rather than NaN when the input is too small to define
 * the statistic, so callers must decide what an undefined metric means.
 */

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return sum(values) / values.length;
}

/** Sample standard deviation (n-1). Needs at least two points. */
export function stdev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  if (m === null) return null;
  let acc = 0;
  for (const v of values) {
    const d = v - m;
    acc += d * d;
  }
  return Math.sqrt(acc / (values.length - 1));
}

/**
 * Sortino's downside deviation lives in ./risk-ratios.ts, not here. It must divide by the
 * count of ALL periods rather than only the negative ones, so it is not a generic
 * "stdev of the negatives" helper and was removed from this module to stop the two being
 * confused.
 */

/** Period-over-period simple returns of an equity series. */
export function simpleReturns(series: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < series.length; i += 1) {
    const prev = series[i - 1];
    const cur = series[i];
    if (prev === undefined || cur === undefined || prev === 0) continue;
    out.push((cur - prev) / prev);
  }
  return out;
}

/** Safe division that reports "undefined" instead of Infinity or NaN. */
export function safeDivide(numerator: number, denominator: number): number | null {
  if (denominator === 0 || !Number.isFinite(denominator) || !Number.isFinite(numerator)) {
    return null;
  }
  return numerator / denominator;
}

export function maxOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let best = Number.NEGATIVE_INFINITY;
  for (const v of values) if (v > best) best = v;
  return best;
}

export function minOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let best = Number.POSITIVE_INFINITY;
  for (const v of values) if (v < best) best = v;
  return best;
}
