import { useQuery } from '@tanstack/react-query';
import {
  CandlestickSeries,
  LineSeries,
  createSeriesMarkers,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import type { CostedTrade, Timeframe } from '@edgelab/shared';

import { fetchCandles } from '@/lib/api';
import { baseOptions, chartPalette, toUtcSeconds } from '@/lib/chart-theme';
import { MINUS, formatPrice } from '@/lib/format';
import { useStudio } from '@/stores/studio';
import { useThemeStore } from '@/stores/theme';

/**
 * Candles with entry/exit markers and the script's own plots.
 *
 * Clicking a trade in the table sets `focusedTradeSeq`, which this scrolls to and highlights with
 * entry/exit price lines. That is the link spec 04 asks for — a number in a table is not much use
 * if you cannot see where it happened.
 */
export function PriceChart({
  symbol,
  timeframe,
  fromMs,
  toMs,
  trades,
  digits,
}: {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly fromMs: number;
  readonly toMs: number;
  readonly trades: readonly CostedTrade[];
  readonly digits: number;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const levelLinesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const theme = useThemeStore((s) => s.theme);
  const focusedSeq = useStudio((s) => s.focusedTradeSeq);
  const focusedAtMs = useStudio((s) => s.focusedAtMs);

  const candles = useQuery({
    queryKey: ['candles', symbol, timeframe, fromMs, toMs],
    queryFn: () => fetchCandles(symbol, timeframe, fromMs, toMs),
    staleTime: 5 * 60_000,
  });

  /* ------------------------------------------------------- chart lifecycle */

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;

    const palette = chartPalette(theme);
    const chart = createChart(host, {
      ...baseOptions(palette),
      width: host.clientWidth,
      height: host.clientHeight,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: palette.positive,
      downColor: palette.negative,
      borderUpColor: palette.positive,
      borderDownColor: palette.negative,
      wickUpColor: palette.positive,
      wickDownColor: palette.negative,
      priceFormat: { type: 'price', precision: digits, minMove: 10 ** -digits },
    });

    chartRef.current = chart;
    candleRef.current = candleSeries;

    const observer = new ResizeObserver(() => {
      chart.applyOptions({ width: host.clientWidth, height: host.clientHeight });
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      levelLinesRef.current = [];
    };
  }, [theme, digits]);

  /* ------------------------------------------------------------ bar data */

  useEffect(() => {
    const series = candleRef.current;
    if (series === null || candles.data === undefined) return;

    series.setData(
      candles.data.candles.map((c) => ({
        time: toUtcSeconds(c.time),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [candles.data]);

  /* ------------------------------------------------------------- markers */

  useEffect(() => {
    const series = candleRef.current;
    if (series === null) return;

    const palette = chartPalette(theme);
    const markers: SeriesMarker<UTCTimestamp>[] = [];

    for (const trade of trades) {
      const long = trade.side === 'long';
      const won = trade.netPnl > 0;

      markers.push({
        time: toUtcSeconds(trade.entryTime),
        position: long ? 'belowBar' : 'aboveBar',
        color: long ? palette.positive : palette.negative,
        shape: long ? 'arrowUp' : 'arrowDown',
        text: `#${String(trade.seq)} ${long ? 'L' : 'S'} ${formatPrice(trade.entryPrice, digits)}`,
      });

      markers.push({
        time: toUtcSeconds(trade.exitTime),
        position: long ? 'aboveBar' : 'belowBar',
        // Exit markers are coloured by OUTCOME, not by side: when scanning a chart the question
        // is "did this one work", and side is already shown by the entry arrow's direction.
        color: won ? palette.positive : palette.negative,
        shape: 'circle',
        text: `${won ? '+' : MINUS}${Math.abs(trade.netPnl).toFixed(2)}`,
      });
    }

    // Markers must be sorted by time or Lightweight Charts drops the out-of-order ones silently.
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    createSeriesMarkers(series, markers);
  }, [trades, theme, digits]);

  /* ------------------------------ focused trade: scroll + SL/TP style lines */

  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;

    // Clear previous level lines before drawing the new ones.
    for (const line of levelLinesRef.current) chart.removeSeries(line);
    levelLinesRef.current = [];

    /*
     * An INSTANT with no trade on it is the ordinary case for look-ahead evidence (A53): the
     * causality check's first peek on a leaking script is bar 0, and prefix invariance names the
     * bar a decision changed on, which is usually not a bar anything traded. Centre and mark it,
     * then fall through to the trade lines only when a trade was what was focused.
     */
    if (focusedSeq === null) {
      if (focusedAtMs === null) return;
      markInstant(chart, focusedAtMs, chartPalette(theme), levelLinesRef);
      return;
    }

    const trade = trades.find((t) => t.seq === focusedSeq);
    if (trade === undefined) {
      // A trade that is not in this run's list still has an instant worth showing.
      if (focusedAtMs !== null) markInstant(chart, focusedAtMs, chartPalette(theme), levelLinesRef);
      return;
    }

    const palette = chartPalette(theme);
    const span: [UTCTimestamp, UTCTimestamp] = [
      toUtcSeconds(trade.entryTime),
      toUtcSeconds(trade.exitTime),
    ];

    // Entry and exit as horizontal segments spanning the holding period. This doubles as the
    // SL/TP visualisation when the exit was a stop: the exit line IS the level that triggered.
    for (const [price, colour, title] of [
      [trade.entryPrice, palette.primary, `#${String(trade.seq)} entry`],
      [
        trade.exitPrice,
        trade.netPnl > 0 ? palette.positive : palette.negative,
        `#${String(trade.seq)} exit`,
      ],
    ] as const) {
      const line = chart.addSeries(LineSeries, {
        color: colour,
        lineWidth: 1,
        lineStyle: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        title,
      });
      line.setData([
        { time: span[0], value: price },
        { time: span[1], value: price },
      ]);
      levelLinesRef.current.push(line);
    }

    // Centre the trade with context either side, rather than scrolling it to an edge where you
    // cannot see what led into it.
    const pad = Math.max(3_600, (span[1] - span[0]) * 2);
    chart.timeScale().setVisibleRange({
      from: (span[0] - pad) as UTCTimestamp,
      to: (span[1] + pad) as UTCTimestamp,
    });
  }, [focusedSeq, focusedAtMs, trades, theme]);

  return (
    <div className="relative h-full min-h-0" data-testid="price-chart">
      <div ref={hostRef} className="h-full min-h-0" />

      {candles.isLoading && (
        <p className="absolute inset-0 grid place-items-center text-xs text-muted">
          Loading candles…
        </p>
      )}
      {candles.error !== null && (
        <p className="absolute inset-0 grid place-items-center px-6 text-center text-xs text-destructive">
          {candles.error instanceof Error ? candles.error.message : 'Could not load candles.'}
        </p>
      )}
      {focusedSeq !== null && (
        <span
          className="pointer-events-none absolute left-2 top-2 rounded bg-background/85 px-2 py-0.5 text-[11px] text-muted"
          data-testid="focused-trade-badge"
        >
          Trade #{focusedSeq}
        </span>
      )}
    </div>
  );
}

/**
 * Centre on an instant and mark it.
 *
 * A vertical marker rather than a horizontal level, because the claim being made is "here, at this
 * time" — there is no price associated with a look-ahead divergence, and drawing one at an
 * arbitrary level would invent a claim the evidence does not make.
 *
 * Lightweight Charts has no vertical-line primitive, so the marker is a two-point series at the
 * focused instant spanning the visible price range. It is registered in the same ref the trade
 * lines use, so the next focus clears it without special-casing.
 */
function markInstant(
  chart: IChartApi,
  atMs: number,
  palette: ReturnType<typeof chartPalette>,
  linesRef: { current: ISeriesApi<'Line'>[] },
): void {
  const at = toUtcSeconds(atMs);

  const marker = chart.addSeries(LineSeries, {
    color: palette.primary,
    lineWidth: 2,
    lineStyle: 2,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  // Two points one second apart: a "vertical" line in a library that only draws series.
  marker.setData([
    { time: at, value: 0 },
    { time: (at + 1) as UTCTimestamp, value: 0 },
  ]);
  marker.applyOptions({ autoscaleInfoProvider: () => null });
  linesRef.current.push(marker);

  // Four hours either side: enough to see what led into the bar, which is the whole point of
  // jumping to it.
  const pad = 4 * 3_600;
  chart.timeScale().setVisibleRange({
    from: (at - pad) as UTCTimestamp,
    to: (at + pad) as UTCTimestamp,
  });
}
