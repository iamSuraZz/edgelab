import type { Bar, SymbolSpec } from '@edgelab/shared';

/**
 * The currency layer (spec 03).
 *
 * PineTS's own currency conversion is a passthrough, so the engine runs in the instrument's QUOTE
 * currency and this converts P&L and equity to the account currency, bar by bar, through a real
 * conversion pair.
 *
 * The one thing to get right is DIRECTION, and it is easy to get backwards because an fx pair's
 * name reads in the opposite order to the conversion it performs. A pair BBBQQQ quotes
 * "how many QQQ per one BBB". So:
 *
 *   quote JPY → account USD:  the pair is USDJPY, which gives JPY per USD.
 *                             We need USD per JPY, so INVERT: 1 / USDJPY.
 *   quote GBP → account USD:  the pair is GBPUSD, which gives USD per GBP.
 *                             That is already what we need, so use it DIRECTLY.
 *
 * Getting this backwards on USDJPY does not produce an obviously silly number — it produces P&L
 * that is wrong by a factor of ~150², which still looks like money. Hence the hand-computed tests.
 */

export interface ConversionPair {
  /** Symbol whose bars supply the rate, e.g. 'USDJPY'. */
  readonly symbol: string;
  /**
   * True when the pair's price must be inverted to get "account currency per quote currency".
   * See the direction note above.
   */
  readonly invert: boolean;
}

export type ConversionPlan =
  /** Quote and account currency are the same; no conversion and no data needed. */
  | { readonly kind: 'identity' }
  /** A pair is needed and named. */
  | { readonly kind: 'pair'; readonly pair: ConversionPair };

/**
 * Which pair converts `quoteCcy` into `accountCcy`, and which way round.
 *
 * Both spellings are considered — QUOTE+ACCOUNT and ACCOUNT+QUOTE — because only one of them is a
 * real instrument. `known` decides which exists, so this never invents a symbol nobody quotes;
 * without it, EURGBP on a USD account would happily ask for a non-existent "GBPUSD" or "USDGBP"
 * depending on which order the code tried first.
 */
export function planConversion(
  quoteCcy: string,
  accountCcy: string,
  known: (symbol: string) => boolean,
): ConversionPlan | null {
  const quote = quoteCcy.toUpperCase();
  const account = accountCcy.toUpperCase();

  if (quote === account) return { kind: 'identity' };

  // QUOTEACCOUNT quotes "account per quote" — exactly the rate we want.
  const direct = `${quote}${account}`;
  if (known(direct)) return { kind: 'pair', pair: { symbol: direct, invert: false } };

  // ACCOUNTQUOTE quotes "quote per account" — the reciprocal.
  const inverse = `${account}${quote}`;
  if (known(inverse)) return { kind: 'pair', pair: { symbol: inverse, invert: true } };

  return null;
}

/** Everything the caller needs to fetch, when the pair's bars are not stored yet. */
export interface MissingConversionData {
  readonly symbol: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly reason: string;
}

export class MissingConversionPairError extends Error {
  readonly code = 'missing-conversion-pair';

  constructor(
    readonly quoteCcy: string,
    readonly accountCcy: string,
  ) {
    super(
      `No conversion pair links ${quoteCcy} to ${accountCcy}. EdgeLab converts through a single ` +
        `pair, so one of ${quoteCcy}${accountCcy} or ${accountCcy}${quoteCcy} must be a ` +
        'configured symbol.',
      // Tagged in `cause`, because neither `name` nor an own property survives the worker
      // thread's structured clone. See docs/decisions.md.
      { cause: { edgelabCode: 'currency-mismatch' } },
    );
    this.name = 'MissingConversionPairError';
  }
}

/**
 * The pair exists but its bars are not stored for this range.
 *
 * Separate from MissingConversionPairError because this one is ACTIONABLE — it names a download
 * the user can start — while the other means nothing quotes that currency link at all.
 */
export class MissingConversionDataError extends Error {
  readonly code = 'missing-conversion-data';

  constructor(readonly missing: MissingConversionData) {
    super(
      `${missing.reason} Download ${missing.symbol} for ` +
        `${new Date(missing.fromMs).toISOString().slice(0, 10)} .. ` +
        `${new Date(missing.toMs).toISOString().slice(0, 10)} and run again.`,
      { cause: { edgelabCode: 'no-data' } },
    );
    this.name = 'MissingConversionDataError';
  }
}

/**
 * Rate lookup: account currency per unit of quote currency, at an instant.
 *
 * Returns the rate from the most recent conversion bar AT OR BEFORE `atMs` — never a later one,
 * which would be look-ahead in the reporting layer. A run is converted with the rates that were
 * knowable as it happened.
 */
