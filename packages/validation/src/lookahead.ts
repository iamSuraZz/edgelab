import type { Candle } from '@edgelab/shared';

/**
 * The look-ahead causality check (amendment A1a).
 *
 * The question it answers: on each chart bar, did `request.security` return a value from a
 * higher-timeframe bucket that had **already closed**, or from one still forming — which is
 * information the script could not have had at that moment?
 *
 * TWO THINGS THAT MAKE THIS SUBTLER THAN IT LOOKS.
 *
 * 1. **Judge at the bar's CLOSE, not its open.** `lookahead_off` legitimately returns a bucket's
 *    value on the chart bar where that bucket closes — that is the first moment the value is
 *    genuinely known. Judging at the open would flag every correct script on one bar in four.
 *
 * 2. **Ties are causal.** A value can match several buckets (a flat series, a boolean, a round
 *    number). Attributing it to the latest matching bucket would invent leaks; attributing it to
 *    the earliest would hide them. The rule is: if ANY causal bucket matches, the bar is causal.
 *    That is deliberately conservative — it under-reports rather than crying wolf — which is why
 *    a run where most bars are ambiguous is reported `inconclusive` rather than `pass`.
 */

export type CausalityVerdict = 'causal' | 'leaky' | 'inconclusive';

export interface SecurityObservation {
  readonly bar: number;
  /** Chart bar OPEN time, UTC ms. */
  readonly barTime: number;
  readonly timeframe: string;
  readonly lookaheadOn: boolean;
  readonly value: number | null;
  readonly callIndex: number;
}

export interface CausalityOptions {
  /** Chart bar duration in ms, to derive each bar's close from its open. */
  readonly chartBarMs: number;
  /**
   * Relative tolerance when matching a returned value to a bucket's value. Prices are doubles
   * that have been through resampling and a transpiler, so exact equality is too strict.
   */
  readonly tolerance?: number;
  /**
   * Fraction of judged bars that may be ambiguous before the result is `inconclusive`.
   * Default 0.5 — if most bars cannot be attributed, the check has not established anything.
   */
  readonly maxAmbiguousFraction?: number;
}

export interface LeakEvidence {
  readonly bar: number;
  readonly barTime: number;
  /** When the chart bar closed — the moment the value had to be knowable by. */
  readonly barCloseTime: number;
  readonly value: number;
  /** Open time of the earliest bucket that could have produced this value. */
  readonly bucketTime: number;
  /** When that bucket closed. Later than `barCloseTime` is the leak. */
  readonly bucketCloseTime: number;
  /** How far into the future the value came from, in ms. */
  readonly aheadByMs: number;
}

export interface CausalityResult {
  readonly verdict: CausalityVerdict;
  /** Bars where a value could only have come from a bucket that had not yet closed. */
  readonly leaks: LeakEvidence[];
  readonly barsJudged: number;
  readonly barsCausal: number;
  /** Bars whose value matched no bucket at all — usually warmup `na`. */
  readonly barsUnmatched: number;
  /**
   * Bars whose value matched so many buckets that attribution says nothing. A boolean series
   * matches half the chart.
   */
  readonly barsAmbiguous: number;
  readonly headline: string;
}

/** A bucket a value could have come from. */
export interface HtfBucket {
  readonly time: number;
  readonly closeTime: number;
  readonly values: readonly number[];
}

/**
 * Build the candidate buckets from an HTF candle series.
 *
 * All four OHLC values are candidates because the script chooses which it requests, and the log
 * records only the number that came back. Over-supplying candidates is the safe direction: it can
 * only make a bar MORE likely to be judged causal.
 */
export function bucketsFromCandles(candles: readonly Candle[]): HtfBucket[] {
  return candles.map((c) => ({
    time: c.time,
    closeTime: c.closeTime,
    values: [c.close, c.open, c.high, c.low],
  }));
}

