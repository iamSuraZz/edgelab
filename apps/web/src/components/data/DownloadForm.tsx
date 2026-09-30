import { Download, Loader2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  cancelIngest,
  startIngest,
  subscribeToJob,
  type ProviderCard,
  type SymbolDto,
} from '@/lib/api';

/**
 * Fetch M1 history from a provider, with the download visible while it runs.
 *
 * Live progress rather than a spinner, because a backfill is minutes, not seconds, and a spinner
 * that has been turning for four minutes is indistinguishable from one that is stuck — which is
 * precisely how the verification sprint's dead-SSE bug survived.
 *
 * The form refuses to offer a provider that cannot serve the symbol, rather than letting the
 * request fail server-side: the API's message would be correct and the UI would still have invited
 * the mistake.
 */

export interface DownloadFormProps {
  readonly providers: readonly ProviderCard[];
  readonly symbols: readonly SymbolDto[];
  /** Called when a download finishes, so coverage can be refetched. */
  readonly onFinished: () => void;
}

interface Progress {
  readonly percent: number;
  readonly message: string;
}

export function DownloadForm({
  providers,
  symbols,
  onFinished,
}: DownloadFormProps): React.JSX.Element {
  const [symbol, setSymbol] = useState(symbols[0]?.symbol ?? '');
  const [preferred, setPreferred] = useState<string | null>(null);
  const [from, setFrom] = useState(defaultFrom());
  const [to, setTo] = useState(defaultTo());
  const [force, setForce] = useState(false);

  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const disposeRef = useRef<(() => void) | null>(null);

  const selected = symbols.find((s) => s.symbol === symbol);
  // A provider that does not cover this asset class cannot serve it, so it is not offered.
  const usable = providers.filter(
    (p) => p.enabled && (selected === undefined || p.assetClasses.includes(selected.assetClass)),
  );

  /*
   * DERIVED, not stored, so changing the symbol cannot leave a provider selected that cannot serve
   * it. Storing the effective provider meant an effect correcting it after the fact — a render
   * cascade, and a frame in which the form offered an impossible combination.
   */
  const provider = usable.some((p) => p.id === preferred) ? preferred! : (usable[0]?.id ?? '');

  useEffect(() => {
    if (jobId === null) return;

    disposeRef.current?.();
    const dispose = subscribeToJob(jobId, {
      onProgress: (event) => {
        setProgress({ percent: event.percent, message: event.message });
        if (event.state === 'failed' || event.state === 'cancelled') {
          setError(event.error ?? event.message);
        }
      },
      onEnd: () => {
        setJobId(null);
        setProgress(null);
        setDone(`${symbol} updated. Coverage below has been refreshed.`);
        onFinished();
      },
      onError: (message) => {
        setError(message);
      },
    });

    disposeRef.current = dispose;
    return dispose;
  }, [jobId, onFinished, symbol]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setDone(null);

    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (!(fromMs < toMs)) {
      setError('The start date must be before the end date.');
      return;
    }

    try {
      const started = await startIngest({ symbol, provider, from: fromMs, to: toMs, force });
      setJobId(started.jobId);
      setProgress({ percent: 0, message: 'queued' });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const running = jobId !== null;

  return (
    <form
      className="space-y-2 rounded-md border border-border p-3"
      onSubmit={(e) => void submit(e)}
      data-testid="download-form"
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Symbol">
          <select
            className={INPUT}
            value={symbol}
            onChange={(e) => {
              setSymbol(e.target.value);
            }}
            disabled={running}
            data-testid="download-symbol"
          >
            {symbols.map((s) => (
              <option key={s.symbol} value={s.symbol}>
                {s.symbol}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Provider">
          <select
            className={INPUT}
            value={provider}
            onChange={(e) => {
              setPreferred(e.target.value);
            }}
            disabled={running || usable.length === 0}
            data-testid="download-provider"
          >
            {usable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="From">
          <input
            type="date"
            className={INPUT}
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
            }}
            disabled={running}
            data-testid="download-from"
          />
        </Field>

        <Field label="To">
          <input
            type="date"
            className={INPUT}
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
            }}
            disabled={running}
            data-testid="download-to"
          />
        </Field>

        <div className="flex items-end gap-2">
          <button
            type="submit"
            disabled={running || provider === ''}
            className="inline-flex h-8 items-center gap-1.5 rounded bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            data-testid="download-start"
          >
            <Download className="size-3" />
            Download
          </button>
          {running && (
            <button
              type="button"
              onClick={() => void cancelIngest(jobId!).catch(() => undefined)}
              className="inline-flex h-8 items-center gap-1 rounded border border-border px-2 text-xs"
              data-testid="download-cancel"
            >
              <X className="size-3" /> Cancel
            </button>
          )}
        </div>
      </div>

      <label className="flex items-center gap-1.5 text-xs text-muted">
        <input
          type="checkbox"
          checked={force}
          onChange={(e) => {
            setForce(e.target.checked);
          }}
          disabled={running}
          data-testid="download-force"
        />
        {/*
          Ingest is resumable from the last stored bar, so the default re-fetches only what is
          missing. Forcing is for a feed you believe is wrong, not for a feed you believe is short.
        */}
        Re-fetch the whole range, ignoring what is already stored
      </label>

      {usable.length === 0 && (
        <p className="rounded bg-amber-500/10 p-1.5 text-xs text-amber-200">
          No enabled provider serves {selected?.assetClass ?? 'this asset class'}. Check the cards
          above — a provider that needs a key shows which variable to set.
        </p>
      )}

      {progress !== null && (
        <div data-testid="download-progress">
          <div className="flex items-center justify-between text-xs text-muted">
            <span className="flex items-center gap-1.5">
              <Loader2 className="size-3 animate-spin" />
              {progress.message}
            </span>
            <span className="tabular-nums">{progress.percent}%</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded bg-surface-hover">
            <div
              className="h-full bg-primary transition-[width] duration-300"
              style={{ width: `${String(Math.max(2, progress.percent))}%` }}
            />
          </div>
        </div>
      )}

      {error !== null && (
        <p
          className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
          data-testid="download-error"
        >
          {error}
        </p>
      )}

      {done !== null && (
        <p
          className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-200"
          data-testid="download-done"
        >
          {done}
        </p>
      )}
    </form>
  );
}

const INPUT =
  'h-8 w-full rounded border border-border bg-surface px-2 text-xs outline-none focus:border-primary';

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-[0.65rem] uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  );
}

/** A week back, which is the smallest range worth a round trip and the one spec 02's DONE WHEN uses. */
function defaultFrom(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

function defaultTo(): string {
  return new Date().toISOString().slice(0, 10);
}
