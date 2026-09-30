import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronRight, Lock } from 'lucide-react';
import { useState } from 'react';

import { fetchDailyCounts, fetchQuality, type CoverageRow } from '@/lib/api';

/**
 * What is actually stored, per feed.
 *
 * PER FEED, not per instrument, because every symbol holds exactly one feed (A6) and a run whose
 * range spans two is refused — so `EURUSD` and `EURUSD.twelvedata` are separate rows that happen to
 * describe the same instrument. Merging them would hide the one distinction that decides whether a
 * run is allowed.
 *
 * Three things ride along with the range:
 *
 *  - the **holdout seal**, because a holdout is exactly the part of the range you are not allowed
 *    to use, and a range shown without it invites planning a run that will be silently truncated;
 *  - **blocked since**, when a source has been refusing (A11);
 *  - the **quality report**, loaded on demand — it has to read the bars, so it is not something to
 *    run for every symbol on every page load.
 */

export function CoverageTable({
  rows,
  onPreview,
}: {
  readonly rows: readonly CoverageRow[];
  readonly onPreview: (symbol: string) => void;
}): React.JSX.Element {
  // Empty symbols are noise on a page about what you hold; the registry is the place for those.
  const stored = rows.filter((r) => r.barCount > 0);

  return (
    <div className="space-y-1" data-testid="coverage-table">
      {stored.length === 0 && (
        <p className="rounded border border-border p-3 text-xs text-muted">
          No bars stored yet. Download a range above, or import a file.
        </p>
      )}
      {stored.map((row) => (
        <CoverageRowView key={row.symbol} row={row} onPreview={onPreview} />
      ))}
    </div>
  );
}

