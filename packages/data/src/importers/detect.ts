/**
 * Delimiter sniffing and header detection for uploaded files.
 *
 * csv-parse's `delimiter_auto` is NOT usable here: it crashes with a TypeError if the
 * sampled head contains any code point above 126 (a UTF-8 BOM is enough), and when it
 * does work it scores preamble lines too, so a comma-rich header block makes it pick ','
 * for a tab-separated body and emit junk records with no error. So we sniff the first
 * real data line ourselves and always pass an explicit delimiter.
 */

export const SUPPORTED_DELIMITERS = [',', '\t', ';'] as const;
export type Delimiter = (typeof SUPPORTED_DELIMITERS)[number];

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Pick the delimiter that splits `line` into the most fields. Ties prefer the earlier
 * entry, which puts comma first — the most common case.
 */
export function sniffDelimiter(line: string): Delimiter {
  let best: Delimiter = ',';
  let bestCount = -1;
  for (const d of SUPPORTED_DELIMITERS) {
    const count = line.split(d).length;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

/** First line that is neither blank nor a comment. */
export function firstDataLine(text: string): string | null {
  for (const raw of stripBom(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length > 0 && !line.startsWith('#')) return line;
  }
  return null;
}

/**
 * Normalise a header cell for matching: strip MT5's angle brackets, drop non-alphanumeric
 * characters, uppercase. `<TICKVOL>` and "Tick volume" both become TICKVOL / TICKVOLUME.
 */
export function normaliseHeaderCell(cell: string): string {
  return cell
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

/**
 * Resolve a logical field to its column index by trying each alias in order.
 * Returns -1 when absent, so callers can distinguish required from optional fields.
 */
export function findColumn(header: readonly string[], aliases: readonly string[]): number {
  const normalised = header.map(normaliseHeaderCell);
  for (const alias of aliases) {
    const idx = normalised.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

/** True when the row looks like a header rather than data: no cell parses as a number. */
export function looksLikeHeader(cells: readonly string[]): boolean {
  const meaningful = cells.filter((c) => c.trim().length > 0);
  if (meaningful.length === 0) return false;
  return meaningful.every((c) => !Number.isFinite(Number(c.trim())));
}

export class ImportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportFormatError';
  }
}
