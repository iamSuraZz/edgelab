/**
 * Per-fill figures in the units a trader reads, alongside the money.
 *
 * Every execution-bias check produces a total in account currency, and a total is the worst unit for
 * noticing that something is wrong. "$9,080.99" over an unstated number of fills is unfalsifiable at
 * a glance; "$12.58 per fill, 1.3 pips" is immediately checkable against what an H1 EURUSD bar
 * actually does, and a unit error of 100,000x stops being invisible.
 *
 * Both instrument scales are reported because they answer different questions. PIPS are the scale a
 * strategy is designed in — stops and targets are chosen in pips. TICKS are the scale the data is
 * quoted in, so a figure of "0.4 ticks" says the effect is below what the feed can even represent.
 *
 * Derived from the PRICE gap each check already computes, never by dividing money by a position
 * size. Inverting money would reintroduce exactly the lots-vs-units question these figures exist to
 * expose.
 */

export interface InstrumentScale {
  /** Smallest representable price increment. */
  readonly mintick: number;
  /** One pip. Ten ticks on a 5-digit pair, one tick on a 3-digit one. */
  readonly pipSize: number;
}

export interface PerFillFigures {
  readonly fills: number;
  /** Mean account-currency cost per fill. */
  readonly moneyPerFill: number | null;
  /** Mean absolute price movement per fill, in pips. */
  readonly pipsPerFill: number | null;
  /** The same, in ticks. */
  readonly ticksPerFill: number | null;
}

/**
 * Summarise a set of price gaps.
 *
 * `priceGaps` are SIGNED, so the mean can cancel out — which is itself a finding, and the reason the
 * signed mean is reported rather than the mean of absolutes. A systematically adverse effect and a
 * randomly distributed one are different conclusions, and only the signed mean tells them apart.
 */
export function perFillFigures(
  priceGaps: readonly number[],
  totalMoney: number,
  scale: InstrumentScale,
): PerFillFigures {
  const n = priceGaps.length;
  if (n === 0) {
    return { fills: 0, moneyPerFill: null, pipsPerFill: null, ticksPerFill: null };
  }

  const meanGap = priceGaps.reduce((sum, g) => sum + g, 0) / n;

  return {
    fills: n,
    moneyPerFill: totalMoney / n,
    pipsPerFill: scale.pipSize > 0 ? meanGap / scale.pipSize : null,
    ticksPerFill: scale.mintick > 0 ? meanGap / scale.mintick : null,
  };
}

/** The one-line form every execution-bias check appends to its detail string. */
export function describePerFill(f: PerFillFigures): string {
  if (f.fills === 0 || f.moneyPerFill === null) return 'No fills to summarise.';

  const pips = f.pipsPerFill === null ? '' : ` = ${f.pipsPerFill.toFixed(2)} pips`;
  const ticks = f.ticksPerFill === null ? '' : ` (${f.ticksPerFill.toFixed(1)} ticks)`;

  return `${f.moneyPerFill.toFixed(2)} per fill over ${String(f.fills)} fills${pips}${ticks}`;
}

/* ------------------------------------------------------------- gap types */

/**
 * Why two consecutive bars are not adjacent in time.
 *
 * A market order fills at the NEXT bar's open, so the distance from the signal bar's close to that
 * open is the execution bias. How big it can be depends entirely on what sat between them:
 *
 *   - `normal` — the next bar started exactly one timeframe later. Price moved during the last
 *     minute of one bar and the first of the next, and that is all.
 *   - `session` — a daily rollover or a holiday. The book was thin or shut; the open can be some
 *     way from the previous close.
 *   - `weekend` — the market was closed for roughly two days. This is where a gap is unbounded, and
 *     one weekend can dominate a whole run's average.
 *
 * Separating them is what turns "1.3 pips per fill" from a number into a diagnosis, because the
 * three have completely different implications for whether a strategy is tradeable.
 */
export type GapType = 'normal' | 'session' | 'weekend';

const DAY_MS = 24 * 60 * 60_000;

/**
 * Classify the interval between a signal bar and the bar we filled on.
 *
 * The weekend test is calendar-based rather than a duration threshold: a Friday-to-Monday gap on a
 * daily timeframe is only three days, which no fixed threshold separates from an ordinary D1 step.
 * Crossing a Saturday is what actually means the market was shut.
 */
export function classifyGap(signalBarMs: number, fillBarMs: number, timeframeMs: number): GapType {
  const delta = fillBarMs - signalBarMs;

  // A tolerance, because a resampled bucket can land a shade off its nominal step.
  if (delta <= timeframeMs * 1.5) return 'normal';

  if (crossesSaturday(signalBarMs, fillBarMs)) return 'weekend';

  return 'session';
}

function crossesSaturday(fromMs: number, toMs: number): boolean {
  // Walk UTC day boundaries between the two instants. The span is at most a few days by the time we
  // get here, so this is cheap and exact — no timezone library, no DST question.
  const firstDay = Math.floor(fromMs / DAY_MS);
  const lastDay = Math.floor(toMs / DAY_MS);

  for (let day = firstDay; day <= lastDay; day += 1) {
    // 1970-01-01 was a Thursday, so day 0 is Thursday and Saturday is day % 7 === 2.
    if (((day % 7) + 7) % 7 === 2) return true;
  }
  return false;
}

export interface GapBreakdownRow {
  readonly type: GapType;
  readonly fills: number;
  readonly totalMoney: number;
  readonly figures: PerFillFigures;
}

/** Split a set of fills by what sat between the signal and the fill. */
export function breakdownByGap(
  entries: readonly { readonly gap: GapType; readonly priceGap: number; readonly money: number }[],
  scale: InstrumentScale,
): GapBreakdownRow[] {
  const types: GapType[] = ['normal', 'session', 'weekend'];

  return types
    .map((type) => {
      const mine = entries.filter((e) => e.gap === type);
      const totalMoney = mine.reduce((sum, e) => sum + e.money, 0);
      return {
        type,
        fills: mine.length,
        totalMoney,
        figures: perFillFigures(
          mine.map((e) => e.priceGap),
          totalMoney,
          scale,
        ),
      };
    })
    .filter((r) => r.fills > 0);
}

export function describeGapBreakdown(rows: readonly GapBreakdownRow[]): string {
  if (rows.length === 0) return 'no fills';

  return rows
    .map(
      (r) =>
        `${r.type}: ${String(r.fills)} fills, ${r.totalMoney.toFixed(2)} ` +
        `(${(r.figures.pipsPerFill ?? 0).toFixed(2)} pips/fill)`,
    )
    .join('; ');
}
