import { describe, expect, it } from 'vitest';
import { ImportFormatError } from './detect';
import { detectMt5Columns, parseMt5CsvText, parseMt5Timestamp } from './mt5-csv';

/** A GMT+2 broker, the most common MT5 server offset. */
const GMT2 = { serverUtcOffsetMinutes: 120, mintick: 0.00001 };
const UTC = { serverUtcOffsetMinutes: 0, mintick: 0.00001 };

const TAB_HEADER = '<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>';

describe('parseMt5Timestamp', () => {
  it('parses MT5 dotted dates', () => {
    expect(parseMt5Timestamp('2024.01.02', '09:30:00', 0)).toBe(Date.UTC(2024, 0, 2, 9, 30));
  });

  it('accepts dashed dates and HH:mm without seconds', () => {
    expect(parseMt5Timestamp('2024-01-02', '09:30', 0)).toBe(Date.UTC(2024, 0, 2, 9, 30));
  });

  it('accepts a combined datetime in the date column', () => {
    expect(parseMt5Timestamp('2024.01.02 09:30:00', undefined, 0)).toBe(
      Date.UTC(2024, 0, 2, 9, 30),
    );
  });

  it('converts broker server time to UTC by SUBTRACTING the offset', () => {
    // 09:30 on a GMT+2 server is 07:30 UTC.
    expect(parseMt5Timestamp('2024.01.02', '09:30:00', 120)).toBe(Date.UTC(2024, 0, 2, 7, 30));
  });

  it('handles an offset that crosses midnight backwards', () => {
    expect(parseMt5Timestamp('2024.01.02', '00:30:00', 120)).toBe(Date.UTC(2024, 0, 1, 22, 30));
  });

  it('handles a negative offset for a server behind UTC', () => {
    expect(parseMt5Timestamp('2024.01.02', '09:30:00', -300)).toBe(Date.UTC(2024, 0, 2, 14, 30));
  });

  it('defaults a missing time to midnight', () => {
    expect(parseMt5Timestamp('2024.01.02', '', 0)).toBe(Date.UTC(2024, 0, 2));
  });

  it('returns null for junk', () => {
    expect(parseMt5Timestamp('not-a-date', '09:30', 0)).toBeNull();
    expect(parseMt5Timestamp('', '', 0)).toBeNull();
  });
});

describe('detectMt5Columns', () => {
  it('reads angle-bracketed headers in any order', () => {
    const map = detectMt5Columns(['<CLOSE>', '<DATE>', '<OPEN>', '<HIGH>', '<LOW>', '<TIME>']);
    expect(map.close).toBe(0);
    expect(map.date).toBe(1);
    expect(map.time).toBe(5);
  });

  it('tolerates plain headers without brackets or casing', () => {
    const map = detectMt5Columns(['Date', 'Time', 'Open', 'High', 'Low', 'Close', 'Tick volume']);
    expect(map.date).toBe(0);
    expect(map.tickVol).toBe(6);
  });

  it('reports which required columns are missing', () => {
    expect(() => detectMt5Columns(['<DATE>', '<OPEN>'])).toThrow(ImportFormatError);
    expect(() => detectMt5Columns(['<DATE>', '<OPEN>'])).toThrow(/<HIGH>/);
  });
});

