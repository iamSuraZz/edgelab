/**
 * Prefix invariance — the definitive look-ahead test.
 *
 * The static lint reads the source and can only catch what it recognises. This asks the question
 * directly: if the data had simply STOPPED earlier, would the decisions taken before that point
 * have been the same? A strategy that cannot see the future must answer yes every time, because
 * nothing it used had happened yet. A leak answers no, and the first bar where the two runs
 * disagree is where it read something it should not have.
 *
 * Truncation is by `dataCutoffTs`, not by asking for a shorter range, and that distinction is the
 * whole reason this catches HTF leaks: the provider drops any bucket whose close extends past the
 * cutoff, so a partially-formed H4 bar cannot be served with its future minutes folded in.
 *
 * THE MARGIN (amendment A1). Decisions in the last HTF bucket before a cutoff legitimately differ,
 * because that bucket exists in the full run and is dropped in the truncated one. Comparing them
 * would report a leak on every clean strategy that reads a higher timeframe. So the comparison
 * ignores anything decided within one bucket of the cutoff, and a real leak still shows up — it
 * moves decisions much earlier than one bucket.
 *
 * This module is pure. The caller supplies the runs.
 */

/** The minimum a trade must expose to be compared. */
export interface ComparableTrade {
  readonly side: string;
  readonly qty: number;
  readonly entryBar: number;
  readonly entryTime: number;
  readonly entryPrice: number;
  readonly exitBar: number | null;
  readonly exitTime: number | null;
  readonly exitPrice: number | null;
}

export interface ComparableRun {
  readonly trades: readonly ComparableTrade[];
}

/** Prices are compared to this tolerance; anything larger is a real move, not float noise. */
export const PRICE_EPSILON = 1e-9;

export interface Divergence {
  /** What differed: `count`, or a field name. */
  readonly field: string;
  /** 1-based trade ordinal, as a trade list numbers them. */
  readonly tradeSeq: number;
  readonly bar: number;
  readonly time: number;
  readonly fullValue: number | string;
  readonly truncatedValue: number | string;
}

export interface PrefixComparison {
  readonly cutoffMs: number;
  /** Trades compared, i.e. those decided at least one bucket before the cutoff. */
  readonly compared: number;
  readonly divergence: Divergence | null;
}

export interface ComparePrefixParams {
  readonly full: ComparableRun;
  readonly truncated: ComparableRun;
  readonly cutoffMs: number;
  /** One higher-timeframe bucket in ms — the A1 margin. */
  readonly marginMs: number;
}

/**
 * Compare one truncated run against the full one.
 *
 * Only trades ENTERED before `cutoff - margin` are compared, because those are the decisions the
 * truncated run had the same information for. A trade's exit is compared only when it, too, lands
 * before the boundary; a position still open at the cutoff has nothing to be compared against.
 */
export function comparePrefix(params: ComparePrefixParams): PrefixComparison {
  const boundary = params.cutoffMs - params.marginMs;

  const fullBefore = params.full.trades.filter((t) => t.entryTime < boundary);
  const truncatedBefore = params.truncated.trades.filter((t) => t.entryTime < boundary);

  const base = { cutoffMs: params.cutoffMs, compared: fullBefore.length };

  // A different NUMBER of decisions before the boundary is itself the finding, and the first
  // missing or extra trade is the most useful thing to point at.
  if (fullBefore.length !== truncatedBefore.length) {
    const firstDiffIndex = Math.min(fullBefore.length, truncatedBefore.length);
    const reference = fullBefore[firstDiffIndex] ?? truncatedBefore[firstDiffIndex];
    return {
      ...base,
      divergence: {
        field: 'trade count before cutoff',
        tradeSeq: firstDiffIndex + 1,
        bar: reference?.entryBar ?? -1,
        time: reference?.entryTime ?? params.cutoffMs,
        fullValue: fullBefore.length,
        truncatedValue: truncatedBefore.length,
      },
    };
  }

  for (let i = 0; i < fullBefore.length; i += 1) {
    const a = fullBefore[i]!;
    const b = truncatedBefore[i]!;
    const seq = i + 1;

    const mismatch = firstFieldMismatch(a, b, boundary);
    if (mismatch !== null) {
      return {
        ...base,
        divergence: { ...mismatch, tradeSeq: seq, bar: a.entryBar, time: a.entryTime },
      };
    }
  }

  return { ...base, divergence: null };
}

