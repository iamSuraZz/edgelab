/**
 * Monte Carlo over trade ORDER (spec 06 §3).
 *
 * The same trades in a different sequence produce the same bottom line and a completely different
 * ride. This reshuffles them many times and reports the distribution of what the ride looked like,
 * which is the part a single backtest cannot show: one equity curve is one draw from that
 * distribution, and the drawdown it happens to display is not the drawdown to plan around.
 *
 * WHAT GETS SHUFFLED DEPENDS ON SIZING (A43). Under percent-of-equity sizing the stationary quantity
 * is the per-trade RETURN; under fixed lots it is the dollar P&L. Shuffling dollars under
 * equity-proportional sizing drops a late $4,000 win onto a small early account as though the
 * strategy could have made it there, and the resulting distribution has a fatter right tail and a
 * shallower drawdown than anything reachable. Shuffling percentages under fixed sizing makes the
 * opposite error, manufacturing compounding the strategy never had.
 *
 * THE FINAL RESULT IS INVARIANT, AND THAT IS NOT A BUG. Summing dollars and multiplying growth
 * factors are both commutative, so every ordering ends at the same place. Only the PATH moves. This
 * is worth stating plainly because a Monte Carlo that reports a spread of final returns has almost
 * certainly shuffled the wrong quantity — a distribution of outcomes is the symptom A43 prevents.
 *
 * Pure and deterministic: the shuffle is seeded, so a report is reproducible.
 */

export type SizingMode = 'percent-equity' | 'fixed' | 'unknown';

export interface McTrade {
  /** Dollar result. Shuffled directly under fixed sizing. */
  readonly netPnl: number;
  /**
   * Result as a percentage of the equity the trade was sized against.
   *
   * Required under percent-of-equity sizing and ignored otherwise. Null when it could not be
   * established, which makes the trade unusable rather than approximated.
   */
  readonly returnPct: number | null;
}

export interface Percentiles {
  readonly p5: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p95: number;
  readonly worst: number;
}

export interface MonteCarloResult {
  readonly iterations: number;
  readonly sizingMode: SizingMode;
  /** Which quantity was permuted. */
  readonly quantity: 'return-pct' | 'dollar-pnl' | null;
  readonly trades: number;
  /** Distribution of maximum drawdown, in percent of peak equity. */
  readonly maxDrawdownPct: Percentiles | null;
  /** The drawdown the actual ordering produced. */
  readonly observedMaxDrawdownPct: number | null;
  /**
   * Where the observed drawdown sits in the distribution, as a fraction.
   *
   * Low means the real sequence was LUCKY: most orderings of the same trades were worse. That is
   * the finding — a backtest showing a 12% drawdown at the 5th percentile is really a strategy whose
   * typical drawdown is larger, and sizing chosen from the 12% would be sized from a fluke.
   */
  readonly observedPercentile: number | null;
  /** Share of orderings whose equity ever reached zero. */
  readonly riskOfRuinPct: number | null;
  /** Invariant across orderings, and reported to make that visible. */
  readonly finalReturnPct: number | null;
  readonly verdict: 'pass' | 'warn' | 'fail' | 'n/a';
  readonly explanation: string;
  readonly inconclusiveReason: string | null;
}

export interface MonteCarloParams {
  readonly trades: readonly McTrade[];
  readonly sizingMode: SizingMode;
  readonly initialCapital: number;
  readonly iterations?: number;
  readonly seed?: number;
  readonly minTrades?: number;
}

const DEFAULT_ITERATIONS = 1000;
const DEFAULT_MIN_TRADES = 20;

