import { deriveQuotes, type Bar, type Lots, type Price, type PriceBasis } from '@edgelab/shared';

import { type ResolvedLevels } from './exit-levels';
import { perFillFigures, type InstrumentScale, type PerFillFigures } from './per-fill';

/**
 * Intrabar ambiguity, replayed on M1 (spec 06 §2).
 *
 * A chart bar hides the order things happened in. When a stop and a target both sit inside one H1
 * bar, the engine decides the outcome from four numbers that cannot say which level the market
 * reached first. This replays the holding period minute by minute, on the side of the book each
 * order actually fills on, and takes the FIRST level genuinely touched.
 *
 * Two kinds of error come out, and only one of them is visible from the exit bar alone:
 *
 *   - **phantom target** — the engine closed at a target the correct quote never reached. The
 *     asymmetry check can see this, because it inspects the bar the exit happened on.
 *   - **missed stop** — the correct quote crossed the stop on some EARLIER bar, on which the stored
 *     prices never did. The trade really closed at a loss; the engine kept it open, often all the
 *     way to a target. No check that examines only exits that HAPPENED can see this, because the
 *     evidence is on a bar where, as far as the engine is concerned, nothing occurred.
 *
 * The second is the more dangerous of the two: it converts a loss into a win rather than merely
 * mispricing one, and it is invisible in every report the run produces.
 *
 * SIDE OF THE BOOK. A long exits by SELLING, so both its stop and its target trigger on the BID. A
 * short exits by BUYING, so both trigger on the ASK. On a mid feed the bid runs half a spread below
 * every stored low, which is precisely how a stop can be crossed on a bar whose stored low never
 * reached it.
 *
 * Pure. The caller supplies the M1 series, the basis and the spread.
 */

export interface ReplayTrade {
  readonly seq: number;
  readonly side: 'long' | 'short';
  readonly qty: Lots;
  readonly entryPrice: Price;
  readonly entryMs: number;
  readonly exitPrice: Price;
  readonly exitMs: number;
  /** Chart-bar index of the entry, so level lookups cannot reach into the previous position. */
  readonly entryBar?: number;
  /** The id of the order that closed the trade, so a multi-bracket script pairs correctly. */
  readonly exitId?: string | null;
  readonly netPnl: number;
}

/** A bracket's two distances from the entry price, in price units. */
export interface BracketLevels {
  readonly stopDistance: number;
  readonly targetDistance: number;
  /** Trades the inference agreed on. */
  readonly inferredFrom: number;
  /** Trades matching neither cluster — gap fills, forced closes, end-of-data exits. */
  readonly outliers: number;
}

/**
 * Recover a fixed bracket's distances from the run's own exits.
 *
 * The engine keeps no order log, so the levels are not recorded anywhere. They are recoverable
 * because a resting order fills AT its level: for a `strategy.exit` bracket, every favourable exit
 * sits one target-distance from its entry and every adverse exit one stop-distance.
 *
 * This is not circular with what the replay tests. The replay asks WHEN a level was reached; the
 * level itself is correct even when the timing is not, because the engine exits at the level either
 * way.
 *
 * Returns null unless both sides cluster tightly. A trailing stop, a dynamic level or a
 * signal-based exit will not cluster, and the check then reports `n/a` rather than inventing
 * levels — which would be far worse than declining.
 */
export function inferBracketLevels(
  trades: readonly ReplayTrade[],
  tolerance: number,
): BracketLevels | null {
  const favourable: number[] = [];
  const adverse: number[] = [];

  for (const t of trades) {
    const signed = t.side === 'long' ? t.exitPrice - t.entryPrice : t.entryPrice - t.exitPrice;
    (signed > 0 ? favourable : adverse).push(Math.abs(signed));
  }

  const target = dominantValue(favourable, tolerance);
  const stop = dominantValue(adverse, tolerance);
  if (target === null || stop === null) return null;

  const agreeing =
    favourable.filter((d) => Math.abs(d - target) <= tolerance).length +
    adverse.filter((d) => Math.abs(d - stop) <= tolerance).length;

  return {
    stopDistance: stop,
    targetDistance: target,
    inferredFrom: agreeing,
    outliers: trades.length - agreeing,
  };
}

