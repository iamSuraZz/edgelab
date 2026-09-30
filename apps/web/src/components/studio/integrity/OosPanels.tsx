import { Figure, Withheld } from './Withheld';

/**
 * The out-of-sample split and the rolling folds.
 *
 * Both compare an in-sample window against an out-of-sample one, and both report their ratio PER
 * CALENDAR DAY (A36) — comparing raw returns over windows of different lengths scored an unchanged
 * strategy at 0.33 on a 3:1 fold and 0.43 on a 70/30 split, artefacts of the layout that read as
 * decay. The label says "per day" for that reason, not for decoration.
 *
 * A withheld ratio shows why it was withheld, never a zero.
 */

export interface SegmentView {
  readonly fromMs: number;
  readonly toMs: number;
  readonly trades: number;
  readonly netProfit: number;
  readonly returnPct: number | null;
  readonly profitFactor: number | null;
}

export interface OosSplitView {
  readonly inSample: SegmentView;
  readonly outOfSample: SegmentView;
  readonly degradation: {
    readonly returnRatio: number | null;
    readonly returnRatioStable: boolean;
  };
  readonly verdict: string;
  readonly explanation: string;
}

export function OosSplitPanel({
  split,
  currency,
}: {
  split: OosSplitView;
  currency: string;
}): React.JSX.Element {
  const { returnRatio, returnRatioStable } = split.degradation;

  return (
    <div className="space-y-2" data-testid="oos-split-panel">
      <table className="w-full text-xs">
        <thead className="text-muted">
          <tr className="border-b border-border">
            <th className="py-1 text-left font-normal">Segment</th>
            <th className="py-1 text-left font-normal">Window</th>
            <th className="py-1 text-right font-normal">Trades</th>
            <th className="py-1 text-right font-normal">Net</th>
            <th className="py-1 text-right font-normal">Return</th>
            <th className="py-1 text-right font-normal">Per day</th>
            <th className="py-1 text-right font-normal">PF</th>
          </tr>
        </thead>
        <tbody>
          <SegmentRow label="In sample" seg={split.inSample} />
          <SegmentRow label="Out of sample" seg={split.outOfSample} />
        </tbody>
      </table>

      <p className="text-xs text-muted">
        Retention{' '}
        {returnRatio === null || !returnRatioStable ? (
          <Figure
            value={null}
            reason={
              returnRatio === null
                ? 'The in-sample half did not make money, so there is no edge whose persistence could be measured. A ratio against a non-positive baseline reads as success when both halves lose.'
                : 'The in-sample return was too small for a ratio against it to mean anything — a denominator that close to zero makes the result arithmetic rather than evidence.'
            }
          />
        ) : (
          <strong className="text-foreground">{(returnRatio * 100).toFixed(0)}%</strong>
        )}{' '}
        of the in-sample earning RATE, both measured per calendar day. {split.explanation} Net in{' '}
        {currency}.
      </p>
    </div>
  );
}

function SegmentRow({ label, seg }: { label: string; seg: SegmentView }): React.JSX.Element {
  const days = (seg.toMs - seg.fromMs) / 86_400_000;
  const perDay = seg.returnPct === null || days <= 0 ? null : seg.returnPct / days;

  return (
    <tr className="border-b border-border/40">
      <td className="py-1">{label}</td>
      <td className="py-1 text-muted">
        {day(seg.fromMs)} → {day(seg.toMs)}
      </td>
      <td className="py-1 text-right tabular-nums">{seg.trades}</td>
      <td
        className={`py-1 text-right tabular-nums ${seg.netProfit < 0 ? 'text-rose-300' : 'text-emerald-300'}`}
      >
        {seg.netProfit.toFixed(0)}
      </td>
      <td className="py-1 text-right tabular-nums">
        <Figure value={seg.returnPct} format={(v) => `${v.toFixed(2)}%`} />
      </td>
      <td className="py-1 text-right tabular-nums">
        <Figure
          value={perDay}
          format={(v) => `${v.toFixed(3)}%`}
          reason="The window has no length, so a daily rate is undefined."
        />
      </td>
      <td className="py-1 text-right tabular-nums">
        <Figure
          value={seg.profitFactor}
          format={(v) => v.toFixed(2)}
          reason="No losing trades, so the profit factor has a zero denominator and is genuinely undefined."
        />
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------ rolling folds */

export interface RollingFoldView {
  readonly index: number;
  readonly inSample: SegmentView;
  readonly outOfSample: SegmentView;
  readonly retention: number | null;
  readonly retentionStable: boolean;
  readonly hadEdge: boolean;
  readonly survived: boolean;
  readonly assessable: boolean;
}

export function RollingFoldsPanel({
  folds,
  medianRetention,
}: {
  folds: readonly RollingFoldView[];
  medianRetention: number | null;
}): React.JSX.Element {
  if (folds.length === 0) {
    return <Withheld>No folds were produced, so there is nothing to compare.</Withheld>;
  }

  return (
    <div className="space-y-2" data-testid="rolling-folds-panel">
      <table className="w-full text-xs">
        <thead className="text-muted">
          <tr className="border-b border-border">
            <th className="py-1 text-left font-normal">Fold</th>
            <th className="py-1 text-right font-normal">IS return</th>
            <th className="py-1 text-right font-normal">OOS return</th>
            <th className="py-1 text-right font-normal">OOS trades</th>
            <th className="py-1 text-right font-normal">Retention /day</th>
            <th className="py-1 text-left font-normal">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {folds.map((f) => (
            <tr key={f.index} className="border-b border-border/40">
              <td className="py-1">#{f.index}</td>
              <td className="py-1 text-right tabular-nums">
                <Figure value={f.inSample.returnPct} format={(v) => `${v.toFixed(2)}%`} />
              </td>
              <td className="py-1 text-right tabular-nums">
                <Figure value={f.outOfSample.returnPct} format={(v) => `${v.toFixed(2)}%`} />
              </td>
              <td className="py-1 text-right tabular-nums">{f.outOfSample.trades}</td>
              <td className="py-1 text-right tabular-nums">
                <Figure
                  value={f.retentionStable ? f.retention : null}
                  format={(v) => v.toFixed(2)}
                  reason={
                    f.retention === null
                      ? 'This fold did not train profitably, so there was no edge to retain.'
                      : 'The in-sample return was too small for the ratio to mean anything.'
                  }
                />
              </td>
              <td className="py-1">
                {!f.assessable ? (
                  <span className="text-muted">too few trades</span>
                ) : !f.hadEdge ? (
                  <span className="text-muted">no edge in sample</span>
                ) : f.survived ? (
                  <span className="text-emerald-300">held</span>
                ) : (
                  <span className="text-rose-300">reversed</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-xs text-muted">
        Median retention{' '}
        <Figure
          value={medianRetention}
          format={(v) => v.toFixed(2)}
          reason="No fold had an in-sample return large enough for a meaningful ratio."
        />{' '}
        — 1.0 means the strategy earned at the same rate out of sample as in it. Nothing is
        optimised here: these are the script&rsquo;s own inputs on rolling windows, so a strategy
        hand-tuned on this data will pass.
      </p>
    </div>
  );
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
