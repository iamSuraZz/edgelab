import type { Bar, ResolvedLevels, SymbolSpec } from '@edgelab/shared';

import type { EngineTrade } from './pine-engine';

/**
 * Slippage MEASURED per fill, by comparing each fill against the price it would have had without
 * slippage.
 *
 * This replaces `2 x slippagePoints x mintick x units`, which was a formula with an assumption
 * inside it — "both fills slip" — stated as a comment and never checked. Two things were wrong with
 * that. The waterfall's slippage line was a nominal figure rather than the amount actually charged,
 * so the costs shown could differ from the costs taken. And an aggregate P&L swing cannot separate
 * slippage-per-fill from the changed trade set that slippage itself causes, so no amount of
 * before-and-after arithmetic settles which fills slip.
 *
 * The reference price for each fill is the price the order would have transacted at with slippage
 * switched off:
 *
 *   - **market** — the bar's open, which is where a market order fills.
 *   - **stop / limit** — the resting LEVEL, because that is what a stop or a limit fills at. Unless
 *     the bar opened beyond it: a gap through a level fills at the open, and the distance from the
 *     level to the open is a gap, not slippage.
 *
 * Slippage is signed ADVERSE-POSITIVE throughout: paying more to buy and receiving less to sell are
 * both positive. A negative figure means the fill was better than its reference, which should not
 * happen and is worth seeing if it does.
 *
 * Pure.
 */

export type FillType = 'market' | 'stop' | 'limit' | 'unknown';

export interface FillSlippage {
  readonly tradeSeq: number;
  readonly leg: 'entry' | 'exit';
  readonly type: FillType;
  /** `buy` or `sell`, which decides the sign convention. */
  readonly action: 'buy' | 'sell';
  readonly bar: number;
  readonly fillPrice: number;
  /** Where the fill would have landed with slippage off. */
  readonly reference: number;
  /** Adverse-positive difference, in price units. */
  readonly slippagePrice: number;
  /** True when the bar opened beyond the level, so the reference is the open rather than the level. */
  readonly gapped: boolean;
}

export interface MeasureSlippageParams {
  readonly trades: readonly EngineTrade[];
  readonly bars: readonly Bar[];
  readonly symbol: SymbolSpec;
  /**
   * The resting levels in force for a trade's exit, from the order log.
   *
   * Omit it and every fill is classified `market`, which is correct for a strategy that closes at
   * market and wrong for a bracket — so the caller that HAS an order log should always pass it.
   */
  readonly exitLevelsFor?: (trade: EngineTrade, seq: number) => ResolvedLevels | null;
  /**
   * True when some entry order carried a `limit` or `stop` argument anywhere in the run.
   *
   * Entry legs are then classified `unknown` rather than assumed to be market fills. Every fixture
   * this repo ships enters at market, so in practice this is false and entries are known.
   */
  readonly entriesMayRest?: boolean;
}

export function measureFillSlippage(params: MeasureSlippageParams): FillSlippage[] {
  const { trades, bars, exitLevelsFor, entriesMayRest } = params;
  const out: FillSlippage[] = [];

  trades.forEach((trade, i) => {
    const seq = i + 1;
    if (trade.status !== 'closed' || trade.exitPrice === null || trade.exitBar === null) return;

    const entryAction = trade.side === 'long' ? 'buy' : 'sell';
    const exitAction = trade.side === 'long' ? 'sell' : 'buy';

    const entryBar = bars[trade.entryBar];
    if (entryBar !== undefined) {
      out.push(
        row({
          tradeSeq: seq,
          leg: 'entry',
          type: entriesMayRest === true ? 'unknown' : 'market',
          action: entryAction,
          bar: trade.entryBar,
          fillPrice: trade.entryPrice,
          reference: entryBar.open,
          gapped: false,
        }),
      );
    }

    const exitBar = bars[trade.exitBar];
    if (exitBar === undefined) return;

    const levels = exitLevelsFor?.(trade, seq) ?? null;
    const classified = classifyExit(trade, levels);

    out.push(
      row({
        tradeSeq: seq,
        leg: 'exit',
        type: classified.type,
        action: exitAction,
        bar: trade.exitBar,
        fillPrice: trade.exitPrice,
        reference: classified.level === null ? exitBar.open : referenceFor(classified, exitBar),
        gapped: classified.level !== null && gappedThrough(classified, exitBar),
      }),
    );
  });

  return out;
}

