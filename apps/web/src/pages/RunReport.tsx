import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check, Copy, Download, RefreshCw, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ResultsPane } from '@/components/studio/ResultsPane';
import { fetchRun, fetchRunSeries, fetchRunTrades } from '@/lib/api';
import { formatDate } from '@/lib/format';

/**
 * A single run at its own URL (spec 07).
 *
 * Reuses the Studio's `ResultsPane` rather than reimplementing the report, so the two can never
 * drift — a second copy of the KPI strip is a second place for a formatting bug to live.
 */
export function RunReportPage(): React.JSX.Element {
  const { runId } = useParams<{ runId: string }>();

  if (runId === undefined) {
    return <p className="p-6 text-sm text-destructive">No run id in the URL.</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <RunHeader runId={runId} />
      <div className="min-h-0 flex-1 overflow-hidden rounded border border-border">
        <ResultsPane runId={runId} />
      </div>
    </div>
  );
}

function RunHeader({ runId }: { readonly runId: string }): React.JSX.Element {
  const run = useQuery({ queryKey: ['run', runId], queryFn: () => fetchRun(runId) });
  const [copied, setCopied] = useState(false);

  const detail = run.data;

  return (
    <header className="flex flex-wrap items-center gap-2">
      <Link
        to="/runs"
        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> Runs
      </Link>

      {detail !== undefined && (
        <>
          <h1 className="text-sm font-semibold">
            {detail.strategy.name}{' '}
            <span className="font-normal text-muted">v{detail.strategy.version}</span>
          </h1>
          <span className="font-mono text-xs text-muted">
            {detail.config.symbol} {detail.config.timeframe} · {formatDate(detail.config.from)} →{' '}
            {formatDate(detail.config.to)}
          </span>
        </>
      )}

      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(window.location.href).then(() => {
              setCopied(true);
              setTimeout(() => {
                setCopied(false);
              }, 1_500);
            });
          }}
          title="Copy this run's URL"
          data-testid="copy-run-url"
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          {copied ? <Check className="size-3.5 text-accent" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy link'}
        </button>

        <ExportJsonButton runId={runId} />

        <Link
          to={`/studio?rerun=${runId}&mode=identical`}
          title="Re-run with exactly this configuration"
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <RotateCcw className="size-3.5" /> Re-run
        </Link>
        <Link
          to={`/studio?rerun=${runId}&mode=latest`}
          title="Re-run on the latest available data"
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <RefreshCw className="size-3.5" /> Latest data
        </Link>
      </div>
    </header>
  );
}

/**
 * JSON export (spec 05).
 *
 * Fetches the report, trades and series together so the file is self-contained — an export that
 * needed the API to be readable later would not be much of an export. Built on demand rather than
 * kept in memory, because the series alone can be tens of thousands of points.
 */
function ExportJsonButton({ runId }: { readonly runId: string }): React.JSX.Element {
  const [busy, setBusy] = useState(false);

  const exportJson = async (): Promise<void> => {
    setBusy(true);
    try {
      const [run, trades, series] = await Promise.all([
        fetchRun(runId),
        fetchRunTrades(runId),
        // Every point, not the downsampled view: this is an archive, not a chart.
        fetchRunSeries(runId, 20_000),
      ]);

      const payload = {
        exportedAt: new Date().toISOString(),
        run,
        trades: trades.trades,
        series,
      };

      const url = URL.createObjectURL(
        new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `edgelab-run-${runId.slice(0, 8)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => {
        void exportJson();
      }}
      disabled={busy}
      title="Export the full report as JSON"
      data-testid="export-json"
      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
    >
      <Download className="size-3.5" /> {busy ? 'Exporting…' : 'JSON'}
    </button>
  );
}
