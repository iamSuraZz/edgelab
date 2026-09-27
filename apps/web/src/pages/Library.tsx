import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, Loader2, Tag as TagIcon, Upload, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  createStrategy,
  fetchStrategy,
  fetchStrategyVersion,
  listStrategies,
  updateStrategy,
  type StrategyDetail,
} from '@/lib/api';
import { collapseUnchanged, diffLines, diffStats } from '@/lib/diff';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The Library (spec 07): saved strategies, their version history, a diff between any two
 * versions, tags, and `.pine` import/export.
 *
 * Versions are created by SAVING in the Studio, not here — this page is for looking back at what
 * you saved. So the actions it offers are the ones that only make sense with history in front of
 * you: compare two revisions, tag a strategy, take a copy out, bring one in.
 */
export function LibraryPage(): React.JSX.Element {
  const strategies = useQuery({ queryKey: ['strategies'], queryFn: listStrategies });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const rows = useMemo(() => {
    const all = strategies.data ?? [];
    const needle = filter.trim().toLowerCase();
    if (needle === '') return all;
    return all.filter(
      (s) =>
        s.name.toLowerCase().includes(needle) ||
        s.tags.some((t) => t.toLowerCase().includes(needle)),
    );
  }, [strategies.data, filter]);

  // Select the first strategy once the list arrives, so the page is never an empty right pane
  // next to a full list.
  const activeId = selectedId ?? rows[0]?.id ?? null;

  return (
    <div className="flex h-full min-h-0 gap-3 p-3">
      <aside className="flex w-72 shrink-0 flex-col gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold">Library</h1>
          <span className="text-xs text-muted">{strategies.data?.length ?? 0}</span>
          <div className="ml-auto">
            <ImportPineButton />
          </div>
        </div>

        <input
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
          }}
          placeholder="Filter by name or tag"
          aria-label="Filter strategies"
          data-testid="library-filter"
          className="rounded border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
        />

        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="strategy-list">
          {strategies.isPending && (
            <p className="p-3 text-xs text-muted">
              <Loader2 className="inline size-3 animate-spin" /> Loading…
            </p>
          )}

          {strategies.isError && (
            <p className="p-3 text-xs text-destructive">Could not reach the API. Is it running?</p>
          )}

          {strategies.isSuccess && rows.length === 0 && (
            <p className="p-3 text-xs leading-relaxed text-muted">
              {strategies.data.length === 0 ? (
                <>
                  Nothing saved yet. Open the{' '}
                  <Link to="/studio" className="text-accent underline">
                    Studio
                  </Link>{' '}
                  and press Ctrl/Cmd+S to save a version.
                </>
              ) : (
                <>No strategy matches “{filter}”.</>
              )}
            </p>
          )}

          <ul className="flex flex-col gap-1">
            {rows.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(s.id);
                  }}
                  aria-current={s.id === activeId ? 'true' : undefined}
                  className={cn(
                    'w-full rounded border px-2 py-1.5 text-left transition-colors',
                    s.id === activeId
                      ? 'border-accent bg-surface-hover'
                      : 'border-transparent hover:bg-surface-hover',
                  )}
                >
                  <span className="block truncate text-xs font-medium">{s.name}</span>
                  <span className="block truncate font-mono text-[10px] text-muted">
                    {s.versionCount} version{s.versionCount === 1 ? '' : 's'} ·{' '}
                    {formatDate(s.updatedAt)}
                    {s.latestVersion !== null && ` · ${s.latestVersion.pineVersion}`}
                  </span>
                  {s.tags.length > 0 && (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {s.tags.map((t) => (
                        <span key={t} className="rounded bg-surface px-1 text-[10px] text-muted">
                          {t}
                        </span>
                      ))}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <section className="min-h-0 min-w-0 flex-1 overflow-hidden rounded border border-border">
        {activeId === null ? (
          <p className="p-6 text-xs text-muted">Select a strategy to see its versions.</p>
        ) : (
          <StrategyDetailPane strategyId={activeId} />
        )}
      </section>
    </div>
  );
}

