/**
 * The sealed holdout (spec 06 §3).
 *
 * A fraction of the most recent data is reserved and excluded from every ordinary read. The point is
 * not that the data is secret — it is that looking at it is RECORDED, so a result on the holdout
 * means something the first time and progressively less thereafter. A holdout viewed nine times is
 * just in-sample data with extra steps, and the only thing that makes that visible is the count.
 *
 * WHERE THE SEAL LIVES MATTERS MORE THAN THE SEAL (A24). Enforcing it in the validation runner alone
 * would be theatre: the Studio's date presets, the timeframe matrix, walk-forward and the
 * optimisation all load bars by other paths, and any one of them would hand over the holdout without
 * comment. So the rule is applied at the single function every reader goes through, and a caller
 * that genuinely needs sealed data has to say so by name — at which point it is counted.
 *
 * This module is the pure half: what window a request actually gets, given a seal. The storage and
 * the counting live in `@edgelab/db`.
 */

export interface Holdout {
  readonly symbolId: string;
  /**
   * Start of the sealed region. Bars at or after this instant are reserved.
   *
   * An instant rather than a fraction, fixed when the holdout is created. A fraction would move
   * every time new data arrived, so yesterday's out-of-sample result would quietly become part of
   * today's training set.
   */
  readonly sealedFromMs: number;
  readonly createdAtMs: number;
  /** How many times the seal has been deliberately broken. */
  readonly viewCount: number;
  readonly lastViewedAtMs: number | null;
}

export interface EffectiveWindow {
  readonly fromMs: number;
  readonly toMs: number;
  /** True when the request reached into the sealed region and was cut short. */
  readonly truncated: boolean;
  /** How much was withheld, in ms. Zero when nothing was. */
  readonly withheldMs: number;
  /** True when the request lies entirely inside the sealed region, so nothing is returned. */
  readonly empty: boolean;
}

/**
 * The window a read actually gets.
 *
 * Truncation rather than refusal, deliberately. A backtest whose range overlaps the holdout should
 * still run — on the data it is allowed — because refusing would push people towards unsealing for
 * ordinary work, which is precisely the habit the seal exists to prevent. What it must never do is
 * return sealed bars while reporting the requested range, so the caller is told what it lost.
 */
export function effectiveWindow(
  requestedFromMs: number,
  requestedToMs: number,
  holdout: Holdout | null,
): EffectiveWindow {
  if (holdout === null || requestedToMs <= holdout.sealedFromMs) {
    return {
      fromMs: requestedFromMs,
      toMs: requestedToMs,
      truncated: false,
      withheldMs: 0,
      empty: requestedToMs <= requestedFromMs,
    };
  }

  // Entirely inside the seal: an empty window rather than a negative one.
  if (requestedFromMs >= holdout.sealedFromMs) {
    return {
      fromMs: requestedFromMs,
      toMs: requestedFromMs,
      truncated: true,
      withheldMs: requestedToMs - requestedFromMs,
      empty: true,
    };
  }

  return {
    fromMs: requestedFromMs,
    toMs: holdout.sealedFromMs,
    truncated: true,
    withheldMs: requestedToMs - holdout.sealedFromMs,
    empty: false,
  };
}

/**
 * Where to seal, given the data actually stored and the share to reserve.
 *
 * Computed from the stored range at the moment of sealing and then frozen — see `sealedFromMs`.
 */
export function sealInstant(earliestMs: number, latestMs: number, fraction: number): number {
  if (!(fraction > 0 && fraction < 1)) {
    throw new RangeError(`Holdout fraction must be between 0 and 1, received ${String(fraction)}`);
  }
  return Math.round(latestMs - (latestMs - earliestMs) * fraction);
}

/** The sentence a report shows. Blunt on purpose: a viewed holdout is a weaker claim. */
export function describeHoldout(holdout: Holdout | null): string {
  if (holdout === null) return 'No holdout is sealed for this symbol.';

  if (holdout.viewCount === 0) {
    return `Holdout sealed from ${new Date(holdout.sealedFromMs).toISOString().slice(0, 10)}, never viewed.`;
  }

  return (
    `Holdout sealed from ${new Date(holdout.sealedFromMs).toISOString().slice(0, 10)}, ` +
    `viewed ${String(holdout.viewCount)} time(s). Each view weakens it: data looked at repeatedly ` +
    'is in-sample data, whatever it is labelled.'
  );
}
