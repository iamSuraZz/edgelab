/**
 * Number formatting for a data-dense report.
 *
 * Two rules run through all of it:
 *
 *  - **A sign goes on figures where direction is the point** (profit, return, expectancy) and is
 *    omitted from magnitudes (a drawdown, a win rate, a trade count). "+5.9% drawdown" reads like
 *    a gain.
 *  - **`null` is never rendered as 0.** A metric that is genuinely undefined shows "—", because
 *    "no profit factor" and "a profit factor of zero" mean opposite things.
 */

/** en-US explicitly: the default locale groups by lakh on some machines, giving "1,00,000". */
const LOCALE = 'en-US';

export const EM_DASH = '—';

export function formatCurrency(
  value: number | null | undefined,
  currency = 'USD',
  opts: { signed?: boolean } = {},
): string {
  if (value == null || !Number.isFinite(value)) return EM_DASH;

  const abs = Math.abs(value).toLocaleString(LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const symbol = currencySymbol(currency);
  const sign = opts.signed === false ? '' : signOf(value);
  return `${sign}${symbol}${abs}`;
}

export function formatPercent(
  value: number | null | undefined,
  opts: { signed?: boolean; digits?: number } = {},
): string {
  if (value == null || !Number.isFinite(value)) return EM_DASH;
  const digits = opts.digits ?? 2;
  const sign = opts.signed === false ? '' : signOf(value);
  return `${sign}${Math.abs(value).toFixed(digits)}%`;
}

/** A ratio, which can legitimately be negative (a negative Sharpe means something). */
export function formatRatio(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return EM_DASH;
  return `${value < 0 ? MINUS : ''}${Math.abs(value).toFixed(digits)}`;
}

export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return EM_DASH;
  return value.toLocaleString(LOCALE);
}

export function formatPrice(value: number | null | undefined, digits = 5): string {
  if (value == null || !Number.isFinite(value)) return EM_DASH;
  return value.toFixed(digits);
}

/** UTC throughout: a bar's time is its open time in UTC, and localising it would misalign it. */
export function formatDateTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return EM_DASH;
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

export function formatDate(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return EM_DASH;
  return new Date(ms).toISOString().slice(0, 10);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return EM_DASH;
  if (ms < 1_000) return `${String(Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${String(minutes)}m ${String(seconds)}s`;
}

/** U+2212, not a hyphen: it aligns under a plus sign at the same width. */
export const MINUS = '−';

function signOf(value: number): string {
  if (value > 0) return '+';
  if (value < 0) return MINUS;
  return '';
}

function currencySymbol(currency: string): string {
  switch (currency.toUpperCase()) {
    case 'USD':
      return '$';
    case 'EUR':
      return '€';
    case 'GBP':
      return '£';
    case 'JPY':
      return '¥';
    default:
      return `${currency} `;
  }
}

/**
 * Tailwind class for a profit/loss value.
 *
 * Colour is never the only channel — every figure that uses this also carries a +/− sign, so the
 * report stays readable for the ~8% of men with red/green colour blindness. Teal rather than pure
 * green for the same reason.
 */
export function pnlClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return 'text-foreground';
  return value > 0 ? 'text-accent' : 'text-destructive';
}

/** Format a metric by the unit declared in the shared dictionary. */
export function formatByUnit(
  value: number | null | undefined,
  unit: string,
  currency = 'USD',
): string {
  switch (unit) {
    case 'currency':
      return formatCurrency(value, currency);
    case 'percent':
      return formatPercent(value);
    case 'count':
      return formatCount(value);
    case 'bars':
      return value == null ? EM_DASH : `${formatRatio(value, 1)} bars`;
    case 'days':
      return value == null ? EM_DASH : `${formatRatio(value, 1)} days`;
    case 'pips':
      return value == null ? EM_DASH : `${formatRatio(value, 1)} pips`;
    case 'ratio':
    case 'factor':
    default:
      return formatRatio(value);
  }
}
