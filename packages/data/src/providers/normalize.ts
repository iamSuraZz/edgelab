import type { Bar } from '@edgelab/shared';

/**
 * The single normalization boundary every adapter passes through, so the invariants the
 * resampler and storage layer assume are guaranteed exactly once:
 *
 *   - UTC epoch milliseconds, integer
 *   - strictly ascending, de-duplicated by timestamp
 *   - finite numbers
 *   - high >= max(open, close) and low <= min(open, close)
 *   - volume >= 0
 *
 * A single bad bar must not kill a three-month download, so invalid rows are DROPPED and
 * counted rather than thrown. The caller logs the counts and the data-quality report
 * surfaces them; silently discarding without counting would be the actual sin.
 */

export type RejectReason =
  | 'non-integer-time'
  | 'negative-time'
  | 'non-finite-price'
  | 'incoherent-ohlc'
  | 'negative-volume'
  | 'duplicate-time'
  | 'filler-bar';

export interface NormalizeResult {
  readonly bars: Bar[];
  readonly rejected: number;
  readonly reasons: Readonly<Partial<Record<RejectReason, number>>>;
}

export interface NormalizeOptions {
  /** Drop bars outside [fromMs, toMs). Providers routinely overshoot a page. */
  readonly fromMs?: number;
  readonly toMs?: number;
  /**
   * Snap timestamps down to the minute. Some feeds emit a stray second/millisecond;
   * without this those bars would collide with the real minute bar. Default true.
   */
  readonly snapToMinute?: boolean;
  /**
   * Drop flat (`high === low`) bars that also carry zero volume. Default true (decision D4).
   *
   * MetaTrader only forms a bar when a tick arrives, so a bar with no volume and no range
   * never existed on the broker's chart — it is provider filler, emitted to keep a series
   * contiguous across weekends, holidays and dead minutes. Keeping it puts phantom bars in
   * the resampler, counts them as tradeable time, and lets a strategy fill at a price that
   * was never quoted.
   *
   * Flatness alone is NOT sufficient. On real Dukascopy EURUSD M1 data, 393 of 1,825 flat
   * bars carry genuine volume (a tick arrived, the price did not move), and every
   * zero-volume bar is flat. Both conditions are required, which is why this replaces the
   * earlier Sunday-only session filter: the volume rule also catches holidays and dead
   * midweek minutes, which a session window never could.
   */
  readonly dropFillerBars?: boolean;
  /**
   * Whether this feed's `volume` carries information. Default true.
   *
   * D4 requires BOTH flatness and zero volume, precisely because flatness alone is not evidence of
   * filler. That reasoning silently inverts on a feed that reports no volume at all: every bar has
   * `volume === 0`, so the conjunction collapses to "drop every flat bar" — the exact rule the
   * docstring above says is wrong.
   *
   * Measured on real data. Twelve Data omits volume for forex, and its EURUSD feed lost 20,464 of
   * 185,008 minutes over 2022-01..06 against the volume-carrying Dukascopy series — 11% — with ZERO
   * flat bars surviving where Dukascopy keeps 1.35%. The losses clustered in the quiet hours
   * (21:00 UTC worst, then 22-23 and 02-05), which is exactly where a minute is most likely to be
   * genuinely flat.
   *
   * So a feed without volume gets no filler filtering at all. A real flat minute kept is a minor
   * inaccuracy; a real flat minute deleted is a hole in the series that every downstream check then
   * reasons over as if the market had been closed.
   */
  readonly volumeIsMeaningful?: boolean;
}

const MS_PER_MINUTE = 60_000;

export function normalizeBars(
  raw: readonly Bar[],
  options: NormalizeOptions = {},
): NormalizeResult {
  const snap = options.snapToMinute ?? true;
  const dropFiller = options.dropFillerBars ?? true;
  const volumeIsMeaningful = options.volumeIsMeaningful ?? true;
  const reasons: Partial<Record<RejectReason, number>> = {};
  let rejected = 0;

  const reject = (reason: RejectReason): void => {
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    rejected += 1;
  };

  // Map de-duplicates by timestamp; a later bar for the same minute wins, so re-fetching
  // a range corrects a previously-stored bad bar.
  const byTime = new Map<number, Bar>();

  for (const bar of raw) {
    let time = bar.time;

    if (!Number.isFinite(time)) {
      reject('non-integer-time');
      continue;
    }
    if (snap) time = Math.floor(time / MS_PER_MINUTE) * MS_PER_MINUTE;
    if (!Number.isInteger(time)) {
      reject('non-integer-time');
      continue;
    }
    if (time < 0) {
      reject('negative-time');
      continue;
    }
    if (options.fromMs !== undefined && time < options.fromMs) continue;
    if (options.toMs !== undefined && time >= options.toMs) continue;

    const { open, high, low, close } = bar;
    if (
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      reject('non-finite-price');
      continue;
    }

    const volume = Number.isFinite(bar.volume) ? bar.volume : 0;
    if (volume < 0) {
      reject('negative-volume');
      continue;
    }

    if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) {
      reject('incoherent-ohlc');
      continue;
    }

    // `volumeIsMeaningful` guards the whole rule: without volume evidence, flatness alone is not
    // grounds for deleting a minute. See the option's note.
    if (dropFiller && volumeIsMeaningful && high === low && volume === 0) {
      reject('filler-bar');
      continue;
    }

    const spread =
      bar.spread == null || !Number.isFinite(bar.spread) || bar.spread < 0 ? null : bar.spread;

    if (byTime.has(time)) reject('duplicate-time');
    byTime.set(time, { time, open, high, low, close, volume, spread });
  }

  const bars = [...byTime.values()].sort((a, b) => a.time - b.time);
  return { bars, rejected, reasons };
}

/**
 * Join bid and ask series by TIMESTAMP, producing bid OHLC plus
 * spread = ask.close - bid.close.
 *
 * Must not be a positional zip: dukascopy-node's `ignoreFlats` drops flat candles
 * independently on each price side, so the two arrays can differ in length and a
 * positional pairing would misassign every spread after the first divergence. Even with
 * ignoreFlats:false a missing tick on one side can desynchronise them.
 *
 * Bid bars with no matching ask keep their OHLC and get a null spread — losing a spread
 * is acceptable, inventing one is not.
 */
export function joinBidAsk(bid: readonly Bar[], ask: readonly Bar[]): Bar[] {
  const askCloseByTime = new Map<number, number>();
  for (const bar of ask) {
    if (Number.isFinite(bar.close)) askCloseByTime.set(bar.time, bar.close);
  }

  return bid.map((bar) => {
    const askClose = askCloseByTime.get(bar.time);
    const spread = askClose === undefined ? null : askClose - bar.close;
    // A negative spread means crossed or mismatched data; drop it rather than store it.
    return { ...bar, spread: spread !== null && spread >= 0 ? spread : null };
  });
}
