import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Play } from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  fetchValidation,
  listOptimizations,
  startOptimization,
  subscribeToJob,
  type OptimizationSpecInput,
  type ValidationDetail,
} from '@/lib/api';
import { Figure, Withheld } from './Withheld';

/**
 * Walk-forward optimisation: the setup form, the ETA, and the result.
 *
 * Opt-in because it is 1,204 engine runs at the cap — minutes, not seconds — so it never starts on
 * its own. The ETA is shown BEFORE anything runs, because a progress bar with no horizon is
 * indistinguishable from a hang.
 *
 * The result is read as a procedure, not a parameter set: drift is reported beside the returns
 * because an optimum that jumps across its range each fold has found whatever the last window
 * rewarded, and the sensitivity grid is shown because the winning cell alone cannot distinguish a
 * plateau from a spike.
 */

export interface OptimizationPanelProps {
  readonly runId: string;
  /** Numeric inputs the script declares, for prefilling. Keyed by InputSpec key. */
  readonly inputs: readonly {
    readonly key: string;
    readonly title: string;
    readonly type: string;
    readonly default: unknown;
    readonly min?: number;
    readonly max?: number;
    readonly step?: number;
  }[];
}

interface Draft extends OptimizationSpecInput {
  readonly enabled: boolean;
  readonly title: string;
}

