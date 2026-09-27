import Editor, { type OnMount } from '@monaco-editor/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type * as monacoNs from 'monaco-editor';
import { AlertTriangle, Check, ChevronDown, Loader2, Save, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Panel } from '@/components/ui/panes';
import {
  ApiClientError,
  addStrategyVersion,
  compilePine,
  createStrategy,
  fetchFixtures,
  type CompileResponse,
  type DiagnosticDto,
} from '@/lib/api';
import { PINE_LANGUAGE_ID, registerPineLanguage } from '@/lib/pine-language';
import { cn } from '@/lib/utils';
import { useStudio } from '@/stores/studio';
import { useThemeStore } from '@/stores/theme';

/** Long enough that typing is not interrupted, short enough that errors feel immediate. */
const COMPILE_DEBOUNCE_MS = 450;

export function EditorPane({
  onToast,
}: {
  readonly onToast: (message: string, kind: 'ok' | 'error') => void;
}): React.JSX.Element {
  const source = useStudio((s) => s.source);
  const setSource = useStudio((s) => s.setSource);
  const setCompileResult = useStudio((s) => s.setCompileResult);
  const setCompiling = useStudio((s) => s.setCompiling);
  const diagnostics = useStudio((s) => s.diagnostics);
  const compiling = useStudio((s) => s.compiling);
  const strategyId = useStudio((s) => s.strategyId);
  const strategyName = useStudio((s) => s.strategyName);
  const setStrategy = useStudio((s) => s.setStrategy);
  const theme = useThemeStore((s) => s.theme);

  const editorRef = useRef<monacoNs.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof monacoNs | null>(null);
  const [compileMeta, setCompileMeta] = useState<CompileResponse['meta'] | null>(null);

  const fixtures = useQuery({
    queryKey: ['fixtures'],
    queryFn: fetchFixtures,
    staleTime: Infinity,
  });

  /* ------------------------------------------------------------- compiling */

  // Debounced compile. The AbortController matters: typing fast enqueues several compiles, and
  // without cancelling the earlier ones a slow response can land after a newer one and overwrite
  // the markers with stale diagnostics.
  useEffect(() => {
    const controller = new AbortController();

    // Everything, including the empty-source reset, happens inside the timer rather than in the
    // effect body. A synchronous setState here would cascade an extra render on every keystroke.
    const timer = setTimeout(() => {
      if (source.trim() === '') {
        setCompileResult([], []);
        setCompileMeta(null);
        return;
      }

      setCompiling(true);
      compilePine(source, controller.signal)
        .then((result) => {
          setCompileResult(result.meta.inputs, result.diagnostics);
          setCompileMeta(result.meta);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          // A failed compile REQUEST is not a failed compile — the API being down should not be
          // rendered as a syntax error on line 1.
          setCompileResult(
            [],
            [
              {
                line: null,
                col: null,
                severity: 'error',
                message: error instanceof Error ? error.message : String(error),
                code: 'compile-request-failed',
              },
            ],
          );
        })
        .finally(() => {
          setCompiling(false);
        });
    }, COMPILE_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [source, setCompileResult, setCompiling]);

  /* --------------------------------------------------------- inline markers */

  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (monaco === null || model === null || model === undefined) return;

    monaco.editor.setModelMarkers(
      model,
      'pine-compile',
      diagnostics
        // A diagnostic with no line cannot be placed in the gutter; the Compatibility panel
        // below shows those instead of pinning them to an arbitrary line.
        .filter((d) => d.line !== null)
        .map((d) => {
          const line = Math.max(1, Math.min(d.line!, model.getLineCount()));
          return {
            severity:
              d.severity === 'error'
                ? monaco.MarkerSeverity.Error
                : d.severity === 'warning'
                  ? monaco.MarkerSeverity.Warning
                  : monaco.MarkerSeverity.Info,
            message: d.message,
            startLineNumber: line,
            endLineNumber: line,
            startColumn: d.col ?? 1,
            endColumn: model.getLineMaxColumn(line),
          };
        }),
    );
  }, [diagnostics]);

  /* -------------------------------------------------------------- saving */

  const save = useMutation({
    mutationFn: async () => {
      if (source.trim() === '') throw new Error('Nothing to save.');

      if (strategyId !== null) {
        const result = await addStrategyVersion(strategyId, source);
        return { version: result.version, created: result.created, strategyId };
      }

      const name =
        strategyName.trim() !== ''
          ? strategyName
          : (compileMeta?.title ?? `Untitled ${new Date().toISOString().slice(0, 10)}`);
      const result = await createStrategy({ name, source });
      return { version: result.version, created: true, strategyId: result.strategyId, name };
    },
    onSuccess: (result) => {
      setStrategy(
        result.strategyId,
        'name' in result ? (result.name ?? strategyName) : strategyName,
      );
      onToast(
        result.created
          ? `Saved as version ${String(result.version)}.`
          : `Unchanged — still version ${String(result.version)}.`,
        'ok',
      );
    },
    onError: (error: unknown) => {
      onToast(error instanceof Error ? error.message : String(error), 'error');
    },
  });

  // Ctrl/Cmd+S on the window, not just inside Monaco: the shortcut should work wherever focus is,
  // and the browser's own Save dialog has to be suppressed either way.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save.mutate();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [save]);

  const onMount = useCallback<OnMount>((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    registerPineLanguage(monaco);
    monaco.editor.setModelLanguage(editor.getModel()!, PINE_LANGUAGE_ID);
  }, []);

  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity !== 'error');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Panel
        title="Editor"
        actions={
          <>
            <FixtureMenu
              fixtures={fixtures.data ?? []}
              onPick={(fixture) => {
                setSource(fixture.source);
                // A fixture is a fresh script, not a new version of whatever was open.
                setStrategy(null, fixture.name);
                onToast(`Loaded "${fixture.name}".`, 'ok');
              }}
            />
            <button
              type="button"
              onClick={() => {
                save.mutate();
              }}
              disabled={save.isPending || source.trim() === ''}
              title="Save a version (Ctrl/Cmd+S)"
              data-testid="save-version"
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
            >
              {save.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              Save
            </button>
            <CompileBadge compiling={compiling} errors={errors.length} warnings={warnings.length} />
          </>
        }
        className="min-h-0 flex-1"
        bodyClassName="overflow-hidden"
      >
        <Editor
          value={source}
          onChange={(value) => {
            setSource(value ?? '');
          }}
          language={PINE_LANGUAGE_ID}
          theme={theme === 'dark' ? 'edgelab-dark' : 'edgelab-light'}
          onMount={onMount}
          loading={<div className="p-4 text-xs text-muted">Loading editor…</div>}
          options={{
            fontSize: 13,
            fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
            fontLigatures: false,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            renderWhitespace: 'selection',
            // D1: TradingView rejects indentation that is not a multiple of 4, so the editor
            // produces 4 spaces and never a tab.
            tabSize: 4,
            insertSpaces: true,
            detectIndentation: false,
            rulers: [100],
            smoothScrolling: true,
            padding: { top: 10, bottom: 10 },
            automaticLayout: true,
            bracketPairColorization: { enabled: true },
            suggest: { showWords: false },
          }}
        />
      </Panel>

      <CompatibilityPanel diagnostics={diagnostics} meta={compileMeta} />
    </div>
  );
}

