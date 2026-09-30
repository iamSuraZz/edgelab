import { useQuery } from '@tanstack/react-query';
import { CandlestickSeries, createChart, type IChartApi } from 'lightweight-charts';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { TIMEFRAME_CODES, type Timeframe } from '@edgelab/shared';

import { fetchCandles, listSymbols } from '@/lib/api';
import { baseOptions, chartPalette, toUtcSeconds } from '@/lib/chart-theme';
import { useThemeStore } from '@/stores/theme';

/**
 * Stored M1, drawn at any timeframe.
 *
 * The point is not to look at a chart — it is to confirm that what was downloaded RESAMPLES
 * correctly, which is spec 02's DONE WHEN ("display correctly on every MT5 timeframe"). Only M1 is
 * stored; everything else here is computed on the way out, so a resampler bug shows up as a chart
 * that looks wrong at M15 and right at M1.
 *
 * The chip bar is the full MT5 set rather than a curated few, because the timeframes worth checking
 * are precisely the awkward ones — M7 does not exist, M20 and H3 do, and the boundary cases are
 * where bucketing goes wrong.
 */

const PREVIEW_DAYS = 14;

export function CandlePreview({
  symbol,
  onClose,
}: {
  readonly symbol: string;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [timeframe, setTimeframe] = useState<Timeframe>('H1');
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const theme = useThemeStore((s) => s.theme);

  const symbols = useQuery({ queryKey: ['symbols'], queryFn: listSymbols, staleTime: 60_000 });
  const spec = symbols.data?.find((s) => s.symbol === symbol);

  /*
   * The window is anchored to the symbol's LAST stored bar, not to today.
   *
   * Most series here end months ago, and a preview that defaulted to "the last two weeks" would
   * show an empty chart for every one of them and read as a broken download.
   */
  const lastMs = spec?.coverage.lastBar ?? null;
  const toMs = lastMs === null ? null : lastMs + 60_000;
  const fromMs = toMs === null ? null : toMs - PREVIEW_DAYS * 24 * 60 * 60_000;

  const candles = useQuery({
    queryKey: ['preview-candles', symbol, timeframe, fromMs, toMs],
    queryFn: () => fetchCandles(symbol, timeframe, fromMs!, toMs!),
    enabled: fromMs !== null && toMs !== null,
  });

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;

    const palette = chartPalette(theme);
    const chart = createChart(host, {
      ...baseOptions(palette),
      width: host.clientWidth,
      height: host.clientHeight,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: palette.positive,
      downColor: palette.negative,
      borderUpColor: palette.positive,
      borderDownColor: palette.negative,
      wickUpColor: palette.positive,
      wickDownColor: palette.negative,
      ...(spec === undefined
        ? {}
        : {
            priceFormat: {
              type: 'price' as const,
              precision: spec.digits,
              minMove: 10 ** -spec.digits,
            },
          }),
    });

    chartRef.current = chart;

    if (candles.data !== undefined) {
      series.setData(
        candles.data.candles.map((c) => ({
          time: toUtcSeconds(c.time),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })),
      );
      chart.timeScale().fitContent();
    }

    const observer = new ResizeObserver(() => {
      chart.applyOptions({ width: host.clientWidth, height: host.clientHeight });
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [candles.data, theme, spec]);

  return (
    <div className="rounded-md border border-border" data-testid="candle-preview">
      <header className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        <h3 className="text-sm font-medium">{symbol}</h3>
        <span className="text-xs text-muted">
          {fromMs === null ? 'no stored bars' : `${isoDay(fromMs)} → ${isoDay(toMs!)}`}
        </span>
        <span className="text-xs tabular-nums text-muted" data-testid="preview-count">
          {candles.data === undefined ? '' : `${candles.data.count.toLocaleString()} bars`}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded p-1 text-muted hover:text-foreground"
          aria-label="Close preview"
          data-testid="preview-close"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="flex flex-wrap gap-0.5 border-b border-border p-1.5" role="tablist">
        {TIMEFRAME_CODES.map((code) => (
          <button
            key={code}
            type="button"
            role="tab"
            aria-selected={timeframe === code}
            onClick={() => {
              setTimeframe(code);
            }}
            className={`rounded px-1.5 py-0.5 text-[0.65rem] font-medium transition-colors ${
              timeframe === code
                ? 'bg-primary text-primary-foreground'
                : 'text-muted hover:bg-surface-hover hover:text-foreground'
            }`}
            data-testid={`preview-tf-${code}`}
          >
            {code}
          </button>
        ))}
      </div>

      {/*
        `relative` + an absolutely positioned host: a percentage height resolves to zero through a
        container whose own height comes from a min-height floor, and the chart then renders at 0px
        while appearing present in the DOM (A55).
      */}
      <div className="relative h-80 min-h-80">
        <div ref={hostRef} className="absolute inset-0" />

        {candles.error !== null && (
          <p
            className="absolute inset-0 grid place-items-center p-4 text-center text-xs text-destructive"
            data-testid="preview-error"
          >
            {candles.error instanceof Error ? candles.error.message : String(candles.error)}
          </p>
        )}
        {candles.data?.count === 0 && (
          <p className="absolute inset-0 grid place-items-center text-xs text-muted">
            No bars in this window at {timeframe}.
          </p>
        )}
      </div>
    </div>
  );
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
