import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';

import { ProviderCards } from '@/components/data/ProviderCards';
import { listProviders } from '@/lib/api';

/**
 * The Data page (spec 02).
 *
 * Built in the order the page is actually used: what can I download from, download it, import a
 * file instead, what do I now hold, and does it look right.
 */
export function DataPage(): React.JSX.Element {
  const providers = useQuery({ queryKey: ['providers'], queryFn: listProviders });

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
    </div>
  );
}
