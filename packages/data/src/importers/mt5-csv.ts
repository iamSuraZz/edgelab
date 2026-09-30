import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';
import type { Bar } from '@edgelab/shared';
import {
  ImportFormatError,
  findColumn,
  firstDataLine,
  looksLikeHeader,
  sniffDelimiter,
  stripBom,
  type Delimiter,
} from './detect';

/**
 * MetaTrader 5 "Export Bars" importer.
 *
 * Format: tab or comma separated, header tokens in angle brackets
 *   <DATE> <TIME> <OPEN> <HIGH> <LOW> <CLOSE> <TICKVOL> <VOL> <SPREAD>
 *
 * Two conversions matter and are easy to get silently wrong:
 *
 *  - Dates look like `2024.01.02`, which neither Date.parse nor csv-parse's `cast` handle.
 *    Parsed manually.
 *  - Timestamps are in the BROKER'S SERVER TIME, not UTC. The offset is supplied at upload
 *    because nothing in the file records it. UTC = serverTime - offset.
 *  - <SPREAD> is in POINTS, so it is multiplied by the symbol's mintick to reach a price.
 */

/*
 * DATE first, then the single-column spellings (A63).
 *
 * MT5 exports split the stamp across `<DATE>` and `<TIME>`; almost everything else writes one
 * column. Listing DATE first keeps MT5 files matching exactly as before, and the fallbacks let a
 * generic export through without a second parser — the row reader already accepts
 * `YYYY-MM-DD HH:MM:SS`, `YYYY.MM.DD` and the ISO `T` separator.
 */
const DATE_ALIASES = ['DATE', 'DATETIME', 'TIMESTAMP', 'TIME'];
const TIME_ALIASES = ['TIME'];
const OPEN_ALIASES = ['OPEN'];
const HIGH_ALIASES = ['HIGH'];
const LOW_ALIASES = ['LOW'];
const CLOSE_ALIASES = ['CLOSE'];
const TICKVOL_ALIASES = ['TICKVOL', 'TICKVOLUME'];
const VOL_ALIASES = ['VOL', 'VOLUME', 'REALVOLUME'];
const SPREAD_ALIASES = ['SPREAD'];

export interface Mt5ColumnMap {
  readonly date: number;
  /** -1 when the file has a single combined datetime column. */
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly tickVol: number;
  readonly vol: number;
  readonly spread: number;
}

export interface Mt5ImportOptions {
  /**
   * Broker server time offset from UTC, in minutes. A broker on UTC+2 (typical for
   * "GMT+2" MT5 servers) passes 120, and timestamps are shifted back by that amount.
   */
  readonly serverUtcOffsetMinutes: number;
  /** Symbol mintick, used to convert <SPREAD> points into a price delta. */
  readonly mintick: number;
}

export interface Mt5ParseStats {
  rows: number;
  bars: number;
  skipped: number;
  /** Rows dropped because a field would not parse. */
  malformed: number;
}

export function detectMt5Columns(header: readonly string[]): Mt5ColumnMap {
  const map: Mt5ColumnMap = {
    date: findColumn(header, DATE_ALIASES),
    time: findColumn(header, TIME_ALIASES),
    open: findColumn(header, OPEN_ALIASES),
    high: findColumn(header, HIGH_ALIASES),
    low: findColumn(header, LOW_ALIASES),
    close: findColumn(header, CLOSE_ALIASES),
    tickVol: findColumn(header, TICKVOL_ALIASES),
    vol: findColumn(header, VOL_ALIASES),
    spread: findColumn(header, SPREAD_ALIASES),
  };

  /*
   * One column matched as BOTH date and time — a file whose only stamp column is called `TIME`.
   * Left alone, the reader would concatenate it with itself. `-1` means "the date cell is the whole
   * stamp", which is exactly what it is.
   */
  const resolved: Mt5ColumnMap =
    map.date !== -1 && map.date === map.time ? { ...map, time: -1 } : map;

  const missing: string[] = [];
  if (resolved.date === -1) missing.push('<DATE>');
  if (resolved.open === -1) missing.push('<OPEN>');
  if (resolved.high === -1) missing.push('<HIGH>');
  if (resolved.low === -1) missing.push('<LOW>');
  if (resolved.close === -1) missing.push('<CLOSE>');

  if (missing.length > 0) {
    throw new ImportFormatError(
      `Not a bar file: missing ${missing.join(', ')}. A date or datetime column plus open, high, ` +
        `low and close are required; time, volume and spread are optional. ` +
        `Found columns: ${header.join(', ')}`,
    );
  }

  return resolved;
}

/**
 * Parse `2024.01.02` + `09:30:00` into UTC epoch ms, applying the server offset.
 * Also accepts `2024-01-02` and a combined `2024.01.02 09:30:00` in the date column.
 */
export function parseMt5Timestamp(
  dateCell: string,
  timeCell: string | undefined,
  serverUtcOffsetMinutes: number,
): number | null {
  const raw =
    timeCell === undefined || timeCell.length === 0 ? dateCell : `${dateCell} ${timeCell}`;
  const match = /^(\d{4})[.\-/](\d{2})[.\-/](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(
    raw.trim(),
  );
  if (match === null) return null;

  const [, y, mo, d, h, mi, s] = match;
  if (y === undefined || mo === undefined || d === undefined) return null;

  const serverMs = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    h === undefined ? 0 : Number(h),
    mi === undefined ? 0 : Number(mi),
    s === undefined ? 0 : Number(s),
  );
  if (Number.isNaN(serverMs)) return null;

  // The wall-clock above was the broker's, so subtract the offset to reach UTC.
  return serverMs - serverUtcOffsetMinutes * 60_000;
}

