import { timeframeMs, type Timeframe } from '@edgelab/shared';

/**
 * Refuse a run that cannot fit, instead of letting the task be killed half way through.
 *
 * The old behaviour was a worker that died at some unpredictable point with
 * "This usually means an unbounded array or a var that grows on every bar" — a guess, and the wrong
 * one (A71). A refusal before any work starts costs nothing and can say what to do instead.
 *
 * ESTIMATED FROM MEASUREMENT, not from a guess. The constants below come from the per-stage tables in
 * A71/A72, taken on real multi-year runs:
 *
 *   | stage                     | measured              |
 *   | ------------------------- | --------------------- |
 *   | engine, per CHART bar     | 350-650 B/bar         |
 *   | equity, per chart bar     | 154 B x 2 series      |
 *   | paged M1 read             | one page, ~17MB flat  |
 *
 * The engine figure varies with what the script computes — more series means more per bar — so the
 * upper end of the measured range is used. Under-estimating is the failure that matters: it lets a
 * run through that then dies, which is the behaviour this exists to remove.
 */

/** Engine retention per CHART bar, from the two measured runs (639 B/bar on XAU, 349 on BTC). */
const ENGINE_BYTES_PER_CHART_BAR = 700;

/** Equity: two series of points at a measured 154 B each. */
const EQUITY_BYTES_PER_CHART_BAR = 154 * 2;

/** One page of M1 objects plus the module graph and pool overhead, measured at ~23MB baseline. */
const FLAT_OVERHEAD_BYTES = 60 * 1024 * 1024;

/** Headroom, because the estimate is a model: V8 fragments, and a near-miss still dies. */
const SAFETY_FRACTION = 0.8;

export const DEFAULT_MEMORY_LIMIT_MB = 1024;

/**
 * Engine time per CHART bar, measured.
 *
 * A33 timed the engine at ~0.042ms/bar on short windows; the long runs in A71/A72 came out at
 * 40.4s for 491,652 bars and 26.9s for 319,235 — 0.082 and 0.084ms per bar. The larger figure is
 * used, because the cost of under-estimating is a run that is allowed and then killed, which is the
 * behaviour this exists to remove.
 */
const ENGINE_MS_PER_CHART_BAR = 0.085;

/** Reading and aggregating the minutes: measured at 9.1s for 2.44M rows, so ~3.7us a row. */
const READ_MS_PER_M1_BAR = 0.0037;

/** Thread startup, compile and persistence. Measured at a few seconds; rounded up. */
const FLAT_MS = 15_000;

export const DEFAULT_TIMEOUT_MS = 600_000;

export interface MemoryEstimate {
  readonly m1Bars: number;
  readonly chartBars: number;
  readonly estimatedBytes: number;
  readonly limitBytes: number;
  readonly fits: boolean;
  /** Estimated wall clock, so a run is not admitted on memory and then killed on time (A74). */
  readonly estimatedMs: number;
  readonly timeoutMs: number;
  readonly fitsTime: boolean;
}

export function estimateRunMemory(params: {
  readonly m1Bars: number;
  readonly timeframe: Timeframe;
  readonly limitMb?: number;
  readonly timeoutMs?: number;
}): MemoryEstimate {
  const limitMb = params.limitMb ?? DEFAULT_MEMORY_LIMIT_MB;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /*
   * Chart bars, not M1 bars, drive the estimate.
   *
   * That is the whole point of the fix this guards: a nine-year M1 range costs the same to READ at D1
   * as at M1 now, because the minutes are paged. What scales is the number of bars the engine holds,
   * which is the M1 count divided by the timeframe's length in minutes.
   */
  const tfMs = timeframeMs(params.timeframe) ?? 60_000;
  const minutesPerBar = Math.max(1, Math.round(tfMs / 60_000));
  const chartBars = Math.ceil(params.m1Bars / minutesPerBar);

  const estimatedBytes =
    FLAT_OVERHEAD_BYTES + chartBars * (ENGINE_BYTES_PER_CHART_BAR + EQUITY_BYTES_PER_CHART_BAR);

  const limitBytes = limitMb * 1024 * 1024;

  const estimatedMs =
    FLAT_MS + chartBars * ENGINE_MS_PER_CHART_BAR + params.m1Bars * READ_MS_PER_M1_BAR;

  return {
    m1Bars: params.m1Bars,
    chartBars,
    estimatedBytes,
    limitBytes,
    fits: estimatedBytes <= limitBytes * SAFETY_FRACTION,
    estimatedMs: Math.round(estimatedMs),
    timeoutMs,
    fitsTime: estimatedMs <= timeoutMs * SAFETY_FRACTION,
  };
}

/** Thrown when a run is refused up front. Carries the figures so the message can be rebuilt. */
export class RunTooLargeError extends Error {
  readonly estimate: MemoryEstimate;

  constructor(message: string, estimate: MemoryEstimate) {
    super(message);
    this.name = 'RunTooLargeError';
    this.estimate = estimate;
  }
}

export function assertRunFitsMemory(params: {
  readonly m1Bars: number;
  readonly timeframe: Timeframe;
  readonly symbol: string;
  readonly limitMb?: number;
  readonly timeoutMs?: number;
}): MemoryEstimate {
  const estimate = estimateRunMemory(params);
  if (estimate.fits && estimate.fitsTime) return estimate;

  throw new RunTooLargeError(describeTooLarge(params.symbol, params.timeframe, estimate), estimate);
}

/**
 * The refusal, with the numbers and a way forward.
 *
 * Suggests the smallest timeframe that WOULD fit rather than "try a higher timeframe", because the
 * reader cannot compute that themselves and would otherwise guess twice.
 */
function describeTooLarge(symbol: string, timeframe: Timeframe, estimate: MemoryEstimate): string {
  const suggestion = smallestFittingTimeframe(estimate);

  // Which limit it breaches, because the fix differs: a higher timeframe helps both, but a shorter
  // range is the only thing that helps when even D1 does not fit.
  const breach = !estimate.fits
    ? `needs about ${mb(estimate.estimatedBytes)} against a ${mb(estimate.limitBytes)} limit`
    : `would take about ${secs(estimate.estimatedMs)} against a ${secs(estimate.timeoutMs)} limit`;

  return (
    `This run ${breach}. ${symbol} ${timeframe} over this range is ` +
    `${estimate.chartBars.toLocaleString('en-US')} chart bars from ` +
    `${estimate.m1Bars.toLocaleString('en-US')} stored minutes. ` +
    (suggestion === null
      ? 'Shorten the range — even D1 over this window would not fit.'
      : `Run it on ${suggestion} or higher, or shorten the range. `) +
    'Nothing was read, so this cost nothing but the check.'
  );
}

/** The first timeframe, smallest upwards, that fits BOTH limits. Null when none does. */
function smallestFittingTimeframe(estimate: MemoryEstimate): Timeframe | null {
  const ladder: Timeframe[] = ['M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

  for (const tf of ladder) {
    const candidate = estimateRunMemory({
      m1Bars: estimate.m1Bars,
      timeframe: tf,
      limitMb: estimate.limitBytes / 1024 / 1024,
      timeoutMs: estimate.timeoutMs,
    });
    if (candidate.fits && candidate.fitsTime) return tf;
  }
  return null;
}

function secs(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

function mb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}