/**
 * The value at least 80% of a sample agrees on, or null.
 *
 * A supermajority rather than a mean: a handful of gap fills would drag a mean off the real level,
 * and a level that is nearly right is worse than none — it would manufacture flips.
 */
function dominantValue(values: readonly number[], tolerance: number): number | null {
  if (values.length === 0) return null;

  let best: number | null = null;
  let bestCount = 0;

  for (const candidate of values) {
    const count = values.filter((v) => Math.abs(v - candidate) <= tolerance).length;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }

  return bestCount >= values.length * 0.8 ? best : null;
}

export type FlipKind = 'none' | 'phantom-target' | 'missed-stop';

export interface ReplayRow {
  readonly seq: number;
  readonly side: 'long' | 'short';
  readonly flip: FlipKind;
  /** Where the engine closed it. */
  readonly enginePrice: number;
  readonly engineMs: number;
  /** Where the replay says it closed. Null when no level was genuinely touched. */
  readonly truePrice: number | null;
  readonly trueMs: number | null;
  /** Signed price difference between the true exit and the engine's, in price units. */
  readonly priceDelta: number;
  /** The trade's P&L as reported, and as corrected. */
  readonly netPnlReported: number;
  readonly netPnlCorrected: number;
}

export interface IntrabarReplayResult {
  readonly rows: readonly ReplayRow[];
  readonly assessed: number;
  readonly skipped: number;
  /** Trades whose levels trail, and so cannot be replayed as fixed levels. */
  readonly trailing: number;
  /** Trades with several exit ids in play whose closing id could not be identified. */
  readonly ambiguous: number;
  /** Where the levels came from. `clustered` is the degraded path. */
  readonly levelSource: 'order-log' | 'clustered' | 'none';
  readonly levels: BracketLevels | null;
  readonly phantomTargets: number;
  readonly missedStops: number;
  /** Sum of the P&L corrections. Negative means the run overstated its result. */
  readonly netPnlDelta: number;
  readonly perFill: PerFillFigures;
  readonly explanation: string;
}

export interface IntrabarReplayParams {
  readonly trades: readonly ReplayTrade[];
  /** M1 bars covering at least every trade's holding period, ascending by time. */
  readonly m1: readonly Bar[];
  readonly basis: PriceBasis;
  /** Spread in PRICE units for an M1 bar. */
  readonly spreadAt: (bar: Bar) => number;
  /** Account-currency value of one price unit on one lot. */
  readonly valuePerPricePerLot: number;
  readonly scale: InstrumentScale;
  /**
   * The CHART timeframe in ms.
   *
   * Needed because a trade's `exitMs` is its exit bar's OPEN time, by this codebase's convention.
   * The level that closed the trade was reached somewhere INSIDE that bar, so the replay has to
   * walk to its end — stopping at the open excluded every minute in which the exit actually
   * happened, and reported a third of all exits as phantom targets on a feed where long targets
   * are exact by construction.
   */
  readonly chartBarMs: number;
  /**
   * The authoritative level source: the run's order log, resolved per trade and per bar.
   *
   * Returns null when no exit call had been made yet, and `trailing: true` when the call carried a
   * `trail_*` argument — those trades are reported n/a rather than replayed against a level that
   * depends on a path this cannot reconstruct.
   *
   * When absent, the check falls back to clustering exit prices, which only works for a fixed
   * bracket. The fallback exists so a run recorded before the order log was wired still produces
   * something; it is not the intended path.
   */
  readonly levelsAt?: (trade: ReplayTrade, atMs: number) => ResolvedLevels | null;
  /** Clustered levels, for the fallback. Inferred from the trades when omitted. */
  readonly levels?: BracketLevels | null;
  /** Which trades closed on a resting order. Only those have levels to replay. */
  readonly isLevelExit?: (seq: number) => boolean;
}

