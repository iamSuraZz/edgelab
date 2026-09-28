import { retentionRatio, type SegmentMetrics } from './oos-split';
import {
  objectiveValue,
  valuesOf,
  type CandidateResult,
  type Objective,
  type OptimizationSpec,
  type ParameterSet,
} from './wf-optimization';

/**
 * What a walk-forward optimization actually reports.
 *
 * Separated from the selection logic because the two answer different questions and fail in
 * different ways: selection decides which parameter set wins a fold, this decides what the sequence
 * of winners means. Keeping them apart is also what lets the selection rules be tested without
 * simulating a whole run.
 *
 * THE HEADLINE IS NOT THE RETURN. A walk-forward optimization that made money can still be
 * worthless: if the winning parameters jump across their range every fold, the procedure has found
 * whatever the last window rewarded rather than a parameter, and the next fold's winner is a coin
 * flip. So drift is scored alongside performance, and a sensitivity grid is reported because the
 * winning cell alone cannot distinguish a broad plateau from a lucky spike.
 */

export interface OptimizedFold {
  readonly index: number;
  /** The set that won in sample. Null when nothing met the trade floor. */
  readonly winner: ParameterSet | null;
  readonly inSample: SegmentMetrics | null;
  readonly outOfSample: SegmentMetrics | null;
  /**
   * Walk-forward efficiency: out-of-sample return RATE over in-sample rate, per calendar day, for
   * the WINNING set.
   *
   * This is the real WFE, unlike the rolling check's retention figure — a parameter set was actually
   * selected in sample here, so the ratio measures how much of a FITTED result survived.
   *
   * Null when the in-sample return was not strictly positive (A24): two losses divide into a
   * flattering positive number, and an optimiser that could only find a losing set has nothing
   * whose generalisation could be measured.
   */
  readonly wfe: number | null;
  /** False when the in-sample return was positive but too small for the ratio to mean anything. */
  readonly wfeStable: boolean;
  readonly assessable: boolean;
}

export interface ParameterDrift {
  readonly name: string;
  readonly values: readonly number[];
  /** Mean absolute change between consecutive folds, as a fraction of the swept range. */
  readonly meanStepFraction: number;
  readonly maxStepFraction: number;
  readonly distinctValues: number;
}

export interface StitchedPoint {
  readonly foldIndex: number;
  readonly atMs: number;
  /** Cumulative return in percent, compounding each fold's out-of-sample return. */
  readonly cumulativeReturnPct: number;
}

export interface SensitivityCell {
  readonly a: number;
  readonly b: number;
  readonly value: number | null;
}

export interface SensitivityGrid {
  readonly inputA: string;
  readonly inputB: string;
  readonly objective: Objective;
  readonly cells: readonly SensitivityCell[];
  /** True when more than two inputs were swept, so the other axes are collapsed optimistically. */
  readonly collapsed: boolean;
}

export interface WfOptimizationResult {
  readonly folds: readonly OptimizedFold[];
  readonly spec: OptimizationSpec;
  readonly combinationsRun: number;
  readonly gridSize: number;
  readonly sampled: boolean;
  readonly assessableFolds: number;
  readonly foldsWithEdge: number;
  readonly foldsSurviving: number;
  readonly consistency: number | null;
  readonly medianWfe: number | null;
  readonly stitchedEquity: readonly StitchedPoint[];
  readonly finalOosReturnPct: number | null;
  readonly drift: readonly ParameterDrift[];
  readonly sensitivity: SensitivityGrid | null;
  readonly verdict: 'pass' | 'warn' | 'fail' | 'n/a';
  readonly explanation: string;
  readonly inconclusiveReason: string | null;
}

export interface WfOptimizationParams {
  readonly spec: OptimizationSpec;
  readonly folds: readonly {
    readonly winner: ParameterSet | null;
    readonly inSample: SegmentMetrics | null;
    readonly outOfSample: SegmentMetrics | null;
  }[];
  readonly combinationsRun: number;
  readonly gridSize: number;
  /** In-sample candidates of ONE fold, for the sensitivity grid. */
  readonly sensitivityFold?: readonly CandidateResult[];
  readonly minStableReturnPct?: number;
}

