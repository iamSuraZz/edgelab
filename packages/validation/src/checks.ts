import { getTimeframe } from '@edgelab/shared';
import { type Check, fail, notApplicable, pass, warn } from './check';

/**
 * The built-in checks. Two real ones ship in the scaffold — one per family — so the
 * framework is exercised end to end. The full battery (walk-forward degradation,
 * parameter-sensitivity, Monte Carlo) lands in the validation phase.
 */

/**
 * Bar integrity: the resampler assumes strictly ascending, non-duplicated bars with
 * coherent OHLC. A violation means the metrics downstream are meaningless, so this is
 * critical.
 */
export const barIntegrityCheck: Check = {
  id: 'bar-integrity',
  label: 'Bar integrity',
  severity: 'critical',
  kind: 'integrity',
  run(input) {
    if (input.bars.length === 0) {
      return notApplicable(barIntegrityCheck, 'No bars were loaded for this run.');
    }

    let duplicates = 0;
    let outOfOrder = 0;
    let badOhlc = 0;

    for (let i = 0; i < input.bars.length; i += 1) {
      const bar = input.bars[i];
      if (bar === undefined) continue;

      const { open, high, low, close } = bar;
      if (
        high < low ||
        open > high ||
        open < low ||
        close > high ||
        close < low ||
        !Number.isFinite(open + high + low + close)
      ) {
        badOhlc += 1;
      }

      if (i > 0) {
        const prev = input.bars[i - 1];
        if (prev !== undefined) {
          if (bar.time === prev.time) duplicates += 1;
          else if (bar.time < prev.time) outOfOrder += 1;
        }
      }
    }

    const evidence = { bars: input.bars.length, duplicates, outOfOrder, badOhlc };

    if (duplicates > 0 || outOfOrder > 0 || badOhlc > 0) {
      return fail(
        barIntegrityCheck,
        `Bar series is malformed: ${duplicates} duplicate timestamps, ${outOfOrder} out of order, ` +
          `${badOhlc} with incoherent OHLC.`,
        evidence,
      );
    }

    return pass(
      barIntegrityCheck,
      `${input.bars.length} bars are ordered, unique and internally coherent.`,
      evidence,
    );
  },
};

/** Below this, per-trade statistics are noise rather than signal. */
export const MIN_TRADES_FOR_CONFIDENCE = 30;
/** Below this, per-trade statistics are not worth reporting at all (spec 06). */
export const MIN_TRADES_TO_JUDGE = 10;

/**
 * Sample size: a strategy with a handful of trades can post spectacular metrics by
 * luck. This is the cheapest overfitting guard there is.
 *
 * Three outcomes rather than two, per spec 06 and amendment A2. Zero trades is `n/a` — there is
 * nothing to be right or wrong about, and calling it a failure would blame the strategy for a
 * window that simply never triggered it. That distinction matters most on walk-forward folds,
 * where a short segment legitimately produces no trades and a `fail` there would poison the
 * overall verdict for a structural reason rather than a real one.
 */
export const sampleSizeCheck: Check = {
  id: 'sample-size',
  label: 'Trade sample size',
  severity: 'warning',
  kind: 'overfitting',
  run(input) {
    const n = input.trades.length;
    const evidence = {
      trades: n,
      warnBelow: MIN_TRADES_FOR_CONFIDENCE,
      failBelow: MIN_TRADES_TO_JUDGE,
    };

    if (n === 0) {
      return notApplicable(
        sampleSizeCheck,
        'No closed trades in this segment, so there is no sample to judge.',
        evidence,
      );
    }
    if (n < MIN_TRADES_TO_JUDGE) {
      return fail(
        sampleSizeCheck,
        `Only ${String(n)} closed trades — under ${String(MIN_TRADES_TO_JUDGE)}, the metrics are ` +
          'anecdotes rather than statistics.',
        evidence,
      );
    }
    if (n < MIN_TRADES_FOR_CONFIDENCE) {
      return warn(
        sampleSizeCheck,
        `${String(n)} closed trades — below the ${String(MIN_TRADES_FOR_CONFIDENCE)} needed ` +
          'before per-trade statistics mean much.',
        evidence,
      );
    }
    return pass(sampleSizeCheck, `${String(n)} closed trades is an adequate sample.`, evidence);
  },
};

/**
 * Trades must fall inside the loaded bar range, and must not close before they open.
 * A trade outside the data window is a look-ahead or wiring bug.
 */
export const tradeWindowCheck: Check = {
  id: 'trade-window',
  label: 'Trades within data window',
  severity: 'critical',
  kind: 'integrity',
  run(input) {
    if (input.trades.length === 0) {
      return notApplicable(tradeWindowCheck, 'No trades to place within the data window.');
    }
    const first = input.bars[0];
    const last = input.bars[input.bars.length - 1];
    if (first === undefined || last === undefined) {
      return notApplicable(tradeWindowCheck, 'No bars were loaded for this run.');
    }

    // The final bar spans its own length, so allow an exit at its close.
    const minutes = getTimeframe(input.timeframe).minutes;
    const tail = minutes === null ? 0 : minutes * 60_000;
    const windowEnd = last.time + tail;

    let inverted = 0;
    let outside = 0;

    for (const t of input.trades) {
      if (t.exitTime < t.entryTime) inverted += 1;
      if (t.entryTime < first.time || t.exitTime > windowEnd) outside += 1;
    }

    const evidence = { trades: input.trades.length, inverted, outside };

    if (inverted > 0 || outside > 0) {
      return fail(
        tradeWindowCheck,
        `${inverted} trades exit before they enter and ${outside} fall outside the loaded ` +
          `bar range — likely a look-ahead or timestamp bug.`,
        evidence,
      );
    }

    return pass(tradeWindowCheck, 'All trades sit inside the loaded bar range.', evidence);
  },
};

export const BUILT_IN_CHECKS: readonly Check[] = [
  barIntegrityCheck,
  tradeWindowCheck,
  sampleSizeCheck,
];