export function runMonteCarlo(params: MonteCarloParams): MonteCarloResult {
  const iterations = params.iterations ?? DEFAULT_ITERATIONS;
  const minTrades = params.minTrades ?? DEFAULT_MIN_TRADES;

  const base = {
    iterations,
    sizingMode: params.sizingMode,
    trades: params.trades.length,
    maxDrawdownPct: null,
    observedMaxDrawdownPct: null,
    observedPercentile: null,
    riskOfRuinPct: null,
    finalReturnPct: null,
  };

  if (params.sizingMode === 'unknown') {
    const reason =
      'The sizing mode could not be established, so there is no way to know which quantity is ' +
      'stationary under reshuffling. Shuffling the wrong one produces a distribution that looks ' +
      'authoritative and describes nothing (A43), so nothing is reported.';
    return {
      ...base,
      quantity: null,
      verdict: 'n/a',
      explanation: reason,
      inconclusiveReason: reason,
    };
  }

  const quantity = params.sizingMode === 'percent-equity' ? 'return-pct' : 'dollar-pnl';

  const usable =
    quantity === 'return-pct'
      ? params.trades.filter((t) => t.returnPct !== null)
      : [...params.trades];

  if (usable.length < minTrades) {
    const reason =
      `${String(usable.length)} usable trade(s), against a minimum of ${String(minTrades)}. ` +
      'Reshuffling a handful of trades permutes noise: the distribution would describe the sample, ' +
      'not the strategy.';
    return { ...base, quantity, verdict: 'n/a', explanation: reason, inconclusiveReason: reason };
  }

  const values =
    quantity === 'return-pct'
      ? usable.map((t) => t.returnPct as number)
      : usable.map((t) => t.netPnl);

  const observed = walk(values, quantity, params.initialCapital);

  const drawdowns: number[] = [];
  let ruined = 0;
  const rng = lcg(params.seed ?? 1);
  const order = [...values];

  for (let i = 0; i < iterations; i += 1) {
    shuffleInPlace(order, rng);
    const path = walk(order, quantity, params.initialCapital);
    drawdowns.push(path.maxDrawdownPct);
    if (path.ruined) ruined += 1;
  }

  const sorted = [...drawdowns].sort((a, b) => a - b);
  const below = sorted.filter((d) => d < observed.maxDrawdownPct).length;

  return {
    ...base,
    quantity,
    trades: usable.length,
    maxDrawdownPct: percentilesOf(sorted),
    observedMaxDrawdownPct: observed.maxDrawdownPct,
    observedPercentile: below / sorted.length,
    riskOfRuinPct: (ruined / iterations) * 100,
    finalReturnPct: observed.finalReturnPct,
    ...judge(
      observed.maxDrawdownPct,
      below / sorted.length,
      percentilesOf(sorted),
      ruined / iterations,
    ),
  };
}

interface Path {
  readonly maxDrawdownPct: number;
  readonly finalReturnPct: number;
  readonly ruined: boolean;
}

/**
 * Walk one ordering, tracking the worst peak-to-trough fall.
 *
 * Drawdown is measured against the running PEAK rather than the starting capital, which is what
 * makes it comparable between an ordering that lost early and one that gave back a gain.
 */
function walk(values: readonly number[], quantity: string, initialCapital: number): Path {
  let equity = initialCapital;
  let peak = initialCapital;
  let worst = 0;
  let ruined = false;

  for (const v of values) {
    equity = quantity === 'return-pct' ? equity * (1 + v / 100) : equity + v;

    if (equity <= 0) {
      ruined = true;
      equity = 0;
    }
    if (equity > peak) peak = equity;

    const fall = peak === 0 ? 0 : ((peak - equity) / peak) * 100;
    if (fall > worst) worst = fall;
    if (ruined) break;
  }

  return {
    maxDrawdownPct: worst,
    finalReturnPct: initialCapital === 0 ? 0 : ((equity - initialCapital) / initialCapital) * 100,
    ruined,
  };
}

function judge(
  observedDd: number,
  percentile: number,
  dist: Percentiles,
  ruinRate: number,
): Pick<MonteCarloResult, 'verdict' | 'explanation' | 'inconclusiveReason'> {
  const shape =
    `Reshuffling the same trades gives a median drawdown of ${dist.p50.toFixed(1)}% and a 95th ` +
    `percentile of ${dist.p95.toFixed(1)}%, against the ${observedDd.toFixed(1)}% this run actually ` +
    `showed. Final return is identical in every ordering — only the path moves.`;

  if (ruinRate > 0) {
    return {
      verdict: 'fail',
      explanation:
        `${(ruinRate * 100).toFixed(1)}% of orderings wipe the account out entirely. The same trades ` +
        `in a different sequence end at zero, so this result depends on the order they happened to ` +
        `arrive in. ${shape}`,
      inconclusiveReason: null,
    };
  }

  // A run sitting in the bottom quarter of the drawdown distribution had a favourable ordering, and
  // sizing chosen from its curve would be sized from that luck rather than from the strategy.
  if (percentile <= 0.25) {
    return {
      verdict: 'warn',
      explanation:
        `This run's drawdown sits at the ${(percentile * 100).toFixed(0)}th percentile of orderings ` +
        `— three quarters of them were worse. The curve you are looking at is a favourable draw, ` +
        `and position sizing taken from it would be sized from that luck. ${shape}`,
      inconclusiveReason: null,
    };
  }

  return { verdict: 'pass', explanation: shape, inconclusiveReason: null };
}

function percentilesOf(sorted: readonly number[]): Percentiles {
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    p5: at(0.05),
    p25: at(0.25),
    p50: at(0.5),
    p75: at(0.75),
    p95: at(0.95),
    worst: sorted[sorted.length - 1] ?? 0,
  };
}

/** Fisher-Yates, in place. Unbiased, unlike sorting by a random comparator. */
function shuffleInPlace(values: number[], rng: () => number): void {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = values[i]!;
    values[i] = values[j]!;
    values[j] = tmp;
  }
}

/** Seeded, so a report is reproducible. Same generator the optimiser samples with. */
function lcg(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
