/**
 * Out-of-sample split (spec 06 §3).
 *
 * Fit is measured on the first part of the range, honesty on the last. The question is not whether
 * the out-of-sample half made money — it is whether whatever edge the in-sample half showed
 * SURVIVED into data the strategy was not shaped around.
 *
 * WHY EACH SEGMENT IS ITS OWN RUN, from the same starting capital (A24). Slicing one full run into
 * two is the obvious implementation and it is wrong under any equity-proportional sizing: the
 * out-of-sample slice inherits position sizes grown by in-sample profits, so a strategy looks better
 * out of sample exactly when it did well in sample — the opposite of what the check is for. Warmup
 * comes through the engine's own gate, which loads bars before the window and suppresses orders on
 * them, so the second segment's indicators are warm without its trades starting early.
 *
 * NO EDGE MEANS NOTHING TO TEST. If the in-sample half did not make money there is no persistence
 * question to ask, and every ratio below has a non-positive denominator. That is `n/a`, not `fail` —
 * the same rule A24 fixed for walk-forward efficiency, where two losses divide into a flattering
 * positive number.
 *
 * Pure: the caller performs the two runs and passes their metrics.
 */

export interface SegmentMetrics {
  readonly fromMs: number;
  readonly toMs: number;
  readonly trades: number;
  readonly netProfit: number;
  readonly returnPct: number | null;
  readonly profitFactor: number | null;
  readonly sharpe: number | null;
  readonly winRatePct: number | null;
  readonly maxDrawdownPct: number | null;
  readonly expectancy: number | null;
}

const MS_PER_DAY = 24 * 60 * 60_000;

/**
 * Return per CALENDAR DAY of the window, in percent.
 *
 * Every ratio below compares two windows of different lengths, and comparing their raw returns is
 * simply wrong: with 3:1 folds a strategy performing identically in both scores 1/3, and with a
 * 70/30 split it scores 3/7. Those are properties of the layout, not of the strategy, and they made
 * every retention figure this repo has reported read as decay when nothing had decayed.
 *
 * SIMPLE, not compounded. De-compounding a six-week window to a daily rate takes a root, which
 * amplifies whatever happened in that short window — a fold that returned 12% over 40 days becomes
 * a 0.28%/day rate under simple division and something far spikier under a geometric one. The
 * quantity wanted here is "how fast was it earning", and the arithmetic mean is the honest reading
 * of that over windows this short.
 *
 * Null when the window has no length, which is the only way this can be undefined.
 */
export function returnPerDay(m: SegmentMetrics): number | null {
  if (m.returnPct === null) return null;
  const days = (m.toMs - m.fromMs) / MS_PER_DAY;
  if (!(days > 0)) return null;
  return m.returnPct / days;
}

/**
 * Out-of-sample daily rate over in-sample daily rate, or null.
 *
 * A24's guard is applied to the RAW in-sample return, not the normalised one: the question "was
 * there an edge to retain" is about the window's actual result, and dividing by its length cannot
 * change that sign. 1.0 now means the strategy earned at the same rate in both windows.
 */
export function retentionRatio(
  inSample: SegmentMetrics,
  outOfSample: SegmentMetrics,
): number | null {
  if (!((inSample.returnPct ?? 0) > 0)) return null;

  const is = returnPerDay(inSample);
  const oos = returnPerDay(outOfSample);
  if (is === null || oos === null || !(is > 0)) return null;

  return oos / is;
}

export interface OosDegradation {
  /**
   * Out-of-sample return RATE as a fraction of the in-sample rate, both per calendar day.
   *
   * 1.0 means it earned at the same speed in both windows; 0.5 means half as fast; negative means it
   * reversed. Null when the in-sample return was not positive, because the ratio would then reward
   * losing more.
   */
  readonly returnRatio: number | null;
  readonly profitFactorRatio: number | null;
  /** Signed differences, which stay meaningful when the in-sample figure is negative. */
  readonly sharpeDelta: number | null;
  readonly winRateDelta: number | null;
  readonly expectancyRatio: number | null;
  /**
   * False when the in-sample return was positive but too small for a ratio to mean anything.
   *
   * A denominator near zero is the soft form of the trap A24 named: dividing by a 0.1% in-sample
   * return produced "kept 1911%" on a real fixture, which reads as a triumph and is noise. The
   * ratio is still reported, and qualified.
   */
  readonly returnRatioStable: boolean;
}

export type OosVerdict = 'pass' | 'warn' | 'fail' | 'n/a';

export interface OosSplitResult {
  readonly inSample: SegmentMetrics;
  readonly outOfSample: SegmentMetrics;
  readonly splitMs: number;
  /** Share of the window given to the in-sample segment. */
  readonly splitFraction: number;
  readonly degradation: OosDegradation;
  readonly verdict: OosVerdict;
  readonly explanation: string;
  /** Present when the verdict is `n/a`. */
  readonly inconclusiveReason: string | null;
}

export interface OosSplitParams {
  readonly inSample: SegmentMetrics;
  readonly outOfSample: SegmentMetrics;
  readonly splitMs: number;
  readonly splitFraction: number;
  /**
   * Fewest trades a segment needs before its metrics mean anything.
   *
   * Applied to BOTH segments. A strategy with four out-of-sample trades has not been tested; saying
   * so is more useful than a profit factor computed from four numbers.
   */
  readonly minTradesPerSegment?: number;
}

const DEFAULT_MIN_TRADES = 10;