export function OptimizationPanel({ runId, inputs }: OptimizationPanelProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const numeric = inputs.filter((i) => i.type === 'int' || i.type === 'float');

  const [drafts, setDrafts] = useState<Draft[]>(() =>
    numeric.slice(0, 6).map((i, index) => ({
      // Prefilled from the script's own declared bounds. A range invented without looking usually
      // either misses the interesting region or sweeps values the script rejects.
      enabled: index < 2,
      name: i.key,
      title: i.title,
      min: i.min ?? suggest(i.default, 0.5),
      max: i.max ?? suggest(i.default, 2),
      step: i.step ?? (i.type === 'int' ? 1 : 0.1),
    })),
  );
  const [objective, setObjective] = useState<'netProfit' | 'profitFactor' | 'sharpe'>('netProfit');
  const [minTrades, setMinTrades] = useState(20);
  const [job, setJob] = useState<{ jobId: string; id: string } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<{ combinations: number; gridSize: number } | null>(null);

  const history = useQuery({
    queryKey: ['optimizations', runId],
    queryFn: () => listOptimizations(runId),
  });
  const latest = history.data?.find((o) => o.state === 'completed');
  const detail = useQuery({
    queryKey: ['optimization', latest?.id],
    queryFn: () => fetchValidation(latest!.id),
    enabled: latest !== undefined,
  });

  const chosen = drafts.filter((d) => d.enabled);
  const localCombinations = chosen.reduce(
    (n, d) => n * Math.max(1, Math.floor((d.max - d.min) / Math.max(1e-9, d.step)) + 1),
    1,
  );

  useEffect(() => {
    if (job === null) return;
    return subscribeToJob(job.jobId, {
      onProgress: (e) => {
        setProgress(`${e.percent}% — ${e.message}`);
      },
      onEnd: () => {
        setJob(null);
        setProgress(null);
        void queryClient.invalidateQueries({ queryKey: ['optimizations', runId] });
      },
      onError: setError,
    });
  }, [job, queryClient, runId]);

  const start = async (): Promise<void> => {
    setError(null);
    try {
      const started = await startOptimization(runId, {
        inputs: chosen.map(({ name, min, max, step }) => ({ name, min, max, step })),
        objective,
        minTrades,
      });
      setEstimate({ combinations: started.combinations, gridSize: started.gridSize });
      setJob({ jobId: started.jobId, id: started.validationId });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (numeric.length === 0) {
    return (
      <Withheld>This script declares no numeric inputs, so there is nothing to sweep.</Withheld>
    );
  }

  return (
    <div className="space-y-3" data-testid="optimization-panel">
      <table className="w-full text-xs">
        <thead className="text-muted">
          <tr className="border-b border-border">
            <th className="py-1 text-left font-normal">Sweep</th>
            <th className="py-1 text-left font-normal">Input</th>
            <th className="py-1 text-right font-normal">Min</th>
            <th className="py-1 text-right font-normal">Max</th>
            <th className="py-1 text-right font-normal">Step</th>
          </tr>
        </thead>
        <tbody>
          {drafts.map((d, i) => (
            <tr key={d.name} className="border-b border-border/40">
              <td className="py-1">
                <input
                  type="checkbox"
                  checked={d.enabled}
                  // Three is the cap: a fourth dimension multiplies the run count without making
                  // the result more trustworthy, and the API refuses it anyway.
                  disabled={!d.enabled && chosen.length >= 3}
                  onChange={(e) => {
                    setDrafts((prev) =>
                      prev.map((p, j) => (i === j ? { ...p, enabled: e.target.checked } : p)),
                    );
                  }}
                  data-testid={`sweep-${d.name}`}
                />
              </td>
              <td className="py-1">
                <span className="font-mono">{d.name}</span>{' '}
                <span className="text-muted">{d.title}</span>
              </td>
              {(['min', 'max', 'step'] as const).map((field) => (
                <td key={field} className="py-1 text-right">
                  <input
                    type="number"
                    value={d[field]}
                    disabled={!d.enabled}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setDrafts((prev) => prev.map((p, j) => (i === j ? { ...p, [field]: v } : p)));
                    }}
                    className="w-16 rounded border border-border bg-transparent px-1 text-right tabular-nums disabled:opacity-40"
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          Objective
          <select
            value={objective}
            onChange={(e) => {
              setObjective(e.target.value as typeof objective);
            }}
            className="rounded border border-border bg-transparent px-1 py-0.5"
          >
            <option value="netProfit">net profit</option>
            <option value="profitFactor">profit factor</option>
            <option value="sharpe">Sharpe</option>
          </select>
        </label>

        <label className="flex items-center gap-1">
          Min trades
          <input
            type="number"
            value={minTrades}
            onChange={(e) => {
              setMinTrades(Number(e.target.value));
            }}
            className="w-16 rounded border border-border bg-transparent px-1 text-right tabular-nums"
          />
        </label>

        {/*
          The ETA before start. 1,204 runs is minutes, and the cost model is fitted to two measured
          runs (~11s pool startup + ~444ms per run per thread), so this is arithmetic on a
          measurement rather than a guess.
        */}
        <span className="text-muted">
          {localCombinations} combination(s) x 4 folds ≈{' '}
          {formatEta(11 + ((localCombinations + 1) * 4 * 0.444) / 7)}
        </span>

        {job === null ? (
          <button
            type="button"
            onClick={() => void start()}
            disabled={chosen.length === 0}
            className="inline-flex items-center gap-1.5 rounded bg-primary px-2.5 py-1 font-medium text-primary-foreground disabled:opacity-40"
            data-testid="run-optimization"
          >
            <Play className="h-3 w-3" />
            Optimise
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-muted">
            <Loader2 className="h-3 w-3 animate-spin" />
            {progress ?? 'starting'}
          </span>
        )}
      </div>

      {estimate !== null && estimate.combinations < estimate.gridSize && (
        <p className="text-xs text-amber-300">
          The grid holds {estimate.gridSize} combinations; {estimate.combinations} were SAMPLED from
          across it rather than taking the first — truncating would sweep one input thoroughly and
          never move the others.
        </p>
      )}

      {error !== null && <p className="text-xs text-rose-300">{error}</p>}

      {detail.data !== undefined && <OptimizationResult detail={detail.data} />}
    </div>
  );
}

interface FoldRow {
  readonly index: number;
  readonly winner: Record<string, number> | null;
  readonly inSample: { readonly returnPct: number | null } | null;
  readonly outOfSample: { readonly returnPct: number | null } | null;
  readonly wfe: number | null;
  readonly wfeStable: boolean;
  readonly assessable: boolean;
}

function OptimizationResult({ detail }: { detail: ValidationDetail }): React.JSX.Element | null {
  const report = detail.report as {
    result?: {
      folds?: FoldRow[];
      drift?: { name: string; values: number[]; meanStepFraction: number }[];
      stitchedEquity?: { foldIndex: number; cumulativeReturnPct: number }[];
      sensitivity?: {
        inputA: string;
        inputB: string;
        cells: { a: number; b: number; value: number | null }[];
        collapsed: boolean;
      } | null;
      medianWfe?: number | null;
      explanation?: string;
    };
  } | null;

  const r = report?.result;
  if (r?.folds === undefined) return null;

  return (
    <div className="space-y-3 border-t border-border pt-3" data-testid="optimization-result">
      <p className="text-xs text-muted">{r.explanation}</p>

      <table className="w-full text-xs">
        <thead className="text-muted">
          <tr className="border-b border-border">
            <th className="py-1 text-left font-normal">Fold</th>
            <th className="py-1 text-left font-normal">Winner</th>
            <th className="py-1 text-right font-normal">IS</th>
            <th className="py-1 text-right font-normal">OOS</th>
            <th className="py-1 text-right font-normal">WFE /day</th>
          </tr>
        </thead>
        <tbody>
          {r.folds.map((f) => (
            <tr key={f.index} className="border-b border-border/40">
              <td className="py-1">#{f.index}</td>
              <td className="py-1 font-mono">
                {f.winner === null
                  ? '—'
                  : Object.entries(f.winner)
                      .map(([k, v]) => `${k}=${String(v)}`)
                      .join(' ')}
              </td>
              <td className="py-1 text-right tabular-nums">
                <Figure value={f.inSample?.returnPct ?? null} format={(v) => `${v.toFixed(2)}%`} />
              </td>
              <td className="py-1 text-right tabular-nums">
                <Figure
                  value={f.outOfSample?.returnPct ?? null}
                  format={(v) => `${v.toFixed(2)}%`}
                />
              </td>
              <td className="py-1 text-right tabular-nums">
                <Figure
                  value={f.wfeStable ? f.wfe : null}
                  format={(v) => v.toFixed(2)}
                  reason={
                    f.wfe === null
                      ? 'The winning set did not make money in sample, so there is nothing whose generalisation could be measured.'
                      : 'The in-sample return was too small for the ratio to mean anything.'
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {r.stitchedEquity !== undefined && r.stitchedEquity.length > 0 && (
        <div>
          <h5 className="text-xs font-medium">Stitched out-of-sample equity</h5>
          <p className="text-xs text-muted">
            {r.stitchedEquity
              .map((p) => `fold ${String(p.foldIndex)}: ${p.cumulativeReturnPct.toFixed(2)}%`)
              .join('  →  ')}
          </p>
        </div>
      )}

      {r.drift !== undefined && r.drift.length > 0 && (
        <div>
          <h5 className="text-xs font-medium">Parameter drift</h5>
          <ul className="text-xs text-muted">
            {r.drift.map((d) => (
              <li key={d.name}>
                <span className="font-mono">{d.name}</span>: {d.values.join(' → ')} — mean step{' '}
                <strong className={d.meanStepFraction >= 0.4 ? 'text-rose-300' : 'text-foreground'}>
                  {(d.meanStepFraction * 100).toFixed(0)}%
                </strong>{' '}
                of its range
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted">
            An optimum that moves far between folds is not a parameter the procedure found — it is
            whatever the last window rewarded, and the next fold&rsquo;s winner is a coin flip.
          </p>
        </div>
      )}

      {r.sensitivity != null && <Heatmap grid={r.sensitivity} />}
    </div>
  );
}

function Heatmap({
  grid,
}: {
  grid: {
    inputA: string;
    inputB: string;
    cells: { a: number; b: number; value: number | null }[];
    collapsed: boolean;
  };
}): React.JSX.Element {
  const as = [...new Set(grid.cells.map((c) => c.a))].sort((x, y) => x - y);
  const bs = [...new Set(grid.cells.map((c) => c.b))].sort((x, y) => x - y);
  const values = grid.cells.map((c) => c.value).filter((v): v is number => v !== null);
  const lo = Math.min(...values);
  const hi = Math.max(...values);

  return (
    <div data-testid="sensitivity-heatmap">
      <h5 className="text-xs font-medium">
        Sensitivity — {grid.inputA} x {grid.inputB}
        {grid.collapsed && <span className="text-muted"> (third axis at its best)</span>}
      </h5>
      <table className="mt-1 text-[0.65rem]">
        <tbody>
          {as.map((a) => (
            <tr key={a}>
              <td className="pr-1 text-right text-muted">{a}</td>
              {bs.map((b) => {
                const cell = grid.cells.find((c) => c.a === a && c.b === b);
                const t = cell?.value == null || hi === lo ? null : (cell.value - lo) / (hi - lo);
                return (
                  <td key={b} className="p-px">
                    <div
                      className="h-5 w-7 rounded-sm"
                      style={{
                        backgroundColor:
                          t === null
                            ? 'transparent'
                            : `color-mix(in oklab, var(--primary) ${String(Math.round(t * 100))}%, transparent)`,
                      }}
                      title={
                        cell?.value == null
                          ? 'not sampled'
                          : `${grid.inputA}=${String(a)} ${grid.inputB}=${String(b)}: ${cell.value.toFixed(0)}`
                      }
                    />
                  </td>
                );
              })}
            </tr>
          ))}
          <tr>
            <td />
            {bs.map((b) => (
              <td key={b} className="text-center text-muted">
                {b}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <p className="mt-1 text-xs text-muted">
        A broad plateau is a parameter; an isolated bright cell surrounded by dark ones is an
        artefact.
      </p>
    </div>
  );
}

function suggest(defval: unknown, factor: number): number {
  const d = typeof defval === 'number' ? defval : 10;
  return Math.max(1, Math.round(d * factor));
}

function formatEta(seconds: number): string {
  if (seconds < 90) return `${String(Math.round(seconds))}s`;
  return `${String(Math.round(seconds / 60))} min`;
}
