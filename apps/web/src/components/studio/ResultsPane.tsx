import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useState } from 'react';

import { Panel } from '@/components/ui/panes';
import { fetchRun, fetchRunSeries, fetchRunTrades, listSymbols, type RunDetail } from '@/lib/api';
import { EM_DASH, formatCurrency, formatPercent, formatRatio, pnlClass } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useStudio } from '@/stores/studio';
import { EquityChart } from './EquityChart';
import { CostWaterfall } from './CostWaterfall';
import { MetricTable, type MetricRowSpec } from './MetricTable';
import { MonthlyHeatmap } from './MonthlyHeatmap';
import { PriceChart } from './PriceChart';
import { TradesTable } from './TradesTable';
import { IntegrityTab } from './integrity/IntegrityTab';

const TABS = [
  'Overview',
  'Performance',
  'Risk',
  'Trade stats',
  'Costs',
  'Chart',
  'Trades',
  'Integrity',
] as const;
type Tab = (typeof TABS)[number];

/**
 * `runId` lets this render any stored run, not only the one the Studio just produced — which is
 * what makes `/runs/:runId` a real page rather than a link back to the list. Omitted in the
 * Studio, where the current run comes from the store.
 */
export function ResultsPane({
  runId: explicitRunId,
}: { readonly runId?: string } = {}): React.JSX.Element {
  const storeRunId = useStudio((s) => s.lastRunId);
  const runId = explicitRunId ?? storeRunId;
  const liveRun = useStudio((s) => s.liveRun);
  const [tab, setTab] = useState<Tab>('Overview');
  const focusTrade = useStudio((s) => s.focusTrade);
  const focusAt = useStudio((s) => s.focusAt);

  const run = useQuery({
    queryKey: ['run', runId],
    queryFn: () => fetchRun(runId!),
    enabled: runId !== null,
  });

  const trades = useQuery({
    queryKey: ['run-trades', runId],
    queryFn: () => fetchRunTrades(runId!),
    enabled: runId !== null && run.data?.state === 'completed',
  });

  const series = useQuery({
    queryKey: ['run-series', runId],
    queryFn: () => fetchRunSeries(runId!),
    enabled: runId !== null && run.data?.state === 'completed',
  });

  const symbols = useQuery({ queryKey: ['symbols'], queryFn: listSymbols, staleTime: 60_000 });

  if (runId === null) {
    return (
      <Panel title="Results">
        <EmptyState
          title="No run yet"
          body={
            liveRun === null
              ? 'Load an example, pick a symbol and timeframe, then press Run (Ctrl/Cmd+Enter).'
              : 'Waiting for the first run to finish…'
          }
        />
      </Panel>
    );
  }

  if (run.isLoading) {
    return (
      <Panel title="Results">
        <div className="grid h-full place-items-center">
          <Loader2 className="size-5 animate-spin text-muted" />
        </div>
      </Panel>
    );
  }

  if (run.error !== null) {
    return (
      <Panel title="Results">
        <EmptyState
          title="Could not load the run"
          body={run.error instanceof Error ? run.error.message : String(run.error)}
          tone="error"
        />
      </Panel>
    );
  }

  const detail = run.data;
  if (detail === undefined) return <Panel title="Results">{null}</Panel>;

  if (detail.state !== 'completed') {
    return (
      <Panel title="Results">
        <EmptyState
          title={`Run ${detail.state}`}
          // The API's own message, verbatim: it names the real reason ("No EURUSD data after
          // 2024-01-31"), and paraphrasing it here would lose exactly that.
          body={detail.error ?? 'This run produced no results.'}
          tone={detail.state === 'failed' ? 'error' : 'muted'}
        />
      </Panel>
    );
  }

  const currency = detail.config.accountCurrency;
  const digits = symbols.data?.find((s) => s.symbol === detail.config.symbol)?.digits ?? 5;
  // A pip is ten ticks on a 5- or 3-digit pair and one tick otherwise, which is what the flips
  // table needs to report pips per fill.
  const pipSize =
    symbols.data?.find((s) => s.symbol === detail.config.symbol)?.pipSize ?? 10 ** -(digits - 1);

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          Results
          <span className="font-normal normal-case tracking-normal text-muted">
            {detail.config.symbol} {detail.config.timeframe} · {detail.strategy.name} v
            {detail.strategy.version}
          </span>
        </span>
      }
      bodyClassName="flex flex-col min-h-0"
    >
      <KpiStrip detail={detail} />

      {detail.crossCheck.ok === false && (
        <Banner tone="error">
          {detail.crossCheck.message ??
            'The zero-cost cross-check failed: reconstructed P&L does not match the engine. Treat these numbers as suspect.'}
        </Banner>
      )}
      {detail.unfilledEntryOrders > 0 && (
        <Banner tone="warn">
          {detail.unfilledEntryOrders} entry order(s) were placed but never filled — usually
          insufficient margin. Lower the lot size or raise the leverage.
        </Banner>
      )}

      <nav
        className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-border px-2"
        role="tablist"
      >
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => {
              setTab(name);
            }}
            data-testid={`tab-${name.toLowerCase().replace(/\s+/g, '-')}`}
            className={cn(
              '-mb-px shrink-0 border-b-2 px-2.5 py-1.5 text-xs transition-colors',
              tab === name
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted hover:text-foreground',
            )}
          >
            {name}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-auto">
        {/*
          `min-h-` as well as `h-full`: the chart hosts size themselves from their container, and
          the container's height comes from a chain of percentage heights that resolves to zero
          whenever an ancestor's height is content-driven. The chart then renders at 0px and is
          invisible — which is exactly what happened in the Studio, where the panel collapsed and
          the Chart tab appeared blank. A floor also happens to be right on its own: a price
          chart under about 20rem is not usable.
        */}
        {tab === 'Overview' && (
          <div className="space-y-3 p-2">
            {/* Fixed height for the chart, then the heatmap below it: spec 05 asks for both on
                Overview, and a chart sized to fill the pane would push the grid off-screen. */}
            <div className="relative h-80 min-h-80">
              {series.data === undefined ? (
                <Loading />
              ) : (
                <EquityChart series={series.data} currency={currency} />
              )}
            </div>

            <section className="space-y-1.5">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
                Monthly returns
              </h3>
              {detail.metrics === null ? (
                <p className="text-xs text-muted">
                  This run has no stored metrics report, so its monthly breakdown is unavailable.
                </p>
              ) : (
                <MonthlyHeatmap months={detail.metrics.monthlyReturns} />
              )}
            </section>
          </div>
        )}

        {tab === 'Performance' && (
          <MetricsSection>
            <MetricTable
              title="Performance & profitability"
              currency={currency}
              rows={performanceRows(detail)}
            />
            <MetricTable title="Run" currency={currency} rows={provenanceRows(detail)} />
          </MetricsSection>
        )}

        {tab === 'Risk' && (
          <MetricsSection>
            <MetricTable title="Risk & drawdown" currency={currency} rows={riskRows(detail)} />
            <MetricTable title="Ratios" currency={currency} rows={ratioRows(detail)} />
          </MetricsSection>
        )}

        {tab === 'Trade stats' && <TradeStatsTables detail={detail} currency={currency} />}

        {tab === 'Costs' && (
          <div className="space-y-4 p-2">
            {detail.metrics === null ? (
              <p className="text-xs text-muted">
                This run has no stored metrics report, so its cost breakdown is unavailable.
              </p>
            ) : (
              <section className="space-y-2">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
                  Gross to net
                </h3>
                <CostWaterfall
                  costs={detail.metrics.costs}
                  netProfit={detail.kpis.netProfit ?? 0}
                  currency={currency}
                />
              </section>
            )}

            <MetricTable title="Slippage & cost drag" currency={currency} rows={costRows(detail)} />
          </div>
        )}

        {tab === 'Chart' && (
          // `relative`: this is the chart's containing block, and it is the element whose
          // `min-h-80` floor the chart now inherits by filling it (A55).
          <div className="relative h-full min-h-80">
            <PriceChart
              symbol={detail.config.symbol}
              timeframe={detail.config.timeframe}
              fromMs={detail.config.from}
              toMs={detail.config.to}
              trades={trades.data?.trades ?? []}
              digits={digits}
            />
          </div>
        )}

        {tab === 'Integrity' && (
          <IntegrityTab
            runId={detail.id}
            currency={currency}
            pipSize={pipSize}
            /*
             * The chart's focus is a TIME (A53). Look-ahead evidence names bars that frequently
             * carry no trade — the causality check's first peek on a leaking script is bar 0 — so a
             * trade-shaped jump left the most important evidence dead. A trade jump is the case
             * that also highlights the trade, which is why both handlers exist.
             */
            onJumpToTrade={(seq) => {
              const hit = trades.data?.trades.find((t) => t.seq === seq);
              focusTrade(seq, hit?.entryTime ?? null);
              setTab('Chart');
            }}
            onJumpToTime={(atMs) => {
              focusAt(atMs);
              setTab('Chart');
            }}
          />
        )}

        {tab === 'Trades' && (
          <div className="h-full min-h-0">
            {trades.data === undefined ? (
              <Loading />
            ) : (
              <TradesTable trades={trades.data.trades} currency={currency} digits={digits} />
            )}
          </div>
        )}
      </div>

      {detail.notes.length > 0 && (
        <div className="shrink-0 border-t border-border px-3 py-1.5">
          {detail.notes.map((note) => (
            <p key={note} className="text-[11px] leading-snug text-muted">
              · {note}
            </p>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ---------------------------------------------------------------- KPI strip */

function KpiStrip({ detail }: { readonly detail: RunDetail }): React.JSX.Element {
  const k = detail.kpis;
  const currency = detail.config.accountCurrency;

  return (
    <div
      className="grid shrink-0 grid-cols-2 divide-x divide-y divide-border border-b border-border sm:grid-cols-4 xl:grid-cols-8 xl:divide-y-0"
      data-testid="kpi-strip"
    >
      <Kpi
        label="Net profit"
        value={formatCurrency(k.netProfit, currency)}
        tone={k.netProfit}
        testId="kpi-net-profit"
      />
      <Kpi
        label="Return"
        value={formatPercent(k.totalReturnPct)}
        tone={k.totalReturnPct}
        sub={
          k.buyAndHoldReturnPct == null ? undefined : `B&H ${formatPercent(k.buyAndHoldReturnPct)}`
        }
        testId="kpi-return"
      />
      <Kpi label="CAGR" value={formatPercent(k.cagrPct)} tone={k.cagrPct} />
      <Kpi
        label="Profit factor"
        value={formatRatio(k.profitFactor)}
        tone={profitFactorTone(k.profitFactor)}
      />
      {/* A drawdown is a magnitude, so it gets no sign — but it is always bad, so it is always red. */}
      <Kpi
        label="Max DD"
        value={
          k.maxDrawdownPct == null ? EM_DASH : formatPercent(k.maxDrawdownPct, { signed: false })
        }
        tone={k.maxDrawdownPct == null ? null : -1}
      />
      <Kpi label="Sharpe" value={formatRatio(k.sharpe)} tone={k.sharpe} />
      <Kpi
        label="Win rate"
        value={k.winRatePct == null ? EM_DASH : formatPercent(k.winRatePct, { signed: false })}
      />
      <Kpi
        label="Trades"
        value={k.closedTrades == null ? EM_DASH : String(k.closedTrades)}
        testId="kpi-trades"
      />
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  tone,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
  readonly tone?: number | null;
  readonly testId?: string;
}): React.JSX.Element {
  return (
    <div className="px-3 py-2" {...(testId === undefined ? {} : { 'data-testid': testId })}>
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted">{label}</p>
      <p
        className={cn(
          'mt-0.5 font-mono text-sm tabular-nums',
          tone === undefined ? '' : pnlClass(tone),
        )}
      >
        {value}
      </p>
      {sub !== undefined && <p className="text-[10px] tabular-nums text-muted">{sub}</p>}
    </div>
  );
}

/** A profit factor below 1 loses money, so 1 is the colour boundary rather than 0. */
function profitFactorTone(value: number | null): number | null {
  if (value == null) return null;
  return value - 1;
}

/* ------------------------------------------------------------------ sections */

function MetricsSection({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <div className="grid gap-3 p-3 lg:grid-cols-2">{children}</div>;
}

function TradeStatsTables({
  detail,
  currency,
}: {
  readonly detail: RunDetail;
  readonly currency: string;
}): React.JSX.Element {
  const trades = detail.metrics?.trades;
  if (trades === undefined) return <EmptyState title="No trade statistics" body="" />;

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-3">
      {(['all', 'long', 'short'] as const).map((side) => (
        <MetricTable
          key={side}
          title={side === 'all' ? 'All trades' : side === 'long' ? 'Long only' : 'Short only'}
          currency={currency}
          rows={sideRows(trades[side])}
        />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- row builders */

function performanceRows(detail: RunDetail): MetricRowSpec[] {
  const p = detail.metrics?.performance;
  return [
    { dictKey: 'netProfit', value: p?.netProfit, colour: true },
    { dictKey: 'totalReturnPct', value: p?.totalReturnPct, colour: true },
    {
      dictKey: 'cagrPct',
      value: p?.cagrPct,
      colour: true,
      note:
        p?.annualizedFromShortWindow === true
          ? `annualized from ${String(Math.round(p.windowDays))} days — will overstate a sustainable rate`
          : undefined,
    },
    { dictKey: 'grossProfit', value: p?.grossProfit },
    { dictKey: 'grossLoss', value: p?.grossLoss },
    { dictKey: 'profitFactor', value: p?.profitFactor },
    { dictKey: 'recoveryFactor', value: p?.recoveryFactor },
    { label: 'Open P&L', unit: 'currency', value: p?.openPnl, colour: true },
    { label: 'Final equity', unit: 'currency', value: p?.finalEquity },
    { dictKey: 'buyAndHoldReturnPct', value: p?.buyAndHoldReturnPct, colour: true },
    { label: 'vs buy & hold', unit: 'percent', value: p?.vsBuyAndHoldPct, colour: true },
  ];
}

function riskRows(detail: RunDetail): MetricRowSpec[] {
  const risk = detail.metrics?.risk;
  return [
    // Intrabar is the headline: it is the drawdown that would actually have shown on the account.
    { label: 'Max DD (intrabar)', unit: 'currency', value: risk?.intrabar.maxDrawdown },
    { label: 'Max DD % (intrabar)', unit: 'percent', value: risk?.intrabar.maxDrawdownPct },
    { label: 'Max DD (close)', unit: 'currency', value: risk?.closeToClose.maxDrawdown },
    { label: 'Max DD % (close)', unit: 'percent', value: risk?.closeToClose.maxDrawdownPct },
    { label: 'Peak equity', unit: 'currency', value: risk?.intrabar.peakEquity },
    { label: 'Trough equity', unit: 'currency', value: risk?.intrabar.troughEquity },
    { dictKey: 'maxDrawdownDurationDays', value: risk?.duration.longestDays },
    { label: 'Time underwater', unit: 'percent', value: risk?.duration.percentOfTimeUnderwater },
    {
      label: 'Longest DD (bars)',
      unit: 'bars',
      value: risk?.duration.longestBars,
      note:
        risk?.duration.unrecovered === true ? 'never recovered — measured to the end' : undefined,
    },
  ];
}

function ratioRows(detail: RunDetail): MetricRowSpec[] {
  const risk = detail.metrics?.risk;
  return [
    { dictKey: 'sharpe', value: risk?.sharpe },
    { dictKey: 'sortino', value: risk?.sortino },
    {
      label: 'Sharpe (TV style)',
      unit: 'ratio',
      value: risk?.sharpeTradingView,
      note: 'monthly, rf 2%/12, population stdev, not annualized',
    },
    { label: 'Sortino (TV style)', unit: 'ratio', value: risk?.sortinoTradingView },
    { dictKey: 'ulcerIndex', value: risk?.ulcerIndex },
    { dictKey: 'ulcerPerformanceIndex', value: risk?.ulcerPerformanceIndex },
    {
      label: 'Daily returns / yr',
      unit: 'count',
      value: risk?.periodsPerYear,
      note: 'observed from the data, not assumed',
    },
    { label: 'Daily observations', unit: 'count', value: risk?.dailyReturnCount },
  ];
}

function sideRows(stats: NonNullable<RunDetail['metrics']>['trades']['all']): MetricRowSpec[] {
  return [
    { label: 'Trades', unit: 'count', value: stats.trades },
    {
      label: 'Wins / losses',
      unit: 'count',
      value: stats.wins,
      note: `${String(stats.losses)} losses`,
    },
    { dictKey: 'winRatePct', value: stats.winRatePct },
    { dictKey: 'netProfit', value: stats.netProfit, colour: true },
    { dictKey: 'profitFactor', value: stats.profitFactor },
    { dictKey: 'expectancy', value: stats.expectancy, colour: true },
    { dictKey: 'avgWin', value: stats.avgWin },
    { dictKey: 'avgLoss', value: stats.avgLoss },
    { dictKey: 'winLossRatio', value: stats.winLossRatio },
    { dictKey: 'largestWin', value: stats.largestWin },
    { dictKey: 'largestLoss', value: stats.largestLoss },
    { dictKey: 'maxConsecutiveWins', value: stats.maxConsecutiveWins },
    { dictKey: 'maxConsecutiveLosses', value: stats.maxConsecutiveLosses },
    { label: 'Current streak', unit: 'count', value: stats.currentStreak, colour: true },
    { dictKey: 'avgBarsHeld', value: stats.avgBarsHeld },
  ];
}

function costRows(detail: RunDetail): MetricRowSpec[] {
  const costs = detail.metrics?.costs;
  return [
    { dictKey: 'commissionTotal', value: costs?.commission.total },
    { label: 'Slippage', unit: 'currency', value: costs?.slippage.total },
    { dictKey: 'spreadTotal', value: costs?.spread.total },
    { label: 'Financing', unit: 'currency', value: costs?.financing.total },
    { dictKey: 'totalCosts', value: costs?.totalCosts },
    { label: 'Gross before costs', unit: 'currency', value: costs?.grossBeforeCosts, colour: true },
    { dictKey: 'costDragPct', value: costs?.costDragPct },
    {
      dictKey: 'breakEvenPerSidePips',
      value: costs?.breakEvenPerSidePips,
      note: 'how much worse execution can get, per side, before the edge is gone',
    },
    { label: 'Per trade: commission', unit: 'currency', value: costs?.commission.perTrade },
    { label: 'Per trade: spread', unit: 'currency', value: costs?.spread.perTrade },
  ];
}

function provenanceRows(detail: RunDetail): MetricRowSpec[] {
  return [
    { label: 'Bars processed', unit: 'count', value: detail.timings.barsProcessed },
    { label: 'Engine time (ms)', unit: 'count', value: detail.timings.engineMs },
    { label: 'Total time (ms)', unit: 'count', value: detail.timings.totalMs },
    { label: 'Data version', unit: 'count', value: detail.provenance.dataVersion },
    { label: 'Warmup bars', unit: 'count', value: detail.config.warmupBars },
    { label: 'Initial capital', unit: 'currency', value: detail.config.initialCapital },
  ];
}

/* ------------------------------------------------------------------- pieces */

function Loading(): React.JSX.Element {
  return (
    <div className="grid h-full place-items-center">
      <Loader2 className="size-5 animate-spin text-muted" />
    </div>
  );
}

function EmptyState({
  title,
  body,
  tone = 'muted',
}: {
  readonly title: string;
  readonly body: string;
  readonly tone?: 'muted' | 'error';
}): React.JSX.Element {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-md text-center">
        <p
          className={cn(
            'text-sm font-medium',
            tone === 'error' ? 'text-destructive' : 'text-foreground',
          )}
        >
          {title}
        </p>
        {body !== '' && <p className="mt-1 text-xs leading-relaxed text-muted">{body}</p>}
      </div>
    </div>
  );
}

function Banner({
  tone,
  children,
}: {
  readonly tone: 'error' | 'warn';
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      data-testid={`banner-${tone}`}
      className={cn(
        'flex shrink-0 items-start gap-2 border-b px-3 py-1.5 text-[11px] leading-snug',
        tone === 'error'
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : 'border-amber-500/40 bg-amber-500/10 text-amber-500',
      )}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