interface Classified {
  readonly type: FillType;
  readonly level: number | null;
  /** Which way price had to move to reach the level. */
  readonly direction: 'up' | 'down';
}

/**
 * Which resting order closed the trade.
 *
 * WHETHER it was a resting order at all is decided by the caller, from the exit ID — the order log
 * records which order closed each trade, so a reversal or a margin call arrives here with no levels
 * and is a market fill. WHICH of the two levels fired is then simply the nearer one: a long's target
 * is always above its stop, so there is nothing to confuse.
 *
 * An earlier version also demanded the fill be within five ticks of its level, and that was wrong in
 * a way that hid the answer it was built to find: with fifteen ticks of slippage configured, every
 * slipped limit fill missed the tolerance and was reclassified as a market fill. The run then
 * reported ZERO limit fills on a bracket strategy, and market fills averaging -25 ticks, because
 * their reference had silently become the bar open. Proximity cannot identify a fill when the thing
 * being measured is how far the fill moved.
 */
function classifyExit(trade: EngineTrade, levels: ResolvedLevels | null): Classified {
  const exitPrice = trade.exitPrice as number;
  const long = trade.side === 'long';

  if (levels === null || levels.ambiguous || levels.trailing) {
    return { type: 'market', level: null, direction: long ? 'down' : 'up' };
  }

  const dStop = levels.stop === null ? Infinity : Math.abs(exitPrice - levels.stop);
  const dTarget = levels.target === null ? Infinity : Math.abs(exitPrice - levels.target);

  if (!Number.isFinite(dStop) && !Number.isFinite(dTarget)) {
    return { type: 'market', level: null, direction: long ? 'down' : 'up' };
  }

  return dStop <= dTarget
    ? { type: 'stop', level: levels.stop, direction: long ? 'down' : 'up' }
    : { type: 'limit', level: levels.target, direction: long ? 'up' : 'down' };
}

/** True when the bar's open was already past the level, so the fill happened at the open. */
function gappedThrough(c: Classified, bar: Bar): boolean {
  if (c.level === null) return false;
  return c.direction === 'up' ? bar.open >= c.level : bar.open <= c.level;
}

function referenceFor(c: Classified, bar: Bar): number {
  return gappedThrough(c, bar) ? bar.open : (c.level as number);
}

function row(r: Omit<FillSlippage, 'slippagePrice'>): FillSlippage {
  // Adverse-positive: buying above the reference costs, selling below it costs.
  const slippagePrice = r.action === 'buy' ? r.fillPrice - r.reference : r.reference - r.fillPrice;
  return { ...r, slippagePrice };
}

/* -------------------------------------------------------------- summary */

export interface SlippageByType {
  readonly type: FillType;
  readonly fills: number;
  readonly totalPrice: number;
  readonly meanPrice: number;
  readonly meanTicks: number;
  /** Fills whose measured slippage is more than half a tick. */
  readonly slipped: number;
}

export function summariseSlippage(
  rows: readonly FillSlippage[],
  mintick: number,
): SlippageByType[] {
  const types: FillType[] = ['market', 'stop', 'limit', 'unknown'];

  return types
    .map((type) => {
      const mine = rows.filter((r) => r.type === type);
      const totalPrice = mine.reduce((sum, r) => sum + r.slippagePrice, 0);
      const meanPrice = mine.length === 0 ? 0 : totalPrice / mine.length;
      return {
        type,
        fills: mine.length,
        totalPrice,
        meanPrice,
        meanTicks: mintick > 0 ? meanPrice / mintick : 0,
        slipped: mine.filter((r) => Math.abs(r.slippagePrice) > mintick / 2).length,
      };
    })
    .filter((r) => r.fills > 0);
}

/** Total measured slippage for one trade, in PRICE units. */
export function slippageForTrade(rows: readonly FillSlippage[], tradeSeq: number): number {
  return rows.reduce((sum, r) => (r.tradeSeq === tradeSeq ? sum + r.slippagePrice : sum), 0);
}
