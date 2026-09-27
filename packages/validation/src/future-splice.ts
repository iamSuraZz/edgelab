/**
 * Future splicing — the look-ahead test that truncation cannot be (A1b).
 *
 * Prefix invariance truncates: it removes everything after a cutoff and checks that earlier
 * decisions did not move. That catches leaks with an UNBOUNDED horizon, and provably misses leaks
 * with a bounded one. The reason is structural, and it was measured rather than guessed — the leaky
 * fixture passes 6 of 6 truncation cutoffs:
 *
 *   `request.security` with `lookahead_on` sees at most to the end of the current higher-timeframe
 *   bucket. Truncation deletes that bucket, so the only bars whose decisions change are the ones
 *   inside it — exactly the region the margin has to exclude, because for an HONEST strategy that
 *   bucket legitimately differs between a full run and a truncated one. A margin wide enough to
 *   avoid false positives is wide enough to hide the leak.
 *
 * Splicing removes nothing. Every bar and every timestamp survives; only the CONTENT after the
 * cutoff changes, replaced by a different real segment rescaled to continue from the cutoff price.
 * So the higher-timeframe bucket straddling the cutoff still exists and still closes — it just
 * closes somewhere else. A causal strategy cannot tell the difference before the cutoff, because
 * everything it read there is byte-identical. A strategy reading that bucket's final value sees a
 * different number and diverges on the first affected bar. No margin is needed, and no margin means
 * no blind spot.
 *
 * Rescaling is multiplicative, not additive: FX moves are proportional, and an additive shift on a
 * donor segment from a different price level produces percentage moves the instrument never makes.
 *
 * Pure. No I/O, no clock.
 */

export interface SpliceBar {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly spread?: number | null;
}

export interface SpliceResult<T extends SpliceBar> {
  readonly bars: readonly T[];
  /** Bars kept untouched, i.e. at or before the cutoff. */
  readonly kept: number;
  /** Bars whose prices were replaced. */
  readonly spliced: number;
  /** Factor applied to donor prices so the splice continues from the cutoff price. */
  readonly scale: number;
}

export class SpliceNotPossibleError extends Error {
  readonly code = 'splice-not-possible';

  constructor(message: string) {
    super(message);
    this.name = 'SpliceNotPossibleError';
  }
}

export interface SpliceFutureParams<T extends SpliceBar> {
  /** The real series, ascending by time. */
  readonly bars: readonly T[];
  /** Bars at or before this instant keep their values exactly. */
  readonly cutoffMs: number;
  /**
   * A DIFFERENT real segment to graft on. Must be real data rather than anything generated: the
   * point is that the future is plausible but unknowable, and a synthetic future can differ from
   * real price behaviour in ways a strategy might legitimately react to.
   */
  readonly donor: readonly SpliceBar[];
  /**
   * How far past the cutoff to replace. Beyond it the real series resumes.
   *
   * Bounded because the leak this test exists to catch is bounded: `lookahead_on` on timeframe X
   * sees at most to the end of the current X bucket, so perturbing one bucket's worth is enough to
   * move any decision that read it. Replacing the entire remaining series instead would need a
   * disjoint donor as long as the run, which no early cutoff can supply — that made the check report
   * `n/a` on a clean strategy, which is the failure mode that gets a check switched off.
   *
   * The discontinuity where the real series resumes lies in the future relative to the cutoff, so it
   * cannot reach the pre-cutoff decisions this test compares.
   *
   * Omitted means replace everything after the cutoff.
   */
  readonly windowMs?: number;
}

/**
 * Replace everything after `cutoffMs` with rescaled donor data, keeping every timestamp.
 *
 * Donor bars are consumed in order and mapped onto the ORIGINAL timestamps, so the output has
 * exactly the same length, the same bar times and the same session structure as the input. Only
 * the prices after the cutoff differ, which is the whole point: any change in behaviour before the
 * cutoff is then attributable to nothing but a look-ahead read.
 */
export function spliceFuture<T extends SpliceBar>(params: SpliceFutureParams<T>): SpliceResult<T> {
  const { bars, cutoffMs, donor } = params;

  const cutIndex = lastIndexAtOrBefore(bars, cutoffMs);
  if (cutIndex < 0) {
    throw new SpliceNotPossibleError(
      `No bar at or before the cutoff ${new Date(cutoffMs).toISOString()}, so there is no price to ` +
        'continue from.',
    );
  }

  const anchor = bars[cutIndex]!.close;

  // Only the bounded window is replaced; everything past it keeps its real values.
  const windowEnd = params.windowMs === undefined ? Infinity : cutoffMs + params.windowMs;
  const afterCut = bars.slice(cutIndex + 1);
  const tail = afterCut.filter((b) => b.time <= windowEnd);
  const untouchedTail = afterCut.slice(tail.length);

  if (tail.length === 0) {
    // A cutoff at or past the end splices nothing, which is not a failure — it just tests nothing.
    return { bars, kept: bars.length, spliced: 0, scale: 1 };
  }

  if (donor.length < tail.length) {
    throw new SpliceNotPossibleError(
      `Donor segment has ${String(donor.length)} bars but ${String(tail.length)} are needed to fill ` +
        'the splice window. A donor shorter than the window would have to be repeated, and a ' +
        'repeating future is a pattern a strategy could legitimately detect.',
    );
  }

  const donorAnchor = donor[0]!.open;
  if (!(donorAnchor > 0) || !(anchor > 0)) {
    throw new SpliceNotPossibleError(
      'Splicing rescales multiplicatively, which needs both the cutoff price and the donor start ' +
        'to be positive.',
    );
  }
  const scale = anchor / donorAnchor;

  const head = bars.slice(0, cutIndex + 1);
  const grafted = tail.map((original, i) => {
    const d = donor[i]!;
    return {
      ...original,
      open: d.open * scale,
      high: d.high * scale,
      low: d.low * scale,
      close: d.close * scale,
      volume: d.volume,
      // Spread comes from the donor too, because it is part of what the donor minute WAS. Falling
      // back to the original's spread would leak one real number from the future we are hiding.
      ...(d.spread === undefined ? {} : { spread: d.spread }),
    } as T;
  });

  return {
    bars: [...head, ...grafted, ...untouchedTail],
    kept: head.length + untouchedTail.length,
    spliced: grafted.length,
    scale,
  };
}

/** Index of the last bar at or before `atMs`, or -1. Assumes ascending order. */
function lastIndexAtOrBefore(bars: readonly SpliceBar[], atMs: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.time <= atMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Pick a donor window from the same series, disjoint from the part being tested.
 *
 * Taken from the series' own EARLY history rather than generated, so the grafted future has the
 * instrument's real volatility and session rhythm. Disjoint from everything at or after the cutoff
 * so the donor cannot accidentally BE the future it is standing in for — which would make the test
 * silently vacuous.
 *
 * Returns null when the history is too short to spare a disjoint window; the caller should report
 * `n/a` rather than splice with something overlapping.
 */
export function pickDonor<T extends SpliceBar>(
  bars: readonly T[],
  cutoffMs: number,
  needed: number,
): readonly T[] | null {
  const cutIndex = lastIndexAtOrBefore(bars, cutoffMs);
  if (cutIndex < 0) return null;

  // Everything strictly before the cutoff is fair game as a donor, because the strategy has
  // already seen it — the test is about whether it can see FORWARD, not whether it remembers.
  const available = bars.slice(0, cutIndex + 1);
  if (available.length < needed) return null;

  // The oldest `needed` bars: furthest from the cutoff, so the graft is least likely to look like
  // a smooth continuation of the very recent past.
  return available.slice(0, needed);
}
