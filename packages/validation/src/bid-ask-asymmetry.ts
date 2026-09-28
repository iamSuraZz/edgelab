import { blankCommentsAndStrings } from './static-lint';

import {
  fillSide,
  quoteFor,
  type AccountMoney,
  type Lots,
  type Price,
  type PriceBasis,
} from '@edgelab/shared';

/**
 * Bid/ask asymmetry at stop and target levels (spec 06 §2).
 *
 * A stop or a target is a resting order, so it triggers when a QUOTE reaches it — not when the
 * stored price does. Which quote depends on the direction of the closing fill: a long's exit is a
 * SELL and triggers on the bid, a short's exit is a BUY and triggers on the ask.
 *
 * The engine has only one number per bar, so it triggers every level off that number. How wrong
 * that is depends entirely on the feed's basis:
 *
 *   - **bid feed** — the stored price IS the bid, so long-side levels are exact and SHORT-side
 *     levels are off by a full spread. That is the asymmetry the check is named for: on a bid feed
 *     the error falls entirely on one side of the book.
 *   - **mid feed** — neither side is the stored price, so EVERY level is off by half a spread. The
 *     total error is the same; it is just distributed evenly instead of landing on the shorts.
 *
 * THE ERROR IS ALWAYS ADVERSE, which is what makes it worth checking rather than merely noting. A
 * target becomes harder to reach and a stop becomes easier, on both sides, on every basis — the
 * spread never pays you. So a backtest that looks profitable partly because its targets filled is
 * being flattered, and the size of the flattery is what this quantifies.
 *
 * Pure. The caller resolves the spread (the cost overlay owns that policy) and says which exits
 * were levels at all; without that, market exits would be scored as if they were resting orders.
 */

export interface LevelExitTrade {
  readonly seq: number;
  readonly side: 'long' | 'short';
  readonly qty: Lots;
  readonly entryPrice: Price;
  readonly exitPrice: Price;
  readonly exitBar: number;
  readonly netPnl: AccountMoney;
}

export interface AsymmetryBar {
  readonly high: number;
  readonly low: number;
}

/** A stop and a target differ only in which side of the entry they sit on. */
export type LevelKind = 'stop' | 'target';

export interface AsymmetryRow {
  readonly seq: number;
  readonly side: 'long' | 'short';
  readonly kind: LevelKind;
  /** The closing fill's direction, which is what picks the quote side. */
  readonly exitAction: 'buy' | 'sell';
  readonly quoteSide: 'bid' | 'ask';
  /** The level as the run used it. */
  readonly modelledPrice: number;
  /**
   * Where the stored price must reach for the correct quote to touch the level.
   *
   * Compared against the bar's own range, this is what decides whether the exit happened at all.
   */
  readonly requiredStoredPrice: number;
  /** How far the level moved, in price units. Always adverse, so always reported positive. */
  readonly priceError: number;
  /** `priceError` as money on this position. Positive means the run was flattered. */
  readonly accountError: number;
  /**
   * True when the bar never reached `requiredStoredPrice`, so the exit would not have triggered on
   * the correct side of the book at all and the trade's outcome is not merely mispriced but wrong.
   */
  readonly outcomeFlips: boolean;
}

export interface AsymmetryParams {
  readonly trades: readonly LevelExitTrade[];
  /** Indexed as `exitBar` indexes them. */
  readonly bars: readonly AsymmetryBar[];
  readonly basis: PriceBasis;
  /** Resolved spread in PRICE units at a bar — the cost overlay's `spreadPriceAt`. */
  readonly spreadAt: (barIndex: number) => number;
  /** Account-currency value of one price unit on one lot: `contractSize x pointValue x rate`. */
  readonly valuePerPricePerLot: number;
  /**
   * Which exits were resting orders. A market exit fills wherever the market is and carries no
   * level error, so scoring it here would invent a cost that does not exist.
   *
   * Omit it and NOTHING is assessed — the check reports `n/a` rather than assuming, because
   * assuming every exit is a stop is exactly how a check starts reporting confident nonsense.
   */
  readonly isLevelExit?: (seq: number) => boolean;
}

export interface AsymmetryResult {
  readonly rows: readonly AsymmetryRow[];
  readonly basis: PriceBasis;
  /** Level exits assessed. */
  readonly assessed: number;
  /** Trades skipped because they were not level exits, or had no bar. */
  readonly skipped: number;
  /** Sum of `accountError` — the total by which levels flattered the run. */
  readonly totalAccountError: AccountMoney;
  /** Trades whose exit would not have triggered at all on the correct quote side. */
  readonly flips: number;
  /** Null when nothing could be assessed, which is the `n/a` signal. */
  readonly meanAccountError: number | null;
  readonly explanation: string;
}

/**
 * Where the stored price sits relative to the quote a level triggers on.
 *
 * Derived from `quoteFor` rather than re-deriving the basis arithmetic, so the two cannot drift
 * apart: a change to how a mid feed straddles its spread shows up here automatically.
 */