export function checkCausality(
  observations: readonly SecurityObservation[],
  buckets: readonly HtfBucket[],
  options: CausalityOptions,
): CausalityResult {
  const tolerance = options.tolerance ?? 1e-9;
  const maxAmbiguous = options.maxAmbiguousFraction ?? 0.5;

  const leaks: LeakEvidence[] = [];
  let judged = 0;
  let causal = 0;
  let unmatched = 0;
  let ambiguous = 0;

  // How many distinct buckets a value may match before attribution is meaningless. Two is
  // already generous: a genuinely informative value picks out one bucket.
  const AMBIGUITY_LIMIT = 3;

  for (const obs of observations) {
    if (obs.value === null) {
      unmatched += 1;
      continue;
    }

    const barClose = obs.barTime + options.chartBarMs;
    const matches = buckets.filter((b) => b.values.some((v) => close(v, obs.value!, tolerance)));

    if (matches.length === 0) {
      unmatched += 1;
      continue;
    }

    judged += 1;

    // A bucket is causal for this bar if it had closed by the time the chart bar closed.
    const causalMatches = matches.filter((b) => b.closeTime <= barClose);

    if (causalMatches.length > 0) {
      causal += 1;
      // Ambiguity is tracked even when the bar passes, because a run that passed only because
      // everything matched everything has not been shown to be clean.
      if (matches.length > AMBIGUITY_LIMIT) ambiguous += 1;
      continue;
    }

    // Every candidate closed after this bar did. Report the earliest — the smallest leak that
    // explains the value, which is the least alarming honest reading.
    const earliest = matches.reduce((a, b) => (a.closeTime <= b.closeTime ? a : b));
    leaks.push({
      bar: obs.bar,
      barTime: obs.barTime,
      barCloseTime: barClose,
      value: obs.value,
      bucketTime: earliest.time,
      bucketCloseTime: earliest.closeTime,
      aheadByMs: earliest.closeTime - barClose,
    });
  }

  return finish({ leaks, judged, causal, unmatched, ambiguous, maxAmbiguous });
}

function finish(state: {
  leaks: LeakEvidence[];
  judged: number;
  causal: number;
  unmatched: number;
  ambiguous: number;
  maxAmbiguous: number;
}): CausalityResult {
  const { leaks, judged, causal, unmatched, ambiguous, maxAmbiguous } = state;

  const base = {
    leaks,
    barsJudged: judged,
    barsCausal: causal,
    barsUnmatched: unmatched,
    barsAmbiguous: ambiguous,
  };

  // A leak is a leak: one bar that could only have come from the future is enough, and no amount
  // of ambiguity elsewhere excuses it.
  if (leaks.length > 0) {
    const first = leaks[0]!;
    return {
      ...base,
      verdict: 'leaky',
      headline:
        `${String(leaks.length)} of ${String(judged)} bars used a higher-timeframe value from a ` +
        `bucket that had not closed yet. First at bar ${String(first.bar)} ` +
        `(${iso(first.barTime)}): the value came from the bucket closing ${iso(first.bucketCloseTime)}, ` +
        `${describeAhead(first.aheadByMs)} after that bar closed.`,
    };
  }

  if (judged === 0) {
    return {
      ...base,
      verdict: 'inconclusive',
      headline:
        'No higher-timeframe value could be matched to a bucket, so causality was not ' +
        'established. The script may request no higher timeframe, or every value may be na.',
    };
  }

  if (ambiguous / judged > maxAmbiguous) {
    return {
      ...base,
      verdict: 'inconclusive',
      headline:
        `${String(ambiguous)} of ${String(judged)} bars returned a value matching several ` +
        'buckets — typical of a boolean or a flat series — so which bucket was used cannot be ' +
        'determined. No leak was found, but none would have been visible either.',
    };
  }

  return {
    ...base,
    verdict: 'causal',
    headline:
      `All ${String(judged)} matched bars used a higher-timeframe bucket that had already ` +
      `closed.${unmatched > 0 ? ` ${String(unmatched)} bar(s) had no value to judge (warmup).` : ''}`,
  };
}

/** Relative comparison, with an absolute floor so values near zero still compare sanely. */
function close(a: number, b: number, tolerance: number): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= tolerance * scale;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

function describeAhead(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${String(minutes)} minutes`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${String(hours)} hours` : `${String(Math.round(hours / 24))} days`;
}
