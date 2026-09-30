import { Withheld } from './Withheld';

/**
 * Net profit against the cost multiplier, with the break-even point marked.
 *
 * The curve is the answer to "how much worse could execution get before this stops working", and
 * the break-even crossing is the only point on it anyone acts on — so it is drawn, not left to be
 * read off an axis.
 *
 * An SVG rather than a charting library: five to eight points and one marker does not justify
 * another dependency in the bundle, and hand-drawing it means the break-even marker sits exactly
 * where the interpolation says rather than where a library's nearest-point logic puts it.
 */

export interface CostStressPoint {
  readonly multiplier: number;
  readonly netProfit: number;
  readonly totalCosts: number;
  readonly trades: number;
}

export interface CostStressCurveProps {
  readonly points: readonly CostStressPoint[];
  /** Interpolated crossing. Null when the curve never reaches zero. */
  readonly breakEvenMultiplier: number | null;
  readonly currency: string;
}

const W = 520;
const H = 180;
const PAD = { top: 12, right: 16, bottom: 26, left: 56 };

export function CostStressCurve({
  points,
  breakEvenMultiplier,
  currency,
}: CostStressCurveProps): React.JSX.Element {
  if (points.length < 2) {
    return <Withheld>Fewer than two stress points, so there is no curve to draw.</Withheld>;
  }

  const sorted = [...points].sort((a, b) => a.multiplier - b.multiplier);
  const xs = sorted.map((p) => p.multiplier);
  const ys = sorted.map((p) => p.netProfit);

  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  // Zero is always in range: a profit curve that never shows the zero line hides the only
  // threshold that matters.
  const yMin = Math.min(0, ...ys);
  const yMax = Math.max(0, ...ys);

  const x = (v: number): number =>
    PAD.left + ((v - xMin) / Math.max(1e-9, xMax - xMin)) * (W - PAD.left - PAD.right);
  const y = (v: number): number =>
    H - PAD.bottom - ((v - yMin) / Math.max(1e-9, yMax - yMin)) * (H - PAD.top - PAD.bottom);

  const path = sorted.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.multiplier)},${y(p.netProfit)}`);
  const zeroY = y(0);

  return (
    <figure className="space-y-1" data-testid="cost-stress-curve">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Cost stress curve">
        {/* The zero line, which is what "break-even" means. */}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={zeroY}
          y2={zeroY}
          className="stroke-muted"
          strokeDasharray="3 3"
          strokeWidth={1}
        />
        <text x={4} y={zeroY + 3} className="fill-muted text-[9px]">
          0
        </text>

        <text x={4} y={y(yMax) + 3} className="fill-muted text-[9px]">
          {compact(yMax)}
        </text>
        {yMin < 0 && (
          <text x={4} y={y(yMin) + 3} className="fill-muted text-[9px]">
            {compact(yMin)}
          </text>
        )}

        <path d={path.join(' ')} className="fill-none stroke-primary" strokeWidth={2} />

        {sorted.map((p) => (
          <g key={p.multiplier}>
            <circle cx={x(p.multiplier)} cy={y(p.netProfit)} r={3} className="fill-primary" />
            <text
              x={x(p.multiplier)}
              y={H - 8}
              textAnchor="middle"
              className="fill-muted text-[9px]"
            >
              {p.multiplier}x
            </text>
          </g>
        ))}

        {breakEvenMultiplier !== null &&
          breakEvenMultiplier >= xMin &&
          breakEvenMultiplier <= xMax && (
            <g data-testid="break-even-marker">
              <line
                x1={x(breakEvenMultiplier)}
                x2={x(breakEvenMultiplier)}
                y1={PAD.top}
                y2={H - PAD.bottom}
                className="stroke-amber-400"
                strokeWidth={1.5}
              />
              <circle cx={x(breakEvenMultiplier)} cy={zeroY} r={4} className="fill-amber-400" />
              <text
                x={x(breakEvenMultiplier)}
                y={PAD.top + 9}
                textAnchor="middle"
                className="fill-amber-300 text-[10px] font-medium"
              >
                break-even {breakEvenMultiplier.toFixed(2)}x
              </text>
            </g>
          )}
      </svg>

      <figcaption className="text-xs text-muted">
        Net profit in {currency} as costs are scaled.{' '}
        {breakEvenMultiplier === null
          ? 'The curve never reaches zero over the range tested.'
          : `It crosses zero at ${breakEvenMultiplier.toFixed(2)}x this run's actual costs.`}
      </figcaption>
    </figure>
  );
}

function compact(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return v.toFixed(0);
}