export type RateAt = (atMs: number) => number;

export interface BuildRateOptions {
  readonly pair: ConversionPair;
  /** Conversion-pair bars, ascending. */
  readonly bars: readonly Bar[];
  /**
   * Rate to use before the first conversion bar. Defaults to the first bar's rate — the earliest
   * rate that exists — rather than 1, which would silently report unconverted figures.
   */
  readonly fallback?: number;
}

export function buildRateAt(options: BuildRateOptions): RateAt {
  const { pair, bars } = options;

  if (bars.length === 0) {
    throw new Error(
      `No bars for conversion pair ${pair.symbol}; cannot convert without a rate series.`,
    );
  }

  // Precomputed parallel arrays: the rate function is called once per bar of the run, and a
  // binary search over a typed array beats re-deriving the rate each time.
  const times = new Float64Array(bars.length);
  const rates = new Float64Array(bars.length);

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;
    times[i] = bar.time;
    rates[i] = pair.invert ? 1 / bar.close : bar.close;
  }

  const fallback = options.fallback ?? rates[0]!;

  return (atMs: number): number => {
    if (atMs < times[0]!) return fallback;

    // Rightmost bar whose OPEN time is at or before `atMs`.
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid]! <= atMs) lo = mid;
      else hi = mid - 1;
    }
    return rates[lo]!;
  };
}

/**
 * The conversion window a run needs.
 *
 * Padded backwards by one day so the first bar of the run has a rate at or before it, rather than
 * falling back. Not padded forwards: a rate after the run ends is never consulted.
 */
export function conversionWindow(fromMs: number, toMs: number): { fromMs: number; toMs: number } {
  return { fromMs: fromMs - 86_400_000, toMs };
}

/**
 * Initial capital, expressed in the QUOTE currency, for a run whose account is in another.
 *
 * Spec 03: the engine runs in the quote currency, so its starting capital has to be restated at
 * the first bar's rate. Reporting then converts back bar by bar — which is not a round trip,
 * because the rate moves, and that movement is a real component of the account-currency result.
 */
export function initialCapitalInQuote(accountCapital: number, rateAtFirstBar: number): number {
  if (!Number.isFinite(rateAtFirstBar) || rateAtFirstBar <= 0) {
    throw new RangeError(`Conversion rate must be positive, received ${String(rateAtFirstBar)}`);
  }
  return accountCapital / rateAtFirstBar;
}

/**
 * Resolve a run's conversion, or say precisely what is missing.
 *
 * Replaces D6's blanket refusal of non-USD quote currencies. The guard existed because there was
 * no currency layer; with one, the only remaining reasons to refuse are a currency pair nobody
 * quotes, or bars we do not have — and the second is actionable, so it names the download.
 */
export interface ResolveConversionParams {
  readonly symbol: SymbolSpec;
  readonly accountCurrency: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly known: (symbol: string) => boolean;
  /** Bars for the conversion pair, if already stored. */
  readonly loadBars: (symbol: string, fromMs: number, toMs: number) => readonly Bar[];
}

export type ConversionOutcome =
  | { readonly kind: 'identity'; readonly rateAt: RateAt }
  | { readonly kind: 'converted'; readonly pair: ConversionPair; readonly rateAt: RateAt }
  | { readonly kind: 'needs-data'; readonly missing: MissingConversionData };

export function resolveConversion(params: ResolveConversionParams): ConversionOutcome {
  const plan = planConversion(params.symbol.quoteCcy, params.accountCurrency, params.known);

  if (plan === null) {
    throw new MissingConversionPairError(params.symbol.quoteCcy, params.accountCurrency);
  }
  if (plan.kind === 'identity') {
    return { kind: 'identity', rateAt: () => 1 };
  }

  const window = conversionWindow(params.fromMs, params.toMs);
  const bars = params.loadBars(plan.pair.symbol, window.fromMs, window.toMs);

  if (bars.length === 0) {
    return {
      kind: 'needs-data',
      missing: {
        symbol: plan.pair.symbol,
        fromMs: window.fromMs,
        toMs: window.toMs,
        reason:
          `${params.symbol.symbol} is quoted in ${params.symbol.quoteCcy} but the account is in ` +
          `${params.accountCurrency}, so P&L is converted through ${plan.pair.symbol} — and no ` +
          `${plan.pair.symbol} bars are stored for this range.`,
      },
    };
  }

  return { kind: 'converted', pair: plan.pair, rateAt: buildRateAt({ pair: plan.pair, bars }) };
}
