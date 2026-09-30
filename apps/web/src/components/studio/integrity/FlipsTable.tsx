import { Figure, Withheld } from './Withheld';

/**
 * Trades whose outcome the M1 replay changed.
 *
 * Two kinds, and the distinction is the reason this table exists rather than a count:
 *
 *  - **phantom target** — the engine closed at a target the correct side of the book never reached;
 *  - **missed stop** — the correct side crossed the stop on an earlier bar whose stored prices did
 *    not, so the trade really closed at a loss while the engine carried it on, often to a target.
 *
 * The second is the one no other check can see, and it converts a loss into a win rather than
 * merely mispricing one — so it is listed first and marked, not averaged into a total.
 *
 * Every row jumps to the instant the replay found, which is minute-level and will be snapped to the
 * chart's bar with a note (A53).
 */

export interface FlipRow {
  readonly seq: number;
  readonly side: 'long' | 'short';
  readonly flip: 'none' | 'phantom-target' | 'missed-stop';
  readonly enginePrice: number;
  readonly truePrice: number | null;
  readonly trueMs: number | null;
  readonly priceDelta: number;
  readonly netPnlReported: number;
  readonly netPnlCorrected: number;
}

export interface FlipsTableProps {
  readonly rows: readonly FlipRow[];
  readonly pipSize: number;
  readonly currency: string;
  readonly onJumpToTime?: (atMs: number) => void;
  readonly onJumpToTrade?: (seq: number) => void;
}

const FLIP_LABEL: Record<string, string> = {
  'missed-stop': 'missed stop',
  'phantom-target': 'phantom target',
};

export function FlipsTable({
  rows,
  pipSize,
  currency,
  onJumpToTime,
  onJumpToTrade,
}: FlipsTableProps): React.JSX.Element {
  const flips = rows.filter((r) => r.flip !== 'none');

  if (flips.length === 0) {
    return (
      <Withheld>
        No outcome changed when the holding periods were replayed on M1. Every stop and target
        triggered on the side of the book it actually fills on.
      </Withheld>
    );
  }

  // Missed stops first: they turn a loss into a win, which is a larger claim than mispricing one.
  const ordered = [...flips].sort((a, b) =>
    a.flip === b.flip ? a.seq - b.seq : a.flip === 'missed-stop' ? -1 : 1,
  );

  const totalDelta = flips.reduce((s, r) => s + (r.netPnlCorrected - r.netPnlReported), 0);

  return (
    <div className="space-y-1" data-testid="flips-table">
      <table className="w-full text-xs">
        <thead className="text-muted">
          <tr className="border-b border-border">
            <th className="py-1 text-left font-normal">Trade</th>
            <th className="py-1 text-left font-normal">What changed</th>
            <th className="py-1 text-right font-normal">Engine</th>
            <th className="py-1 text-right font-normal">Replay</th>
            <th className="py-1 text-right font-normal">Pips</th>
            <th className="py-1 text-right font-normal">P&amp;L effect</th>
            <th className="py-1 text-right font-normal">When</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((r) => {
            const delta = r.netPnlCorrected - r.netPnlReported;
            return (
              <tr key={r.seq} className="border-b border-border/40">
                <td className="py-1">
                  <button
                    type="button"
                    className="text-primary underline underline-offset-2"
                    onClick={() => onJumpToTrade?.(r.seq)}
                    data-testid={`flip-trade-${String(r.seq)}`}
                  >
                    #{r.seq} {r.side}
                  </button>
                </td>
                <td className="py-1">
                  <span className={r.flip === 'missed-stop' ? 'text-rose-300' : 'text-amber-300'}>
                    {FLIP_LABEL[r.flip]}
                  </span>
                </td>
                <td className="py-1 text-right tabular-nums">{r.enginePrice.toFixed(5)}</td>
                <td className="py-1 text-right tabular-nums">
                  <Figure
                    value={r.truePrice}
                    format={(v) => v.toFixed(5)}
                    reason="No level was genuinely touched in the holding period, so there is no replayed price — which is what makes this a phantom."
                  />
                </td>
                <td className="py-1 text-right tabular-nums">
                  {pipSize > 0 ? (r.priceDelta / pipSize).toFixed(1) : '—'}
                </td>
                <td
                  className={`py-1 text-right tabular-nums ${delta < 0 ? 'text-rose-300' : 'text-emerald-300'}`}
                >
                  {delta === 0 ? '—' : delta.toFixed(2)}
                </td>
                <td className="py-1 text-right">
                  {r.trueMs === null ? (
                    <span className="text-muted">—</span>
                  ) : (
                    <button
                      type="button"
                      className="text-primary underline underline-offset-2"
                      onClick={() => onJumpToTime?.(r.trueMs as number)}
                      data-testid={`flip-time-${String(r.seq)}`}
                    >
                      {new Date(r.trueMs).toISOString().replace('T', ' ').slice(5, 16)}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="text-xs text-muted">
        {flips.filter((f) => f.flip === 'missed-stop').length} missed stop(s),{' '}
        {flips.filter((f) => f.flip === 'phantom-target').length} phantom target(s). Net effect{' '}
        {totalDelta.toFixed(2)} {currency}. A phantom has no P&amp;L correction: without replaying
        the strategy past the engine&rsquo;s exit there is no way to know where the trade would have
        ended, and understating the correction is the safe direction.
      </p>
    </div>
  );
}
