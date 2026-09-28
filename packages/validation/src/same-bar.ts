import { lotsToUnits, type Lots, type Units } from '@edgelab/shared';

/**
 * Same-bar execution bias, estimated analytically rather than re-run.
 *
 * Spec 06 wanted this measured by re-running the strategy with `process_orders_on_close` flipped
 * and diffing the two results. That is not possible: the engine ignores that flag and its
 * siblings entirely, so the "with the flag on" run would be byte-identical to the "with it off"
 * run and the check would report a reassuring zero forever. A check that cannot fail is worse
 * than no check.
 *
 * So this quantifies the gap directly instead. We fill a market order at the NEXT bar's open;
 * TradingView with `process_orders_on_close=true` fills at the SIGNAL bar's close. The difference
 * between those two prices, times the position size, is the bias — per fill, and summed.
 *
 * It is an ESTIMATE and says so. It holds the strategy's decisions fixed, whereas a real
 * same-bar run could take different decisions once its equity diverges. It is therefore a lower
 * bound on the disagreement, and its value is the order of magnitude: "this result depends on
 * two ticks of slippage per trade" is a different conclusion from "this is robust to it".
 *
 * Pure. No I/O, no clock.
 */

/** One market fill to assess. */
export interface MarketFill {
  /** Identifies the fill in the report, e.g. `t7 entry`. */
  readonly label: string;
  /**
   * Index into `bars` of the bar we filled on — the bar AFTER the signal.
   *
   * A fill on bar 0 has no preceding bar and so no comparable same-bar price; those are reported
   * as unassessable rather than silently scored zero.
   */
  readonly fillBar: number;
  /** The price we actually filled at. Usually `bars[fillBar].open`. */
  readonly fillPrice: number;
  /**
   * Position size in UNITS (contracts), because `pointValue` below is per unit.
   *
   * Branded after this was wrong in production: the caller passed a CostedTrade's `qty`, which is
   * in LOTS, so every estimate came out 100,000x too small and the report read "-0.00". A `Lots`
   * value no longer compiles here.
   */
  readonly qty: Units;
  /**
   * Which way the fill went.
   *
   * `buy` covers a long entry and a short exit; `sell` covers a short entry and a long exit.
   * The distinction is the whole sign convention: paying more is worse when buying, receiving
   * less is worse when selling.
   */
  readonly direction: 'buy' | 'sell';
}

export interface FillBiasRow {
  readonly label: string;
  readonly fillBar: number;
  /** Where we filled. */
  readonly ourPrice: number;
  /** Where a same-bar fill would have gone: the signal bar's close. */
  readonly sameBarPrice: number;
  /** Signed price difference, positive when our price was worse. */
  readonly priceGap: number;
  /** `priceGap` as money in the account currency, positive when our fill cost us. */
  readonly accountCost: number;
}

export interface SameBarBiasEstimate {
  readonly rows: readonly FillBiasRow[];
  /** Sum of `accountCost`. Positive means our execution was worse in total. */
  readonly totalAccountCost: number;
  /** Fills that could be assessed. */
  readonly assessed: number;
  /** Fills skipped because they had no preceding bar. */
  readonly unassessable: number;
  /** Mean cost per assessed fill, or null when nothing could be assessed. */
  readonly meanAccountCost: number | null;
  /** Always true: this is an estimate under fixed decisions, never a re-run. */
  readonly isEstimate: true;
  /** The sentence the report shows verbatim. */
  readonly warning: string;
}

export interface SameBarBiasParams {
  readonly fills: readonly MarketFill[];
  /** The run's bars, indexed as `fillBar` indexes them. */
  readonly bars: readonly { readonly open: number; readonly close: number }[];
  /** Quote-currency value of one price unit for one contract. */
  readonly pointValue: number;
  /** Quote -> account rate. Pass `() => 1` when they are the same currency. */
  readonly rateAt: (fillBar: number) => number;
}

export const SAME_BAR_WARNING =
  'Estimated, not re-run: the engine ignores process_orders_on_close, so a same-bar run would be ' +
  'identical to this one. These figures hold the strategy’s decisions fixed and price only the ' +
  'fill difference, so they are a lower bound on the disagreement.';

export function estimateSameBarBias(params: SameBarBiasParams): SameBarBiasEstimate {
  const rows: FillBiasRow[] = [];
  let unassessable = 0;

  for (const fill of params.fills) {
    const signalBar = params.bars[fill.fillBar - 1];
    if (fill.fillBar <= 0 || signalBar === undefined) {
      unassessable += 1;
      continue;
    }

    const sameBarPrice = signalBar.close;

    // Positive = worse for us. Buying above the same-bar price costs; selling below it costs.
    const priceGap =
      fill.direction === 'buy' ? fill.fillPrice - sameBarPrice : sameBarPrice - fill.fillPrice;

    rows.push({
      label: fill.label,
      fillBar: fill.fillBar,
      ourPrice: fill.fillPrice,
      sameBarPrice,
      priceGap,
      accountCost: priceGap * Math.abs(fill.qty) * params.pointValue * params.rateAt(fill.fillBar),
    });
  }

  const totalAccountCost = rows.reduce((sum, r) => sum + r.accountCost, 0);

  return {
    rows,
    totalAccountCost,
    assessed: rows.length,
    unassessable,
    meanAccountCost: rows.length === 0 ? null : totalAccountCost / rows.length,
    isEstimate: true,
    warning: SAME_BAR_WARNING,
  };
}

/**
 * Derive the market fills of a run from its closed trades.
 *
 * Takes `contractSize` because a trade's `qty` is in LOTS and a fill's is in UNITS. That conversion
 * used to be absent, which is what made every estimate 100,000x too small.
 *
 * Both legs of every trade, because both are market fills under the fixtures we ship. A strategy
 * using limit or stop orders fills at its own level rather than the next open, so those legs are
 * not comparable this way — the caller passes `isMarketFill` to exclude them.
 */
export function marketFillsFromTrades(
  contractSize: number,
  trades: readonly {
    readonly seq: number;
    readonly side: 'long' | 'short';
    readonly qty: Lots;
    readonly entryBar: number;
    readonly entryPrice: number;
    readonly exitBar: number;
    readonly exitPrice: number;
  }[],
  isMarketFill?: (seq: number, leg: 'entry' | 'exit') => boolean,
): MarketFill[] {
  const fills: MarketFill[] = [];

  for (const t of trades) {
    const entryDirection = t.side === 'long' ? 'buy' : 'sell';

    if (isMarketFill?.(t.seq, 'entry') ?? true) {
      fills.push({
        label: `t${String(t.seq)} entry`,
        fillBar: t.entryBar,
        fillPrice: t.entryPrice,
        qty: lotsToUnits(t.qty, contractSize),
        direction: entryDirection,
      });
    }
    if (isMarketFill?.(t.seq, 'exit') ?? true) {
      fills.push({
        label: `t${String(t.seq)} exit`,
        fillBar: t.exitBar,
        fillPrice: t.exitPrice,
        qty: lotsToUnits(t.qty, contractSize),
        // Closing reverses the direction: a long is sold to close.
        direction: entryDirection === 'buy' ? 'sell' : 'buy',
      });
    }
  }

  return fills;
}