function CoverageRowView({
  row,
  onPreview,
}: {
  readonly row: CoverageRow;
  readonly onPreview: (symbol: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <article className="rounded-md border border-border" data-testid={`coverage-${row.symbol}`}>
      <header className="flex flex-wrap items-center gap-2 p-2.5">
        <button
          type="button"
          onClick={() => {
            setOpen((v) => !v);
          }}
          className="flex items-center gap-1 text-sm font-medium"
          aria-expanded={open}
          data-testid={`coverage-${row.symbol}-toggle`}
        >
          <ChevronRight className={`size-4 transition-transform ${open ? 'rotate-90' : ''}`} />
          {row.symbol}
        </button>

        <span className="rounded bg-surface-hover px-1.5 py-0.5 text-[0.65rem] text-muted">
          {row.sources.join(', ') || 'unknown source'}
        </span>

        <span className="font-mono text-xs text-muted">
          {isoDay(row.firstBar)} → {isoDay(row.lastBar)}
        </span>

        <span className="text-xs tabular-nums text-muted">
          {row.barCount.toLocaleString()} bars
        </span>

        {row.holdout != null && (
          <span
            className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[0.65rem] text-amber-200"
            title={`Bars from ${isoDay(row.holdout.sealedFromMs)} are withheld from ordinary runs.`}
            data-testid={`coverage-${row.symbol}-seal`}
          >
            <Lock className="size-3" />
            sealed from {isoDay(row.holdout.sealedFromMs)} · viewed {row.holdout.viewCount}×
          </span>
        )}

        <button
          type="button"
          onClick={() => {
            onPreview(row.symbol);
          }}
          className="ml-auto rounded border border-border px-2 py-1 text-xs hover:bg-surface-hover"
          data-testid={`coverage-${row.symbol}-preview`}
        >
          Preview
        </button>
      </header>

      {row.blocked !== undefined && row.blocked.length > 0 && (
        <p className="mx-2.5 mb-2.5 rounded border border-amber-500/40 bg-amber-500/10 p-1.5 text-xs text-amber-100">
          <AlertTriangle className="mr-1 inline size-3" />
          {row.blocked.join(' · ')}
        </p>
      )}

      {open && <Detail row={row} />}
    </article>
  );
}

function Detail({ row }: { readonly row: CoverageRow }): React.JSX.Element {
  const from = row.firstBar ?? 0;
  const to = (row.lastBar ?? 0) + 60_000;

  const counts = useQuery({
    queryKey: ['daily-counts', row.symbol, from, to],
    queryFn: () => fetchDailyCounts(row.symbol, from, to),
    enabled: row.firstBar !== null,
  });

  const quality = useQuery({
    queryKey: ['quality', row.symbol, from, to],
    queryFn: () => fetchQuality(row.symbol, from, to),
    enabled: row.firstBar !== null,
  });

  return (
    <div className="border-t border-border p-2.5">
      {counts.data !== undefined && <Heatmap days={counts.data} />}

      {quality.isLoading && <p className="mt-2 text-xs text-muted">Reading bars…</p>}
      {quality.data !== undefined && (
        <QualityWarnings
          report={quality.data.report}
          truncated={quality.data.truncation !== null}
        />
      )}
    </div>
  );
}

/**
 * Bars per UTC day.
 *
 * Shaded against a FULL trading day (1,440 minutes) rather than against the busiest day in the
 * range, so the same colour means the same thing in every symbol and every window. Scaling to the
 * local maximum would paint a uniformly thin series as if it were complete.
 */
function Heatmap({ days }: { readonly days: readonly { day: number; bars: number }[] }) {
  if (days.length === 0) return null;

  return (
    <div data-testid="coverage-heatmap">
      <div className="flex flex-wrap gap-px">
        {days.map((d) => (
          <span
            key={d.day}
            className={`size-2.5 rounded-[1px] ${shade(d.bars)}`}
            title={`${new Date(d.day).toISOString().slice(0, 10)}: ${d.bars} bars`}
          />
        ))}
      </div>
      <p className="mt-1.5 text-[0.65rem] text-muted">
        One square per UTC day, shaded against a full 1,440-minute day. Weekends are empty for fx by
        design; a pale weekday is a real gap.
      </p>
    </div>
  );
}

function shade(bars: number): string {
  const share = bars / 1_440;
  if (share <= 0) return 'bg-surface-hover';
  if (share < 0.25) return 'bg-primary/20';
  if (share < 0.5) return 'bg-primary/40';
  if (share < 0.9) return 'bg-primary/60';
  return 'bg-primary';
}

interface Finding {
  readonly count: number;
  readonly truncated: boolean;
}

interface Report {
  readonly completeness: number;
  readonly missingMinutes: number;
  readonly gaps: Finding;
  readonly duplicateTimestamps: Finding;
  readonly outOfOrderTimestamps: Finding;
  readonly zeroRangeBars: Finding;
  readonly fillerBars: Finding;
  readonly spikes: Finding;
  readonly spreadOutliers: Finding;
  readonly invalidBars: Finding;
}

/**
 * Only what was found.
 *
 * A list of nine "0" rows trains you to stop reading it, and the one that is not zero then looks
 * like the rest. Clean data says so in one line.
 */
function QualityWarnings({
  report,
  truncated,
}: {
  readonly report: Report;
  readonly truncated: boolean;
}): React.JSX.Element {
  const issues = (
    [
      ['Invalid bars', report.invalidBars, 'error'],
      ['Duplicate timestamps', report.duplicateTimestamps, 'error'],
      ['Out of order', report.outOfOrderTimestamps, 'error'],
      ['Gaps in open hours', report.gaps, 'warn'],
      ['Filler bars (flat, zero volume)', report.fillerBars, 'warn'],
      ['Zero-range bars', report.zeroRangeBars, 'warn'],
      ['Price spikes', report.spikes, 'warn'],
      ['Spread outliers', report.spreadOutliers, 'warn'],
    ] as const
  ).filter(([, f]) => f.count > 0);

  return (
    <div className="mt-2 space-y-1" data-testid="coverage-quality">
      <p className="text-xs">
        <span className="text-muted">Completeness</span>{' '}
        <strong className={completenessClass(report.completeness)}>
          {(report.completeness * 100).toFixed(1)}%
        </strong>
        <span className="text-muted">
          {' '}
          of expected open minutes
          {report.missingMinutes > 0 &&
            ` · ${report.missingMinutes.toLocaleString()} minutes missing`}
        </span>
      </p>

      {truncated && (
        <p className="rounded bg-amber-500/10 p-1.5 text-xs text-amber-200">
          A sealed holdout cut this report short. It describes the readable part of the range only.
        </p>
      )}

      {issues.length === 0 ? (
        <p className="text-xs text-emerald-300">No quality issues found in this range.</p>
      ) : (
        <ul className="space-y-0.5 text-xs">
          {issues.map(([label, f, tone]) => (
            <li key={label} className={tone === 'error' ? 'text-rose-300' : 'text-amber-300'}>
              {label}: <span className="tabular-nums">{f.count.toLocaleString()}</span>
              {f.truncated && ' (samples capped)'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function completenessClass(v: number): string {
  if (v >= 0.99) return 'text-emerald-300';
  if (v >= 0.9) return 'text-amber-300';
  return 'text-rose-300';
}

function isoDay(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toISOString().slice(0, 10);
}
