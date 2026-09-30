import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Play, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  cancelValidation,
  fetchValidation,
  listValidations,
  startValidation,
  subscribeToJob,
  type CheckResultView,
  type ValidationDetail,
} from '@/lib/api';
import { CheckCard } from './CheckCard';
import { VerdictHeader } from './VerdictHeader';

/**
 * The "Integrity & Overfitting" tab.
 *
 * Past results load from the API rather than being re-run (step 2 persists them), so opening a run
 * that has been validated shows its verdict immediately. Running again is explicit.
 */

export interface IntegrityTabProps {
  readonly runId: string;
  /** Switch to the Chart tab and centre on an instant. */
  readonly onJumpToTime?: (atMs: number) => void;
  readonly onJumpToTrade?: (seq: number) => void;
}

interface ValidationReportShape {
  readonly results: readonly CheckResultView[];
  readonly headline: string;
}

export function IntegrityTab({
  runId,
  onJumpToTime,
  onJumpToTrade,
}: IntegrityTabProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [activeJob, setActiveJob] = useState<{ jobId: string; validationId: string } | null>(null);
  const [progress, setProgress] = useState<{ percent: number; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const history = useQuery({
    queryKey: ['validations', runId],
    queryFn: () => listValidations(runId),
  });

  const latestCompleted = history.data?.find((v) => v.state === 'completed');

  const detail = useQuery({
    queryKey: ['validation', latestCompleted?.id],
    queryFn: () => fetchValidation(latestCompleted!.id),
    enabled: latestCompleted !== undefined,
  });

  // Held in a ref so the effect below can dispose the previous subscription without listing the
  // disposer as a dependency, which would re-subscribe on every render.
  const disposeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (activeJob === null) return;

    disposeRef.current?.();
    const dispose = subscribeToJob(activeJob.jobId, {
      onProgress: (event) => {
        setProgress({ percent: event.percent, message: event.message });
        if (event.state === 'failed' || event.state === 'cancelled') {
          setError(event.error ?? event.state);
        }
      },
      onEnd: () => {
        setActiveJob(null);
        setProgress(null);
        void queryClient.invalidateQueries({ queryKey: ['validations', runId] });
      },
      onError: (message) => {
        setError(message);
      },
    });

    disposeRef.current = dispose;
    return dispose;
  }, [activeJob, queryClient, runId]);

  const run = async (): Promise<void> => {
    setError(null);
    try {
      const started = await startValidation(runId);
      setActiveJob({ jobId: started.jobId, validationId: started.validationId });
      setProgress({ percent: 0, message: 'queued' });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const cancel = async (): Promise<void> => {
    if (activeJob === null) return;
    try {
      await cancelValidation(activeJob.validationId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const report = reportOf(detail.data);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="integrity-tab">
      <div className="flex shrink-0 items-center gap-2 border-b border-border p-2">
        {activeJob === null ? (
          <button
            type="button"
            onClick={() => void run()}
            className="inline-flex items-center gap-1.5 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            data-testid="run-validation"
          >
            <Play className="h-3 w-3" />
            {latestCompleted === undefined ? 'Validate' : 'Validate again'}
          </button>
        ) : (
          <>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted">
              <Loader2 className="h-3 w-3 animate-spin" />
              {progress?.percent ?? 0}% — {progress?.message ?? 'starting'}
            </span>
            <button
              type="button"
              onClick={() => void cancel()}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted/10"
              data-testid="cancel-validation"
            >
              <X className="h-3 w-3" />
              Cancel
            </button>
          </>
        )}

        {latestCompleted?.elapsedMs != null && activeJob === null && (
          <span className="text-xs text-muted">
            last run {(latestCompleted.elapsedMs / 1000).toFixed(1)}s ago-ish
          </span>
        )}
      </div>

      {error !== null && (
        <p
          className="shrink-0 border-b border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-200"
          data-testid="validation-error"
        >
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {history.isLoading && <Centered>Loading…</Centered>}

        {!history.isLoading && latestCompleted === undefined && activeJob === null && (
          <Centered>
            This run has not been validated yet. Validation re-executes the strategy about thirty
            times, so it takes a few seconds.
          </Centered>
        )}

        {report !== null && detail.data !== undefined && (
          <>
            <VerdictHeader
              results={report.results as never}
              context={detail.data.context}
              seal={sealLine(detail.data)}
            />

            <div className="space-y-2 p-3">
              {report.results.map((check) => (
                <CheckCard
                  key={check.id}
                  check={check}
                  {...(onJumpToTime !== undefined ? { onJumpToTime } : {})}
                  {...(onJumpToTrade !== undefined ? { onJumpToTrade } : {})}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function reportOf(detail: ValidationDetail | undefined): ValidationReportShape | null {
  if (detail === undefined || detail.report === null) return null;
  const r = detail.report as Partial<ValidationReportShape>;
  return Array.isArray(r.results) ? (r as ValidationReportShape) : null;
}

/**
 * The seal line: which seal this verdict was obtained under, and how many times it had been viewed
 * by then (A38). Null when nothing was sealed, which the header then omits rather than showing
 * "no holdout" as though it were a finding.
 */
function sealLine(detail: ValidationDetail): { line: string; retiredCount: number } | null {
  const { holdoutId, holdoutViewCount } = detail.context;
  if (holdoutId === null) return null;

  const views = holdoutViewCount ?? 0;
  return {
    line:
      `Holdout seal ${holdoutId.slice(0, 8)} was in force, viewed ${String(views)} time(s) when ` +
      `this ran.` +
      (views > 0 ? ' Each view weakens it: data looked at repeatedly is in-sample data.' : ''),
    retiredCount: 0,
  };
}

function Centered({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <p className="max-w-md text-center text-xs leading-relaxed text-muted">{children}</p>
    </div>
  );
}
