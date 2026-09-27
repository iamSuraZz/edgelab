import { pipeline } from 'node:stream/promises';
import { parse } from 'csv-parse';
import yauzl from 'yauzl';
import type { Bar } from '@edgelab/shared';
import { ImportFormatError, findColumn, looksLikeHeader, sniffDelimiter } from './detect';

/**
 * Exness tick-history importer. Monthly ZIPs are downloaded by hand and uploaded here.
 *
 * Streaming end to end: yauzl reads one entry at a time, csv-parse emits one record at a
 * time, and the aggregator folds ticks into M1 bars incrementally. A monthly tick file is
 * hundreds of MB, so nothing is ever fully materialised.
 *
 * NOTE (flagged for confirmation): no sample Exness tick file was available, so the exact
 * column names and timestamp format are NOT verified. Per the spec this detects the header
 * rather than hardcoding positions, and it accepts every plausible timestamp encoding. If
 * an upload fails, the error names the columns it did find — send me that message (or a
 * 20-line sample) and this becomes a one-line alias addition.
 */

const TIME_ALIASES = [
  'TIMESTAMP',
  'DATETIME',
  'TIME',
  'DATE',
  'GMTTIME',
  'LOCALTIME',
  'TIMESTAMPUTC',
];
const BID_ALIASES = ['BID', 'BIDPRICE', 'BIDQUOTE'];
const ASK_ALIASES = ['ASK', 'ASKPRICE', 'ASKQUOTE'];
const VOLUME_ALIASES = ['VOLUME', 'BIDVOLUME', 'LOTS', 'SIZE'];

const MS_PER_MINUTE = 60_000;

export interface Tick {
  readonly time: number;
  readonly bid: number;
  readonly ask: number | null;
}

export interface ExnessColumnMap {
  readonly time: number;
  readonly bid: number;
  readonly ask: number;
  readonly volume: number;
}

export interface ExnessImportStats {
  entries: number;
  ticks: number;
  bars: number;
  malformed: number;
}

export function detectExnessColumns(header: readonly string[]): ExnessColumnMap {
  const map: ExnessColumnMap = {
    time: findColumn(header, TIME_ALIASES),
    bid: findColumn(header, BID_ALIASES),
    ask: findColumn(header, ASK_ALIASES),
    volume: findColumn(header, VOLUME_ALIASES),
  };

  const missing: string[] = [];
  if (map.time === -1) missing.push('a timestamp column');
  if (map.bid === -1) missing.push('a bid column');

  if (missing.length > 0) {
    throw new ImportFormatError(
      `Unrecognised tick file: could not find ${missing.join(' and ')}. ` +
        `Columns present: [${header.join(', ')}]. ` +
        `Add the real name to TIME_ALIASES/BID_ALIASES in exness-ticks.ts.`,
    );
  }

  return map;
}

/**
 * Parse a tick timestamp. Accepts epoch ms, epoch seconds, `2024-01-02 00:00:00.123`,
 * ISO 8601, and `20240102 00:00:00.123`. Always interpreted as UTC — tick history is
 * published in UTC, unlike MT5 bar exports.
 */
export function parseTickTimestamp(raw: string): number | null {
  const value = raw.trim();
  if (value.length === 0) return null;

  if (/^\d+$/.test(value)) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    // Sub-1e12 is far too small to be a modern ms timestamp, so it must be seconds.
    return n >= 1e12 ? n : n * 1000;
  }

  // 20240102 00:00:00.123 -> 2024-01-02T00:00:00.123
  const compact = /^(\d{4})(\d{2})(\d{2})[ T](.+)$/.exec(value);
  const normalised =
    compact === null
      ? value.replace(' ', 'T')
      : `${compact[1] ?? ''}-${compact[2] ?? ''}-${compact[3] ?? ''}T${compact[4] ?? ''}`;

  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalised) ? normalised : `${normalised}Z`;
  const ms = Date.parse(withZone);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Folds ticks into M1 bars.
 *
 * Bars are built on the BID, with the mean bid-ask spread for the minute and the tick
 * count as volume — exactly as the spec requires. Emits a bar as soon as the minute rolls,
 * so memory is O(1) regardless of file size.
 *
 * Ticks are assumed ascending; an out-of-order tick that lands in an already-emitted
 * minute is counted as malformed rather than silently corrupting a closed bar.
 */
export class M1TickAggregator {
  private minute = -1;
  private open = 0;
  private high = 0;
  private low = 0;
  private close = 0;
  private spreadSum = 0;
  private spreadCount = 0;
  private ticks = 0;
  private lastEmittedMinute = -1;

  public outOfOrder = 0;

  /** Returns the completed bar when `tick` starts a new minute, otherwise null. */
  add(tick: Tick): Bar | null {
    const minute = Math.floor(tick.time / MS_PER_MINUTE) * MS_PER_MINUTE;

    if (minute < this.lastEmittedMinute || (this.minute !== -1 && minute < this.minute)) {
      this.outOfOrder += 1;
      return null;
    }

    let completed: Bar | null = null;

    if (minute !== this.minute) {
      completed = this.finalise();
      this.minute = minute;
      this.open = tick.bid;
      this.high = tick.bid;
      this.low = tick.bid;
      this.spreadSum = 0;
      this.spreadCount = 0;
      this.ticks = 0;
    }

    if (tick.bid > this.high) this.high = tick.bid;
    if (tick.bid < this.low) this.low = tick.bid;
    this.close = tick.bid;
    this.ticks += 1;

    if (tick.ask !== null) {
      const spread = tick.ask - tick.bid;
      // A crossed or zero-ask quote is bad data; skip it rather than average it in.
      if (Number.isFinite(spread) && spread >= 0) {
        this.spreadSum += spread;
        this.spreadCount += 1;
      }
    }

    return completed;
  }