export function replayIntrabar(params: IntrabarReplayParams): IntrabarReplayResult {
  const { trades, m1, basis, spreadAt, valuePerPricePerLot, scale, isLevelExit, levelsAt } = params;

  const levelTrades = trades.filter((t) => isLevelExit?.(t.seq) ?? true);

  // The order log is authoritative. Clustering is only consulted when there is no log to read.
  const levels =
    levelsAt !== undefined
      ? null
      : (params.levels ?? inferBracketLevels(levelTrades, scale.mintick * 2));
  const levelSource: 'order-log' | 'clustered' | 'none' =
    levelsAt !== undefined ? 'order-log' : levels !== null ? 'clustered' : 'none';

  if (levelSource === 'none' || levelTrades.length === 0) {
    return {
      rows: [],
      assessed: 0,
      skipped: trades.length,
      trailing: 0,
      ambiguous: 0,
      levelSource,
      levels,
      phantomTargets: 0,
      missedStops: 0,
      netPnlDelta: 0,
      perFill: perFillFigures([], 0, scale),
      explanation:
        levelTrades.length === 0
          ? 'No resting-order exits to replay: this strategy closes at market, so there are no ' +
            'levels whose ordering within a bar could be ambiguous.'
          : 'The exits do not sit at two consistent distances from their entries, so the stop and ' +
            'target levels cannot be recovered from the run. A trailing or dynamic level needs an ' +
            'order log; inventing levels here would manufacture flips rather than find them.',
    };
  }

  const rows: ReplayRow[] = [];
  let skipped = trades.length - levelTrades.length;
  let trailing = 0;
  let ambiguous = 0;

  for (const t of levelTrades) {
    // Levels are re-read at every minute rather than fixed per trade, because an ATR or swing stop
    // moves while the position is open. A fixed bracket simply returns the same pair every time.
    const levelsFor =
      levelsAt ??
      ((trade: ReplayTrade): ResolvedLevels => ({
        stop:
          trade.side === 'long'
            ? trade.entryPrice - levels!.stopDistance
            : trade.entryPrice + levels!.stopDistance,
        target:
          trade.side === 'long'
            ? trade.entryPrice + levels!.targetDistance
            : trade.entryPrice - levels!.targetDistance,
        trailing: false,
        ambiguous: false,
        setOnBar: -1,
      }));

    const touch = firstTouch({
      trade: t,
      m1,
      basis,
      spreadAt,
      levelsFor,
      untilMs: t.exitMs + params.chartBarMs,
    });

    if (touch === 'no-bars') {
      skipped += 1;
      continue;
    }
    if (touch === 'trailing') {
      trailing += 1;
      skipped += 1;
      continue;
    }
    if (touch === 'ambiguous') {
      ambiguous += 1;
      skipped += 1;
      continue;
    }

    const engineWasFavourable =
      t.side === 'long' ? t.exitPrice > t.entryPrice : t.exitPrice < t.entryPrice;

    let flip: FlipKind = 'none';
    if (touch === null) {
      // Nothing was genuinely touched in the whole holding period, yet the engine closed the trade
      // at a level. If that level was the target, the run booked a win that never happened.
      flip = engineWasFavourable ? 'phantom-target' : 'none';
    } else if (touch.kind === 'stop' && engineWasFavourable) {
      // The stop was crossed first, on the correct side of the book, before the engine's target.
      flip = 'missed-stop';
    } else if (touch.kind === 'target' && !engineWasFavourable) {
      flip = 'none';
    }

    const truePrice = touch === null ? null : touch.price;
    const trueMs = touch === null ? null : touch.atMs;

    // Unchanged when nothing was touched: without replaying the strategy past the engine's exit we
    // cannot know where the trade would have ended, so the correction is left at zero and the flip
    // is reported on its own. Understating a correction is the safe direction.
    const priceDelta = truePrice === null ? 0 : truePrice - t.exitPrice;
    const direction = t.side === 'long' ? 1 : -1;
    const pnlDelta = priceDelta * direction * Math.abs(t.qty) * valuePerPricePerLot;

    rows.push({
      seq: t.seq,
      side: t.side,
      flip,
      enginePrice: t.exitPrice,
      engineMs: t.exitMs,
      truePrice,
      trueMs,
      priceDelta,
      netPnlReported: t.netPnl,
      netPnlCorrected: t.netPnl + pnlDelta,
    });
  }

  const flipped = rows.filter((r) => r.flip !== 'none');
  const netPnlDelta = rows.reduce((sum, r) => sum + (r.netPnlCorrected - r.netPnlReported), 0);

  return {
    rows,
    assessed: rows.length,
    skipped,
    trailing,
    ambiguous,
    levelSource,
    levels,
    phantomTargets: rows.filter((r) => r.flip === 'phantom-target').length,
    missedStops: rows.filter((r) => r.flip === 'missed-stop').length,
    netPnlDelta,
    perFill: perFillFigures(
      flipped.map((r) => r.priceDelta),
      netPnlDelta,
      scale,
    ),
    explanation:
      `Replayed ${String(rows.length)} resting-order exits on M1, with sells triggering on the bid ` +
      `and buys on the ask. ` +
      (levels === null
        ? 'Levels read from the order log, resolved per bar against each trade’s entry price.'
        : `Levels CLUSTERED from exit prices (no order log): stop ${levels.stopDistance.toFixed(5)}, ` +
          `target ${levels.targetDistance.toFixed(5)} from entry, ` +
          `${String(levels.outliers)} exit(s) matched neither.`) +
      (trailing > 0
        ? ` ${String(trailing)} trade(s) use a trailing stop and are n/a: a trail depends on the ` +
          'path taken since it armed, so replaying it as a fixed level would manufacture flips.'
        : '') +
      (ambiguous > 0
        ? ` ${String(ambiguous)} trade(s) had several exit ids in play with no way to tell which ` +
          'closed them, and are n/a for the same reason: pairing a fill with the wrong bracket ' +
          'would manufacture a flip.'
        : ''),
  };
}

