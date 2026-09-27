/**
 * Currency conversion for P&L expressed in an instrument's quote currency but
 * reported in the account currency.
 *
 * The rate lookup is an interface so the engine stays pure and tests can supply a
 * fixed table instead of a live feed.
 */

export interface FxRateSource {
  /**
   * Rate to multiply a `from` amount by to get `to`, at `atMs`.
   * Return null when the pair is unknown — callers decide whether that is fatal.
   */
  rate(from: string, to: string, atMs: number): number | null;
}

export class MissingRateError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
    public readonly atMs: number,
  ) {
    super(`No FX rate for ${from}->${to} at ${new Date(atMs).toISOString()}`);
    this.name = 'MissingRateError';
  }
}

/**
 * Convert `amount` from one currency to another. Tries the direct pair, then the
 * inverse, before giving up.
 */
export function convertAmount(
  amount: number,
  from: string,
  to: string,
  source: FxRateSource,
  atMs: number,
): number {
  const base = from.toUpperCase();
  const quote = to.toUpperCase();

  if (base === quote) return amount;

  const direct = source.rate(base, quote, atMs);
  if (direct !== null && Number.isFinite(direct) && direct > 0) {
    return amount * direct;
  }

  const inverse = source.rate(quote, base, atMs);
  if (inverse !== null && Number.isFinite(inverse) && inverse > 0) {
    return amount / inverse;
  }

  throw new MissingRateError(base, quote, atMs);
}

/** An immutable rate table — used in tests and for single-rate runs. */
export function staticRateSource(rates: Readonly<Record<string, number>>): FxRateSource {
  return {
    rate(from: string, to: string): number | null {
      return rates[`${from}${to}`] ?? null;
    },
  };
}
