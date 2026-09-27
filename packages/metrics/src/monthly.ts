import type { EquitySample } from '@edgelab/shared';
import type { MonthlyReturn } from './types';

/**
 * Monthly returns table (year x month) for the heatmap.
 *
 * The first month's return is measured from `initialCapital`, not from its own closing
 * equity — otherwise month one would always read 0%.
 */
export function computeMonthlyReturns(
  monthly: readonly EquitySample[],
  initialCapital: number,
): MonthlyReturn[] {
  const out: MonthlyReturn[] = [];
  let previous = initialCapital;

  for (const sample of monthly) {
    const date = new Date(sample.time);
    const start = previous;
    const end = sample.equity;

    out.push({
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      // A non-positive starting equity makes a percentage meaningless.
      returnPct: start > 0 ? ((end - start) / start) * 100 : null,
      startEquity: start,
      endEquity: end,
    });

    previous = end;
  }

  return out;
}
