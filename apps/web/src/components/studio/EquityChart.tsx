import {
  AreaSeries,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';

import type { RunSeries } from '@/lib/api';
import { baseOptions, chartPalette, toUtcSeconds } from '@/lib/chart-theme';
import { useThemeStore } from '@/stores/theme';

/**
 * Equity, buy & hold and a drawdown pane.
 *
 * Two synchronised charts rather than one with two scales: a drawdown is always ≤ 0 and an equity
 * curve is a large positive number, so sharing an axis would squash the drawdown into the baseline
 * and make it unreadable — which is the one thing it exists to show.
 *
 * The Lightweight Charts attribution stays visible, as its licence requires.
 */
export function EquityChart({
  series,
  currency,
}: {
  readonly series: RunSeries;
  readonly currency: string;
}): React.JSX.Element {
  const equityRef = useRef<HTMLDivElement>(null);
  const drawdownRef = useRef<HTMLDivElement>(null);
  const theme = useThemeStore((s) => s.theme);

  useEffect(() => {
    const equityHost = equityRef.current;
    const drawdownHost = drawdownRef.current;
    if (equityHost === null || drawdownHost === null) return undefined;

    const palette = chartPalette(theme);

    const equityChart = createChart(equityHost, {
      ...baseOptions(palette),
      height: equityHost.clientHeight,
      // Attribution on, per the licence.
      layout: { ...baseOptions(palette).layout, attributionLogo: true },
    });

    const drawdownChart = createChart(drawdownHost, {
      ...baseOptions(palette),
      height: drawdownHost.clientHeight,
      layout: { ...baseOptions(palette).layout, attributionLogo: false },
      timeScale: { ...baseOptions(palette).timeScale, visible: true },
    });

    const equitySeries = equityChart.addSeries(AreaSeries, {
      lineColor: palette.primary,
      topColor: `${palette.primary}44`,
      bottomColor: `${palette.primary}04`,
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      title: `Equity (${currency})`,
    });
    equitySeries.setData(
      series.equityClose.points.map((p) => ({ time: toUtcSeconds(p.time), value: p.equity })),
    );

    if (series.buyAndHold !== null && series.buyAndHold.points.length > 0) {
      const benchmark = equityChart.addSeries(LineSeries, {
        color: palette.muted,
        lineWidth: 1,
        lineStyle: 2, // dashed: it is a reference, not a result
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        title: 'Buy & hold',
      });
      benchmark.setData(
        series.buyAndHold.points.map((p) => ({ time: toUtcSeconds(p.time), value: p.equity })),
      );
    }

    // Drawdown as a histogram below zero — the shape reads as "underwater" at a glance in a way
    // a line does not.
    const drawdownSeries = drawdownChart.addSeries(HistogramSeries, {
      color: palette.negative,
      priceFormat: { type: 'percent', precision: 2, minMove: 0.01 },
      title: 'Drawdown %',
    });
    drawdownSeries.setData(
      series.equityClose.points.map((p) => ({
        time: toUtcSeconds(p.time),
        value: -Math.abs(p.drawdownPct),
      })),
    );

    equityChart.timeScale().fitContent();
    drawdownChart.timeScale().fitContent();

    // Keep the two time axes locked together, guarding against the feedback loop each would
    // otherwise trigger in the other.
    let syncing = false;
    const sync = (from: IChartApi, to: IChartApi): (() => void) => {
      const handler = (): void => {
        if (syncing) return;
        syncing = true;
        const range = from.timeScale().getVisibleLogicalRange();
        if (range !== null) to.timeScale().setVisibleLogicalRange(range);
        syncing = false;
      };
      from.timeScale().subscribeVisibleLogicalRangeChange(handler);
      return () => {
        from.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
      };
    };
    const unsyncA = sync(equityChart, drawdownChart);
    const unsyncB = sync(drawdownChart, equityChart);

    const observer = new ResizeObserver(() => {
      equityChart.applyOptions({ width: equityHost.clientWidth, height: equityHost.clientHeight });
      drawdownChart.applyOptions({
        width: drawdownHost.clientWidth,
        height: drawdownHost.clientHeight,
      });
    });
    observer.observe(equityHost);
    observer.observe(drawdownHost);

    return () => {
      unsyncA();
      unsyncB();
      observer.disconnect();
      equityChart.remove();
      drawdownChart.remove();
    };
  }, [series, currency, theme]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-1" data-testid="equity-chart">
      <div ref={equityRef} className="min-h-0 flex-[3]" />
      <div ref={drawdownRef} className="min-h-0 flex-1 border-t border-border" />
    </div>
  );
}
