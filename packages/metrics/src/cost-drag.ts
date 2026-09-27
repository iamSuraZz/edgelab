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
  const financing = bucket(
    trades.map((t) => t.financingCost),
    count,
  );

  const totalCosts = commission.total + slippage.total + spread.total + financing.total;
  const netProfit = sum(trades.map((t) => t.netPnl));
  const grossBeforeCosts = netProfit + totalCosts;

  // Costs as a share of what the strategy would have made with perfect execution. A zero
  // denominator (costs exactly cancel the gross) is genuinely undefined.
  const costDragPct = grossBeforeCosts === 0 ? null : (totalCosts / grossBeforeCosts) * 100;

  const breakEven = breakEvenPerSide(trades, instrument, netProfit);

  return {
    commission,
    slippage,
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
 * The factor of 2 is because the cost is paid on entry AND exit.
 */
function breakEvenPerSide(
  trades: readonly CostedTrade[],
  instrument: MetricsInstrument,
  netProfit: number,
): Pick<CostMetrics, 'breakEvenPerSidePrice' | 'breakEvenPerSideTicks' | 'breakEvenPerSidePips'> {
  const totalUnits = sum(trades.map((t) => Math.abs(t.qty) * instrument.contractSize));
  const denominator = 2 * totalUnits * instrument.pointValue;

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
