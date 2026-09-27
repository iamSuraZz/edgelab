import { useQuery } from '@tanstack/react-query';
import { GitCompare, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { CompareEquity } from '@/components/runs/CompareEquity';
import { listRuns, type RunListItem } from '@/lib/api';
import {
  EM_DASH,
  formatCurrency,
  formatDate,
  formatPercent,
  formatRatio,
  pnlClass,
} from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The Runs page (spec 07): every run, sortable, with a Compare view for two to four of them.
 *
 * Selection lives in the URL (`?compare=id,id`), not in component state, so a comparison is a
 * link you can send yourself — which is the same reason every run has its own URL.
 */

type SortKey = 'createdAt' | 'netProfit' | 'profitFactor' | 'maxDrawdownPct' | 'sharpe';

export function RunsPage(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const [sortKey, setSortKey] = useState<SortKey>('createdAt');

  const runs = useQuery({ queryKey: ['runs'], queryFn: () => listRuns(200), staleTime: 15_000 });

  const selected = useMemo(
    () => (params.get('compare') ?? '').split(',').filter((s) => s !== ''),
    [params],
  );

  const toggle = (id: string): void => {
    const next = selected.includes(id)
      ? selected.filter((s) => s !== id)
      : // Four is the cap spec 07 sets: beyond that the comparison table stops being readable
        // on one screen, which defeats the point of putting them side by side.
        [...selected, id].slice(0, 4);

    if (next.length === 0) params.delete('compare');
    else params.set('compare', next.join(','));
    setParams(params, { replace: true });
  };

  const sorted = useMemo(() => {
    const rows = [...(runs.data ?? [])];
    rows.sort((a, b) => {
      if (sortKey === 'createdAt') return b.createdAt - a.createdAt;
      // Nulls last whichever way the metric points: a run with no profit factor should not
      // outrank one that has a bad but real number.
      const av = a.kpis[sortKey];
      const bv = b.kpis[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      // Drawdown is the one metric where smaller is better.
      return sortKey === 'maxDrawdownPct' ? av - bv : bv - av;
    });
    return rows;
  }, [runs.data, sortKey]);

  if (runs.isLoading) {
    return (
      <div className="grid h-full place-items-center">
        <Loader2 className="size-5 animate-spin text-muted" />
      </div>
    );
  }

  if (runs.error !== null) {
    return (
      <Empty
        title="Could not load runs"
        body={runs.error instanceof Error ? runs.error.message : String(runs.error)}
      />
    );
  }

  if (sorted.length === 0) {
    return (
      <Empty
        title="No runs yet"
        body="Run a backtest in the Studio and it will appear here, with its own URL."
      />
    );
  }

  const comparing = sorted.filter((r) => selected.includes(r.id));

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold">Runs</h1>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted">
            Sort
            <select
              value={sortKey}
              onChange={(event) => {
                setSortKey(event.target.value as SortKey);
              }}
              className="rounded border border-border bg-background px-1.5 py-1 text-xs"
            >
              <option value="createdAt">Newest</option>
              <option value="netProfit">Net profit</option>
              <option value="profitFactor">Profit factor</option>
              <option value="maxDrawdownPct">Max drawdown</option>
              <option value="sharpe">Sharpe</option>
            </select>
          </label>
          <span className="text-xs tabular-nums text-muted" data-testid="runs-count">
            {sorted.length} run{sorted.length === 1 ? '' : 's'}
          </span>
        </div>
      </header>

      {comparing.length >= 2 && <CompareView runs={comparing} />}

      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full min-w-[60rem] text-xs" data-testid="runs-table">
          <thead className="bg-surface text-[10px] uppercase tracking-wider text-muted">
            <tr>
              <th className="w-8 px-2 py-1.5">
                <GitCompare className="size-3" aria-label="Compare" />
              </th>
              <th className="px-2 py-1.5 text-left">Strategy</th>
              <th className="px-2 py-1.5 text-left">Symbol</th>
              <th className="px-2 py-1.5 text-left">Range</th>
              <th className="px-2 py-1.5 text-right">Net P&amp;L</th>
              <th className="px-2 py-1.5 text-right">Return</th>
              <th className="px-2 py-1.5 text-right">PF</th>
              <th className="px-2 py-1.5 text-right">Max DD</th>
              <th className="px-2 py-1.5 text-right">Sharpe</th>
              <th className="px-2 py-1.5 text-right">Trades</th>
              <th className="px-2 py-1.5 text-left">State</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((run) => (
              <tr
                key={run.id}
                data-testid={`run-row-${run.id}`}
                className={cn(
                  'border-t border-border/60 transition-colors hover:bg-surface-hover',
                  selected.includes(run.id) && 'bg-primary/10',
                )}
              >
                <td className="px-2 py-1">
                  <input
                    type="checkbox"
                    checked={selected.includes(run.id)}
                    onChange={() => {
                      toggle(run.id);
                    }}
                    aria-label={`Compare ${run.strategyName}`}
                    className="size-3.5 accent-[var(--primary)]"
                  />
                </td>
                <td className="px-2 py-1">
                  {/* Every run has its own URL (spec 07). */}
                  <Link to={`/runs/${run.id}`} className="font-medium text-primary hover:underline">
                    {run.strategyName}
                  </Link>
                  <span className="ml-1 text-muted">v{run.version}</span>
                </td>
                <td className="px-2 py-1 font-mono">
                  {run.symbol} {run.timeframe}
                </td>
                <td className="px-2 py-1 tabular-nums text-muted">
                  {formatDate(run.from)} → {formatDate(run.to)}
                </td>
                <td
                  className={cn(
                    'px-2 py-1 text-right font-mono tabular-nums',
                    pnlClass(run.kpis.netProfit),
                  )}
                >
                  {formatCurrency(run.kpis.netProfit)}
                </td>
                <td
                  className={cn(
                    'px-2 py-1 text-right font-mono tabular-nums',
                    pnlClass(run.kpis.totalReturnPct),
                  )}
                >
                  {formatPercent(run.kpis.totalReturnPct)}
                </td>
                <td className="px-2 py-1 text-right font-mono tabular-nums">
                  {formatRatio(run.kpis.profitFactor)}
                </td>
                <td className="px-2 py-1 text-right font-mono tabular-nums">
                  {run.kpis.maxDrawdownPct == null
                    ? EM_DASH
                    : formatPercent(run.kpis.maxDrawdownPct, { signed: false })}
                </td>
                <td className="px-2 py-1 text-right font-mono tabular-nums">
                  {formatRatio(run.kpis.sharpe)}
                </td>
                <td className="px-2 py-1 text-right font-mono tabular-nums">{run.tradeCount}</td>
                <td className="px-2 py-1">
                  <StateBadge state={run.state} crossCheckOk={run.crossCheckOk} />
                </td>
                <td className="px-2 py-1">
                  <RerunActions run={run} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Re-run actions (spec 07).
 *
 * Both are LINKS into the Studio carrying the run's config, not one-click submits. A backtest is
 * cheap but not free, and "re-run on latest data" silently changing the date range is exactly the
 * kind of thing you want to see before it happens.
 */
function RerunActions({ run }: { readonly run: RunListItem }): React.JSX.Element {
  const identical = new URLSearchParams({
    rerun: run.id,
    mode: 'identical',
  });
  const latest = new URLSearchParams({
    rerun: run.id,
    mode: 'latest',
  });

  return (
    <span className="flex items-center gap-1">
      <Link
        to={`/studio?${identical.toString()}`}
        title="Re-run with exactly this configuration"
        data-testid={`rerun-identical-${run.id}`}
        className="rounded p-1 text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        <RotateCcw className="size-3.5" />
      </Link>
      <Link
        to={`/studio?${latest.toString()}`}
        title="Re-run on the latest available data"
        data-testid={`rerun-latest-${run.id}`}
        className="rounded p-1 text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        <RefreshCw className="size-3.5" />
      </Link>
    </span>
  );
}

function StateBadge({
  state,
  crossCheckOk,
}: {
  readonly state: string;
  readonly crossCheckOk: boolean | null;
}): React.JSX.Element {
  // A completed run whose cross-check failed is NOT simply "completed" — its numbers are
  // suspect, and the list is where you would otherwise never find that out.
  if (state === 'completed' && crossCheckOk === false) {
    return (
      <span
        title="The zero-cost cross-check failed: reconstructed P&L does not match the engine."
        className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
      >
        suspect
      </span>
    );
  }

  const tone =
    state === 'completed'
      ? 'bg-accent/15 text-accent'
      : state === 'failed'
        ? 'bg-destructive/15 text-destructive'
        : state === 'cancelled'
          ? 'bg-muted/20 text-muted'
          : 'bg-primary/15 text-primary';

  return <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', tone)}>{state}</span>;
}

/**
 * Compare view: the selected runs side by side, best value in each row highlighted.
 *
 * Equity curves overlaid and normalised to 100 are spec 07's other half and are NOT here yet —
 * that needs each run's series, which is a fetch per run.
 */
function CompareView({ runs }: { readonly runs: readonly RunListItem[] }): React.JSX.Element {
  const rows = [
    {
      label: 'Net profit',
      get: (r: RunListItem) => r.kpis.netProfit,
      higherBetter: true,
      fmt: formatCurrency,
    },
    {
      label: 'Return',
      get: (r: RunListItem) => r.kpis.totalReturnPct,
      higherBetter: true,
      fmt: (v: number | null) => formatPercent(v),
    },
    {
      label: 'Profit factor',
      get: (r: RunListItem) => r.kpis.profitFactor,
      higherBetter: true,
      fmt: (v: number | null) => formatRatio(v),
    },
    {
      label: 'Max drawdown',
      get: (r: RunListItem) => r.kpis.maxDrawdownPct,
      higherBetter: false,
      fmt: (v: number | null) => (v == null ? EM_DASH : formatPercent(v, { signed: false })),
    },
    {
      label: 'Sharpe',
      get: (r: RunListItem) => r.kpis.sharpe,
      higherBetter: true,
      fmt: (v: number | null) => formatRatio(v),
    },
    {
      label: 'Win rate',
      get: (r: RunListItem) => r.kpis.winRatePct,
      higherBetter: true,
      fmt: (v: number | null) => (v == null ? EM_DASH : formatPercent(v, { signed: false })),
    },
    {
      label: 'Trades',
      get: (r: RunListItem) => r.kpis.closedTrades,
      higherBetter: null,
      fmt: (v: number | null) => (v == null ? EM_DASH : String(v)),
    },
  ] as const;

  return (
    <section className="rounded border border-border" data-testid="compare-view">
      <h2 className="border-b border-border bg-surface px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
        Comparing {runs.length} runs
      </h2>

      <CompareEquity
        runs={runs.map((r) => ({ id: r.id, label: `${r.strategyName} v${r.version}` }))}
      />

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-muted">
              <th className="px-3 py-1.5 text-left">Metric</th>
              {runs.map((run) => (
                <th key={run.id} className="px-3 py-1.5 text-right">
                  <Link to={`/runs/${run.id}`} className="text-primary hover:underline">
                    {run.strategyName} v{run.version}
                  </Link>
                  <span className="block font-normal normal-case text-muted">
                    {run.symbol} {run.timeframe}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const values = runs.map(row.get);
              const best = bestIndex(values, row.higherBetter);
              return (
                <tr key={row.label} className="border-t border-border/60">
                  <td className="px-3 py-1 text-muted">{row.label}</td>
                  {values.map((value, i) => (
                    <td
                      key={runs[i]!.id}
                      className={cn(
                        'px-3 py-1 text-right font-mono tabular-nums',
                        i === best && 'font-semibold text-accent',
                      )}
                    >
                      {row.fmt(value)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Index of the best value, or -1 when ranking is meaningless or nothing is comparable. */
function bestIndex(values: readonly (number | null)[], higherBetter: boolean | null): number {
  if (higherBetter === null) return -1;
  let best = -1;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v == null) continue;
    const current = values[best];
    if (best === -1 || current == null) {
      best = i;
      continue;
    }
    if (higherBetter ? v > current : v < current) best = i;
  }
  return best;
}

function Empty({
  title,
  body,
}: {
  readonly title: string;
  readonly body: string;
}): React.JSX.Element {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-md text-center">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">{body}</p>
      </div>
    </div>
  );
}
