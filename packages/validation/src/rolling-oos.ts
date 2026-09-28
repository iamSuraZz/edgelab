import type { SegmentMetrics } from './oos-split';

/**
 * Rolling out-of-sample with FIXED parameters.
 *
 * The out-of-sample split (A32) asks the persistence question once. This asks it repeatedly, rolling
 * through the range, which answers a different and harder question: not "did the edge survive into
 * the last 30%" but "does it survive REPEATEDLY, or did it survive once by luck".
 *
 * THIS IS NOT WALK-FORWARD OPTIMIZATION, and the distinction is the whole point of the name. Every
 * fold here runs the script's own input values unchanged. Nothing is selected in sample, so nothing's
 * GENERALIZATION is being tested — only whether one fixed parameter set keeps working as the market
 * moves. That is worth knowing and it is cheap, which is why it stays in the default suite; but a
 * strategy whose inputs were tuned by hand on this very data will sail through it. Spec 06's
 * walk-forward optimization, which fits parameters per fold and tests the WINNER out of sample, is a
 * separate and far more expensive check (A35).
 *
 * ROLLING, not anchored. The in-sample window is a fixed width that moves forward, so every fold
 * is fitted on the same amount of data. An anchored window grows, which means later folds are fitted
 * on more history than earlier ones and their results are not comparable with each other — the thing
 * being measured would change as the measurement proceeded.
 *
 * Layout for `foldCount` folds at an in-sample-to-out-of-sample ratio of `r`: the window is cut into
 * `foldCount + r` equal blocks. Fold i trains on blocks [i, i+r) and tests on block i+r. Every fold
 * therefore trains on r blocks and tests on one, and consecutive folds overlap in training data the
 * way a real re-fit would.
 *
 * COST, measured rather than assumed (A3). Script setup — parse, transpile, install the seams — is a
 * flat ~14ms and does NOT grow with the window; execution is ~39ms fixed plus ~0.042ms per bar. So a
 * fold costs roughly `2 x (53ms + 0.042 x barsPerFold)`, and transpiling once per thread would save
 * ~14ms per run. That is not worth it: `runPretranspiled` bypasses the instrumentation seam
 * entirely, which would cost the order log and the warmup gate — the order log being what A23 reads
 * exit levels from, and the gate being what makes each fold's warmup honest.
 *
 * Pure: the caller performs the runs and passes their metrics.
 */

export interface RollingOosFold {
  readonly index: number;
  readonly inSample: SegmentMetrics;
  readonly outOfSample: SegmentMetrics;
  /**
   * Walk-forward efficiency: out-of-sample return over in-sample return.
   *
   * Null when the in-sample return was not strictly positive (A24). Two losses divide into a
   * flattering positive number, and a fold that lost money in training had no edge to carry
   * forward — there is nothing to be efficient about.
   */
  readonly wfe: number | null;
  /** False when the in-sample return was positive but too small for the ratio to mean anything. */
  readonly wfeStable: boolean;
  /** True when this fold trained profitably. Only these folds can be said to have survived or not. */
  readonly hadEdge: boolean;
  /** True when it had an edge AND kept it out of sample. */
  readonly survived: boolean;
  /** False when either segment was too small to judge. */
  readonly assessable: boolean;
}

export type RollingOosVerdict = 'pass' | 'warn' | 'fail' | 'n/a';

export interface RollingOosResult {
  readonly folds: readonly RollingOosFold[];
  readonly assessableFolds: number;
  readonly foldsWithEdge: number;
  readonly foldsSurviving: number;
  /** Share of edge-bearing folds that kept the edge. Null when no fold had an edge. */
  readonly consistency: number | null;
  /** Median WFE across folds where it is defined and stable. Null when there are none. */
  readonly medianWfe: number | null;
  /** Total out-of-sample trades across assessable folds. */
  readonly totalOosTrades: number;
  readonly verdict: RollingOosVerdict;
  readonly explanation: string;
  readonly inconclusiveReason: string | null;
}

export interface RollingOosParams {
  readonly folds: readonly {
    readonly inSample: SegmentMetrics;
    readonly outOfSample: SegmentMetrics;
  }[];
  /** Fewest trades a segment needs before the fold is judged at all. */
  readonly minTradesPerSegment?: number;
  /** Below this in-sample return percent, the WFE ratio is reported but not trusted. */
  readonly minStableReturnPct?: number;
}

const DEFAULT_MIN_TRADES = 5;
const DEFAULT_MIN_STABLE_RETURN_PCT = 1;