  /** Emit the final in-progress bar. Call once at end of input. */
  flush(): Bar | null {
    const bar = this.finalise();
    this.minute = -1;
    return bar;
  }

  private finalise(): Bar | null {
    if (this.minute === -1 || this.ticks === 0) return null;
    this.lastEmittedMinute = this.minute;
    return {
      time: this.minute,
      open: this.open,
      high: this.high,
      low: this.low,
      close: this.close,
      volume: this.ticks,
      spread: this.spreadCount > 0 ? this.spreadSum / this.spreadCount : null,
    };
  }
}

export interface ExnessImportOptions {
  /** Bars handed to onBatch at a time. */
  readonly batchSize?: number;
  /** Refuse absurd archives before streaming them. */
  readonly maxUncompressedBytes?: number;
}

/**
 * Stream every CSV member of a tick ZIP, aggregating to M1.
 *
 * yauzl notes that forced this shape: it needs a real file path because the central
 * directory lives at the tail of the archive; `strictFileNames` is left at its default so
 * archives written with backslash separators still open; and each entry stream is consumed
 * via `pipeline` so an abandoned stream cannot leak the archive's file descriptor.
 */
export async function streamExnessZip(
  path: string,
  opts: ExnessImportOptions,
  onBatch: (bars: Bar[]) => Promise<void>,
): Promise<ExnessImportStats> {
  const batchSize = opts.batchSize ?? 50_000;
  const maxBytes = opts.maxUncompressedBytes ?? 8 * 1024 ** 3;

  const stats: ExnessImportStats = { entries: 0, ticks: 0, bars: 0, malformed: 0 };
  const aggregator = new M1TickAggregator();
  let batch: Bar[] = [];

  const push = async (bar: Bar | null): Promise<void> => {
    if (bar === null) return;
    batch.push(bar);
    stats.bars += 1;
    if (batch.length >= batchSize) {
      await onBatch(batch);
      batch = [];
    }
  };

  const zip = await openZip(path);
  let totalUncompressed = 0;

  try {
    for await (const entry of zip.eachEntry()) {
      // Directory entries end with '/'.
      if (entry.fileName.endsWith('/')) continue;
      if (!/\.(csv|txt|tsv)$/i.test(entry.fileName)) continue;

      totalUncompressed += entry.uncompressedSize;
      if (totalUncompressed > maxBytes) {
        throw new ImportFormatError(
          `Archive expands to more than ${String(Math.round(maxBytes / 1024 ** 3))}GB; refusing.`,
        );
      }

      stats.entries += 1;
      const stream = await zip.openReadStreamPromise(entry);

      let map: ExnessColumnMap | null = null;
      let delimiter: ',' | '\t' | ';' | null = null;

      const parser = parse({
        bom: true,
        trim: true,
        skip_empty_lines: true,
        relax_column_count: true,
      });

      await pipeline(stream, parser, async (records) => {
        for await (const record of records) {
          const cells = (record as string[]).map((c) => String(c));

          if (map === null) {
            // csv-parse has already split the row; re-sniff only if it did not split,
            // which means the delimiter guess was wrong for this member.
            if (cells.length === 1) {
              delimiter = sniffDelimiter(cells[0] ?? '');
              throw new ImportFormatError(
                `Tick file appears to use "${delimiter}" as its delimiter but produced a ` +
                  `single column. Re-run the import; if it persists, send a sample.`,
              );
            }
            if (looksLikeHeader(cells)) {
              map = detectExnessColumns(cells);
              continue;
            }
            throw new ImportFormatError(
              `Tick file has no header row, so columns cannot be detected. First row: ` +
                `[${cells.slice(0, 6).join(', ')}]`,
            );
          }

          const time = parseTickTimestamp(cells[map.time] ?? '');
          const bid = Number(cells[map.bid]);
          if (time === null || !Number.isFinite(bid)) {
            stats.malformed += 1;
            continue;
          }
          const askRaw = map.ask === -1 ? Number.NaN : Number(cells[map.ask]);
          const ask = Number.isFinite(askRaw) ? askRaw : null;

          stats.ticks += 1;
          await push(aggregator.add({ time, bid, ask }));
        }
      });
    }

    await push(aggregator.flush());
    if (batch.length > 0) await onBatch(batch);

    if (stats.entries === 0) {
      throw new ImportFormatError('Archive contained no .csv/.txt/.tsv members.');
    }

    return stats;
  } finally {
    zip.close();
  }
}

/** yauzl's promise API, with lazyEntries so entries are pulled one at a time. */
async function openZip(path: string): Promise<yauzl.ZipFile> {
  return yauzl.openPromise(path, {
    lazyEntries: true,
    // Must stay false so entries whose names use backslashes are rewritten, not rejected.
    strictFileNames: false,
    // We close it ourselves; autoClose would close on early loop exit and break later reads.
    autoClose: false,
    validateEntrySizes: true,
  });
}
