import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, X, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { EditorPane } from '@/components/studio/EditorPane';
import { ResultsPane } from '@/components/studio/ResultsPane';
import { SettingsPane } from '@/components/studio/SettingsPane';
import { SplitPane } from '@/components/ui/panes';
import { ApiClientError, cancelRun, createBacktest, subscribeToJob } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useStudio } from '@/stores/studio';

/**
 * The Studio: editor | settings | results.
 *
 * Nested splits rather than a three-way one, because the natural gesture is "give the editor more
 * room" or "give results more room" — two independent decisions, each remembered separately.
 */
export function StudioPage(): React.JSX.Element {
  const [toast, setToast] = useState<{ message: string; kind: 'ok' | 'error' } | null>(null);

  const source = useStudio((s) => s.source);
  const settings = useStudio((s) => s.settings);
  const inputs = useStudio((s) => s.inputs);
  const strategyName = useStudio((s) => s.strategyName);
  const liveRun = useStudio((s) => s.liveRun);
  const setLiveRun = useStudio((s) => s.setLiveRun);
  const patchLiveRun = useStudio((s) => s.patchLiveRun);
  const setLastRunId = useStudio((s) => s.setLastRunId);

  const queryClient = useQueryClient();
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const showToast = useCallback((message: string, kind: 'ok' | 'error') => {
    setToast({ message, kind });
  }, []);

  // Errors linger; successes do not. A failure message is something you need time to read, and
  // one that vanished after three seconds would be worse than none.
  useEffect(() => {
    if (toast === null || toast.kind === 'error') return undefined;
    const timer = setTimeout(() => {
      setToast(null);
    }, 3_000);
    return () => {
      clearTimeout(timer);
    };
  }, [toast]);

  // Drop the SSE subscription when the page unmounts, or the EventSource keeps reconnecting for
  // a run nobody is watching.
  useEffect(
    () => () => {
      unsubscribeRef.current?.();
    },
    [],
  );

  const run = useCallback(async () => {
    if (source.trim() === '') {
      showToast('Nothing to run — load an example or paste a script.', 'error');
      return;
    }

    unsubscribeRef.current?.();
    setLiveRun(null);

    try {
      const created = await createBacktest({
        source,
        ...(strategyName.trim() === '' ? {} : { name: strategyName }),
        symbol: settings.symbol,
        timeframe: settings.timeframe,
        from: settings.fromMs,
        to: settings.toMs,
        initialCapital: settings.initialCapital,
        accountCurrency: settings.accountCurrency,
        costs: settings.costs,
        inputs,
        props: {},
        warmupBars: settings.warmupBars,
        rfAnnual: settings.rfAnnual,
        lots: settings.lots,
        leverage: settings.leverage,
      });

      setLiveRun({
        runId: created.runId,
        jobId: created.jobId,
        state: 'queued',
        percent: 0,
        message: 'queued',
        error: null,
      });

      unsubscribeRef.current = subscribeToJob(created.jobId, {
        onProgress: (event) => {
          patchLiveRun({
            state: event.state,
            percent: event.percent,
            message: event.message,
            error: event.error ?? null,
          });
        },
        onEnd: () => {
          // Read the run back regardless of outcome: the report page renders a failure using the
          // API's own error message, so even a failed run has something to show.
          setLastRunId(created.runId);
          void queryClient.invalidateQueries({ queryKey: ['run', created.runId] });

          const finished = useStudio.getState().liveRun;
          if (finished?.state === 'failed') {
            showToast(finished.error ?? 'The run failed.', 'error');
          } else if (finished?.state === 'cancelled') {
            showToast('Run cancelled.', 'ok');
          }
          setLiveRun(null);
        },
        onError: (message) => {
          showToast(message, 'error');
        },
      });
    } catch (error: unknown) {
      // The API's real message, verbatim — "No symbol EURUSD", "EURUSD is quoted in USD but the
      // account is in EUR", the failing zod field. Replacing it with "Run failed" is the one
      // thing that would make this unusable.
      showToast(error instanceof ApiClientError ? error.message : String(error), 'error');
      setLiveRun(null);
    }
  }, [
    source,
    strategyName,
    settings,
    inputs,
    setLiveRun,
    patchLiveRun,
    setLastRunId,
    queryClient,
    showToast,
  ]);

  const cancel = useCallback(async () => {
    const current = useStudio.getState().liveRun;
    if (current === null) return;
    try {
      await cancelRun(current.runId);
      patchLiveRun({ message: 'cancelling…' });
    } catch (error: unknown) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }, [patchLiveRun, showToast]);

  // Ctrl/Cmd+Enter runs, from anywhere including inside the editor.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        void run();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [run]);

  const running = liveRun !== null && liveRun.state !== 'completed' && liveRun.state !== 'failed';

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="studio">
      {liveRun !== null && <ProgressBar percent={liveRun.percent} message={liveRun.message} />}

      <SplitPane
        storageKey="edgelab.studio.outer"
        defaultRatio={0.46}
        minRatio={0.25}
        className="min-h-0 flex-1"
        left={
          <SplitPane
            storageKey="edgelab.studio.inner"
            defaultRatio={0.62}
            minRatio={0.3}
            className="min-h-0 flex-1 border-r border-border"
            left={<EditorPane onToast={showToast} />}
            right={
              <SettingsPane
                onRun={() => {
                  void run();
                }}
                onCancel={() => {
                  void cancel();
                }}
                running={running}
              />
            }
          />
        }
        right={<ResultsPane />}
      />

      {toast !== null && (
        <Toast
          message={toast.message}
          kind={toast.kind}
          onDismiss={() => {
            setToast(null);
          }}
        />
      )}
    </div>
  );
}

function ProgressBar({
  percent,
  message,
}: {
  readonly percent: number;
  readonly message: string;
}): React.JSX.Element {
  return (
    <div className="shrink-0 border-b border-border bg-surface" data-testid="run-progress">
      <div className="flex items-center gap-2 px-3 py-1">
        <span className="text-[11px] tabular-nums text-muted">{Math.round(percent)}%</span>
        <span className="truncate text-[11px] text-muted">{message}</span>
      </div>
      <div className="h-0.5 bg-border">
        <div
          className="h-full bg-primary transition-[width] duration-200"
          style={{ width: `${String(Math.max(2, percent))}%` }}
        />
      </div>
    </div>
  );
}

function Toast({
  message,
  kind,
  onDismiss,
}: {
  readonly message: string;
  readonly kind: 'ok' | 'error';
  readonly onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={`toast-${kind}`}
      className={cn(
        'fixed bottom-4 right-4 z-50 flex max-w-lg items-start gap-2 rounded-md border px-3 py-2 shadow-xl',
        kind === 'error'
          ? 'border-destructive/50 bg-destructive/15 text-destructive'
          : 'border-accent/50 bg-accent/15 text-accent',
      )}
    >
      {kind === 'error' ? (
        <XCircle className="mt-0.5 size-4 shrink-0" />
      ) : (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
      )}
      {/* Wraps and preserves newlines: an API message can be a sentence, not a label. */}
      <p className="min-w-0 whitespace-pre-wrap text-xs leading-snug">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="ml-1 shrink-0 opacity-60 transition-opacity hover:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
