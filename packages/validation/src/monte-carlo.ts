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
 * TWO RESAMPLINGS, ANSWERING DIFFERENT QUESTIONS.
 *
 *   - **Reshuffle** permutes the trades that happened. The final result is INVARIANT under it, and
 *     that is not a bug: summing dollars and multiplying growth factors are both commutative, so
 *     every ordering ends at the same place and only the PATH moves. A reshuffle that reports a
 *     spread of final returns has shuffled the wrong quantity — the symptom A43 prevents. What it
 *     measures is drawdown: how bad the ride could have been with the same trades in another order.
 *   - **Bootstrap** resamples WITH REPLACEMENT, so each draw is a different trade set from the same
 *     distribution. Here a spread of final returns is the whole point, because it answers the
 *     question the reshuffle cannot: could this profit plausibly be luck? A strategy whose bootstrap
 *     loses money a third of the time has an edge indistinguishable from chance at this sample size.
 *
 * The A43 rule governs both: the quantity resampled is whichever one sizing holds stationary.
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

export interface BootstrapResult {
  readonly iterations: number;
  /** Final return across resamples. A spread here is the signal, not a defect. */
  readonly finalReturnPct: Percentiles;
  /** Share of resampled trade sets that lose money. */
  readonly lossSharePct: number;
  /** What the actual trade set returned, for comparison against the distribution. */
  readonly observedFinalReturnPct: number;
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
  /** Invariant across ORDERINGS, and reported to make that visible. */
  readonly finalReturnPct: number | null;
  /**
   * The drawdown to size positions around.
   *
   * The 95th percentile rather than the observed figure: the backtest showed one ordering, and
   * sizing from it is sizing from that draw. This is the number that answers "how bad could the
   * ride get with these same trades".
   */
  readonly planningDrawdownPct: number | null;
  /** Resampling with replacement. Null when the check could not run. */
  readonly bootstrap: BootstrapResult | null;
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

/** See `judge`: one-sided confidence statements about the profit. */
const BOOTSTRAP_WARN_PCT = 5;
const BOOTSTRAP_FAIL_PCT = 33;
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
    planningDrawdownPct: null,
    bootstrap: null,
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
  const ddPercentiles = percentilesOf(sorted);
  const observedPercentile = below / sorted.length;

  // WITH replacement, so each draw is a different trade set from the same distribution. Unlike the
  // reshuffle this genuinely moves the final return, which is what lets it say whether the profit
  // could be luck.
  const bootstrapReturns: number[] = [];
  const draw = [...values];
  for (let i = 0; i < iterations; i += 1) {
    for (let k = 0; k < draw.length; k += 1) {
      draw[k] = values[Math.floor(rng() * values.length)]!;
    }
    bootstrapReturns.push(walk(draw, quantity, params.initialCapital).finalReturnPct);
  }

  const bootstrapSorted = [...bootstrapReturns].sort((a, b) => a - b);
  const bootstrap: BootstrapResult = {
    iterations,
    finalReturnPct: percentilesOf(bootstrapSorted),
    lossSharePct: (bootstrapSorted.filter((r) => r <= 0).length / bootstrapSorted.length) * 100,
    observedFinalReturnPct: observed.finalReturnPct,
  };

  return {
    ...base,
    quantity,
    trades: usable.length,
    maxDrawdownPct: ddPercentiles,
    observedMaxDrawdownPct: observed.maxDrawdownPct,
    observedPercentile,
    riskOfRuinPct: (ruined / iterations) * 100,
    finalReturnPct: observed.finalReturnPct,
    planningDrawdownPct: ddPercentiles.p95,
    bootstrap,
    ...judge(
      observed.maxDrawdownPct,
      observedPercentile,
      ddPercentiles,
      ruined / iterations,
      bootstrap,
    ),
  };
}

interface Path {
  readonly maxDrawdownPct: number;
  readonly finalReturnPct: number;
  readonly ruined: boolean;
}

