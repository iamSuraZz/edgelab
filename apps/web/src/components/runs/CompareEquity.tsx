import { useQueries } from '@tanstack/react-query';
import { LineSeries, createChart } from 'lightweight-charts';
import { useEffect, useMemo, useRef } from 'react';

import { fetchRunSeries } from '@/lib/api';
import { baseOptions, chartPalette, toUtcSeconds } from '@/lib/chart-theme';
import { useThemeStore } from '@/stores/theme';

/**
 * Compared equity curves, overlaid and normalised to 100 (spec 07).
 *
 * Normalisation is what makes the comparison mean anything: two runs on different starting
 * capital produce curves an order of magnitude apart, and the taller one is not the better
 * strategy. Rebased to 100 at each run's own first point, the lines are directly readable as
 * percentage growth and the axis is shared honestly.
 *
 * The x axis stays REAL TIME rather than bars-since-start. Runs over different periods then sit
 * where they actually happened, so a strategy that only worked in one quarter is visible as
 * such — which would be hidden by stacking every curve at a common origin.
 */

/** Distinct enough to tell four lines apart, and legible on both themes. */
const LINE_COLOURS = ['#4f8cff', '#f2a33c', '#39c07f', '#d472e8'] as const;

export function CompareEquity({
  runs,
}: {
  readonly runs: readonly { readonly id: string; readonly label: string }[];
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const theme = useThemeStore((s) => s.theme);

  const queries = useQueries({
    queries: runs.map((run) => ({
      queryKey: ['series', run.id, 600],
      // 600 points is plenty for a curve a few hundred pixels wide, and keeps four concurrent
      // fetches small.
      queryFn: () => fetchRunSeries(run.id, 600),
      staleTime: Infinity,
    })),
  });

  const loading = queries.some((q) => q.isPending);
  const failed = queries.filter((q) => q.isError).length;

  /**
   * Rebase each curve to 100.
   *
   * Against the run's OWN first equity point, not its configured initial capital: if the series
   * starts partway through — a warmup gap, a downsampled first bucket — those two differ, and
   * using the config would put a visible step at the left edge that never happened.
   */
  // `queries` is a fresh array on every render, so memoising on it directly would be pointless.
  // The fetch timestamps change exactly when the data does, which is the dependency that matters.
  const fetchedAt = queries.map((q) => q.dataUpdatedAt).join(',');

  const curves = useMemo(
    () =>
      queries.map((q, i) => {
        const points = q.data?.equityClose.points ?? [];
        const base = points[0]?.equity ?? 0;
        return {
          colour: LINE_COLOURS[i % LINE_COLOURS.length]!,
          label: runs[i]?.label ?? '',
          // A zero or negative opening equity has no meaningful ratio, so the curve is dropped
          // rather than drawn against a fabricated base.
          data:
            base > 0
              ? points.map((p) => ({ time: toUtcSeconds(p.time), value: (p.equity / base) * 100 }))
              : [],
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fetchedAt, runs],
  );

  useEffect(() => {
    const element = host.current;
    if (element === null || loading) return undefined;

    const palette = chartPalette(theme);
    const chart = createChart(element, {
      ...baseOptions(palette),
      height: element.clientHeight,
      // Attribution on, per the licence.
      layout: { ...baseOptions(palette).layout, attributionLogo: true },
    });

    for (const curve of curves) {
      if (curve.data.length === 0) continue;
      const line = chart.addSeries(LineSeries, {
        color: curve.colour,
        lineWidth: 2,
        priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
        title: curve.label,
      });
      line.setData(curve.data);
    }

    // The 100 line: without it "normalised to 100" is a claim rather than something you can see,
    // and breakeven is the one level every curve should be read against.
    const baseline = chart.addSeries(LineSeries, {
      color: palette.muted,
      lineWidth: 1,
      lineStyle: 2,
      priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
      title: '100',
    });
    const spans = curves.flatMap((c) => c.data);
    if (spans.length > 0) {
      const times = spans.map((p) => p.time).sort((a, b) => a - b);
      baseline.setData([
        { time: times[0]!, value: 100 },
        { time: times[times.length - 1]!, value: 100 },
      ]);
    }

    chart.timeScale().fitContent();

    const observer = new ResizeObserver(() => {
      chart.applyOptions({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [curves, loading, theme]);

  return (
    <div className="border-b border-border">
      <div className="flex flex-wrap items-center gap-3 px-3 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-muted">
          Equity, rebased to 100
        </span>
        {runs.map((run, i) => (
          <span key={run.id} className="flex items-center gap-1 text-[11px]">
            <span
              aria-hidden
              className="inline-block size-2 rounded-sm"
              style={{ backgroundColor: LINE_COLOURS[i % LINE_COLOURS.length] }}
            />
            {run.label}
          </span>
        ))}
        {failed > 0 && (
          <span className="text-[11px] text-destructive">
            {failed} of {runs.length} series could not be loaded
          </span>
        )}
      </div>

      <div ref={host} className="h-56 w-full" data-testid="compare-equity">
        {loading && <p className="p-3 text-xs text-muted">Loading equity curves…</p>}
      </div>
    </div>
  );
}
