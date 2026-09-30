import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { DownloadForm } from '@/components/data/DownloadForm';
import { CandlePreview } from '@/components/data/CandlePreview';
import { CoverageTable } from '@/components/data/CoverageTable';
import { ImportDropZone } from '@/components/data/ImportDropZone';
import { ProviderCards } from '@/components/data/ProviderCards';
import { fetchCoverage, listProviders, listSymbols } from '@/lib/api';

/**
 * The Data page (spec 02).
 *
 * Built in the order the page is actually used: what can I download from, download it, import a
 * file instead, what do I now hold, and does it look right.
 */
export function DataPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const providers = useQuery({ queryKey: ['providers'], queryFn: listProviders });
  const symbols = useQuery({ queryKey: ['symbols'], queryFn: listSymbols });
  const coverage = useQuery({ queryKey: ['coverage'], queryFn: fetchCoverage });
  const [preview, setPreview] = useState<string | null>(null);

  /*
   * Refetch coverage AND providers after a download: the bars changed, and so did the provider's
   * remaining credits. Showing a stale credit count right after spending some is how you plan a
   * backfill against a budget you no longer have.
   */
  const refreshAfterDownload = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['coverage'] });
    void queryClient.invalidateQueries({ queryKey: ['symbols'] });
    void queryClient.invalidateQueries({ queryKey: ['providers'] });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto" data-testid="data-page">
      <header>
        <h1 className="text-sm font-semibold">Data</h1>
        <p className="mt-0.5 text-xs text-muted">
          M1 is the only resolution stored; every other timeframe is resampled from it.
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Providers</h2>
        {providers.isLoading && (
          <p className="flex items-center gap-2 text-xs text-muted">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </p>
        )}
        {providers.error !== null && (
          <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {providers.error instanceof Error ? providers.error.message : String(providers.error)}
          </p>
        )}
        {providers.data !== undefined && <ProviderCards providers={providers.data} />}
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Download</h2>
        {providers.data !== undefined && symbols.data !== undefined && (
          <DownloadForm
            providers={providers.data}
            symbols={symbols.data}
            onFinished={refreshAfterDownload}
          />
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Import a file</h2>
        {symbols.data !== undefined && (
          <ImportDropZone symbols={symbols.data} onImported={refreshAfterDownload} />
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Coverage</h2>
        {coverage.data !== undefined && (
          <CoverageTable rows={coverage.data} onPreview={setPreview} />
        )}
      </section>

      {preview !== null && (
        <section className="space-y-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Preview</h2>
          <CandlePreview
            symbol={preview}
            onClose={() => {
              setPreview(null);
            }}
          />
        </section>
      )}
    </div>
  );
}
