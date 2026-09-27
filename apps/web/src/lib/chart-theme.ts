import type { DeepPartial, ChartOptions, UTCTimestamp } from 'lightweight-charts';

/**
 * Shared Lightweight Charts styling.
 *
 * In its own module rather than beside a chart component because a file that exports both a
 * component and plain helpers defeats React Fast Refresh — editing the helper remounts the chart
 * and loses its zoom.
 */

export interface ChartPalette {
  readonly background: string;
  readonly text: string;
  readonly grid: string;
  readonly border: string;
  readonly primary: string;
  readonly muted: string;
  readonly positive: string;
  readonly negative: string;
}

/**
 * Hard-coded hex rather than read from the CSS variables: Lightweight Charts paints to a canvas
 * and cannot resolve `var(--primary)`, and `getComputedStyle` at mount time races the stylesheet.
 * These track `index.css` by hand — if the palette there changes, change it here too.
 */
export function chartPalette(theme: 'dark' | 'light'): ChartPalette {
  return theme === 'dark'
    ? {
        background: '#0d1421',
        text: '#8aa0c0',
        grid: '#1a2436',
        border: '#25314a',
        primary: '#4d8dfd',
        muted: '#6b7f9e',
        positive: '#2bb673',
        negative: '#e05561',
      }
    : {
        background: '#ffffff',
        text: '#64748b',
        grid: '#eef2f7',
        border: '#dbe3ec',
        primary: '#2563eb',
        muted: '#94a3b8',
        positive: '#0f9d58',
        negative: '#d93025',
      };
}

export function baseOptions(palette: ChartPalette): DeepPartial<ChartOptions> {
  return {
    layout: {
      background: { color: palette.background },
      textColor: palette.text,
      fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
      fontSize: 10,
      // The Lightweight Charts attribution stays on, as its licence requires.
      attributionLogo: true,
    },
    grid: {
      vertLines: { color: palette.grid },
      horzLines: { color: palette.grid },
    },
    rightPriceScale: { borderColor: palette.border },
    timeScale: { borderColor: palette.border, timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 },
  };
}

/**
 * Epoch ms → Lightweight Charts' `UTCTimestamp` (seconds).
 *
 * Bar times are already UTC epoch ms by the project's time convention, so this is a pure unit
 * change with no zone arithmetic — and must stay that way, or the chart drifts from the data.
 */
export function toUtcSeconds(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}
