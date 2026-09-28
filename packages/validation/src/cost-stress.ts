import { perFillFigures, type InstrumentScale, type PerFillFigures } from './per-fill';

/**
 * Cost stress (spec 06 §2): re-run with costs scaled and find where the edge dies.
 *
 * The headline is the break-even MULTIPLIER — how many times its actual costs a strategy could pay
 * before net profit reaches zero. A strategy that survives 3x its spread is a different proposition
 * from one that dies at 1.2x, and neither is visible from a single run.
 *
 * WHY THIS IS CROSS-CHECKED AGAINST THE METRICS REPORT. The report already states a break-even cost
 * per side analytically:
 *
 *     breakEvenPerSide = netProfit / (2 x totalUnits x pointValue)
 *
 * The stress computes the same quantity by re-running. If costs scaled linearly and the trade set
 * never changed, the two would agree by construction — so the interesting outcome is DISAGREEMENT,
 * and the size of it measures something real:
 *
 *   - **The trade set moved.** Slippage and commission change fill prices, which changes which
 *     orders pass a margin check and where stops sit. A strategy whose results depend on that is
 *     more fragile than its break-even number suggests.
 *   - **The factor of 2 is wrong for this strategy's fill mix.** The analytical form assumes every
 *     trade pays on both sides. Slippage applies to market fills and not to a limit order resting at
 *     its level, so a bracket strategy pays slippage on one side and the analytical figure
 *     understates how far execution can degrade. The spread is unaffected by this because the
 *     overlay charges exactly one spread per round trip on every price basis (A19) — what the basis
 *     changes is which fill carries it, not how many.
 *
 * Pure: it takes the re-run results, it does not run anything.
 */

export interface StressPoint {
  /** Cost multiplier applied to spread, slippage and commission together. */
  readonly multiplier: number;
  readonly netProfit: number;
  readonly totalCosts: number;
  readonly trades: number;
}

export interface CostStressParams {
  /** One per re-run, including the baseline at multiplier 1. Any order. */
  readonly points: readonly StressPoint[];
  /**
   * `2 x totalUnits x pointValue` at the baseline — the denominator the metrics report uses.
   *
   * Passed in rather than recomputed so the two figures cannot drift apart through a different
   * lots-versus-units reading, which is the mistake this repo has made four times.
   */
  readonly twoSidedUnitValue: number;
  /** `breakEvenPerSidePrice` from the metrics report. */
  readonly analyticalPerSidePrice: number | null;
  readonly scale: InstrumentScale;
  /** How far apart the two may sit before it is worth reporting. Default 5%. */
  readonly tolerancePct?: number;
  /**
   * Fills that pay slippage, and fills in total, at the baseline.
   *
   * A limit order fills at its level and pays no slippage, so a bracket strategy pays it on one side
   * of a round trip rather than two. Supplying the mix lets the check say WHY the two figures
   * differ instead of only that they do.
   */
  readonly slippageFills?: number;
  readonly totalFills?: number;
}

export interface CostStressResult {
  readonly points: readonly StressPoint[];
  /** Where net profit crosses zero, interpolated. Null when it never does. */
  readonly breakEvenMultiplier: number | null;
  /** The extra cost per side implied by that multiplier, in price units. */
  readonly empiricalPerSidePrice: number | null;
  readonly analyticalPerSidePrice: number | null;
  /** Signed difference, empirical minus analytical, in price units. */
  readonly deltaPrice: number | null;
  readonly deltaPct: number | null;
  readonly agrees: boolean | null;
  /** True when scaling costs changed how many trades the strategy took. */
  readonly tradeSetMoved: boolean;
  /** Expressed per fill, in pips and ticks. */
  readonly perFill: PerFillFigures;
  readonly explanation: string;
}

