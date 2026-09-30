import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Play, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  cancelValidation,
  fetchValidation,
  listHoldoutTests,
  listValidations,
  startHoldoutTest,
  startValidation,
  subscribeToJob,
  type CheckResultView,
  type ValidationDetail,
} from '@/lib/api';
import { CheckCard } from './CheckCard';
import { CheckVisual } from './CheckVisual';
import { HoldoutAction, type HoldoutResultView } from './HoldoutAction';
import { VerdictHeader } from './VerdictHeader';

/**
 * The "Integrity & Overfitting" tab.
 *
 * Past results load from the API rather than being re-run (step 2 persists them), so opening a run
 * that has been validated shows its verdict immediately. Running again is explicit.
 */

/** Checks that own a visual. Keeps the card from rendering an empty expandable section. */
const VISUAL_CHECKS = new Set([
  'execution-cost-stress',
  'execution-intrabar-replay',
  'overfitting-oos-split',
  'overfitting-rolling-oos',
  'overfitting-regimes',
  'overfitting-timeframe-matrix',
  'overfitting-monte-carlo',
]);

export interface IntegrityTabProps {
  readonly runId: string;
  readonly currency: string;
  readonly pipSize: number;
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
  currency,
  pipSize,
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

  /*
   * Holdout tests are listed separately from validations, because they are a different KIND (A59):
   * a validation can be re-run for free, a holdout test cannot. Folding them together would let
   * the one irreversible result scroll away among sixteen repeatable ones.
   */
  const holdouts = useQuery({
    queryKey: ['holdout-tests', runId],
    queryFn: () => listHoldoutTests(runId),
  });

  const latestHoldout = holdouts.data?.find((v) => v.state === 'completed');
  const latestCompleted = history.data?.find((v) => v.state === 'completed');

  const detail = useQuery({
    queryKey: ['validation', latestCompleted?.id],
    queryFn: () => fetchValidation(latestCompleted!.id),
    enabled: latestCompleted !== undefined,
  });

  const latestHoldoutDetail = useQuery({
    queryKey: ['validation', latestHoldout?.id],
    queryFn: () => fetchValidation(latestHoldout!.id),
    enabled: latestHoldout !== undefined,
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
        void queryClient.invalidateQueries({ queryKey: ['holdout-tests', runId] });
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

  /**
   * Spend a look at the holdout.
   *
   * Deliberately shares the job plumbing with `run` — same progress, same cancel, same refetch —
   * because it IS the same kind of work from the UI's side. What makes it different is the
   * confirmation in front of it and the fact that the count it produces is permanent.
   */
  const runHoldoutTest = async (): Promise<void> => {
    setError(null);
    try {
      const started = await startHoldoutTest(runId, 'overfitting-holdout');
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
            <span
              className="inline-flex items-center gap-1.5 text-xs text-muted"
              data-testid="validation-progress"
            >
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
          <div data-testid="validation-report">
            <VerdictHeader
              results={report.results as never}
              context={detail.data.context}
              seal={sealLine(detail.data)}
            />

            <div className="space-y-2 p-3">
              {detail.data.context.holdoutId !== null && (
                <HoldoutAction
                  sealedFromMs={detail.data.context.rangeToMs}
                  viewCount={detail.data.context.holdoutViewCount ?? 0}
                  // Not carried on the validation context; the holdout check's own card reports it.
                  retiredSeals={null}
                  busy={activeJob !== null}
                  lastResult={holdoutResultOf(latestHoldoutDetail.data)}
                  onTestOnHoldout={() => void runHoldoutTest()}
                />
              )}
              {report.results.map((check) => {
                const visual = (
                  <CheckVisual
                    checkId={check.id}
                    detail={detail.data as ValidationDetail}
                    currency={currency}
                    pipSize={pipSize}
                    {...(onJumpToTime === undefined ? {} : { onJumpToTime })}
                    {...(onJumpToTrade === undefined ? {} : { onJumpToTrade })}
                  />
                );
                return (
                  <CheckCard
                    key={check.id}
                    check={check}
                    {...(VISUAL_CHECKS.has(check.id) ? { visual } : {})}
                    {...(onJumpToTime !== undefined ? { onJumpToTime } : {})}
                    {...(onJumpToTrade !== undefined ? { onJumpToTrade } : {})}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The holdout test's verdict, as the action panel needs it.
 *
 * Read from the STORED report rather than recomputed, so what the panel says is what the job
 * concluded — including the view count that qualified it (A59).
 */
function holdoutResultOf(detail: ValidationDetail | undefined): HoldoutResultView | null {
  if (detail === undefined || detail.report === null) return null;
  const r = detail.report as {
    result?: { verdict?: string; explanation?: string; retention?: number | null };
    viewCountAfter?: number;
    sealedFromMs?: number;
    sealedToMs?: number;
  };
  if (r.result?.verdict === undefined) return null;

  return {
    verdict: r.result.verdict,
    explanation: r.result.explanation ?? '',
    retention: r.result.retention ?? null,
    viewCountAfter: r.viewCountAfter ?? 0,
    ranAtMs: detail.completedAtMs,
    sealedFromMs: r.sealedFromMs ?? null,
    sealedToMs: r.sealedToMs ?? null,
  };
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
