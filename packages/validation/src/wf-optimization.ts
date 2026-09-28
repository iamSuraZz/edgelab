import type { SegmentMetrics } from './oos-split';

/**
 * Walk-forward OPTIMIZATION (spec 06 §3).
 *
 * The rolling out-of-sample check runs one fixed parameter set through rolling windows. This does
 * the thing that check cannot: it SELECTS parameters in sample, fold by fold, and tests the winner
 * out of sample. What is being validated is therefore not a strategy but a PROCEDURE — "fit these
 * inputs on the last three months and trade the winner next month" — and whether that procedure
 * generalises is a different question from whether any particular parameter set works.
 *
 * It is opt-in because it is expensive by construction: `combinations x folds` in-sample runs plus
 * one out-of-sample run per fold. At the 300-combination cap and four folds that is 1,204 engine
 * runs, which is minutes rather than seconds, so it cannot sit in a suite that is supposed to answer
 * quickly.
 *
 * THE FAILURE MODE IT EXISTS TO CATCH is not a losing strategy — it is a strategy whose optimal
 * parameters move so much between folds that the optimiser is fitting noise. A procedure that picks
 * a 9-period lookback in one fold and a 47-period in the next has not found a parameter; it has
 * found whatever the last three months happened to reward. That is why parameter DRIFT is reported
 * beside the returns, and why a sensitivity grid is worth more than the winning cell.
 *
 * Pure: the caller performs every run and passes the results in.
 */

/** One input being optimised, with the range to sweep. */
export interface OptimizedInput {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/** A concrete assignment: input name to value. */
export type ParameterSet = Readonly<Record<string, number>>;

export type Objective = 'netProfit' | 'profitFactor' | 'sharpe' | 'expectancy';

export interface OptimizationSpec {
  /** Up to three inputs. More than that is a combinatorial trap, not a better search. */
  readonly inputs: readonly OptimizedInput[];
  readonly objective: Objective;
  /** A parameter set producing fewer trades than this cannot win, however good its numbers look. */
  readonly minTrades: number;
  /** Cap on combinations actually run. Above it, the grid is sampled rather than enumerated. */
  readonly maxCombinations?: number;
}

export const DEFAULT_MAX_COMBINATIONS = 300;
export const MAX_OPTIMIZED_INPUTS = 3;

export class OptimizationSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptimizationSpecError';
  }
}

/** Every value one input takes across its range, inclusive of both ends where the step lands. */
export function valuesOf(input: OptimizedInput): number[] {
  if (!(input.step > 0)) {
    throw new OptimizationSpecError(
      `${input.name}: step must be positive, got ${String(input.step)}`,
    );
  }
  if (input.max < input.min) {
    throw new OptimizationSpecError(
      `${input.name}: max ${String(input.max)} is below min ${String(input.min)}`,
    );
  }

  const out: number[] = [];
  const count = Math.floor((input.max - input.min) / input.step + 1e-9) + 1;
  for (let i = 0; i < count; i += 1) {
    // Computed from the index rather than accumulated, so a fractional step cannot drift.
    out.push(round(input.min + i * input.step));
  }
  return out;
}

/** Guard against floating-point dust from a step like 0.1. */
function round(v: number): number {
  return Number(v.toFixed(10));
}

/** How many combinations the full grid holds, before any cap. */
export function gridSize(spec: OptimizationSpec): number {
  return spec.inputs.reduce((n, i) => n * valuesOf(i).length, 1);
}

/**
 * The parameter sets to actually run.
 *
 * Below the cap this is the full grid. Above it the grid is SAMPLED rather than truncated — taking
 * the first 300 of an enumerated grid would sweep the first input thoroughly and never move the
 * last, which is worse than useless because it looks like a search.
 *
 * Sampling is deterministic from `seed`, so a run is reproducible and two runs of the same spec
 * compare like for like. No `Math.random` anywhere, for the same reason the workflow scripts ban it.
 */
