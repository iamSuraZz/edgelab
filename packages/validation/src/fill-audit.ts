import { accountMoney, type AccountMoney, type Lots, type Price } from '@edgelab/shared';

import { perFillFigures, type PerFillFigures } from './per-fill';

/**
 * Fill audit — do the fills the engine reported actually correspond to the bars they happened on?
 *
 * This is the check that would have caught several of the defects the verification sprint found by
 * hand. It asks three questions of every fill, and they escalate in severity:
 *
 *   1. Is the price INSIDE the bar's range? A fill outside `[low, high]` is not a strategy problem
 *      or a modelling choice — it is an engine bug or corrupt data, and nothing computed from it
 *      means anything. That is the only condition here that fails.
 *
 *   2. Did market fills land on a bar's OPEN? Our engine fills market orders at the next bar's open,
 *      so a fill strictly inside a bar is either a limit/stop fill or a divergence worth seeing.
 *      Counted, not judged: a stop-loss legitimately fills mid-bar.
 *
 *   3. Did a fill land exactly on a bar's EXTREME? Those are the dangerous ones. A limit or stop at
 *      a level the bar only just touched is recorded as filled, but in life the level has to be
 *      traded THROUGH, and a wick that grazes it may fill nobody. Spec 06 asks for these to be
 *      counted and for P&L to be recomputed as if one tick of penetration were required — so the
 *      report can say how much of the result rests on fills that might never have happened.
 *
 * Pure. No I/O.
 */

export interface AuditTrade {
  readonly seq: number;
  readonly side: 'long' | 'short';
  readonly qty: Lots;
  readonly entryBar: number;
  readonly entryPrice: Price;
  readonly exitBar: number;
  readonly exitPrice: Price;
  readonly netPnl: AccountMoney;
}

