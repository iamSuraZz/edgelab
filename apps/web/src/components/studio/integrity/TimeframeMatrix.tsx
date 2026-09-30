import { Figure } from './Withheld';

/**
 * The timeframe matrix.
 *
 * NO BEST-CELL HIGHLIGHTING, deliberately (A44). The matrix is a SHAPE to read, not a menu to pick
 * from — an edge with a real basis degrades smoothly as the bar size changes, while a fitted one
 * falls off a cliff either side. Marking the winner would invite exactly the reading the check
 * exists to prevent: choosing the timeframe that paid best, which is overfitting one more dimension.
 *
 * Cells therefore get a uniform treatment, with sign as the only colour. Gross sits beside net
 * because the cost stress runs on the base timeframe only and cannot say whether costs or the signal
 * sank the shorter bars (A45).
 */

export interface MatrixCellView {
  readonly timeframe: string;
  readonly status: 'ok' | 'n/a';
  readonly reason: string | null;
  readonly metrics: { readonly trades: number; readonly netProfit: number } | null;
  readonly costs: {
    readonly grossProfit: number;
    readonly totalCosts: number;
    readonly costShareOfGross: number | null;
  } | null;
}

export interface TimeframeMatrixProps {
  readonly cells: readonly MatrixCellView[];
  readonly baseTimeframe: string;
  readonly currency: string;
}

export function TimeframeMatrix({
  cells,
  baseTimeframe,
  currency,
}: TimeframeMatrixProps): React.JSX.Element {
  return (
    <div className="space-y-2" data-testid="timeframe-matrix">
      <table className="w-full text-xs">
        <thead className="text-muted">
          <tr className="border-b border-border">
            <th className="py-1 text-left font-normal">Timeframe</th>
            <th className="py-1 text-right font-normal">Trades</th>
            <th className="py-1 text-right font-normal">Gross</th>
            <th className="py-1 text-right font-normal">Net</th>
            <th className="py-1 text-right font-normal">Costs</th>
            <th className="py-1 text-left font-normal">If it lost</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((c) => (
            <tr key={c.timeframe} className="border-b border-border/40 align-top">
              <td className="py-1">
                {c.timeframe}
                {/*
                  The base timeframe is LABELLED, not highlighted: saying which one the run used is
                  context, whereas styling a cell as special is a recommendation.
                */}
                {c.timeframe === baseTimeframe && (
                  <span className="ml-1 text-muted">(this run)</span>
                )}
              </td>

              {c.status === 'n/a' || c.metrics === null ? (
                <td colSpan={5} className="py-1 text-muted">
                  <span className="mr-1 rounded bg-slate-500/15 px-1 py-0.5 text-[0.65rem] uppercase">
                    n/a
                  </span>
                  {c.reason ?? 'Not run.'}
                </td>
              ) : (
                <>
                  <td className="py-1 text-right tabular-nums">{c.metrics.trades}</td>
                  <td
                    className={`py-1 text-right tabular-nums ${signClass(c.costs?.grossProfit ?? 0)}`}
                  >
                    <Figure
                      value={c.costs?.grossProfit ?? null}
                      format={(v) => v.toFixed(0)}
                      reason="Gross was not recorded for this cell."
                    />
                  </td>
                  <td className={`py-1 text-right tabular-nums ${signClass(c.metrics.netProfit)}`}>
                    {c.metrics.netProfit.toFixed(0)}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {c.costs === null ? (
                      <span className="text-muted">—</span>
                    ) : c.costs.costShareOfGross === null ? (
                      // A share against a negative gross flips sign and reads as a credit (A45),
                      // so the amount is shown instead.
                      <span title="Gross was not positive, so a share of it is undefined — the cost amount is shown instead.">
                        {c.costs.totalCosts.toFixed(0)}
                      </span>
                    ) : (
                      `${(c.costs.costShareOfGross * 100).toFixed(0)}% of gross`
                    )}
                  </td>
                  <td className="py-1">{lossCauseLabel(c)}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-xs text-muted">
        Net in {currency}. This is a shape, not a menu: an edge that exists at one bar size and
        vanishes at its neighbours is a property of that bar size. The best cell is deliberately not
        marked.
      </p>
    </div>
  );
}

function lossCauseLabel(c: MatrixCellView): React.JSX.Element {
  if (c.metrics === null || c.costs === null || c.metrics.netProfit > 0) {
    return <span className="text-muted">—</span>;
  }
  return c.costs.grossProfit > 0 ? (
    <span
      className="text-amber-300"
      title="The signal made money and costs took it — cheaper execution could rescue this."
    >
      costs
    </span>
  ) : (
    <span
      className="text-rose-300"
      title="It lost money before costs were charged at all — nothing rescues this."
    >
      signal
    </span>
  );
}

function signClass(v: number): string {
  return v < 0 ? 'text-rose-300' : 'text-emerald-300';
}
