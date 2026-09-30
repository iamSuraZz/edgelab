import { retentionRatio, returnPerDay, type SegmentMetrics } from './oos-split';

/**
 * The one result a holdout can give you.
 *
 * Every other check in this suite can be re-run freely: they read data the strategy was built on,
 * so running them again costs nothing but time. This one costs the holdout. Each look is recorded
 * (A37, A38), and a range looked at repeatedly is in-sample data whatever it is labelled — so the
 * report always carries the view count that applied, and the verdict weakens as it rises.
 *
 * The comparison is the OOS split's, deliberately: same `SegmentMetrics`, same per-calendar-day
 * normalisation (A36), same refusal to divide by a non-positive baseline (A24). A holdout is an
 * out-of-sample test whose only distinguishing property is that the data was WITHHELD rather than
 * merely later, and inventing a second scoring rule for it would make the two incomparable for no
 * reason.
 */

export type HoldoutVerdict = 'pass' | 'warn' | 'fail' | 'n/a';

/** Below this many trades on either side, a ratio describes the sample rather than the strategy. */
const DEFAULT_MIN_TRADES = 10;

/** A retention at or above this is "held up"; below it the edge shrank materially. */
const RETENTION_PASS = 0.5;

export interface HoldoutTestResult {
  readonly inSample: SegmentMetrics;
  readonly holdout: SegmentMetrics;
  /** Holdout return per day over in-sample return per day, or null when undefined (A36). */
  readonly retention: number | null;
  readonly inSamplePerDay: number | null;
  readonly holdoutPerDay: number | null;
  /** The seal's view count AFTER this test. One is the first look; more is a weaker claim. */
  readonly viewCountAfter: number;
  readonly verdict: HoldoutVerdict;
  readonly explanation: string;
  readonly inconclusiveReason: string | null;
}

export interface HoldoutTestParams {
  readonly inSample: SegmentMetrics;
  readonly holdout: SegmentMetrics;
  readonly viewCountAfter: number;
  readonly minTradesPerSegment?: number;
}

export function analyseHoldoutTest(params: HoldoutTestParams): HoldoutTestResult {
  const { inSample, holdout, viewCountAfter } = params;
  const minTrades = params.minTradesPerSegment ?? DEFAULT_MIN_TRADES;

  const base = {
    inSample,
    holdout,
    retention: retentionRatio(inSample, holdout),
    inSamplePerDay: returnPerDay(inSample),
    holdoutPerDay: returnPerDay(holdout),
    viewCountAfter,
  };

  /*
   * The count is stated FIRST, on every outcome including the inconclusive ones.
   *
   * A test that came back `n/a` still spent a look. Reporting the cost only when there is a result
   * to show would make the cheapest-looking outcome the one that quietly burned the holdout.
   */
  const spent = describeCost(viewCountAfter);

  if (holdout.trades < minTrades || inSample.trades < minTrades) {
    const reason =
      `Too few trades to compare: ${String(inSample.trades)} in sample and ` +
      `${String(holdout.trades)} on the holdout, against a minimum of ${String(minTrades)} each. ` +
      `A ratio between two small samples describes the samples, not the strategy. ${spent}`;
    return { ...base, verdict: 'n/a', explanation: reason, inconclusiveReason: reason };
  }

  if (!((inSample.returnPct ?? 0) > 0)) {
    const reason =
      `The strategy did not make money in sample (${(inSample.returnPct ?? 0).toFixed(2)}%), so ` +
      `there is no edge whose survival the holdout could test. Nothing here is overfitted because ` +
      `nothing was fitted. ${spent}`;
    return { ...base, verdict: 'n/a', explanation: reason, inconclusiveReason: reason };
  }

  const earned = `${fmtPerDay(base.inSamplePerDay)} per day in sample against ${fmtPerDay(
    base.holdoutPerDay,
  )} per day on the holdout`;

  // A sign flip is the finding the holdout exists to produce, and no view count softens it.
  if (holdout.netProfit <= 0) {
    return {
      ...base,
      verdict: 'fail',
      explanation:
        `The edge did not survive data that was withheld: ${earned}. This is the strongest ` +
        `negative result available here — the strategy had no opportunity to be fitted to these ` +
        `bars, and it lost money on them. ${spent}`,
      inconclusiveReason: null,
    };
  }

  const retention = base.retention;
  if (retention !== null && retention < RETENTION_PASS) {
    return {
      ...base,
      verdict: 'warn',
      explanation:
        `The edge survived but shrank: ${earned}, a retention of ${retention.toFixed(2)}. Still ` +
        `profitable on withheld data, at well under half the rate it earned on data it was built ` +
        `against. ${spent}`,
      inconclusiveReason: null,
    };
  }

  /*
   * A pass on a holdout already viewed is still a WARN.
   *
   * The arithmetic cannot tell the two apart — the numbers are identical whether this is the first
   * look or the fifth — so the distinction has to be carried by the count, or it is lost. The whole
   * value of the mechanism is that it degrades visibly rather than silently.
   */
  if (viewCountAfter > 1) {
    return {
      ...base,
      verdict: 'warn',
      explanation:
        `The edge held up on the holdout — ${earned}${
          retention === null ? '' : `, a retention of ${retention.toFixed(2)}`
        } — but this range has now been looked at ${String(viewCountAfter)} times. Repeated tests ` +
        `on the same withheld data select for strategies that happen to suit it, which is ` +
        `precisely what a holdout exists to prevent. Treat this as a weaker pass than the first.`,
      inconclusiveReason: null,
    };
  }

  return {
    ...base,
    verdict: 'pass',
    explanation:
      `The edge held up on data the strategy had never seen: ${earned}${
        retention === null ? '' : `, a retention of ${retention.toFixed(2)}`
      }. ${spent}`,
    inconclusiveReason: null,
  };
}

function describeCost(viewCountAfter: number): string {
  return viewCountAfter <= 1
    ? 'This was the first look at this holdout; it is now spent, and a second test on it means less.'
    : `This holdout has now been viewed ${String(viewCountAfter)} times, so this result means ` +
        'less than the first one did.';
}

/** Null renders as an em dash, never as 0 — an undefined rate is not a rate of zero. */
function fmtPerDay(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(4)}%`;
}