export function combinations(spec: OptimizationSpec, seed = 1): ParameterSet[] {
  if (spec.inputs.length === 0) {
    throw new OptimizationSpecError('Choose at least one input to optimise.');
  }
  if (spec.inputs.length > MAX_OPTIMIZED_INPUTS) {
    throw new OptimizationSpecError(
      `At most ${String(MAX_OPTIMIZED_INPUTS)} inputs can be optimised at once; got ` +
        `${String(spec.inputs.length)}. A fourth dimension multiplies the run count without ` +
        'making the result more trustworthy.',
    );
  }

  const axes = spec.inputs.map((i) => ({ name: i.name, values: valuesOf(i) }));
  const total = axes.reduce((n, a) => n * a.values.length, 1);
  const cap = spec.maxCombinations ?? DEFAULT_MAX_COMBINATIONS;

  const at = (index: number): ParameterSet => {
    const out: Record<string, number> = {};
    let rest = index;
    for (const axis of axes) {
      out[axis.name] = axis.values[rest % axis.values.length]!;
      rest = Math.floor(rest / axis.values.length);
    }
    return out;
  };

  if (total <= cap) {
    return Array.from({ length: total }, (_unused, i) => at(i));
  }

  // Sample distinct indices from the whole grid.
  const picked = new Set<number>();
  const rng = lcg(seed);
  while (picked.size < cap) {
    picked.add(Math.floor(rng() * total));
  }
  return [...picked].sort((a, b) => a - b).map(at);
}

/** A small deterministic generator. Numerical Recipes constants. */
function lcg(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/* ------------------------------------------------------------- selecting */

export interface CandidateResult {
  readonly parameters: ParameterSet;
  readonly metrics: SegmentMetrics;
}

/** The objective's value for a candidate, or null when it is undefined for that run. */
export function objectiveValue(m: SegmentMetrics, objective: Objective): number | null {
  switch (objective) {
    case 'netProfit':
      return m.netProfit;
    case 'profitFactor':
      return m.profitFactor;
    case 'sharpe':
      return m.sharpe;
    case 'expectancy':
      return m.expectancy;
  }
}

/**
 * The in-sample winner, or null when nothing qualified.
 *
 * The trade-count floor is applied BEFORE ranking, not as a tiebreak. A parameter set that took two
 * trades and won both has the best profit factor in the grid and has established nothing; letting it
 * win is how an optimiser selects noise. Ties break towards the candidate whose parameters sit
 * nearest the middle of their ranges, which is the least-overfitted choice among equals — an
 * extreme of a swept range is more likely to be a boundary artefact than a real optimum.
 */
export function pickWinner(
  candidates: readonly CandidateResult[],
  spec: OptimizationSpec,
): CandidateResult | null {
  const eligible = candidates.filter(
    (c) => c.metrics.trades >= spec.minTrades && objectiveValue(c.metrics, spec.objective) !== null,
  );
  if (eligible.length === 0) return null;

  let best = eligible[0]!;
  let bestValue = objectiveValue(best.metrics, spec.objective) as number;

  for (const c of eligible.slice(1)) {
    const v = objectiveValue(c.metrics, spec.objective) as number;
    if (v > bestValue || (v === bestValue && centrality(c, spec) < centrality(best, spec))) {
      best = c;
      bestValue = v;
    }
  }
  return best;
}

/** Mean distance from the middle of each range, as a fraction. 0 is dead centre. */
function centrality(c: CandidateResult, spec: OptimizationSpec): number {
  const parts = spec.inputs.map((i) => {
    const span = i.max - i.min;
    if (span === 0) return 0;
    const mid = (i.max + i.min) / 2;
    return Math.abs((c.parameters[i.name] ?? mid) - mid) / span;
  });
  return parts.reduce((s, p) => s + p, 0) / Math.max(1, parts.length);
}
