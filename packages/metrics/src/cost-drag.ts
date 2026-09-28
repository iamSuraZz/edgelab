import type { CostedTrade } from '@edgelab/shared';
import { sum } from './stats';
import type { CostBucket, CostMetrics, MetricsInstrument } from './types';

/**
 * Cost analytics — the section that answers "is this edge real, or is it just not paying
 * for execution yet?".
 */

function bucket(values: readonly number[], tradeCount: number): CostBucket {
  const total = sum(values);
  return { total, perTrade: tradeCount > 0 ? total / tradeCount : null };
}

export function computeCostMetrics(
  trades: readonly CostedTrade[],
  instrument: MetricsInstrument,
  chargeableSides?: readonly number[],
): CostMetrics {
  const count = trades.length;

  const commission = bucket(
    trades.map((t) => t.commission),
    count,
  );
  const slippage = bucket(
    trades.map((t) => t.slippageCost),
    count,
  );
  const spread = bucket(
    trades.map((t) => t.spreadCost),
    count,
  );
  const slippageRefunded = bucket(
    trades.map((t) => t.slippageRefund),
    count,
  );
  const financing = bucket(
    trades.map((t) => t.financingCost),
    count,
  );

  // The refund is deliberately absent: it is not a cost that was charged and then returned, it is
  // an engine divergence corrected before net P&L. Including it here would break the identity
  // `grossBeforeCosts - totalCosts === netProfit`.
  const totalCosts = commission.total + slippage.total + spread.total + financing.total;
  const netProfit = sum(trades.map((t) => t.netPnl));
  const grossBeforeCosts = netProfit + totalCosts;

  // Costs as a share of what the strategy would have made with perfect execution. A zero
  // denominator (costs exactly cancel the gross) is genuinely undefined.
  const costDragPct = grossBeforeCosts === 0 ? null : (totalCosts / grossBeforeCosts) * 100;

  const breakEven = breakEvenPerSide(trades, instrument, netProfit, chargeableSides);

  return {
    commission,
    slippage,
    slippageRefunded,
    spread,
    financing,
    totalCosts,
    costDragPct,
    grossBeforeCosts,
    ...breakEven,
  };
}

/**
 * How much worse execution can get, PER SIDE, before the edge disappears.
 *
 *   breakEven = netProfit / (2 * totalUnits * pointValue)
 *
 * NOTE (interpretation, flagged): the spec writes "sum of |qty| * pointValue". `qty` is
 * ambiguous between lots and units, and only the units reading yields a PRICE, which is
 * what the spec then asks to be displayed "in price units, ticks and pips". So qty is
 * converted to units via contractSize. Reading it as lots would give a number ~100,000x too
 * large and meaningless as a price.
 *
 * The factor of 2 WAS because the cost is paid on entry and exit. It is now a per-trade count: a
 * bracket exit that filled on a limit cannot be slipped, so that trade has one chargeable side, not
 * two. Assuming two would understate how far execution can degrade before the edge dies.
 */
function breakEvenPerSide(
  trades: readonly CostedTrade[],
  instrument: MetricsInstrument,
  netProfit: number,
  chargeableSides?: readonly number[],
): Pick<CostMetrics, 'breakEvenPerSidePrice' | 'breakEvenPerSideTicks' | 'breakEvenPerSidePips'> {
  // Sides are counted per trade rather than assumed to be two, because a limit fill cannot slip and
  // so cannot degrade. Falls back to two per trade when the caller did not measure the fill mix.
  const denominator =
    sum(
      trades.map((t, i) => (chargeableSides?.[i] ?? 2) * Math.abs(t.qty) * instrument.contractSize),
    ) * instrument.pointValue;

  if (denominator === 0 || !Number.isFinite(denominator)) {
    return {
      breakEvenPerSidePrice: null,
      breakEvenPerSideTicks: null,
      breakEvenPerSidePips: null,
    };
  }

  const price = netProfit / denominator;

  return {
    breakEvenPerSidePrice: price,
    breakEvenPerSideTicks: instrument.mintick > 0 ? price / instrument.mintick : null,
    breakEvenPerSidePips: instrument.pipSize > 0 ? price / instrument.pipSize : null,
  };
}
