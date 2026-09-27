import type { Bar, ClosedTrade, EquityPoint, Timeframe } from '@edgelab/shared';

/**
 * Integrity and overfitting checks. Every check is a pure function from a snapshot of
 * the run to a verdict, so checks are trivially unit-testable and can run in any order.
 */

export type CheckSeverity = 'info' | 'warning' | 'critical';

/**
 * Spec 06's four statuses.
 *
 * `n/a` is the interesting one, and it is NOT a synonym for pass. It means the check could not
 * reach a conclusion — a segment too short to say anything about, an ambiguity the data cannot
 * resolve, a feature the engine does not expose. Amendment A2 turns that into a first-class
 * outcome precisely so it stops being quietly rounded down to "fine".
 */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'n/a';

export interface CheckResult {
  readonly id: string;
  readonly label: string;
  readonly status: CheckStatus;
  readonly severity: CheckSeverity;
  /** One-line explanation, shown directly in the report. */
  readonly detail: string;
  /** Supporting numbers, e.g. { duplicates: 3 }. */
  readonly evidence?: Readonly<Record<string, number | string>>;
  /** Why no conclusion was possible. Present only when `status` is `n/a`. */
  readonly inconclusiveReason?: string;
}

/** Everything a check is allowed to look at. */
export interface CheckInput {
  readonly bars: readonly Bar[];
  readonly timeframe: Timeframe;
  readonly trades: readonly ClosedTrade[];
  readonly equity: readonly EquityPoint[];
  readonly initialCapital: number;
}

export interface Check {
  readonly id: string;
  readonly label: string;
  readonly severity: CheckSeverity;
  /** Which family the check belongs to, for grouping in the report. */
  readonly kind: 'integrity' | 'overfitting';
  run(input: CheckInput): CheckResult;
}

function result(
  check: Check,
  status: CheckStatus,
  detail: string,
  evidence?: CheckResult['evidence'],
): CheckResult {
  return {
    id: check.id,
    label: check.label,
    status,
    severity: check.severity,
    detail,
    ...(evidence ? { evidence } : {}),
  };
}

export function pass(
  check: Check,
  detail: string,
  evidence?: CheckResult['evidence'],
): CheckResult {
  return result(check, 'pass', detail, evidence);
}

export function warn(
  check: Check,
  detail: string,
  evidence?: CheckResult['evidence'],
): CheckResult {
  return result(check, 'warn', detail, evidence);
}

export function fail(
  check: Check,
  detail: string,
  evidence?: CheckResult['evidence'],
): CheckResult {
  return result(check, 'fail', detail, evidence);
}

/**
 * No conclusion reached, with the reason (A2).
 *
 * The reason is required, not optional. An `n/a` without one is indistinguishable from a check
 * that silently did nothing, and this status exists to be legible.
 */
export function notApplicable(
  check: Check,
  reason: string,
  evidence?: CheckResult['evidence'],
): CheckResult {
  return { ...result(check, 'n/a', reason, evidence), inconclusiveReason: reason };
}

/** Run a set of checks. Pure — the order of results matches the order of checks. */
export function runChecks(checks: readonly Check[], input: CheckInput): CheckResult[] {
  return checks.map((c) => c.run(input));
}

/**
 * The overall verdict.
 *
 * `inconclusive` rather than `pass` whenever a CRITICAL check could not reach a conclusion (A2).
 * The reasoning: the critical checks are the ones that decide whether the numbers mean anything
 * at all, so "we could not tell whether this run leaks future data" must never present as a
 * clean bill of health. A green badge is a claim, and this is the case where we cannot make it.
 */
export type Verdict = 'pass' | 'warn' | 'fail' | 'inconclusive';

export function overallVerdict(results: readonly CheckResult[]): Verdict {
  const critical = results.filter((r) => r.severity === 'critical');

  if (critical.some((r) => r.status === 'fail')) return 'fail';
  if (critical.some((r) => r.status === 'n/a')) return 'inconclusive';
  // A non-critical failure is a warning overall: it is worth seeing, but it does not invalidate
  // the run the way a look-ahead leak does.
  if (results.some((r) => r.status === 'fail' || r.status === 'warn')) return 'warn';
  return 'pass';
}

/** True when no critical check failed. Weaker than the verdict — `n/a` does not fail this. */
export function isRunTrustworthy(results: readonly CheckResult[]): boolean {
  return !results.some((r) => r.status === 'fail' && r.severity === 'critical');
}

export function verdictHeadline(verdict: Verdict): string {
  switch (verdict) {
    case 'fail':
      return 'Failed — this run cannot be trusted as it stands.';
    case 'inconclusive':
      return 'Inconclusive — a critical check could not reach a conclusion.';
    case 'warn':
      return 'Passed with warnings.';
    case 'pass':
      return 'Passed every check.';
  }
}