export function parseMt5Row(
  cells: readonly string[],
  map: Mt5ColumnMap,
  opts: Mt5ImportOptions,
): Bar | null {
  const time = parseMt5Timestamp(
    cells[map.date] ?? '',
    map.time === -1 ? undefined : cells[map.time],
    opts.serverUtcOffsetMinutes,
  );
  if (time === null) return null;

  const open = num(cells[map.open]);
  const high = num(cells[map.high]);
  const low = num(cells[map.low]);
  const close = num(cells[map.close]);
  if (open === null || high === null || low === null || close === null) return null;

  // <TICKVOL> is the tick count and is the usual volume proxy in MT5 exports; <VOL> (real
  // volume) is 0 for most brokers, so it is only a fallback.
  const tickVol = map.tickVol === -1 ? null : num(cells[map.tickVol]);
  const realVol = map.vol === -1 ? null : num(cells[map.vol]);
  const volume = tickVol !== null && tickVol > 0 ? tickVol : (realVol ?? 0);

  const spreadPoints = map.spread === -1 ? null : num(cells[map.spread]);
  const spread = spreadPoints === null || spreadPoints < 0 ? null : spreadPoints * opts.mintick;

  return { time, open, high, low, close, volume, spread };
}

/** Parse a whole file held in memory. Used by tests and small uploads. */
export function parseMt5CsvText(
  text: string,
  opts: Mt5ImportOptions,
): { bars: Bar[]; stats: Mt5ParseStats } {
  const clean = stripBom(text);
  const probe = firstDataLine(clean);
  if (probe === null) {
    return { bars: [], stats: { rows: 0, bars: 0, skipped: 0, malformed: 0 } };
  }

  const delimiter = sniffDelimiter(probe);
  const lines = clean.split(/\r?\n/);

  const stats: Mt5ParseStats = { rows: 0, bars: 0, skipped: 0, malformed: 0 };
  let map: Mt5ColumnMap | null = null;
  const bars: Bar[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const cells = line.split(delimiter).map((c) => c.trim());

    if (map === null) {
      if (looksLikeHeader(cells)) {
        map = detectMt5Columns(cells);
        continue;
      }
      throw new ImportFormatError(
        'MT5 export has no header row; cannot identify columns without one.',
      );
    }

    stats.rows += 1;
    const bar = parseMt5Row(cells, map, opts);
    if (bar === null) {
      stats.malformed += 1;
      continue;
    }
    bars.push(bar);
    stats.bars += 1;
  }

  return { bars, stats };
}

/**
 * Stream a large MT5 export from disk, handing batches to `onBatch`.
 *
 * Never materialises the whole file. The options object is inlined at the call site
 * because csv-parse's overloads reject a hoisted `Options` variable.
 */
export async function streamMt5Csv(
  path: string,
  opts: Mt5ImportOptions,
  onBatch: (bars: Bar[]) => Promise<void>,
  batchSize = 50_000,
): Promise<Mt5ParseStats> {
  const delimiter = await sniffFileDelimiter(path);
  const stats: Mt5ParseStats = { rows: 0, bars: 0, skipped: 0, malformed: 0 };

  let map: Mt5ColumnMap | null = null;
  let batch: Bar[] = [];

  const parser = createReadStream(path).pipe(
    parse({
      delimiter,
      bom: true,
      trim: true,
      skip_empty_lines: true,
      comment: '#',
      relax_column_count: true,
    }),
  );

  for await (const record of parser) {
    const cells = (record as string[]).map((c) => String(c).trim());

    if (map === null) {
      if (looksLikeHeader(cells)) {
        map = detectMt5Columns(cells);
        continue;
      }
      throw new ImportFormatError(
        'MT5 export has no header row; cannot identify columns without one.',
      );
    }

    stats.rows += 1;
    const bar = parseMt5Row(cells, map, opts);
    if (bar === null) {
      stats.malformed += 1;
      continue;
    }

    batch.push(bar);
    stats.bars += 1;

    if (batch.length >= batchSize) {
      await onBatch(batch);
      batch = [];
    }
  }

  if (batch.length > 0) await onBatch(batch);
  return stats;
}

/** Read just enough of the file to sniff its delimiter. */
async function sniffFileDelimiter(path: string): Promise<Delimiter> {
  const stream = createReadStream(path, { encoding: 'utf8', start: 0, end: 8191 });
  let head = '';
  for await (const chunk of stream) {
    head += String(chunk);
    if (head.includes('\n')) break;
  }
  const probe = firstDataLine(head);
  if (probe === null) throw new ImportFormatError('File appears to be empty');
  return sniffDelimiter(probe);
}

function num(cell: string | undefined): number | null {
  if (cell === undefined || cell.length === 0) return null;
  const n = Number(cell);
  return Number.isFinite(n) ? n : null;
}
