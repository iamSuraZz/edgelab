import { TIMEFRAMES, type Timeframe, pineToTimeframe } from '@edgelab/shared';

/**
 * Parse whatever timeframe string PineTS hands the provider.
 *
 * Because we implement IProvider directly (rather than extending BaseProvider) the string
 * arrives RAW and unnormalised, exactly as written in the script. So all of these can turn
 * up: '15', '60', 'D', '1D', '4h', '4H', '1m', '1M', 'W'.
 *
 * CASE IS SIGNIFICANT: '1M' is one MONTH, '1m' is one MINUTE. Getting that backwards is a
 * 43,200x error with no runtime complaint.
 */

const BY_MINUTES: ReadonlyMap<number, Timeframe> = new Map(
  TIMEFRAMES.filter((t) => t.minutes !== null).map((t) => [t.minutes as number, t.code]),
);

export function parsePineTimeframe(raw: string): Timeframe | null {
  const s = raw.trim();
  if (s.length === 0) return null;

  // Exact Pine period strings ('1','240','D','W','M') resolve through the registry.
  const exact = pineToTimeframe(s);
  if (exact !== undefined) return exact;

  // Bare minute count, e.g. '45' -> only if we have that timeframe.
  if (/^\d+$/.test(s)) return BY_MINUTES.get(Number(s)) ?? null;

  const m = /^(\d*)\s*([a-zA-Z])$/.exec(s);
  if (m === null) return null;

  const count = m[1] === undefined || m[1] === '' ? 1 : Number(m[1]);
  const unit = m[2];
  if (count <= 0 || unit === undefined) return null;

  // Only the minute/month pair is case-significant ('1m' vs '1M'); hours, days, weeks and
  // seconds accept either case.
  switch (unit) {
    case 's':
    case 'S':
      return null; // sub-minute is not stored
    case 'm':
      return BY_MINUTES.get(count) ?? null;
    case 'M':
      return count === 1 ? 'MN1' : null;
    case 'h':
    case 'H':
      return BY_MINUTES.get(count * 60) ?? null;
    case 'd':
    case 'D':
      return count === 1 ? 'D1' : null;
    case 'w':
    case 'W':
      return count === 1 ? 'W1' : null;
    default:
      return null;
  }
}

/**
 * Split a PineTS extended ticker into the plain symbol and its modifier.
 * e.g. 'EURUSD;heikinashi' -> { symbol: 'EURUSD', modifier: 'heikinashi' }
 */
export function splitTicker(tickerId: string): { symbol: string; modifier: string | null } {
  const idx = tickerId.indexOf(';');
  if (idx === -1) return { symbol: tickerId, modifier: null };
  return {
    symbol: tickerId.slice(0, idx),
    modifier: tickerId.slice(idx + 1).toLowerCase() || null,
  };
}