const DEFAULT_MIN_STABLE_RETURN_PCT = 1;

/** Drift at or above this fraction of a range, per fold, means the optimum is not a parameter. */
const DRIFT_FAIL = 0.4;
const DRIFT_WARN = 0.25;

export function analyseWfOptimization(params: WfOptimizationParams): WfOptimizationResult {
  const { spec } = params;
  const minStable = params.minStableReturnPct ?? DEFAULT_MIN_STABLE_RETURN_PCT;

  const folds: OptimizedFold[] = params.folds.map((f, index) => {
    const isReturn = f.inSample?.returnPct ?? null;

    return {
      index,
      winner: f.winner,
      inSample: f.inSample,
      outOfSample: f.outOfSample,
      // Normalised per calendar day on both sides. An in-sample window three times longer than the
      // out-of-sample one otherwise caps WFE at 1/3 for a procedure that generalises perfectly.
      wfe:
        f.inSample === null || f.outOfSample === null
          ? null
          : retentionRatio(f.inSample, f.outOfSample),
      wfeStable: (isReturn ?? 0) >= minStable,
      assessable: f.winner !== null && f.inSample !== null && f.outOfSample !== null,
    };
  });

  const assessable = folds.filter((f) => f.assessable);
  const foldsWithEdge = assessable.filter((f) => (f.inSample?.netProfit ?? 0) > 0).length;
  const foldsSurviving = assessable.filter(
    (f) => (f.inSample?.netProfit ?? 0) > 0 && (f.outOfSample?.netProfit ?? 0) > 0,
  ).length;
  const consistency = foldsWithEdge === 0 ? null : foldsSurviving / foldsWithEdge;

  const medianWfe = medianOf(
    assessable.filter((f) => f.wfe !== null && f.wfeStable).map((f) => f.wfe as number),
  );

  const stitchedEquity = stitch(folds);
  const finalOosReturnPct =
    stitchedEquity.length === 0
      ? null
      : stitchedEquity[stitchedEquity.length - 1]!.cumulativeReturnPct;

  const drift = driftOf(folds, spec);
  const sensitivity = gridOf(params.sensitivityFold, spec);

  const base = {
    folds,
    spec,
    combinationsRun: params.combinationsRun,
    gridSize: params.gridSize,
    sampled: params.combinationsRun < params.gridSize,
    assessableFolds: assessable.length,
    foldsWithEdge,
    foldsSurviving,
    consistency,
    medianWfe,
    stitchedEquity,
    finalOosReturnPct,
    drift,
    sensitivity,
  };

  if (assessable.length < 2) {
    const reason =
      `Only ${String(assessable.length)} of ${String(folds.length)} folds produced a winner that ` +
      `met the ${String(spec.minTrades)}-trade floor and ran out of sample. The optimisation had ` +
      'nothing to generalise from, which is a statement about the fold layout and the trade ' +
      'floor rather than about the strategy.';
    return { ...base, verdict: 'n/a', explanation: reason, inconclusiveReason: reason };
  }

  if (foldsWithEdge === 0) {
    const reason =
      `No fold's winning parameters were profitable even in sample, over ` +
      `${String(params.combinationsRun)} combinations. There is nothing whose generalisation ` +
      'could be tested: the optimiser searched and found no edge to carry forward.';
    return { ...base, verdict: 'n/a', explanation: reason, inconclusiveReason: reason };
  }

  const kept = consistency ?? 0;
  const worstDrift = drift.reduce((m, d) => Math.max(m, d.meanStepFraction), 0);

  const head =
    `${String(foldsSurviving)} of ${String(foldsWithEdge)} folds kept their optimised edge out of ` +
    `sample (${(kept * 100).toFixed(0)}%)` +
    (medianWfe === null ? '' : `, median WFE ${medianWfe.toFixed(2)}`) +
    `, stitched out-of-sample return ${(finalOosReturnPct ?? 0).toFixed(2)}%. Winning parameters ` +
    `moved ${(worstDrift * 100).toFixed(0)}% of their range between folds on the worst input.`;

  // Drift is scored on its own account, because a procedure can be profitable and still be fitting
  // noise: if the optimum jumps across half its range each fold, the next winner is a coin flip.
  if (worstDrift >= DRIFT_FAIL) {
    return {
      ...base,
      verdict: 'fail',
      explanation:
        `${head} An optimum that moves that far between folds is not a parameter the procedure ` +
        'found — it is whatever the last window happened to reward.',
      inconclusiveReason: null,
    };
  }

  if (kept < 0.5) {
    return {
      ...base,
      verdict: 'fail',
      explanation: `${head} The selection procedure does not generalise.`,
      inconclusiveReason: null,
    };
  }

  if (kept < 0.7 || (medianWfe !== null && medianWfe < 0.5) || worstDrift >= DRIFT_WARN) {
    return {
      ...base,
      verdict: 'warn',
      explanation: `${head} It generalises more often than not, but not reliably.`,
      inconclusiveReason: null,
    };
  }

  return { ...base, verdict: 'pass', explanation: head, inconclusiveReason: null };
}