interface TouchParams {
  readonly trade: ReplayTrade;
  readonly m1: readonly Bar[];
  readonly basis: PriceBasis;
  readonly spreadAt: (bar: Bar) => number;
  readonly levelsFor: (trade: ReplayTrade, atMs: number) => ResolvedLevels | null;
  /** Exclusive end of the holding period: the exit bar's CLOSE, not its open. */
  readonly untilMs: number;
}

interface Touch {
  readonly kind: 'stop' | 'target';
  readonly price: number;
  readonly atMs: number;
}

/**
 * The first level genuinely reached between entry and the engine's exit.
 *
 * `null` means neither was, which only happens when the engine's own exit was not real.
 * `'no-bars'` means the M1 series does not cover the period, which is a coverage problem rather
 * than a finding and is counted as skipped.
 *
 * When one M1 minute touches BOTH levels the stop wins. One minute of EURUSD is still a bar with
 * the same ambiguity a step up, and there is no deeper data to appeal to — so the tie goes to the
 * pessimistic reading, which is the only direction that cannot flatter a result.
 */
function firstTouch(p: TouchParams): Touch | null | 'no-bars' | 'trailing' | 'ambiguous' {
  const { trade, m1, basis, spreadAt, levelsFor, untilMs } = p;

  let index = lowerBound(m1, trade.entryMs);
  if (index >= m1.length || m1[index]!.time >= untilMs) return 'no-bars';

  for (; index < m1.length; index += 1) {
    const bar = m1[index]!;
    if (bar.time >= untilMs) break;

    const levels = levelsFor(trade, bar.time);
    // Before the strategy first armed its bracket there is nothing resting to hit.
    if (levels === null) continue;
    if (levels.trailing) return 'trailing';
    if (levels.ambiguous) return 'ambiguous';

    const q = deriveQuotes(bar, basis, spreadAt(bar));

    // Both of a long's exits are SELLS and fill on the bid; both of a short's are BUYS on the ask.
    const side = trade.side === 'long' ? q.bid : q.ask;

    const { stop, target } = levels;

    const stopHit = stop !== null && (trade.side === 'long' ? side.low <= stop : side.high >= stop);
    const targetHit =
      target !== null && (trade.side === 'long' ? side.high >= target : side.low <= target);

    if (stopHit) return { kind: 'stop', price: stop, atMs: bar.time };
    if (targetHit) return { kind: 'target', price: target, atMs: bar.time };
  }

  return null;
}

/** First index whose time is >= `ms`. The M1 series is long, so this is a binary search. */
function lowerBound(bars: readonly Bar[], ms: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid]!.time < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
