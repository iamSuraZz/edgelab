import { Figure, Withheld } from './Withheld';

/**
 * Profit by the regime in force when each trade OPENED (A24).
 *
 * The unclassified share is shown as prominently as the buckets, because a breakdown covering half
 * the run reads exactly like a complete account of it. With a 252-session volatility lookback a
 * six-month test is entirely unclassified, and that is the honest output rather than a reason to
 * shorten the lookback until numbers appear (A40).
 */

export interface RegimeBucketView {
  readonly regime: string;
  readonly trades: number;
  readonly netProfit: number;
  readonly winRatePct: number | null;
  readonly sharePct: number;
}

export interface RegimeTableProps {
  readonly buckets: readonly RegimeBucketView[];
  readonly totalTrades: number;
  readonly unclassifiedPct: number;
  readonly unclassifiedDaysPct: number;
  readonly explanation: string;
  readonly currency: string;
}

const LABEL: Record<string, string> = {
  'trending-up': 'Trending up',
  'trending-down': 'Trending down',
  ranging: 'Ranging',
  unclassified: 'Unclassified',
};

export function RegimeTable({
  buckets,
  totalTrades,
  unclassifiedPct,
  unclassifiedDaysPct,
  explanation,
  currency,
}: RegimeTableProps): React.JSX.Element {
  if (totalTrades === 0 || unclassifiedPct >= 50) {
    return <Withheld>{explanation}</Withheld>;
  }

  const classified = buckets.filter((b) => b.regime !== 'unclassified');
  const positive = classified.filter((b) => b.netProfit > 0);

  return (
    <div className="space-y-2" data-testid="regime-table">
      <table className="w-full text-xs">
        <thead className="text-muted">
          <tr className="border-b border-border">
            <th className="py-1 text-left font-normal">Regime at entry</th>
            <th className="py-1 text-right font-normal">Trades</th>
            <th className="py-1 text-right font-normal">Share</th>
            <th className="py-1 text-right font-normal">Net</th>
            <th className="py-1 text-right font-normal">Win rate</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.regime} className="border-b border-border/40">
              <td className="py-1">
                {LABEL[b.regime] ?? b.regime}
                {b.regime === 'unclassified' && (
                  <span className="ml-1 text-muted">(no full lookback)</span>
                )}
              </td>
              <td className="py-1 text-right tabular-nums">{b.trades}</td>
              <td className="py-1 text-right tabular-nums">{b.sharePct.toFixed(0)}%</td>
              <td
                className={`py-1 text-right tabular-nums ${b.netProfit < 0 ? 'text-rose-300' : 'text-emerald-300'}`}
              >
                {b.netProfit.toFixed(0)}
              </td>
              <td className="py-1 text-right tabular-nums">
                <Figure
                  value={b.winRatePct}
                  format={(v) => `${v.toFixed(0)}%`}
                  reason="No trades in this regime, so a win rate is undefined."
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-xs text-muted">
        Net in {currency}. {unclassifiedDaysPct.toFixed(0)}% of daily sessions lack the full
        lookback (200 bars for direction, 252 for the volatility percentile), leaving{' '}
        {unclassifiedPct.toFixed(0)}% of trades unlabelled — those are not classified from a shorter
        window, because a 30-bar direction and a 200-bar direction are different measurements.
        {positive.length === 1 && classified.length > 1 && (
          <>
            {' '}
            <strong className="text-amber-300">
              Only {LABEL[positive[0]!.regime] ?? positive[0]!.regime} made money.
            </strong>{' '}
            An edge confined to one regime is a bet that the regime persists.
          </>
        )}
      </p>
    </div>
  );
}
