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
import { useEffect, useRef, useState } from 'react';
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
  /**
   * Set when a focused instant could not be shown as given.
   *
   * Two cases, both worth saying out loud rather than silently centring on something else: the
   * instant lies outside the range this chart draws, or it was SNAPPED to the bar containing it.
   * The M1 replay reports minute-level evidence — a stop crossed at 09:37 — while the chart may be
   * showing H1, and jumping to "09:37" on an H1 chart can only mean the 09:00 bar.
   */
  const [focusNote, setFocusNote] = useState<string | null>(null);

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
      setFocusNote(
        markInstant(chart, focusedAtMs, chartPalette(theme), levelLinesRef, candles.data?.candles),
      );
      return;
    }

    setFocusNote(null);
    const trade = trades.find((t) => t.seq === focusedSeq);
    if (trade === undefined) {
      // A trade that is not in this run's list still has an instant worth showing.
      if (focusedAtMs !== null) {
        setFocusNote(
          markInstant(
            chart,
            focusedAtMs,
            chartPalette(theme),
            levelLinesRef,
            candles.data?.candles,
          ),
        );
      }
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
  }, [focusedSeq, focusedAtMs, trades, theme, candles.data]);

  return (
    /*
     * `absolute inset-0`, not `h-full` (A55).
     *
     * Lightweight Charts sizes itself from this element, so a zero-height host is an invisible
     * chart. `h-full` is a PERCENTAGE height, and a percentage resolves only against a parent with
     * a definite `height` — through this particular chain (a flex item whose height comes from a
     * `min-height` floor) it resolved to 0 and the chart vanished on the run report page. An
     * absolutely positioned box with all four insets set takes its size from the containing block
     * directly, with no percentage to resolve, so it cannot collapse this way again.
     */
    <div className="absolute inset-0" data-testid="price-chart">
      <div ref={hostRef} className="absolute inset-0" />

      {focusNote !== null && (
        <p
          className="absolute inset-x-2 top-2 z-10 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-200"
          data-testid="focus-note"
        >
          {focusNote}
        </p>
      )}

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
  candles: readonly { readonly time: number }[] | undefined,
): string | null {
  const snapped = snapToBar(atMs, candles);
  const at = toUtcSeconds(snapped.atMs);

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

  // Context either side, scaled to the bar size so an M1 chart is not shown four hours of bars and
  // a D1 chart is not shown four hours of nothing.
  const pad = Math.max(3_600, snapped.barSpanSeconds * 6);
  chart.timeScale().setVisibleRange({
    from: (at - pad) as UTCTimestamp,
    to: (at + pad) as UTCTimestamp,
  });

  return snapped.note;
}

interface Snapped {
  readonly atMs: number;
  readonly barSpanSeconds: number;
  /** What to tell the user, when the instant could not be shown exactly as given. */
  readonly note: string | null;
}

/**
 * Snap an instant to the chart bar containing it.
 *
 * Evidence is reported at the resolution the CHECK worked at, which is not the chart's: the M1
 * intrabar replay finds a stop crossed at 09:37 on a chart drawn in hours. Centring on 09:37
 * without saying so shows the 09:00 bar and lets the reader believe the evidence was about 09:00.
 *
 * An instant outside the drawn range is reported rather than clamped silently, because clamping
 * would put the marker on a bar that has nothing to do with the finding.
 */
function snapToBar(
  atMs: number,
  candles: readonly { readonly time: number }[] | undefined,
): Snapped {
  const span = (list: readonly { readonly time: number }[]): number =>
    list.length < 2 ? 3_600 : Math.round((list[1]!.time - list[0]!.time) / 1000);

  // Nothing drawn yet: mark the instant as given and say nothing, because a note about which bar
  // it landed on would be describing bars that are not on screen.
  if (candles === undefined || candles.length === 0) {
    return { atMs, barSpanSeconds: 3_600, note: null };
  }

  const barSpanSeconds = span(candles);
  const first = candles[0]!.time;
  const last = candles[candles.length - 1]!.time;

  if (atMs < first) {
    return {
      atMs: first,
      barSpanSeconds,
      note: `That instant (${iso(atMs)}) is before this chart's first bar, so the marker sits on the earliest bar shown, ${iso(first)}.`,
    };
  }
  if (atMs > last + barSpanSeconds * 1000) {
    return {
      atMs: last,
      barSpanSeconds,
      note: `That instant (${iso(atMs)}) is after this chart's last bar, so the marker sits on the latest bar shown, ${iso(last)}.`,
    };
  }

  // The last bar whose OPEN time is at or before the instant — a bar's time is its open (repo
  // convention), so the bar containing 09:37 on H1 is the one opening at 09:00.
  let containing = candles[0]!.time;
  for (const c of candles) {
    if (c.time > atMs) break;
    containing = c.time;
  }

  return {
    atMs: containing,
    barSpanSeconds,
    /*
     * Always say what was marked, even when nothing had to be snapped.
     *
     * The marker is drawn on the chart's canvas, so on its own it is a thin dotted line the reader
     * has to find and then trust. Naming the bar turns "the chart moved" into "the chart is showing
     * THIS bar", which is the claim the evidence actually made.
     */
    note:
      containing === atMs
        ? `Marked ${iso(atMs)} — the bar the evidence names.`
        : `Evidence is at ${iso(atMs)}; this chart's bars are ${formatSpan(barSpanSeconds)}, so the marker is on the bar opening ${iso(containing)}.`,
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

function formatSpan(seconds: number): string {
  if (seconds < 3_600) return `${String(Math.round(seconds / 60))}m`;
  if (seconds < 86_400) return `${String(Math.round(seconds / 3_600))}h`;
  return `${String(Math.round(seconds / 86_400))}d`;
}
