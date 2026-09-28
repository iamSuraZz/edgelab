import type { SegmentMetrics } from './oos-split';

/**
 * The timeframe matrix (spec 06 §3): does the edge survive a change of chart timeframe?
 *
 * A strategy that works on H1 and nowhere near it is not a strategy, it is a coincidence found by
 * whoever chose H1. The neighbours are what distinguish the two: an edge with any real basis degrades
 * smoothly as the bar size changes, while a fitted one falls off a cliff on either side.
 *
 * WHAT THIS IS NOT. It is not an optimisation over timeframes — the best cell is never "the answer",
 * and the check deliberately reports the SHAPE of the row rather than its maximum. A matrix read as a
 * menu is a way to overfit one dimension further, which is the opposite of its purpose.
 *
 * Every cell is its own run from the same starting capital, for the reason A24 gives for the OOS
 * split: under equity-proportional sizing, a cell that inherited another's equity would be measuring
 * that inheritance.
 *
 * Pure: the caller performs the runs.
 */

export type CellStatus = 'ok' | 'n/a';

export interface MatrixCell {
  readonly timeframe: string;
  readonly status: CellStatus;
  /** Present when the cell could not be run. */
  readonly reason: string | null;
  readonly metrics: SegmentMetrics | null;
}

export interface TimeframeMatrixResult {
  readonly cells: readonly MatrixCell[];
  readonly baseTimeframe: string;
  readonly ran: number;
  readonly skipped: number;
  /** Cells that made money, of those that ran and had enough trades. */
  readonly profitable: number;
  readonly assessable: number;
  readonly verdict: 'pass' | 'warn' | 'fail' | 'n/a';
  readonly explanation: string;
  readonly inconclusiveReason: string | null;
}

/**
 * Whether a chart timeframe can be tested at all, given what the script asks for.
 *
 * A cell is `n/a` when the CHART timeframe is higher than a timeframe the script requests through
 * `request.security` (A40). A script reading H1 inside an M15 chart is coherent — that is the normal
 * direction, a lower timeframe reaching up. The same script on a D1 chart is asking for data FINER
 * than its own bars, which PineTS and TradingView resolve differently and neither resolves usefully.
 * Running it anyway produces a number, and a number from an incoherent configuration is worse than a
 * blank because it will be compared against the others as though it meant the same thing.
 *
 * `requestedMs` comes from the causality log (A1a), so this is known rather than inferred from the
 * source text.
 */
export function cellAvailability(
  chartTimeframe: string,
  chartMs: number,
  requested: readonly { readonly timeframe: string; readonly ms: number }[],
): { readonly status: CellStatus; readonly reason: string | null } {
  const finer = requested.filter((r) => r.ms > 0 && r.ms < chartMs);
  if (finer.length === 0) return { status: 'ok', reason: null };

  const names = [...new Set(finer.map((f) => f.timeframe))].join(', ');
  return {
    status: 'n/a',
    reason:
      `The script requests ${names} through request.security, which is FINER than a ${chartTimeframe} ` +
      'chart. A higher-timeframe request from a lower-timeframe chart is the normal direction; the ' +
      'reverse is resolved differently by PineTS and TradingView and usefully by neither, so this ' +
      'cell is not run rather than run wrongly.',
  };
}

export interface TimeframeMatrixParams {
  readonly cells: readonly MatrixCell[];
  readonly baseTimeframe: string;
  /** Trades a cell needs before its result counts towards the shape. */
  readonly minTrades?: number;
}

const DEFAULT_MIN_TRADES = 10;

export function analyseTimeframeMatrix(params: TimeframeMatrixParams): TimeframeMatrixResult {
  const minTrades = params.minTrades ?? DEFAULT_MIN_TRADES;

  const ran = params.cells.filter((c) => c.status === 'ok' && c.metrics !== null);
  const skipped = params.cells.length - ran.length;

  const assessableCells = ran.filter((c) => (c.metrics as SegmentMetrics).trades >= minTrades);
  const profitable = assessableCells.filter(
    (c) => (c.metrics as SegmentMetrics).netProfit > 0,
  ).length;

  const base = {
    cells: params.cells,
    baseTimeframe: params.baseTimeframe,
    ran: ran.length,
    skipped,
    profitable,
    assessable: assessableCells.length,
  };

  if (assessableCells.length < 2) {
    const reason =
      `Only ${String(assessableCells.length)} of ${String(params.cells.length)} timeframes ` +
      `produced at least ${String(minTrades)} trades, so there is no shape to read. A matrix needs ` +
      'neighbours to compare against; one cell is just the original run.';
    return { ...base, verdict: 'n/a', explanation: reason, inconclusiveReason: reason };
  }

  const summary = assessableCells
    .map((c) => `${c.timeframe} ${(c.metrics as SegmentMetrics).netProfit.toFixed(0)}`)
    .join(', ');

  const share = profitable / assessableCells.length;

  // The base timeframe standing alone is the signature this check exists for: profitable where it
  // was chosen, unprofitable everywhere around it.
  const baseCell = assessableCells.find((c) => c.timeframe === params.baseTimeframe);
  const baseProfitable = (baseCell?.metrics?.netProfit ?? 0) > 0;
  const isolated = baseProfitable && profitable === 1;

  if (isolated) {
    return {
      ...base,
      verdict: 'fail',
      explanation:
        `${params.baseTimeframe} is the ONLY timeframe of ${String(assessableCells.length)} tested ` +
        `that makes money: ${summary}. An edge that exists at one bar size and vanishes at its ` +
        'neighbours is a property of that bar size, not of the market.',
      inconclusiveReason: null,
    };
  }

  // `<=`, so exactly half warns. A strategy that works on half the bar sizes tried has performed a
  // coin flip across them, which is not evidence of robustness in either direction.
  if (share <= 0.5) {
    return {
      ...base,
      verdict: 'warn',
      explanation:
        `${String(profitable)} of ${String(assessableCells.length)} timeframes make money: ` +
        `${summary}. The edge does not carry across bar sizes, though it is not confined to one.`,
      inconclusiveReason: null,
    };
  }

  return {
    ...base,
    verdict: 'pass',
    explanation: `${String(profitable)} of ${String(assessableCells.length)} timeframes make money: ${summary}.`,
    inconclusiveReason: null,
  };
}