function StrategyDetailPane({ strategyId }: { readonly strategyId: string }): React.JSX.Element {
  const detail = useQuery({
    queryKey: ['strategy', strategyId],
    queryFn: () => fetchStrategy(strategyId),
  });

  // Compare the two newest versions by default: that is the change you most recently made, and
  // it is the diff you almost always want when you open the page.
  const [left, setLeft] = useState<string | null>(null);
  const [right, setRight] = useState<string | null>(null);

  if (detail.isPending) {
    return (
      <p className="p-6 text-xs text-muted">
        <Loader2 className="inline size-3 animate-spin" /> Loading…
      </p>
    );
  }
  if (detail.isError || detail.data === undefined) {
    return <p className="p-6 text-xs text-destructive">Could not load this strategy.</p>;
  }

  const versions = detail.data.versions;
  const rightId = right ?? versions[0]?.id ?? null;
  const leftId = left ?? versions[1]?.id ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">{detail.data.name}</h2>
        <span className="font-mono text-[11px] text-muted">
          {versions.length} version{versions.length === 1 ? '' : 's'} · created{' '}
          {formatDate(detail.data.createdAt)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {rightId !== null && (
            <ExportPineButton
              strategyId={strategyId}
              versionId={rightId}
              name={detail.data.name}
              version={versions.find((v) => v.id === rightId)?.version ?? 0}
            />
          )}
        </div>
      </header>

      <TagEditor strategy={detail.data} />

      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <label className="flex items-center gap-1">
          <span className="text-muted">Compare</span>
          <VersionSelect
            versions={versions}
            value={leftId}
            onChange={setLeft}
            label="Older version"
          />
        </label>
        <span className="text-muted">→</span>
        <VersionSelect
          versions={versions}
          value={rightId}
          onChange={setRight}
          label="Newer version"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {leftId === null || rightId === null ? (
          <p className="p-6 text-xs text-muted">
            Only one version so far — there is nothing to compare it against yet.
          </p>
        ) : (
          <VersionDiff strategyId={strategyId} leftId={leftId} rightId={rightId} />
        )}
      </div>
    </div>
  );
}

function VersionSelect({
  versions,
  value,
  onChange,
  label,
}: {
  readonly versions: StrategyDetail['versions'];
  readonly value: string | null;
  readonly onChange: (id: string) => void;
  readonly label: string;
}): React.JSX.Element {
  return (
    <select
      value={value ?? ''}
      aria-label={label}
      onChange={(e) => {
        onChange(e.target.value);
      }}
      className="rounded border border-border bg-surface px-2 py-1 font-mono text-[11px] outline-none focus:border-accent"
    >
      {versions.map((v) => (
        <option key={v.id} value={v.id}>
          v{v.version} · {formatDate(v.createdAt)}
        </option>
      ))}
    </select>
  );
}

/**
 * The diff itself.
 *
 * Both sources are fetched by version id, never reconstructed from the latest source plus
 * history — a stored version IS the record of what ran, and rebuilding it would let the page
 * show a diff that never existed.
 */
