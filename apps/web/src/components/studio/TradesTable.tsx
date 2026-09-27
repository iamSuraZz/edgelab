import { useVirtualizer } from '@tanstack/react-virtual';
import { Download } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { CostedTrade } from '@edgelab/shared';

import {
  EM_DASH,
  formatCurrency,
  formatDateTime,
  formatPrice,
  formatRatio,
  pnlClass,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import { useStudio } from '@/stores/studio';

/**
 * The trades table: virtualized, filterable, exportable, and wired to the chart.
 *
 * Virtualized because a year of an active strategy is tens of thousands of rows, and rendering
 * those as DOM nodes locks the tab. Only the visible window is mounted.
 */

type SideFilter = 'all' | 'long' | 'short';
type OutcomeFilter = 'all' | 'wins' | 'losses';

export function TradesTable({
  trades,
  currency,
  digits,
}: {
  readonly trades: readonly CostedTrade[];
  readonly currency: string;
  readonly digits: number;
}): React.JSX.Element {
  const focusTrade = useStudio((s) => s.focusTrade);
  const focusedSeq = useStudio((s) => s.focusedTradeSeq);

  const [side, setSide] = useState<SideFilter>('all');
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');

  const filtered = useMemo(
    () =>
      trades.filter((trade) => {
        if (side !== 'all' && trade.side !== side) return false;
        if (outcome === 'wins' && trade.netPnl <= 0) return false;
        if (outcome === 'losses' && trade.netPnl >= 0) return false;
        return true;
      }),
    [trades, side, outcome],
  );

  const scrollRef = useRef<HTMLDivElement>(null);

  // React Compiler cannot memoize `useVirtualizer` — it returns functions whose identity changes
  // on scroll, which is exactly what makes them unsafe to cache. Opting this component out of
  // compiler memoization is the correct outcome, not a defect: virtualization is required here
  // (spec 04 asks for it, and a year of trades is tens of thousands of rows), and the component
  // re-renders on scroll by design.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 12,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
        <FilterGroup
          value={side}
          onChange={setSide}
          options={[
            { value: 'all', label: 'All' },
            { value: 'long', label: 'Long' },
            { value: 'short', label: 'Short' },
          ]}
        />
        <FilterGroup
          value={outcome}
          onChange={setOutcome}
          options={[
            { value: 'all', label: 'Any' },
            { value: 'wins', label: 'Wins' },
            { value: 'losses', label: 'Losses' },
          ]}
        />

        <span className="text-[11px] tabular-nums text-muted" data-testid="trades-count">
          {filtered.length === trades.length
            ? `${String(trades.length)} trades`
            : `${String(filtered.length)} of ${String(trades.length)}`}
        </span>

        <button
          type="button"
          onClick={() => {
            downloadCsv(filtered, currency);
          }}
          disabled={filtered.length === 0}
          data-testid="export-csv"
          className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
        >
          <Download className="size-3" /> CSV
        </button>
      </div>

      {/* One grid template, shared by the header and every row, so the columns cannot drift. */}
      <div
        className="grid shrink-0 gap-2 border-b border-border bg-surface px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted"
        style={{ gridTemplateColumns: COLUMNS }}
      >
        <span>#</span>
        <span>Side</span>
        <span className="text-right">Qty</span>
        <span>Entry</span>
        <span className="text-right">Price</span>
        <span>Exit</span>
        <span className="text-right">Price</span>
        <span className="text-right">Net P&amp;L</span>
        <span className="text-right">Costs</span>
        <span className="text-right">Bars</span>
        <span>Reason</span>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" data-testid="trades-scroll">
        {filtered.length === 0 ? (
          <p className="p-4 text-xs text-muted">
            {trades.length === 0
              ? 'This run produced no closed trades.'
              : 'No trades match the filter.'}
          </p>
        ) : (
          <div style={{ height: `${String(virtualizer.getTotalSize())}px` }} className="relative">
            {virtualizer.getVirtualItems().map((item) => {
              const trade = filtered[item.index]!;
              const costs =
                trade.commission + trade.slippageCost + trade.spreadCost + trade.financingCost;

              return (
                <button
                  type="button"
                  key={trade.seq}
                  onClick={() => {
                    // Toggle: clicking the focused trade again clears the chart highlight.
                    focusTrade(focusedSeq === trade.seq ? null : trade.seq);
                  }}
                  data-testid={`trade-row-${String(trade.seq)}`}
                  className={cn(
                    'absolute left-0 grid w-full items-center gap-2 px-2 text-left font-mono text-[11px] tabular-nums transition-colors',
                    'border-b border-border/50 hover:bg-surface-hover',
                    focusedSeq === trade.seq && 'bg-primary/15',
                  )}
                  style={{
                    gridTemplateColumns: COLUMNS,
                    height: `${String(item.size)}px`,
                    transform: `translateY(${String(item.start)}px)`,
                  }}
                >
                  <span className="text-muted">{trade.seq}</span>
                  <span className={trade.side === 'long' ? 'text-accent' : 'text-destructive'}>
                    {trade.side === 'long' ? 'LONG' : 'SHORT'}
                  </span>
                  <span className="text-right">{formatRatio(trade.qty, 2)}</span>
                  <span className="truncate text-muted">{formatDateTime(trade.entryTime)}</span>
                  <span className="text-right">{formatPrice(trade.entryPrice, digits)}</span>
                  <span className="truncate text-muted">{formatDateTime(trade.exitTime)}</span>
                  <span className="text-right">{formatPrice(trade.exitPrice, digits)}</span>
                  <span className={cn('text-right font-medium', pnlClass(trade.netPnl))}>
                    {formatCurrency(trade.netPnl, currency)}
                  </span>
                  <span className="text-right text-muted">
                    {formatCurrency(costs, currency, { signed: false })}
                  </span>
                  <span className="text-right text-muted">{trade.barsHeld ?? EM_DASH}</span>
                  <span className="truncate text-muted">{trade.exitReason ?? EM_DASH}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const COLUMNS = '2.5rem 3.5rem 3.5rem 8.5rem 5rem 8.5rem 5rem 6rem 5rem 3rem minmax(4rem, 1fr)';

function FilterGroup<T extends string>({
  value,
  onChange,
  options,
}: {
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly options: readonly { value: T; label: string }[];
}): React.JSX.Element {
  return (
    <div className="flex overflow-hidden rounded border border-border">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => {
            onChange(option.value);
          }}
          aria-pressed={option.value === value}
          className={cn(
            'px-2 py-0.5 text-[11px] transition-colors',
            option.value === value
              ? 'bg-primary text-primary-foreground'
              : 'text-muted hover:bg-surface-hover hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * CSV export.
 *
 * Times are ISO-8601 UTC and numbers are unformatted, because this file is for a spreadsheet, not
 * for reading: thousands separators and currency symbols turn every column into text on import.
 */
function downloadCsv(trades: readonly CostedTrade[], currency: string): void {
  const header = [
    'seq',
    'side',
    'qty_lots',
    'entry_time_utc',
    'entry_price',
    'exit_time_utc',
    'exit_price',
    'gross_pnl',
    'commission',
    'slippage',
    'spread',
    'financing',
    `net_pnl_${currency.toLowerCase()}`,
    'mae',
    'mfe',
    'bars_held',
    'exit_reason',
  ];

  const rows = trades.map((t) => [
    t.seq,
    t.side,
    t.qty,
    new Date(t.entryTime).toISOString(),
    t.entryPrice,
    new Date(t.exitTime).toISOString(),
    t.exitPrice,
    t.grossPnl,
    t.commission,
    t.slippageCost,
    t.spreadCost,
    t.financingCost,
    t.netPnl,
    t.mae ?? '',
    t.mfe ?? '',
    t.barsHeld ?? '',
    // Quote the one free-text column; the rest are numbers and enums.
    `"${(t.exitReason ?? '').replace(/"/g, '""')}"`,
  ]);

  const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));

  const link = document.createElement('a');
  link.href = url;
  link.download = `edgelab-trades-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
