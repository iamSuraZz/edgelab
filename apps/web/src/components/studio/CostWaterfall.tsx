import type { CostMetrics } from '@edgelab/metrics';

import { formatCurrency } from '@/lib/format';

/**
 * Gross to net, one cost at a time (spec 05).
 *
 * What is checked here, and what deliberately is NOT.
 *
 * `grossBeforeCosts - totalCosts === netProfit` is NOT worth asserting: `grossBeforeCosts` is
 * computed upstream as `netProfit + totalCosts`, so that identity holds by construction and a badge
 * claiming it verifies nothing. What CAN fail is whether the rows drawn here are the ones that make
 * up `totalCosts` - add a fifth cost category upstream without adding a row, and this waterfall
 * would quietly under-report while still looking balanced. That is the residual checked below.
 *
 * The REFUND rides on the slippage row, not a step of its own (A29). `slippage.total` is ALREADY
 * net of it - the refund is an engine-divergence correction applied before net P&L, not a cost
 * charged and returned - so adding it as a separate credit double-counts it. The first version of
 * this component did exactly that, and its running total overshot net by the refunded amount.
 */

export function CostWaterfall({
  costs,
  netProfit,
  currency,
}: {
  readonly costs: CostMetrics;
  readonly netProfit: number;
  readonly currency: string;
}): React.JSX.Element {
  const refunded = costs.slippageRefunded.total;

  const steps: {
    label: string;
    amount: number;
    perTrade: number | null;
    note?: string;
  }[] = [
    { label: 'Commission', amount: -costs.commission.total, perTrade: costs.commission.perTrade },
    {
      label: 'Slippage',
      amount: -costs.slippage.total,
      perTrade: costs.slippage.perTrade,
      ...(refunded === 0
        ? {}
        : { note: `net of ${formatCurrency(refunded, currency)} refunded on limit fills` }),
    },
    { label: 'Spread', amount: -costs.spread.total, perTrade: costs.spread.perTrade },
    { label: 'Funding', amount: -costs.financing.total, perTrade: costs.financing.perTrade },
  ];

  // The scale is the largest bar, so gross usually sets it and the cost slivers stay in proportion.
  const scale = Math.max(
    Math.abs(costs.grossBeforeCosts),
    Math.abs(netProfit),
    ...steps.map((s) => Math.abs(s.amount)),
    1e-9,
  );

  /*
   * Do the rows shown account for every cost counted?
   *
   * Summing the DRAWN steps against `totalCosts`, rather than re-deriving an identity that is true
   * by construction. A cent of float drift is fine; more means a cost exists upstream that this
   * breakdown does not show.
   */
  const shown = steps.reduce((acc, step) => acc + Math.abs(step.amount), 0);
  const residual = shown - costs.totalCosts;
  const balances = Math.abs(residual) < 0.01;

  let running = costs.grossBeforeCosts;

  return (
    <div className="space-y-2" data-testid="cost-waterfall">
      <Row
        label="Gross before costs"
        amount={costs.grossBeforeCosts}
        scale={scale}
        currency={currency}
        emphasis
      />

      {steps.map((s) => {
        running += s.amount;
        return (
          <Row
            key={s.label}
            label={s.label}
            amount={s.amount}
            perTrade={s.perTrade}
            {...(s.note === undefined ? {} : { note: s.note })}
            runningTotal={running}
            scale={scale}
            currency={currency}
          />
        );
      })}

      <Row label="Net profit" amount={netProfit} scale={scale} currency={currency} emphasis />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-2 text-xs">
        <span className="text-muted">
          Total costs{' '}
          <strong className="text-foreground tabular-nums">
            {formatCurrency(costs.totalCosts, currency)}
          </strong>
        </span>
        <span className="text-muted">
          Cost drag{' '}
          <strong className="text-foreground tabular-nums">
            {costs.costDragPct === null ? '—' : `${costs.costDragPct.toFixed(2)}%`}
          </strong>
        </span>

        {balances ? (
          <span className="text-emerald-300" data-testid="waterfall-balances">
            rows account for every counted cost ✓
          </span>
        ) : (
          <span className="text-rose-300" data-testid="waterfall-imbalance">
            The rows above sum to {formatCurrency(shown, currency)} against a counted{' '}
            {formatCurrency(costs.totalCosts, currency)} - a cost is counted but not shown.
          </span>
        )}
      </div>

      {refunded !== 0 && (
        <p
          className="text-[0.65rem] leading-relaxed text-muted"
          data-testid="waterfall-refund-note"
        >
          The slippage row is already net of {formatCurrency(refunded, currency)} refunded on limit
          fills. This engine slips limit orders, which TradingView never does, so the measured
          amount is credited back as a correction rather than charged (A29) - a limit order cannot
          fill worse than its price.
        </p>
      )}
    </div>
  );
}

function Row({
  label,
  amount,
  perTrade,
  note,
  runningTotal,
  scale,
  currency,
  emphasis = false,
}: {
  readonly label: string;
  readonly amount: number;
  /** Null when undefined — a per-trade average of no trades is not zero. */
  readonly perTrade?: number | null;
  readonly note?: string;
  readonly runningTotal?: number;
  readonly scale: number;
  readonly currency: string;
  readonly emphasis?: boolean;
}): React.JSX.Element {
  const width = Math.max(1, (Math.abs(amount) / scale) * 100);
  const negative = amount < 0;

  return (
    <div className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-2 text-xs">
      <span className={emphasis ? 'font-medium' : 'text-muted'}>
        {label}
        {perTrade != null && perTrade !== 0 && (
          <span className="ml-1 text-[0.65rem] text-muted">
            ({formatCurrency(perTrade, currency)}/trade)
          </span>
        )}
        {note !== undefined && (
          <span className="block text-[0.65rem] text-amber-300/80">{note}</span>
        )}
      </span>

      <span className="h-3 overflow-hidden rounded-sm bg-surface-hover">
        <span
          className={`block h-full ${negative ? 'bg-rose-500/60' : 'bg-emerald-500/60'}`}
          style={{ width: `${String(width)}%` }}
        />
      </span>

      <span className="text-right tabular-nums">
        <span className={negative ? 'text-rose-300' : 'text-emerald-300'}>
          {formatCurrency(amount, currency)}
        </span>
        {runningTotal !== undefined && (
          <span className="ml-2 text-[0.65rem] text-muted">
            → {formatCurrency(runningTotal, currency)}
          </span>
        )}
      </span>
    </div>
  );
}