export function analyseCostStress(params: CostStressParams): CostStressResult {
  const points = [...params.points].sort((a, b) => a.multiplier - b.multiplier);
  const baseline = points.find((p) => p.multiplier === 1) ?? points[0];

  const tradeSetMoved = baseline !== undefined && points.some((p) => p.trades !== baseline.trades);

  const breakEvenMultiplier = crossingOfZero(points);

  const baselineCosts = baseline?.totalCosts ?? 0;
  const empiricalPerSidePrice =
    breakEvenMultiplier === null || params.twoSidedUnitValue === 0
      ? null
      : ((breakEvenMultiplier - 1) * baselineCosts) / params.twoSidedUnitValue;

  const analytical = params.analyticalPerSidePrice;

  const deltaPrice =
    empiricalPerSidePrice === null || analytical === null
      ? null
      : empiricalPerSidePrice - analytical;

  const deltaPct =
    deltaPrice === null || analytical === null || analytical === 0
      ? null
      : (deltaPrice / Math.abs(analytical)) * 100;

  const tolerance = params.tolerancePct ?? 5;
  const agrees = deltaPct === null ? null : Math.abs(deltaPct) <= tolerance;

  return {
    points,
    breakEvenMultiplier,
    empiricalPerSidePrice,
    analyticalPerSidePrice: analytical,
    deltaPrice,
    deltaPct,
    agrees,
    tradeSetMoved,
    perFill: perFillFigures(
      empiricalPerSidePrice === null ? [] : [empiricalPerSidePrice],
      0,
      params.scale,
    ),
    explanation: explain({
      points,
      baseline,
      breakEvenMultiplier,
      agrees,
      deltaPct,
      tradeSetMoved,
      slippageFills: params.slippageFills,
      totalFills: params.totalFills,
    }),
  };
}

/**
 * The multiplier at which net profit reaches zero, by linear interpolation between the two points
 * that straddle it.
 *
 * Linear because costs scale linearly with the multiplier BY CONSTRUCTION — every component is
 * multiplied by the same factor. Net profit is not exactly linear in it, because a changed fill
 * price changes which orders fill at all, and the gap between the straight line and the truth is
 * part of what this check reports.
 */
function crossingOfZero(points: readonly StressPoint[]): number | null {
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (a.netProfit === 0) return a.multiplier;
    if (b.netProfit === 0) return b.multiplier;
    if (a.netProfit > 0 !== b.netProfit > 0) {
      const span = b.netProfit - a.netProfit;
      if (span === 0) return a.multiplier;
      return a.multiplier + ((0 - a.netProfit) / span) * (b.multiplier - a.multiplier);
    }
  }
  return null;
}

interface ExplainParams {
  readonly points: readonly StressPoint[];
  readonly baseline: StressPoint | undefined;
  readonly breakEvenMultiplier: number | null;
  readonly agrees: boolean | null;
  readonly deltaPct: number | null;
  readonly tradeSetMoved: boolean;
  readonly slippageFills?: number;
  readonly totalFills?: number;
}

function explain(p: ExplainParams): string {
  const cheapest = p.points[0];
  const dearest = p.points[p.points.length - 1];

  if (p.breakEvenMultiplier === null) {
    if (cheapest !== undefined && cheapest.netProfit <= 0) {
      return (
        `Net profit is still ${cheapest.netProfit.toFixed(2)} at ${String(cheapest.multiplier)}x ` +
        'costs, so there is no break-even to find: this strategy does not make money with ' +
        'execution switched off, and no improvement in costs would rescue it.'
      );
    }
    return (
      `Still profitable at ${String(dearest?.multiplier ?? 0)}x costs — the stress range did not ` +
      'reach break-even. The edge survives every level tested.'
    );
  }

  const head =
    `Break-even at ${p.breakEvenMultiplier.toFixed(2)}x its actual costs` +
    (p.breakEvenMultiplier < 1
      ? ' — below 1, meaning the strategy is already past the point where execution pays for it.'
      : '.');

  if (p.agrees === true) {
    return `${head} Matches the metrics report's analytical break-even.`;
  }

  const reasons: string[] = [];
  if (p.tradeSetMoved) {
    reasons.push(
      'scaling costs changed how many trades the strategy took, so net profit is not linear in the ' +
        'multiplier — a result that depends on which orders survive a margin check',
    );
  }
  if (
    p.slippageFills !== undefined &&
    p.totalFills !== undefined &&
    p.totalFills > 0 &&
    p.slippageFills < p.totalFills
  ) {
    const pct = ((p.slippageFills / p.totalFills) * 100).toFixed(0);
    reasons.push(
      `only ${String(p.slippageFills)} of ${String(p.totalFills)} fills (${pct}%) pay slippage at ` +
        'all — a limit order fills at its level — while the analytical figure assumes both sides of ' +
        'every trade are charged',
    );
  }

  const why = reasons.length === 0 ? '' : ` Why: ${reasons.join('; ')}.`;

  return (
    `${head} That is ${(p.deltaPct ?? 0).toFixed(1)}% from the analytical break-even in the ` +
    `metrics report.${why}`
  );
}