export function analyseRollingOos(params: RollingOosParams): RollingOosResult {
  const minTrades = params.minTradesPerSegment ?? DEFAULT_MIN_TRADES;
  const minStable = params.minStableReturnPct ?? DEFAULT_MIN_STABLE_RETURN_PCT;

  const folds: RollingOosFold[] = params.folds.map((f, index) => {
    const assessable = f.inSample.trades >= minTrades && f.outOfSample.trades >= minTrades;
    const isReturn = f.inSample.returnPct;
    const oosReturn = f.outOfSample.returnPct;

    const hadEdge = assessable && f.inSample.netProfit > 0;
    const wfe =
      isReturn === null || oosReturn === null || !(isReturn > 0) ? null : oosReturn / isReturn;

    return {
      index,
      inSample: f.inSample,
      outOfSample: f.outOfSample,
      wfe,
      wfeStable: (isReturn ?? 0) >= minStable,
      hadEdge,
      survived: hadEdge && f.outOfSample.netProfit > 0,
      assessable,
    };
  });

  const assessableFolds = folds.filter((f) => f.assessable).length;
  const foldsWithEdge = folds.filter((f) => f.hadEdge).length;
  const foldsSurviving = folds.filter((f) => f.survived).length;
  const totalOosTrades = folds
    .filter((f) => f.assessable)
    .reduce((n, f) => n + f.outOfSample.trades, 0);

  const usableWfe = folds
    .filter((f) => f.assessable && f.wfe !== null && f.wfeStable)
    .map((f) => f.wfe as number);
  const medianWfe = median(usableWfe);

  const consistency = foldsWithEdge === 0 ? null : foldsSurviving / foldsWithEdge;

  const base = {
    folds,
    assessableFolds,
    foldsWithEdge,
    foldsSurviving,
    consistency,
    medianWfe,
    totalOosTrades,
  };

  // Settles the open question this repo has carried: a structurally short segment is `n/a`, never a
  // failure. A fold that produced three trades has not tested anything, and scoring it as a failure
  // would punish a strategy for the fold layout rather than for its behaviour.
  if (assessableFolds < 2) {
    const reason =
      `Only ${String(assessableFolds)} of ${String(folds.length)} folds produced enough trades in ` +
      'both halves to judge. Walk-forward needs at least two comparable folds; fewer means the ' +
      'layout was too fine for this strategy’s trade frequency, not that the strategy failed.';
    return { ...base, verdict: 'n/a', explanation: reason, inconclusiveReason: reason };
  }

  if (foldsWithEdge === 0) {
    const reason =
      `None of the ${String(assessableFolds)} assessable folds trained profitably, so no fold had ` +
      'an edge whose persistence could be tested. Nothing here is overfitted because nothing was ' +
      'fitted.';
    return { ...base, verdict: 'n/a', explanation: reason, inconclusiveReason: reason };
  }

  const kept = consistency ?? 0;
  const head =
    `${String(foldsSurviving)} of ${String(foldsWithEdge)} folds that trained profitably stayed ` +
    `profitable out of sample (${(kept * 100).toFixed(0)}%)` +
    (medianWfe === null
      ? ', with no fold whose in-sample return was large enough for a meaningful efficiency ratio'
      : `, median walk-forward efficiency ${medianWfe.toFixed(2)}`) +
    `, over ${String(totalOosTrades)} out-of-sample trades.`;

  if (kept < 0.5) {
    return {
      ...base,
      verdict: 'fail',
      explanation: `${head} An edge that fails more often than it holds is not an edge that rolled forward.`,
      inconclusiveReason: null,
    };
  }

  if (kept < 0.7 || (medianWfe !== null && medianWfe < 0.5)) {
    return {
      ...base,
      verdict: 'warn',
      explanation: `${head} It holds more often than not, but not reliably.`,
      inconclusiveReason: null,
    };
  }

  return { ...base, verdict: 'pass', explanation: head, inconclusiveReason: null };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export interface FoldWindow {
  readonly index: number;
  readonly isFromMs: number;
  readonly isToMs: number;
  readonly oosFromMs: number;
  readonly oosToMs: number;
}

/**
 * The rolling fold layout: `foldCount + ratio` equal blocks, fold i training on `ratio` of them and
 * testing on the next.
 *
 * Block boundaries are computed from the window rather than accumulated, so rounding cannot drift
 * and leave a gap or an overlap between one fold's test window and the next one's.
 */
export function foldWindows(
  fromMs: number,
  toMs: number,
  foldCount: number,
  ratio: number,
): FoldWindow[] {
  const blocks = foldCount + ratio;
  const edge = (i: number): number => fromMs + Math.round(((toMs - fromMs) * i) / blocks);

  return Array.from({ length: foldCount }, (_unused, i) => ({
    index: i,
    isFromMs: edge(i),
    isToMs: edge(i + ratio),
    oosFromMs: edge(i + ratio),
    oosToMs: edge(i + ratio + 1),
  }));
}
