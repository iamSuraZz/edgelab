import { Withheld } from './Withheld';

/**
 * The two resamplings, which answer different questions (A47, A48).
 *
 * The RESHUFFLE gives a drawdown distribution: the final return is invariant under permutation, so
 * drawing a distribution of returns here would be the symptom of shuffling the wrong quantity. The
 * observed value is marked, and p95 is labelled as the figure to size around — the backtest showed
 * one ordering, and sizing from its curve is sizing from that draw.
 *
 * The BOOTSTRAP gives a final-return distribution, because resampling with replacement genuinely
 * moves it. The share that loses money is the headline: it answers whether the profit could be luck,
 * which permutation cannot.
 */

export interface PercentilesView {
  readonly p5: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p95: number;
  readonly worst: number;
}

export interface MonteCarloView {
  readonly iterations: number;
  readonly quantity: 'return-pct' | 'dollar-pnl' | null;
  readonly maxDrawdownPct: PercentilesView | null;
  readonly observedMaxDrawdownPct: number | null;
  readonly observedPercentile: number | null;
  readonly planningDrawdownPct: number | null;
  readonly riskOfRuinPct: number | null;
  readonly finalReturnPct: number | null;
  readonly bootstrap: {
    readonly finalReturnPct: PercentilesView;
    readonly lossSharePct: number;
    readonly observedFinalReturnPct: number;
  } | null;
  readonly explanation: string;
}

export function MonteCarloPanel({ mc }: { mc: MonteCarloView }): React.JSX.Element {
  if (mc.maxDrawdownPct === null || mc.bootstrap === null) {
    return <Withheld>{mc.explanation}</Withheld>;
  }

  return (
    <div className="space-y-4" data-testid="monte-carlo-panel">
      <section className="space-y-1">
        <h5 className="text-xs font-medium">
          Reshuffled drawdown — {mc.iterations} orderings of the same trades
        </h5>
        <Distribution
          p={mc.maxDrawdownPct}
          observed={mc.observedMaxDrawdownPct}
          highlight={mc.planningDrawdownPct}
          highlightLabel="size around this"
          unit="%"
          testId="reshuffle-distribution"
        />
        <p className="text-xs text-muted">
          The final return is <strong className="text-foreground">identical</strong> in every
          ordering — summing and compounding are both commutative — so only the path moves. Your
          backtest showed{' '}
          <strong className="text-foreground">
            {(mc.observedMaxDrawdownPct ?? 0).toFixed(1)}%
          </strong>
          {mc.observedPercentile !== null && (
            <>
              , the {(mc.observedPercentile * 100).toFixed(0)}th percentile of orderings
              {mc.observedPercentile < 0.05 && ' — a favourable draw, so it understates the risk'}
              {mc.observedPercentile > 0.95 &&
                ' — worse than reshuffling usually produces, which means the losses clustered and permutation cannot reproduce that'}
            </>
          )}
          . Size around{' '}
          <strong className="text-amber-300">{(mc.planningDrawdownPct ?? 0).toFixed(1)}%</strong>,
          not the figure you were shown.
          {mc.riskOfRuinPct !== null && mc.riskOfRuinPct > 0 && (
            <>
              {' '}
              <strong className="text-rose-300">
                {mc.riskOfRuinPct.toFixed(1)}% of orderings wipe the account out.
              </strong>
            </>
          )}
        </p>
      </section>

      <section className="space-y-1">
        <h5 className="text-xs font-medium">
          Bootstrapped final return — {mc.iterations} resamples with replacement
        </h5>
        <Distribution
          p={mc.bootstrap.finalReturnPct}
          observed={mc.bootstrap.observedFinalReturnPct}
          highlight={null}
          highlightLabel=""
          unit="%"
          testId="bootstrap-distribution"
          zeroLine
        />
        <p className="text-xs text-muted">
          Unlike the reshuffle this DOES move the result, which is what lets it answer whether the
          profit could be luck.{' '}
          <strong className={mc.bootstrap.lossSharePct >= 5 ? 'text-amber-300' : 'text-foreground'}>
            {mc.bootstrap.lossSharePct.toFixed(1)}% of resampled trade sets lose money.
          </strong>
        </p>
      </section>
    </div>
  );
}

/**
 * A percentile strip.
 *
 * A box-plot rather than a histogram: five percentiles is what the check reports, and drawing a
 * histogram from them would interpolate a shape nobody measured.
 */
function Distribution({
  p,
  observed,
  highlight,
  highlightLabel,
  unit,
  testId,
  zeroLine = false,
}: {
  p: PercentilesView;
  observed: number | null;
  highlight: number | null;
  highlightLabel: string;
  unit: string;
  testId: string;
  zeroLine?: boolean;
}): React.JSX.Element {
  const lo = Math.min(p.p5, observed ?? p.p5, zeroLine ? 0 : p.p5);
  const hi = Math.max(p.p95, observed ?? p.p95, zeroLine ? 0 : p.p95);
  const span = Math.max(1e-9, hi - lo);
  const at = (v: number): number => ((v - lo) / span) * 100;

  return (
    <div className="space-y-1" data-testid={testId}>
      <div className="relative h-8">
        {/* p5..p95 whisker, p25..p75 box. */}
        <div
          className="absolute top-3.5 h-0.5 bg-border"
          style={{ left: `${at(p.p5)}%`, width: `${at(p.p95) - at(p.p5)}%` }}
        />
        <div
          className="absolute top-2 h-3 rounded-sm bg-primary/25"
          style={{ left: `${at(p.p25)}%`, width: `${Math.max(1, at(p.p75) - at(p.p25))}%` }}
        />
        <div
          className="absolute top-1.5 h-4 w-0.5 bg-primary"
          style={{ left: `${at(p.p50)}%` }}
          title={`median ${p.p50.toFixed(1)}${unit}`}
        />

        {zeroLine && lo < 0 && hi > 0 && (
          <div
            className="absolute top-0 h-7 w-px bg-muted"
            style={{ left: `${at(0)}%` }}
            title="break-even"
          />
        )}

        {observed !== null && (
          <div
            className="absolute top-0 h-7 w-0.5 bg-foreground"
            style={{ left: `${at(observed)}%` }}
            title={`this run: ${observed.toFixed(1)}${unit}`}
            data-testid={`${testId}-observed`}
          />
        )}

        {highlight !== null && (
          <div
            className="absolute top-0 h-7 w-0.5 bg-amber-400"
            style={{ left: `${at(highlight)}%` }}
            title={`${highlightLabel}: ${highlight.toFixed(1)}${unit}`}
            data-testid={`${testId}-highlight`}
          />
        )}
      </div>

      <div className="flex justify-between text-[0.65rem] text-muted">
        <span>
          p5 {p.p5.toFixed(1)}
          {unit}
        </span>
        <span>
          median {p.p50.toFixed(1)}
          {unit}
        </span>
        <span className={highlight === null ? '' : 'text-amber-300'}>
          p95 {p.p95.toFixed(1)}
          {unit}
          {highlight !== null && ` — ${highlightLabel}`}
        </span>
      </div>
    </div>
  );
}
