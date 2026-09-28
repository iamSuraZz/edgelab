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
  /**
   * Identifies this seal, so a report can name the one it ran under.
   *
   * A result is only meaningful relative to a specific seal. Without an id, a report saying "holdout
   * viewed 0 times" is ambiguous between a pristine holdout and a fresh one over ground already
   * walked under an earlier seal.
   */
  readonly id: string;
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
  /**
   * When this seal was retired, or null while it is in force.
   *
   * Retired rather than deleted. Deleting would make drop-then-seal reset the view count, which is
   * precisely the loophole that refusing to RE-seal was meant to close — and a loophole reachable by
   * two commands instead of one is not closed at all. A retired seal keeps its instant, its dates
   * and its count, and remains visible in the symbol's history for ever.
   */
  readonly retiredAtMs: number | null;
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

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Short identity for a report: which seal a result was obtained under. */
export function sealLabel(holdout: Holdout): string {
  return `seal ${holdout.id.slice(0, 8)} (from ${day(holdout.sealedFromMs)})`;
}

/**
 * The sentence a report shows. Blunt on purpose: a viewed holdout is a weaker claim.
 *
 * Takes the symbol's whole history, not just the active seal, because a fresh seal showing zero
 * views is only pristine if nothing preceded it. Prior seals over overlapping ground are exactly
 * what a reader needs in order to discount the number.
 */
export function describeHoldout(active: Holdout | null, history: readonly Holdout[] = []): string {
  const retired = history.filter((h) => h.retiredAtMs !== null);
  const retiredViews = retired.reduce((n, h) => n + h.viewCount, 0);

  const priorNote =
    retired.length === 0
      ? ''
      : ` ${String(retired.length)} earlier seal(s) on this symbol were retired after ` +
        `${String(retiredViews)} view(s) in total, so this data is not untouched.`;

  if (active === null) {
    return `No holdout is currently sealed for this symbol.${priorNote}`;
  }

  const head = `Holdout ${sealLabel(active)}`;

  if (active.viewCount === 0) {
    return `${head}, never viewed.${priorNote}`;
  }

  return (
    `${head}, viewed ${String(active.viewCount)} time(s). Each view weakens it: data looked at ` +
    `repeatedly is in-sample data, whatever it is labelled.${priorNote}`
  );
}