/* ------------------------------------------------------------------- pieces */

function CompileBadge({
  compiling,
  errors,
  warnings,
}: {
  readonly compiling: boolean;
  readonly errors: number;
  readonly warnings: number;
}): React.JSX.Element {
  if (compiling) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted">
        <Loader2 className="size-3.5 animate-spin" /> compiling
      </span>
    );
  }
  if (errors > 0) {
    return (
      <span
        className="flex items-center gap-1 text-xs text-destructive"
        data-testid="compile-status"
      >
        <XCircle className="size-3.5" /> {errors} error{errors === 1 ? '' : 's'}
      </span>
    );
  }
  if (warnings > 0) {
    return (
      <span className="flex items-center gap-1 text-xs text-amber-500" data-testid="compile-status">
        <AlertTriangle className="size-3.5" /> {warnings} warning{warnings === 1 ? '' : 's'}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-accent" data-testid="compile-status">
      <Check className="size-3.5" /> compiles
    </span>
  );
}

function FixtureMenu({
  fixtures,
  onPick,
}: {
  readonly fixtures: readonly { id: string; name: string; description: string; source: string }[];
  readonly onPick: (fixture: { name: string; source: string }) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);

  // Close on any outside click. A dropdown that only closes on a second click of its own button
  // is the kind of small wrongness that makes a UI feel unfinished.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (): void => {
      setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        type="button"
        onPointerDown={(event) => {
          event.stopPropagation();
          setOpen((o) => !o);
        }}
        data-testid="fixtures-menu"
        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        Examples <ChevronDown className="size-3" />
      </button>

      {open && (
        <div
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          className="absolute right-0 z-50 mt-1 w-80 overflow-hidden rounded-md border border-border bg-background shadow-xl"
        >
          {fixtures.length === 0 ? (
            <p className="p-3 text-xs text-muted">No examples available.</p>
          ) : (
            fixtures.map((fixture) => (
              <button
                key={fixture.id}
                type="button"
                data-testid={`fixture-${fixture.id}`}
                onClick={() => {
                  onPick(fixture);
                  setOpen(false);
                }}
                className="block w-full border-b border-border px-3 py-2 text-left transition-colors last:border-0 hover:bg-surface-hover"
              >
                <span className="block text-xs font-medium">{fixture.name}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted">
                  {fixture.description}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The Compatibility panel from spec 03: unsupported features and anything that diverges from
 * TradingView.
 *
 * Warnings get as much room as errors on purpose. The PineTS divergences this surfaces —
 * `process_orders_on_close` being silently ignored, indentation TradingView would reject — do not
 * stop a run, they just make its numbers differ from TradingView's, which is far more dangerous
 * than an error you cannot miss.
 */
function CompatibilityPanel({
  diagnostics,
  meta,
}: {
  readonly diagnostics: readonly DiagnosticDto[];
  readonly meta: CompileResponse['meta'] | null;
}): React.JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false);
  if (diagnostics.length === 0 && meta === null) return null;

  const errors = diagnostics.filter((d) => d.severity === 'error');
  const others = diagnostics.filter((d) => d.severity !== 'error');

  return (
    <div className="shrink-0 border-t border-border bg-surface">
      <button
        type="button"
        onClick={() => {
          setCollapsed((c) => !c);
        }}
        className="flex h-8 w-full items-center gap-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted hover:text-foreground"
      >
        <ChevronDown className={cn('size-3 transition-transform', collapsed && '-rotate-90')} />
        Compatibility
        {meta?.kind !== null && meta !== null && (
          <span className="ml-1 font-normal normal-case tracking-normal">
            {meta.kind} · Pine v{meta.version ?? '?'}
            {meta.title === null ? '' : ` · ${meta.title}`}
          </span>
        )}
      </button>

      {!collapsed && (
        <div className="max-h-44 overflow-auto px-3 pb-2" data-testid="compatibility-panel">
          {diagnostics.length === 0 ? (
            <p className="py-1 text-xs text-muted">
              No compatibility warnings. The script compiles and uses nothing PineTS diverges on.
            </p>
          ) : (
            <ul className="space-y-1 py-1">
              {[...errors, ...others].map((d, i) => (
                <li
                  key={`${String(d.line)}-${String(i)}`}
                  className="flex gap-2 text-xs leading-snug"
                >
                  {d.severity === 'error' ? (
                    <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                  ) : (
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                  )}
                  <span className="min-w-0">
                    {d.line !== null && (
                      <span className="mr-1 font-mono text-muted">line {d.line}</span>
                    )}
                    <span className="text-foreground/90">{d.message}</span>
                    {d.code !== undefined && (
                      <span className="ml-1 font-mono text-[10px] text-muted">({d.code})</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export { ApiClientError };