function firstFieldMismatch(
  a: ComparableTrade,
  b: ComparableTrade,
  boundary: number,
): Omit<Divergence, 'tradeSeq' | 'bar' | 'time'> | null {
  if (a.side !== b.side) {
    return { field: 'side', fullValue: a.side, truncatedValue: b.side };
  }
  if (a.entryBar !== b.entryBar) {
    return { field: 'entryBar', fullValue: a.entryBar, truncatedValue: b.entryBar };
  }
  if (Math.abs(a.qty - b.qty) > PRICE_EPSILON) {
    return { field: 'qty', fullValue: a.qty, truncatedValue: b.qty };
  }
  if (Math.abs(a.entryPrice - b.entryPrice) > PRICE_EPSILON) {
    return { field: 'entryPrice', fullValue: a.entryPrice, truncatedValue: b.entryPrice };
  }

  /*
   * The exit is only comparable when the full run closed the trade before the boundary too.
   * Otherwise the truncated run had no data to close it with, and reporting "still open" as a
   * divergence would fail every strategy holding a position at the cutoff — which is all of them.
   */
  const exitComparable =
    a.exitBar !== null && a.exitPrice !== null && a.exitTime !== null && a.exitTime < boundary;

  if (exitComparable) {
    if (b.exitBar === null || b.exitPrice === null) {
      return { field: 'exitBar', fullValue: a.exitBar!, truncatedValue: 'still open' };
    }
    if (a.exitBar !== b.exitBar) {
      return { field: 'exitBar', fullValue: a.exitBar, truncatedValue: b.exitBar };
    }
    if (Math.abs(a.exitPrice - b.exitPrice) > PRICE_EPSILON) {
      return { field: 'exitPrice', fullValue: a.exitPrice, truncatedValue: b.exitPrice };
    }
  }

  return null;
}

/**
 * Evenly spaced cutoffs across a run's window.
 *
 * Spaced rather than random so a failure is reproducible, and interior rather than at the edges:
 * a cutoff at `fromMs` leaves nothing to compare and one at `toMs` truncates nothing.
 */
export function cutoffsFor(fromMs: number, toMs: number, count: number): number[] {
  if (count <= 0 || toMs <= fromMs) return [];
  const span = toMs - fromMs;
  const cutoffs: number[] = [];
  for (let i = 1; i <= count; i += 1) {
    cutoffs.push(Math.round(fromMs + (span * i) / (count + 1)));
  }
  return cutoffs;
}

export interface PrefixInvarianceResult {
  readonly comparisons: readonly PrefixComparison[];
  /** The earliest divergence across every cutoff, or null when all agreed. */
  readonly firstDivergence: (Divergence & { readonly cutoffMs: number }) | null;
  /** Cutoffs that had at least one comparable trade. */
  readonly usableCutoffs: number;
}

export interface RunPrefixInvarianceParams {
  readonly full: ComparableRun;
  readonly cutoffs: readonly number[];
  readonly marginMs: number;
  /** Execute the strategy with data truncated at `cutoffMs`. */
  readonly runAt: (cutoffMs: number) => Promise<ComparableRun>;
}

export async function runPrefixInvariance(
  params: RunPrefixInvarianceParams,
): Promise<PrefixInvarianceResult> {
  const comparisons: PrefixComparison[] = [];

  for (const cutoffMs of params.cutoffs) {
    const truncated = await params.runAt(cutoffMs);
    comparisons.push(
      comparePrefix({ full: params.full, truncated, cutoffMs, marginMs: params.marginMs }),
    );
  }

  // Earliest by the divergent bar's TIME, not by cutoff order: the most informative report points
  // at the first moment the strategy behaved differently, whichever cutoff exposed it.
  const diverged = comparisons
    .filter((c) => c.divergence !== null)
    .map((c) => ({ ...c.divergence!, cutoffMs: c.cutoffMs }))
    .sort((a, b) => a.time - b.time);

  return {
    comparisons,
    firstDivergence: diverged[0] ?? null,
    usableCutoffs: comparisons.filter((c) => c.compared > 0).length,
  };
}
