import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_COSTS, type CostConfig, type Timeframe } from '@edgelab/shared';

import type { DiagnosticDto, InputSpecDto } from '@/lib/api';

/**
 * Studio state: the script, the run configuration and the current run.
 *
 * Persisted except for the live run, so closing the tab mid-edit does not lose your script or
 * your settings — but a reload never resurrects a "running" state that no longer has a job
 * behind it.
 */

export interface RunSettings {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly fromMs: number;
  readonly toMs: number;
  readonly initialCapital: number;
  readonly accountCurrency: string;
  readonly leverage: number;
  /** 0 keeps the script's own sizing; anything else overrides `default_qty_value`. */
  readonly lots: number;
  readonly warmupBars: number;
  readonly rfAnnual: number;
  readonly costs: CostConfig;
}

export interface LiveRun {
  readonly runId: string;
  readonly jobId: string;
  readonly state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly percent: number;
  readonly message: string;
  readonly error: string | null;
}

/** January 2024 — the month the repo actually has data for, so a fresh install can run. */
const DEFAULT_FROM = Date.UTC(2024, 0, 1);
const DEFAULT_TO = Date.UTC(2024, 1, 1);

export const DEFAULT_SETTINGS: RunSettings = {
  symbol: 'EURUSD',
  timeframe: 'H1',
  fromMs: DEFAULT_FROM,
  toMs: DEFAULT_TO,
  initialCapital: 10_000,
  accountCurrency: 'USD',
  leverage: 100,
  // 1 lot by default, because Pine sizes in CONTRACTS: the fixtures' `default_qty_value=1` is
  // one euro on EURUSD, and a month of that moves the account by pennies. See docs/decisions.md.
  lots: 1,
  warmupBars: 500,
  rfAnnual: 0,
  costs: DEFAULT_COSTS,
};

interface StudioState {
  source: string;
  /** Strategy id once saved, so Ctrl/Cmd+S adds a version instead of creating a duplicate. */
  strategyId: string | null;
  strategyName: string;

  settings: RunSettings;
  /** Input overrides keyed by `InputSpec.key` (the Pine varId). */
  inputs: Record<string, unknown>;

  /** Latest compile result, so the settings pane can build the Inputs form from it. */
  compileInputs: readonly InputSpecDto[];
  diagnostics: readonly DiagnosticDto[];
  compiling: boolean;

  liveRun: LiveRun | null;
  /** The last run to complete, which is what Results displays. */
  lastRunId: string | null;
  /**
   * Where the chart should scroll to and mark.
   *
   * A TIME, not a trade (A53). Look-ahead evidence names bars that frequently carry no trade at
   * all — the causality check's first peek on a leaking script is bar 0 — so a trade-shaped focus
   * left the most important evidence unclickable. A trade focus is the case that ALSO highlights
   * the trade, which is why both fields exist rather than one replacing the other.
   */
  focusedAtMs: number | null;
  /** Set only when the focus came from a trade, so the chart can highlight it as well. */
  focusedTradeSeq: number | null;

  setSource: (source: string) => void;
  setStrategy: (id: string | null, name: string) => void;
  patchSettings: (patch: Partial<RunSettings>) => void;
  patchCosts: (patch: Partial<CostConfig>) => void;
  setInput: (key: string, value: unknown) => void;
  resetInputs: () => void;
  setCompileResult: (
    inputs: readonly InputSpecDto[],
    diagnostics: readonly DiagnosticDto[],
  ) => void;
  setCompiling: (compiling: boolean) => void;
  setLiveRun: (run: LiveRun | null) => void;
  patchLiveRun: (patch: Partial<LiveRun>) => void;
  setLastRunId: (runId: string | null) => void;
  /** Scroll to and mark an instant. The general case. */
  focusAt: (atMs: number | null) => void;
  /** Scroll to a trade, marking the instant AND highlighting the trade. */
  focusTrade: (seq: number | null, atMs?: number | null) => void;
}

export const useStudio = create<StudioState>()(
  persist(
    (set) => ({
      source: '',
      strategyId: null,
      strategyName: '',
      settings: DEFAULT_SETTINGS,
      inputs: {},
      compileInputs: [],
      diagnostics: [],
      compiling: false,
      liveRun: null,
      lastRunId: null,
      focusedTradeSeq: null,
      focusedAtMs: null,

      setSource: (source) => {
        set((state) => {
          // Editing the script invalidates the saved-version link: the next save must create a
          // new version rather than silently reusing the old one's id.
          if (source === state.source) return state;
          return { source };
        });
      },

      setStrategy: (strategyId, strategyName) => {
        set({ strategyId, strategyName });
      },

      patchSettings: (patch) => {
        set((state) => ({ settings: { ...state.settings, ...patch } }));
      },

      patchCosts: (patch) => {
        set((state) => ({
          settings: {
            ...state.settings,
            costs: {
              ...state.settings.costs,
              ...patch,
              spread: { ...state.settings.costs.spread, ...(patch.spread ?? {}) },
              financing: { ...state.settings.costs.financing, ...(patch.financing ?? {}) },
            },
          },
        }));
      },

      setInput: (key, value) => {
        set((state) => ({ inputs: { ...state.inputs, [key]: value } }));
      },

      /** Drop every override so the script's own declared defaults apply again. */
      resetInputs: () => {
        set({ inputs: {} });
      },

      setCompileResult: (compileInputs, diagnostics) => {
        set((state) => {
          // Prune overrides for inputs the script no longer declares. Without this, renaming a
          // variable leaves a stale override that the API would reject as unknown.
          const valid = new Set(compileInputs.map((i) => i.key));
          const inputs = Object.fromEntries(
            Object.entries(state.inputs).filter(([key]) => valid.has(key)),
          );
          return { compileInputs, diagnostics, inputs };
        });
      },

      setCompiling: (compiling) => {
        set({ compiling });
      },

      setLiveRun: (liveRun) => {
        set({ liveRun });
      },

      patchLiveRun: (patch) => {
        set((state) =>
          state.liveRun === null ? state : { liveRun: { ...state.liveRun, ...patch } },
        );
      },

      setLastRunId: (lastRunId) => {
        set({ lastRunId, focusedTradeSeq: null, focusedAtMs: null });
      },

      focusAt: (focusedAtMs) => {
        // Clears any trade highlight: focusing an instant that belongs to no trade must not leave
        // the previous trade marked, which would attribute the evidence to the wrong place.
        set({ focusedAtMs, focusedTradeSeq: null });
      },

      focusTrade: (focusedTradeSeq, atMs) => {
        set({ focusedTradeSeq, ...(atMs === undefined ? {} : { focusedAtMs: atMs }) });
      },
    }),
    {
      name: 'edgelab.studio',
      // `liveRun` and `compiling` are deliberately absent: a reload has no job subscription, so
      // restoring "running at 40%" would show a progress bar that can never finish.
      partialize: (state) => ({
        source: state.source,
        strategyId: state.strategyId,
        strategyName: state.strategyName,
        settings: state.settings,
        inputs: state.inputs,
        lastRunId: state.lastRunId,
      }),
    },
  ),
);