describe('parseMt5CsvText', () => {
  it('parses a tab-separated export', () => {
    const csv = [
      TAB_HEADER,
      '2024.01.02\t00:00:00\t1.10400\t1.10450\t1.10380\t1.10420\t145\t0\t12',
      '2024.01.02\t00:01:00\t1.10420\t1.10460\t1.10410\t1.10455\t132\t0\t10',
    ].join('\n');

    const { bars, stats } = parseMt5CsvText(csv, UTC);
    expect(stats.rows).toBe(2);
    expect(stats.bars).toBe(2);
    expect(bars[0]).toEqual({
      time: Date.UTC(2024, 0, 2, 0, 0),
      open: 1.104,
      high: 1.1045,
      low: 1.1038,
      close: 1.1042,
      volume: 145,
      // 12 points * 0.00001
      spread: 12 * 0.00001,
    });
  });

  it('parses a comma-separated export', () => {
    const csv = [
      '<DATE>,<TIME>,<OPEN>,<HIGH>,<LOW>,<CLOSE>,<TICKVOL>,<VOL>,<SPREAD>',
      '2024.01.02,00:00:00,1.10400,1.10450,1.10380,1.10420,145,0,12',
    ].join('\n');
    expect(parseMt5CsvText(csv, UTC).bars).toHaveLength(1);
  });

  it('applies the broker offset to every row', () => {
    const csv = [TAB_HEADER, '2024.01.02\t09:00:00\t1.1\t1.2\t1.0\t1.15\t10\t0\t8'].join('\n');
    expect(parseMt5CsvText(csv, GMT2).bars[0]?.time).toBe(Date.UTC(2024, 0, 2, 7, 0));
  });

  it('converts SPREAD points to a price using mintick', () => {
    const csv = [TAB_HEADER, '2024.01.02\t00:00:00\t1.1\t1.2\t1.0\t1.15\t10\t0\t25'].join('\n');
    // A 3-digit JPY symbol: mintick 0.001, so 25 points is 0.025.
    const jpy = { serverUtcOffsetMinutes: 0, mintick: 0.001 };
    expect(parseMt5CsvText(csv, jpy).bars[0]?.spread).toBeCloseTo(0.025, 10);
  });

  it('falls back to <VOL> when <TICKVOL> is zero', () => {
    const csv = [TAB_HEADER, '2024.01.02\t00:00:00\t1.1\t1.2\t1.0\t1.15\t0\t777\t8'].join('\n');
    expect(parseMt5CsvText(csv, UTC).bars[0]?.volume).toBe(777);
  });

  it('nulls the spread when the column is absent', () => {
    const csv = [
      '<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>',
      '2024.01.02\t00:00:00\t1.1\t1.2\t1.0\t1.15',
    ].join('\n');
    expect(parseMt5CsvText(csv, UTC).bars[0]?.spread).toBeNull();
  });

  it('skips a BOM, blank lines and comments', () => {
    const csv = [
      '﻿# exported from MT5',
      '',
      TAB_HEADER,
      '',
      '2024.01.02\t00:00:00\t1.1\t1.2\t1.0\t1.15\t5\t0\t8',
      '',
    ].join('\n');
    expect(parseMt5CsvText(csv, UTC).bars).toHaveLength(1);
  });

  it('tolerates CRLF', () => {
    const csv = `${TAB_HEADER}\r\n2024.01.02\t00:00:00\t1.1\t1.2\t1.0\t1.15\t5\t0\t8\r\n`;
    expect(parseMt5CsvText(csv, UTC).bars).toHaveLength(1);
  });

  it('counts malformed rows without aborting the file', () => {
    const csv = [
      TAB_HEADER,
      '2024.01.02\t00:00:00\t1.1\t1.2\t1.0\t1.15\t5\t0\t8',
      'garbage\trow\there\tx\ty\tz\t0\t0\t0',
      '2024.01.02\t00:02:00\t1.1\t1.2\t1.0\t1.15\t5\t0\t8',
    ].join('\n');
    const { bars, stats } = parseMt5CsvText(csv, UTC);
    expect(bars).toHaveLength(2);
    expect(stats.malformed).toBe(1);
  });

  it('refuses a file with no header', () => {
    expect(() => parseMt5CsvText('2024.01.02\t00:00\t1\t2\t0.5\t1.5', UTC)).toThrow(
      /no header row/i,
    );
  });

  it('is empty-safe', () => {
    expect(parseMt5CsvText('', UTC).bars).toEqual([]);
    expect(parseMt5CsvText('\n\n', UTC).bars).toEqual([]);
  });
});