export interface AuditBar {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

/** A fill that sits outside the bar it claims to have happened on. */
export interface OutOfRangeFill {
  readonly tradeSeq: number;
  readonly leg: 'entry' | 'exit';
  readonly bar: number;
  readonly price: number;
  readonly low: number;
  readonly high: number;
  /** How far outside, in price units. Always positive. */
  readonly byPrice: number;
}

/** A fill exactly on a bar's high or low — filled on a touch rather than a penetration. */
export interface TouchFill {
  readonly tradeSeq: number;
  readonly leg: 'entry' | 'exit';
  readonly bar: number;
  readonly price: number;
  readonly extreme: 'high' | 'low';
}

export interface FillAuditResult {
  readonly fillsChecked: number;
  /** Fills the audit could not locate a bar for. */
  readonly fillsUnlocatable: number;
  readonly outOfRange: readonly OutOfRangeFill[];
  /** Fills exactly at a bar's open, consistent with next-bar-open market execution. */
  readonly atOpen: number;
  readonly touches: readonly TouchFill[];
  /**
   * Net P&L if every touch fill had required one tick of penetration.
   *
   * Computed by moving each touch fill one tick ADVERSE — the conservative reading, and the one
   * that answers "how much of this result depends on fills that might not have happened".
   */
  readonly netPnlIfPenetrationRequired: AccountMoney;
  readonly netPnlReported: AccountMoney;
  /** The penetration adjustment per touch fill, in pips and ticks. */
  readonly perFill: PerFillFigures;
}

export interface AuditFillsParams {
  readonly trades: readonly AuditTrade[];
  /** Indexed as `entryBar`/`exitBar` index them. */
  readonly bars: readonly AuditBar[];
  readonly mintick: number;
  /** One pip, for the per-fill figures. Defaults to ten ticks when omitted. */
  readonly pipSize?: number;
  /**
   * Account-currency value of ONE TICK for ONE unit of `AuditTrade.qty`.
   *
   * Named for its unit on purpose. `qty` on a costed trade is in LOTS, so multiplying a tick by it
   * gives 0.00001 × 1 — a number that rounds to nothing and makes the penetration figure look like
   * a rounding error instead of a dollar per fill. For a 5-digit FX pair at 100,000 per lot that is
   * `mintick × contractSize × pointValue` = 1.00. Getting this wrong once already produced a report
   * reading "would move net P&L by 0.00", and the same confusion was still live in the same-bar
   * estimate a session later — which is why `qty` above is branded now rather than commented.
   */
  readonly valuePerTickPerLot: number;
  /**
   * Price tolerance for the range test.
   *
   * Half a tick: prices go through resampling and a transpiler, so bit-exact comparison against a
   * bar extreme reports float noise as an engine bug. Anything beyond half a tick is a real move.
   */
  readonly tolerance?: number;
}

export function auditFills(params: AuditFillsParams): FillAuditResult {
  const tolerance = params.tolerance ?? params.mintick / 2;

  const outOfRange: OutOfRangeFill[] = [];
  const touches: TouchFill[] = [];
  let fillsChecked = 0;
  let fillsUnlocatable = 0;
  let atOpen = 0;
  let penetrationAdjustment = 0;
  let netPnlReported = 0;

  for (const trade of params.trades) {
    netPnlReported += trade.netPnl;

    const legs = [
      { leg: 'entry' as const, bar: trade.entryBar, price: trade.entryPrice },
      { leg: 'exit' as const, bar: trade.exitBar, price: trade.exitPrice },
    ];

    for (const { leg, bar: barIndex, price } of legs) {
      const bar = params.bars[barIndex];
      if (bar === undefined) {
        fillsUnlocatable += 1;
        continue;
      }
      fillsChecked += 1;

      if (price < bar.low - tolerance) {
        outOfRange.push({
          tradeSeq: trade.seq,
          leg,
          bar: barIndex,
          price,
          low: bar.low,
          high: bar.high,
          byPrice: bar.low - price,
        });
      } else if (price > bar.high + tolerance) {
        outOfRange.push({
          tradeSeq: trade.seq,
          leg,
          bar: barIndex,
          price,
          low: bar.low,
          high: bar.high,
          byPrice: price - bar.high,
        });
      }

      if (Math.abs(price - bar.open) <= tolerance) atOpen += 1;

      // A fill on the extreme is a touch. Checked after the range test so a fill that is BOTH out
      // of range and near an extreme is reported as the more serious of the two.
      const onHigh = Math.abs(price - bar.high) <= tolerance;
      const onLow = Math.abs(price - bar.low) <= tolerance;

      // An open that happens to equal the extreme is not a touch fill — a market order filled at
      // the open regardless of where the extreme fell.
      const isOpen = Math.abs(price - bar.open) <= tolerance;

      if (!isOpen && (onHigh || onLow)) {
        touches.push({
          tradeSeq: trade.seq,
          leg,
          bar: barIndex,
          price,
          extreme: onHigh ? 'high' : 'low',
        });

        /*
         * One tick adverse, in the direction that costs the trade.
         *
         * Buying (long entry, short exit) one tick higher costs one tick of value; selling one tick
         * lower costs the same. Both reduce P&L, which is why the adjustment is always negative —
         * the question being answered is how much worse the result could legitimately have been.
         */
        penetrationAdjustment -= params.valuePerTickPerLot * trade.qty;
      }
    }
  }

  return {
    fillsChecked,
    fillsUnlocatable,
    outOfRange,
    atOpen,
    touches,
    netPnlReported: accountMoney(netPnlReported),
    netPnlIfPenetrationRequired: accountMoney(netPnlReported + penetrationAdjustment),
    // One tick per touch fill by construction, so the pip figure is a constant for the instrument —
    // reported anyway so every execution-bias total is readable in the same units.
    perFill: perFillFigures(
      touches.map(() => params.mintick),
      Math.abs(penetrationAdjustment),
      { mintick: params.mintick, pipSize: params.pipSize ?? params.mintick * 10 },
    ),
  };
}