function quoteOffset(basis: PriceBasis, quoteSide: 'bid' | 'ask', spread: number): number {
  const q = quoteFor(0, basis, spread);
  return quoteSide === 'bid' ? q.bid : q.ask;
}

export function checkBidAskAsymmetry(params: AsymmetryParams): AsymmetryResult {
  const { trades, bars, basis, spreadAt, valuePerPricePerLot, isLevelExit } = params;

  const rows: AsymmetryRow[] = [];
  let skipped = 0;

  for (const t of trades) {
    const bar = bars[t.exitBar];
    if (bar === undefined || !(isLevelExit?.(t.seq) ?? false)) {
      skipped += 1;
      continue;
    }

    const exitAction = t.side === 'long' ? 'sell' : 'buy';
    const quoteSide = fillSide(exitAction);
    const spread = spreadAt(t.exitBar);
    const offset = quoteOffset(basis, quoteSide, spread);

    // The quote sits `offset` away from the stored price, so for the quote to reach the level the
    // stored price must reach `level - offset`.
    const requiredStoredPrice = t.exitPrice - offset;
    const priceError = Math.abs(offset);

    // A long exiting ABOVE its entry took a target; below, a stop. Same for a short, mirrored.
    const favourable = t.side === 'long' ? t.exitPrice > t.entryPrice : t.exitPrice < t.entryPrice;
    const kind: LevelKind = favourable ? 'target' : 'stop';

    // Did the bar actually get there? A target needs the stored price to run FURTHER in the
    // favourable direction; a stop triggers earlier, so it always still triggers.
    const reached =
      kind === 'stop'
        ? true
        : t.side === 'long'
          ? bar.high >= requiredStoredPrice
          : bar.low <= requiredStoredPrice;

    rows.push({
      seq: t.seq,
      side: t.side,
      kind,
      exitAction,
      quoteSide,
      modelledPrice: t.exitPrice,
      requiredStoredPrice,
      priceError,
      accountError: priceError * Math.abs(t.qty) * valuePerPricePerLot,
      outcomeFlips: !reached,
    });
  }

  const totalAccountError = rows.reduce((sum, r) => sum + r.accountError, 0);
  const flips = rows.filter((r) => r.outcomeFlips).length;

  return {
    rows,
    basis,
    assessed: rows.length,
    skipped,
    totalAccountError: totalAccountError as AccountMoney,
    flips,
    meanAccountError: rows.length === 0 ? null : totalAccountError / rows.length,
    explanation: explain(basis, rows.length),
  };
}

function explain(basis: PriceBasis, assessed: number): string {
  if (assessed === 0) {
    return (
      'No level exits to assess. Either this strategy closes at market, or the run did not record ' +
      'which exits were resting orders — a market fill carries no level error, so nothing is ' +
      'assumed here.'
    );
  }
  if (basis === 'bid') {
    return (
      'Stored prices are bids, so long-side levels are exact and every SHORT-side stop and target ' +
      'is off by a full spread: a short exits by BUYING, which happens at the ask.'
    );
  }
  const noun = basis === 'last' ? 'last-traded prices, treated as mid' : 'mids';
  return (
    `Stored prices are ${noun}, so EVERY stop and target is off by half a spread — long exits sell ` +
    'into the bid, half a spread below, and short exits buy at the ask, half a spread above.'
  );
}

/**
 * The order ids that `strategy.exit` creates, which are the only exits that rest in the book.
 *
 * A trade's exit reason is the id of whatever order closed it. A reversal closes with the OPPOSING
 * ENTRY's id and fills at market; a `strategy.exit` bracket closes with its own id and fills at a
 * level. Reading the ids out of the source is what separates the two without guessing from prices.
 *
 * Comments and string literals are blanked first (offsets preserved), so a `strategy.exit` inside a
 * comment is not mistaken for a real one. An id given as a VARIABLE cannot be resolved statically
 * and is deliberately not returned: the check then skips those exits and says so, which is better
 * than assuming they were levels.
 */
export function levelExitIdsFromSource(source: string): Set<string> {
  const blanked = blankCommentsAndStrings(source);
  const ids = new Set<string>();

  const call = /\bstrategy\s*\.\s*exit\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = call.exec(blanked)) !== null) {
    // Read the first argument from the ORIGINAL source: the blanked copy has its quotes emptied.
    const argStart = m.index + m[0].length;
    const id = firstStringArgument(source.slice(argStart, argStart + 200));
    if (id !== null) ids.add(id);
  }

  return ids;
}

/** The first positional or `id=` argument of a call, when it is a literal string. */
function firstStringArgument(text: string): string | null {
  const literal = /^\s*(?:id\s*=\s*)?(["'])([^"']*)\1/.exec(text);
  return literal?.[2] ?? null;
}