/**
 * Walk one sequence, tracking the worst peak-to-trough fall.
 *
 * Drawdown is measured against the running PEAK rather than starting capital, which is what makes it
 * comparable between a sequence that lost early and one that gave back a gain.
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

/**
 * Both tails of the reshuffle matter, for opposite reasons.
 *
 * BELOW the 5th percentile the backtest's ordering was LUCKY: almost every other arrangement of the
 * same trades drew down further, so the reported drawdown understates the risk.
 *
 * ABOVE the 95th the realised sequence was worse than reshuffling generally produces, which means
 * the losses CLUSTERED. Random permutation destroys exactly that serial dependence, so the
 * distribution understates the risk here too — by modelling a process the strategy does not have.
 *
 * Both are warnings, and both say the same practical thing: do not size from the observed curve.
 */
function judge(
  observedDd: number,
  percentile: number,
  dist: Percentiles,
  ruinRate: number,
  bootstrap: BootstrapResult,
): Pick<MonteCarloResult, 'verdict' | 'explanation' | 'inconclusiveReason'> {
  const shape =
    `Reshuffling gives a median drawdown of ${dist.p50.toFixed(1)}% and a 95th percentile of ` +
    `${dist.p95.toFixed(1)}%, against the ${observedDd.toFixed(1)}% this run showed — size around ` +
    `${dist.p95.toFixed(1)}%, not ${observedDd.toFixed(1)}%. Final return is identical in every ` +
    `ordering; only the path moves. Bootstrapping with replacement gives a final return of ` +
    `${bootstrap.finalReturnPct.p5.toFixed(1)}% / ${bootstrap.finalReturnPct.p50.toFixed(1)}% / ` +
    `${bootstrap.finalReturnPct.p95.toFixed(1)}% at the 5th/50th/95th percentile, with ` +
    `${bootstrap.lossSharePct.toFixed(1)}% of resamples losing money.`;

  if (ruinRate > 0) {
    return {
      verdict: 'fail',
      explanation:
        `${(ruinRate * 100).toFixed(1)}% of orderings wipe the account out entirely. The same ` +
        `trades in a different sequence end at zero, so this result depends on the order they ` +
        `happened to arrive in. ${shape}`,
      inconclusiveReason: null,
    };
  }

  // Thresholds as one-sided confidence statements about the profit, not about the account:
  //
  //   >5%  losing  — the result is not significant at the conventional level -> warn
  //   >33% losing  — a third of equally plausible trade sets lose money -> fail
  //
  // 50% was the first cut and it is unreachable for a profitable run: the bootstrap centres on the
  // observed mean, so half the resamples can only lose if the run itself made nothing — which the
  // OOS split and the cost stress already catch. A threshold that can only fire on a losing run
  // tells you nothing you did not have.
  if (bootstrap.lossSharePct >= BOOTSTRAP_FAIL_PCT) {
    return {
      verdict: 'fail',
      explanation:
        `${bootstrap.lossSharePct.toFixed(1)}% of bootstrap resamples lose money — a third or more ` +
        `of equally plausible trade sets drawn from the same distribution are unprofitable. The ` +
        `profit this run reports is not distinguishable from luck at this sample size. ${shape}`,
      inconclusiveReason: null,
    };
  }

  if (percentile < 0.05) {
    return {
      verdict: 'warn',
      explanation:
        `This run's drawdown sits at the ${(percentile * 100).toFixed(0)}th percentile of ` +
        `orderings — nearly every other arrangement of the same trades was worse. The curve is a ` +
        `favourable draw and its drawdown understates the risk. ${shape}`,
      inconclusiveReason: null,
    };
  }

  if (percentile > 0.95) {
    return {
      verdict: 'warn',
      explanation:
        `This run's drawdown sits at the ${(percentile * 100).toFixed(0)}th percentile of ` +
        `orderings — worse than reshuffling generally produces, which means the losses CLUSTERED. ` +
        `Random permutation destroys that serial dependence, so this distribution understates the ` +
        `risk rather than bounding it. ${shape}`,
      inconclusiveReason: null,
    };
  }

  if (bootstrap.lossSharePct >= BOOTSTRAP_WARN_PCT) {
    return {
      verdict: 'warn',
      explanation:
        `${bootstrap.lossSharePct.toFixed(1)}% of bootstrap resamples lose money, so a trade set ` +
        `drawn from the same distribution would not always have been profitable. ${shape}`,
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
