import { z } from 'zod';

/**
 * Feed-qualified symbols: one series, one feed.
 *
 * `candles_m1`'s primary key is `(symbol_id, ts)`, so two feeds writing the same minute of the same
 * symbol row cannot coexist — one silently wins on conflict. That alone forces the rule, but the
 * deeper reason is that providers disagree about what a minute IS. Dukascopy stores bid with a
 * measured spread; Twelve Data supplies neither spread nor volume and consolidates a different set
 * of venues. Resampling across a join between them yields an H1 bar whose open follows one vendor's
 * convention and whose close follows another's, and a backtest over that boundary measures the
 * vendor change as if it were the market.
 *
 * So a second feed for an instrument is a SEPARATE dataset: `EURUSD.exness` is its own symbol row
 * sharing EURUSD's instrument metadata. Comparing two feeds then takes two explicit runs instead of
 * happening by accident.
 */

/**
 * Longest a symbol code may be.
 *
 * 40 rather than the original 16 because a feed suffix has to fit: `EURUSD.twelvedata` is already
 * 17. The limit exists to keep a typo from becoming a row, not to be tight.
 */
export const SYMBOL_CODE_MAX = 40;

export const SymbolCodeSchema = z.string().min(3).max(SYMBOL_CODE_MAX);

/** Separates the instrument from the feed. A dot, because no exchange symbol we support uses one. */
export const FEED_SEPARATOR = '.';

/**
 * Feed tags must be lowercase and simple so `EURUSD.exness` has exactly one spelling. Without
 * that, `EURUSD.Exness` and `EURUSD.exness` become two datasets that look like one.
 */
export const FeedTagSchema = z
  .string()
  .min(2)
  .max(20)
  .regex(/^[a-z][a-z0-9-]*$/, 'A feed tag is lowercase letters, digits and hyphens');

export interface ParsedSymbolCode {
  /** The instrument, e.g. `EURUSD`. */
  readonly base: string;
  /** The feed tag, or null for the canonical series. */
  readonly feed: string | null;
}

/**
 * Split a code into instrument and feed.
 *
 * An unsuffixed code is the CANONICAL series for that instrument — the one the app treats as the
 * default. That keeps every existing symbol and every stored run valid without migration.
 */
export function parseSymbolCode(code: string): ParsedSymbolCode {
  const at = code.indexOf(FEED_SEPARATOR);
  if (at === -1) return { base: code, feed: null };
  return { base: code.slice(0, at), feed: code.slice(at + FEED_SEPARATOR.length) };
}

export function feedSymbolCode(base: string, feed: string): string {
  return `${base}${FEED_SEPARATOR}${feed}`;
}

/**
 * Canonical spelling of a symbol code: instrument upper-cased, feed tag left alone.
 *
 * The registry has always upper-cased codes so `eurusd` finds `EURUSD`, which is right for an
 * instrument and WRONG for a feed tag — upper-casing the whole thing turns `EURUSD.twelvedata`
 * into `EURUSD.TWELVEDATA` and the lookup misses a row that is right there. Feed tags are
 * lowercase by schema, so only the base is normalised.
 */
export function normalizeSymbolCode(code: string): string {
  const { base, feed } = parseSymbolCode(code.trim());
  return feed === null
    ? base.toUpperCase()
    : feedSymbolCode(base.toUpperCase(), feed.toLowerCase());
}

/** True when this code names a secondary feed rather than an instrument's canonical series. */
export function isFeedQualified(code: string): boolean {
  return parseSymbolCode(code).feed !== null;
}

/**
 * A human sentence for a run that straddles two feeds.
 *
 * Built here so the API, the CLI and the validator all refuse in the same words — the message has
 * to name both sources and the boundary, because "mixed sources" alone does not tell anyone which
 * range to re-ingest or which dataset to run instead.
 */
export function mixedSourceMessage(params: {
  readonly symbol: string;
  readonly sources: readonly {
    readonly source: string;
    readonly firstMs: number;
    readonly lastMs: number;
    readonly bars: number;
  }[];
}): string {
  const listed = params.sources
    .map((s) => `${s.source} (${String(s.bars)} bars, ${iso(s.firstMs)} .. ${iso(s.lastMs)})`)
    .join(' and ');

  return (
    `${params.symbol} has bars from more than one feed in this range: ${listed}. ` +
    'Providers disagree about what a minute is, so a run across the join measures the feed change ' +
    'rather than the market. Narrow the range to one feed, or import the second feed as its own ' +
    `dataset (e.g. ${params.symbol}${FEED_SEPARATOR}<feed>).`
  );
}

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