function VersionDiff({
  strategyId,
  leftId,
  rightId,
}: {
  readonly strategyId: string;
  readonly leftId: string;
  readonly rightId: string;
}): React.JSX.Element {
  const left = useQuery({
    queryKey: ['version', strategyId, leftId],
    queryFn: () => fetchStrategyVersion(strategyId, leftId),
    staleTime: Infinity,
  });
  const right = useQuery({
    queryKey: ['version', strategyId, rightId],
    queryFn: () => fetchStrategyVersion(strategyId, rightId),
    staleTime: Infinity,
  });

  const lines = useMemo(
    () =>
      left.data === undefined || right.data === undefined
        ? []
        : diffLines(left.data.source, right.data.source),
    [left.data, right.data],
  );
  const hunks = useMemo(() => collapseUnchanged(lines), [lines]);
  const stats = useMemo(() => diffStats(lines), [lines]);

  if (left.isPending || right.isPending) {
    return (
      <p className="p-6 text-xs text-muted">
        <Loader2 className="inline size-3 animate-spin" /> Loading sources…
      </p>
    );
  }
  if (left.isError || right.isError) {
    return <p className="p-6 text-xs text-destructive">Could not load one of the versions.</p>;
  }

  if (hunks.length === 0) {
    return (
      <p className="p-6 text-xs text-muted" data-testid="diff-identical">
        These two versions are identical.
        <br />
        <span className="text-[11px]">
          Expected: a version is only created when the source hash changes, so this means you picked
          the same one twice.
        </span>
      </p>
    );
  }

  return (
    <div data-testid="version-diff">
      <p className="px-3 py-2 font-mono text-[11px]">
        <span className="text-accent">+{stats.added}</span>{' '}
        <span className="text-destructive">−{stats.removed}</span>{' '}
        <span className="text-muted">lines</span>
      </p>

      <table className="w-full border-collapse font-mono text-[11px]">
        <tbody>
          {hunks.map((hunk, hi) => (
            <Hunk key={hi} gapBefore={hunk.gapBefore} lines={hunk.lines} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Hunk({
  gapBefore,
  lines,
}: {
  readonly gapBefore: number;
  readonly lines: readonly ReturnType<typeof diffLines>[number][];
}): React.JSX.Element {
  return (
    <>
      {gapBefore > 0 && (
        <tr>
          <td colSpan={3} className="bg-surface px-3 py-0.5 text-[10px] text-muted">
            ⋯ {gapBefore} unchanged line{gapBefore === 1 ? '' : 's'}
          </td>
        </tr>
      )}
      {lines.map((line, i) => (
        <tr
          key={i}
          className={cn(
            line.kind === 'added' && 'bg-accent/10',
            line.kind === 'removed' && 'bg-destructive/10',
          )}
        >
          <td className="w-10 select-none px-2 text-right text-muted">{line.oldLine ?? ''}</td>
          <td className="w-10 select-none px-2 text-right text-muted">{line.newLine ?? ''}</td>
          <td className="whitespace-pre px-2">
            <span
              className={cn(
                'select-none',
                line.kind === 'added' && 'text-accent',
                line.kind === 'removed' && 'text-destructive',
              )}
            >
              {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
            </span>
            {line.text}
          </td>
        </tr>
      ))}
    </>
  );
}

function TagEditor({ strategy }: { readonly strategy: StrategyDetail }): React.JSX.Element {
  const client = useQueryClient();
  const [draft, setDraft] = useState('');

  const save = useMutation({
    mutationFn: (tags: string[]) => updateStrategy(strategy.id, { tags }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['strategy', strategy.id] });
      void client.invalidateQueries({ queryKey: ['strategies'] });
    },
  });

  const add = (): void => {
    const tag = draft.trim();
    if (tag === '' || strategy.tags.includes(tag)) {
      setDraft('');
      return;
    }
    save.mutate([...strategy.tags, tag]);
    setDraft('');
  };

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2">
      <TagIcon className="size-3 text-muted" />
      {strategy.tags.map((tag) => (
        <span
          key={tag}
          className="flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 text-[11px]"
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            onClick={() => {
              save.mutate(strategy.tags.filter((t) => t !== tag));
            }}
            className="text-muted transition-colors hover:text-destructive"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}

      <input
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
        placeholder="Add a tag"
        aria-label="Add a tag"
        data-testid="tag-input"
        className="w-28 rounded border border-transparent bg-transparent px-1 text-[11px] outline-none focus:border-border"
      />
      {save.isPending && <Loader2 className="size-3 animate-spin text-muted" />}
      {save.isError && (
        <span className="text-[11px] text-destructive">
          {save.error instanceof Error ? save.error.message : 'Could not save tags'}
        </span>
      )}
    </div>
  );
}

/** Download one version as a `.pine` file. */
function ExportPineButton({
  strategyId,
  versionId,
  name,
  version,
}: {
  readonly strategyId: string;
  readonly versionId: string;
  readonly name: string;
  readonly version: number;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);

  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      const v = await fetchStrategyVersion(strategyId, versionId);
      const url = URL.createObjectURL(new Blob([v.source], { type: 'text/plain' }));
      const link = document.createElement('a');
      link.href = url;
      // Filename-safe: a strategy can legitimately be called "EMA 9/21 — long only", and a
      // slash in a download name silently truncates the file to the last segment.
      link.download = `${name.replace(/[^\w.-]+/g, '-')}-v${version}.pine`;
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
        void run();
      }}
      disabled={busy}
      title="Download this version as .pine"
      data-testid="export-pine"
      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
    >
      <Download className="size-3.5" /> {busy ? 'Exporting…' : '.pine'}
    </button>
  );
}

/**
 * Import a `.pine` file as a new strategy.
 *
 * Goes through `POST /strategies`, which compiles before storing — so a file that is not a Pine
 * script is rejected here with the compiler's own message rather than becoming a saved strategy
 * that fails the first time you try to run it.
 */
function ImportPineButton(): React.JSX.Element {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const create = useMutation({
    mutationFn: async (file: File) => {
      const source = await file.text();
      return createStrategy({ name: file.name.replace(/\.pine$/i, ''), source });
    },
    onSuccess: () => {
      setError(null);
      setOk(true);
      setTimeout(() => {
        setOk(false);
      }, 1_500);
      void client.invalidateQueries({ queryKey: ['strategies'] });
    },
    onError: (e: unknown) => {
      setError(e instanceof Error ? e.message : 'Import failed');
    },
  });

  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={create.isPending}
        title="Import a .pine file as a new strategy"
        data-testid="import-pine"
        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
      >
        {create.isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : ok ? (
          <Check className="size-3.5 text-accent" />
        ) : (
          <Upload className="size-3.5" />
        )}
        Import
      </button>
      <input
        ref={input}
        type="file"
        accept=".pine,.txt"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset so picking the SAME file twice still fires a change event — otherwise a failed
          // import cannot be retried without choosing something else first.
          e.target.value = '';
          if (file !== undefined) create.mutate(file);
        }}
      />
      {error !== null && (
        <p className="mt-1 text-[11px] text-destructive" data-testid="import-error">
          {error}
        </p>
      )}
    </>
  );
}