export function analyseOosSplit(params: OosSplitParams): OosSplitResult {
  const { inSample, outOfSample, splitMs, splitFraction } = params;
  const minTrades = params.minTradesPerSegment ?? DEFAULT_MIN_TRADES;

  const degradation = degrade(inSample, outOfSample);

  const base = { inSample, outOfSample, splitMs, splitFraction, degradation };

  if (inSample.trades < minTrades || outOfSample.trades < minTrades) {
    const reason =
      `Too few trades to compare: ${String(inSample.trades)} in sample and ` +
      `${String(outOfSample.trades)} out of sample, against a minimum of ${String(minTrades)} each. ` +
      'A ratio between two small samples describes the samples, not the strategy.';
    return { ...base, verdict: 'n/a', explanation: reason, inconclusiveReason: reason };
  }

  if (inSample.netProfit <= 0) {
    const reason =
      `The in-sample half lost money (${inSample.netProfit.toFixed(2)}), so there is no edge whose ` +
      'persistence could be tested. This is not a pass and not a failure of the split — it is a ' +
      'strategy with nothing to overfit to.';
    return { ...base, verdict: 'n/a', explanation: reason, inconclusiveReason: reason };
  }

  // The sign flip is the finding that matters: an edge that existed in sample and reversed out of
  // sample is the signature the whole exercise is looking for.
  if (outOfSample.netProfit <= 0) {
    return {
      ...base,
      verdict: 'fail',
      explanation:
        `In-sample net profit ${inSample.netProfit.toFixed(2)} became ` +
        `${outOfSample.netProfit.toFixed(2)} out of sample over ` +
        `${String(outOfSample.trades)} trades. The edge did not survive data the strategy was not ` +
        'shaped around.' +
        pfNote(inSample, outOfSample),
      inconclusiveReason: null,
    };
  }

  const kept = degradation.returnRatio;

  // A ratio against a near-zero in-sample return is arithmetic, not evidence. The strategy still
  // made money out of sample, so this is a pass — but the headline number is withheld rather than
  // printed as a 1911% success.
  if (kept !== null && !degradation.returnRatioStable) {
    return {
      ...base,
      verdict: 'pass',
      explanation:
        `Out-of-sample return ${(outOfSample.returnPct ?? 0).toFixed(2)}% over ` +
        `${String(outOfSample.trades)} trades, against an in-sample return of only ` +
        `${(inSample.returnPct ?? 0).toFixed(2)}%. The ratio between them is not reported: a ` +
        'denominator that close to zero makes it arithmetic rather than evidence, and the ' +
        'in-sample half barely established an edge to test.' +
        pfNote(inSample, outOfSample),
      inconclusiveReason: null,
    };
  }

  if (kept !== null && kept < 0.5) {
    return {
      ...base,
      verdict: 'warn',
      explanation:
        `Out-of-sample return kept ${(kept * 100).toFixed(0)}% of the in-sample rate ` +
        `(${(returnPerDay(outOfSample) ?? 0).toFixed(3)}%/day against ` +
        `${(returnPerDay(inSample) ?? 0).toFixed(3)}%/day). Still profitable, but most of the edge ` +
        'is in the half the strategy was chosen on.' +
        pfNote(inSample, outOfSample),
      inconclusiveReason: null,
    };
  }

  return {
    ...base,
    verdict: 'pass',
    explanation:
      `Out-of-sample return kept ${kept === null ? 'its' : `${(kept * 100).toFixed(0)}% of the`} ` +
      `in-sample rate per day over ${String(outOfSample.trades)} trades.` +
      pfNote(inSample, outOfSample),
    inconclusiveReason: null,
  };
}

function pfNote(is: SegmentMetrics, oos: SegmentMetrics): string {
  if (is.profitFactor === null || oos.profitFactor === null) return '';
  return ` Profit factor ${is.profitFactor.toFixed(2)} -> ${oos.profitFactor.toFixed(2)}.`;
}

/** Below this in-sample return, in percent, a ratio against it is arithmetic rather than evidence. */
const MIN_STABLE_RETURN_PCT = 1;

function degrade(is: SegmentMetrics, oos: SegmentMetrics): OosDegradation {
  return {
    returnRatioStable: (is.returnPct ?? 0) >= MIN_STABLE_RETURN_PCT,
    returnRatio: retentionRatio(is, oos),
    profitFactorRatio: ratio(is.profitFactor, oos.profitFactor),
    sharpeDelta: delta(is.sharpe, oos.sharpe),
    winRateDelta: delta(is.winRatePct, oos.winRatePct),
    expectancyRatio: ratio(is.expectancy, oos.expectancy),
  };
}

/**
 * Out-of-sample over in-sample, or null.
 *
 * Null whenever the denominator is not strictly positive. A ratio against a negative or zero
 * baseline is not a degradation measure — with both negative it comes out positive and reads as
 * success, which is the exact trap A24 recorded for walk-forward efficiency.
 */
function ratio(inSample: number | null, outOfSample: number | null): number | null {
  if (inSample === null || outOfSample === null) return null;
  if (!(inSample > 0)) return null;
  return outOfSample / inSample;
}

function delta(inSample: number | null, outOfSample: number | null): number | null {
  if (inSample === null || outOfSample === null) return null;
  return outOfSample - inSample;
}

/** Where to cut the window, given the share the in-sample half should get. */
export function splitInstant(fromMs: number, toMs: number, fraction: number): number {
  return fromMs + Math.round((toMs - fromMs) * fraction);
}
