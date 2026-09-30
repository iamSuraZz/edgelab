import type { MonthlyReturn } from '@edgelab/metrics';

import { EM_DASH } from '@/lib/format';

/**
 * Monthly returns, year by month (spec 05).
 *
 * A heatmap rather than a table because the question it answers is about SHAPE: whether the profit
 * came from every month or from one, and whether the losing months cluster. A column of numbers
 * makes that work; a grid shows it at a glance.
 *
 * Shaded by magnitude relative to the largest absolute month in the run, so a strategy whose worst
 * month is -2% is not painted in the same red as one whose worst month is -40%. The legend states
 * the scale, because a relative scale that looks absolute is worse than no colour.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function MonthlyHeatmap({
  months,
}: {
  readonly months: readonly MonthlyReturn[];
}): React.JSX.Element {
  if (months.length === 0) {
    return <p className="text-xs text-muted">No completed months in this window.</p>;
  }

  const years = [...new Set(months.map((m) => m.year))].sort((a, b) => a - b);
  const byKey = new Map(months.map((m) => [`${String(m.year)}-${String(m.month)}`, m]));
  /*
   * `returnPct` is NULLABLE, and null is not zero (the repo's undefined-vs-zero rule): a month
   * whose starting equity was zero has no defined return. Treating it as 0% would paint a hole in
   * the record as a flat month.
   */
  const scale = Math.max(
    ...months.map((m) => (m.returnPct === null ? 0 : Math.abs(m.returnPct))),
    1e-9,
  );

  return (
    <div className="space-y-1.5" data-testid="monthly-heatmap">
      <div className="overflow-x-auto">
        <table className="text-xs">
          <thead>
            <tr className="text-muted">
              <th className="px-1 py-0.5 text-left font-normal">Year</th>
              {MONTHS.map((m) => (
                <th key={m} className="px-1 py-0.5 text-right font-normal">
                  {m}
                </th>
              ))}
              <th className="px-1 py-0.5 text-right font-normal">Year</th>
            </tr>
          </thead>
          <tbody>
            {years.map((year) => {
              const inYear = months.filter((m) => m.year === year);
              /*
               * Compounded, not summed. Monthly returns are ratios of their own starting equity, so
               * adding them overstates a winning year and understates a losing one — the same class
               * of error A36 found in the ratio checks.
               */
              const measured = inYear.filter((m) => m.returnPct !== null);
              const yearReturn =
                measured.length === 0
                  ? null
                  : (measured.reduce((acc, m) => acc * (1 + m.returnPct! / 100), 1) - 1) * 100;

              return (
                <tr key={year}>
                  <td className="px-1 py-0.5 text-muted">{year}</td>
                  {MONTHS.map((label, i) => {
                    const cell = byKey.get(`${String(year)}-${String(i + 1)}`);
                    return (
                      <td key={label} className="p-px">
                        {cell === undefined || cell.returnPct === null ? (
                          <div
                            className="min-w-12 rounded-sm px-1 py-0.5 text-right text-muted"
                            title={
                              cell === undefined
                                ? 'No bars in this month.'
                                : 'Starting equity was zero, so this month has no defined return.'
                            }
                          >
                            {EM_DASH}
                          </div>
                        ) : (
                          <div
                            className={`min-w-12 rounded-sm px-1 py-0.5 text-right tabular-nums ${tone(cell.returnPct, scale)}`}
                            title={`${label} ${String(year)}: ${cell.returnPct.toFixed(2)}% (${cell.startEquity.toFixed(0)} → ${cell.endEquity.toFixed(0)})`}
                            data-testid={`month-${String(year)}-${String(i + 1)}`}
                          >
                            {cell.returnPct.toFixed(1)}
                          </div>
                        )}
                      </td>
                    );
                  })}
                  <td
                    className={`px-1 py-0.5 text-right font-medium tabular-nums ${
                      yearReturn === null
                        ? 'text-muted'
                        : yearReturn < 0
                          ? 'text-rose-300'
                          : 'text-emerald-300'
                    }`}
                  >
                    {yearReturn === null ? EM_DASH : yearReturn.toFixed(1)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[0.65rem] text-muted">
        Percent return per calendar month. Colour is scaled to this run&apos;s largest month (
        {scale.toFixed(1)}%), so shades are comparable within this report and not between reports.
        The year column compounds its months rather than adding them.
      </p>
    </div>
  );
}

function tone(pct: number, scale: number): string {
  const share = Math.abs(pct) / scale;
  if (share < 0.02) return 'bg-surface-hover text-muted';
  if (pct > 0) {
    if (share > 0.66) return 'bg-emerald-500/40 text-emerald-50';
    if (share > 0.33) return 'bg-emerald-500/25 text-emerald-100';
    return 'bg-emerald-500/10 text-emerald-200';
  }
  if (share > 0.66) return 'bg-rose-500/40 text-rose-50';
  if (share > 0.33) return 'bg-rose-500/25 text-rose-100';
  return 'bg-rose-500/10 text-rose-200';
}
