import type { CheckResult, CheckStatus, Verdict } from './check';

/**
 * The report answers TWO questions, and collapsing them into one badge misleads.
 *
 * "Is this backtest honest?" is about whether the numbers can be believed at all — look-ahead,
 * execution realism, whether the data covered what it claims, whether the holdout was viewed. It
 * has a verdict, because it is a question with an answer.
 *
 * "Does the edge hold up?" is about whether the strategy is likely to keep working — out-of-sample,
 * rolling folds, regimes, timeframes, Monte Carlo. It gets COUNTS and no combined score, because
 * there is no honest way to average "profitable in 2 of 4 timeframes" with "15% of bootstrap
 * resamples lose money" into a single number, and any weighting invented to do so would be a
 * judgement smuggled in as arithmetic.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. A lone "Pass" on a strategy that lost money reads as an
 * endorsement: the checks are saying "we found no lying", and a reader sees "approved". Splitting
 * the questions makes the first badge mean exactly what it measures and leaves the second as a list
 * the reader has to actually look at.
 *
 * The split is derived from check IDs rather than a hand-kept list, so a new check lands on the
 * right side by being named consistently — and `unclassified` surfaces one that was not.
 */

export type Question = 'honesty' | 'robustness' | 'unclassified';

/**
 * Which question a check answers.
 *
 * `overfitting-holdout` is HONESTY, despite its prefix: a viewed holdout does not mean the edge is
 * fragile, it means this particular claim is weaker evidence than it appears. That is a statement
 * about the result's standing, not about the strategy.
 */
export function questionFor(checkId: string): Question {
  if (checkId === 'overfitting-holdout') return 'honesty';
  if (checkId.startsWith('lookahead-') || checkId.startsWith('execution-')) return 'honesty';
  if (checkId === 'bar-integrity' || checkId === 'trade-window' || checkId === 'sample-size') {
    return 'honesty';
  }
  if (checkId.startsWith('overfitting-')) return 'robustness';
  return 'unclassified';
}

export interface StatusCounts {
  readonly pass: number;
  readonly warn: number;
  readonly fail: number;
  readonly na: number;
}

export interface TwoQuestions {
  /** "Is this backtest honest?" — a verdict, because it is a question with an answer. */
  readonly honesty: {
    readonly verdict: Verdict;
    readonly headline: string;
    readonly checks: readonly CheckResult[];
    readonly counts: StatusCounts;
  };
  /** "Does the edge hold up?" — counts only. Deliberately no combined score. */
  readonly robustness: {
    readonly checks: readonly CheckResult[];
    readonly counts: StatusCounts;
    readonly headline: string;
  };
  /** Checks whose id matched no rule. Never silently dropped. */
  readonly unclassified: readonly CheckResult[];
}

function countOf(checks: readonly CheckResult[]): StatusCounts {
  const n = (status: CheckStatus): number => checks.filter((c) => c.status === status).length;
  return { pass: n('pass'), warn: n('warn'), fail: n('fail'), na: n('n/a') };
}

/**
 * The honesty verdict.
 *
 * Same shape as the overall verdict but scoped to the honesty checks: a critical failure fails, a
 * critical `n/a` is Inconclusive — because a check that could not run has not cleared anything —
 * and a non-critical problem warns.
 */
function honestyVerdict(checks: readonly CheckResult[]): Verdict {
  const critical = checks.filter((c) => c.severity === 'critical');

  if (critical.some((c) => c.status === 'fail')) return 'fail';
  if (critical.some((c) => c.status === 'n/a')) return 'inconclusive';
  if (checks.some((c) => c.status === 'fail' || c.status === 'warn')) return 'warn';
  return 'pass';
}

function honestyHeadline(verdict: Verdict, counts: StatusCounts): string {
  switch (verdict) {
    case 'fail':
      return `No — ${String(counts.fail)} check(s) found something that invalidates these numbers.`;
    case 'inconclusive':
      return `Unknown — ${String(counts.na)} check(s) could not reach a conclusion, so nothing here is cleared.`;
    case 'warn':
      return 'Mostly — nothing invalidates the numbers, but some checks found something worth reading.';
    case 'pass':
      // Deliberately not "approved": this says no lying was found, which is not the same as good.
      return 'Yes — no look-ahead, and execution is modelled realistically. This says nothing about whether the strategy is any good.';
  }
}

function robustnessHeadline(counts: StatusCounts, total: number): string {
  if (total === 0) return 'No robustness checks ran.';

  const parts: string[] = [];
  if (counts.pass > 0) parts.push(`${String(counts.pass)} pass`);
  if (counts.warn > 0) parts.push(`${String(counts.warn)} warn`);
  if (counts.fail > 0) parts.push(`${String(counts.fail)} fail`);
  if (counts.na > 0) parts.push(`${String(counts.na)} n/a`);

  return `${parts.join(', ')} — read them individually; there is no combined score.`;
}

export function splitByQuestion(results: readonly CheckResult[]): TwoQuestions {
  const honesty = results.filter((r) => questionFor(r.id) === 'honesty');
  const robustness = results.filter((r) => questionFor(r.id) === 'robustness');
  const unclassified = results.filter((r) => questionFor(r.id) === 'unclassified');

  const honestyCounts = countOf(honesty);
  const robustnessCounts = countOf(robustness);
  const verdict = honestyVerdict(honesty);

  return {
    honesty: {
      verdict,
      headline: honestyHeadline(verdict, honestyCounts),
      checks: honesty,
      counts: honestyCounts,
    },
    robustness: {
      checks: robustness,
      counts: robustnessCounts,
      headline: robustnessHeadline(robustnessCounts, robustness.length),
    },
    unclassified,
  };
}