/**
 * Compound each fold's out-of-sample return into one curve.
 *
 * Compounded rather than summed: each fold is its own run from the same starting capital (A24), so
 * the figures are percentages of that capital, and adding them would misstate the path an account
 * following the procedure would actually have taken.
 */
function stitch(folds: readonly OptimizedFold[]): StitchedPoint[] {
  const out: StitchedPoint[] = [];
  let cumulative = 1;

  for (const f of folds) {
    if (!f.assessable || f.outOfSample === null) continue;
    cumulative *= 1 + (f.outOfSample.returnPct ?? 0) / 100;
    out.push({
      foldIndex: f.index,
      atMs: f.outOfSample.toMs,
      cumulativeReturnPct: (cumulative - 1) * 100,
    });
  }
  return out;
}

function driftOf(folds: readonly OptimizedFold[], spec: OptimizationSpec): ParameterDrift[] {
  const winners = folds
    .filter((f) => f.assessable && f.winner !== null)
    .map((f) => f.winner as ParameterSet);

  return spec.inputs.map((input) => {
    const values = winners.map((w) => w[input.name] ?? input.min);
    const span = input.max - input.min;

    const steps: number[] = [];
    for (let i = 1; i < values.length; i += 1) {
      steps.push(span === 0 ? 0 : Math.abs(values[i]! - values[i - 1]!) / span);
    }

    return {
      name: input.name,
      values,
      meanStepFraction: steps.length === 0 ? 0 : steps.reduce((s, v) => s + v, 0) / steps.length,
      maxStepFraction: steps.length === 0 ? 0 : Math.max(...steps),
      distinctValues: new Set(values).size,
    };
  });
}

/**
 * A two-input slice of the objective surface.
 *
 * The winning cell alone cannot say whether it is a plateau or a spike, and a spike surrounded by
 * losses is an artefact rather than a parameter. With three inputs the third axis is collapsed by
 * taking the BEST value seen — the optimistic projection — and the grid says so rather than
 * averaging into something that describes no actual run.
 */
function gridOf(
  candidates: readonly CandidateResult[] | undefined,
  spec: OptimizationSpec,
): SensitivityGrid | null {
  if (candidates === undefined || candidates.length === 0 || spec.inputs.length < 2) return null;

  const a = spec.inputs[0]!;
  const b = spec.inputs[1]!;
  const best = new Map<string, number | null>();

  for (const c of candidates) {
    const av = c.parameters[a.name];
    const bv = c.parameters[b.name];
    if (av === undefined || bv === undefined) continue;

    const key = `${String(av)}|${String(bv)}`;
    const v = objectiveValue(c.metrics, spec.objective);
    const existing = best.get(key);
    if (existing === undefined || (v !== null && (existing === null || v > existing))) {
      best.set(key, v);
    }
  }

  const cells: SensitivityCell[] = [];
  for (const av of valuesOf(a)) {
    for (const bv of valuesOf(b)) {
      const key = `${String(av)}|${String(bv)}`;
      if (best.has(key)) cells.push({ a: av, b: bv, value: best.get(key) ?? null });
    }
  }

  return {
    inputA: a.name,
    inputB: b.name,
    objective: spec.objective,
    cells,
    collapsed: spec.inputs.length > 2,
  };
}

function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
