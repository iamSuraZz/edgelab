import { describe, expect, it } from 'vitest';

import { parseBackfillTargets } from './backfill';

/**
 * The nightly schedule's configuration (A68).
 *
 * Every malformed entry throws by NAME, because the failure mode of a scheduled job is silence: an
 * entry that parsed to nothing would mean the night's work simply never happened, and nobody looks
 * at a log that has been quiet for a week.
 */
describe('parseBackfillTargets', () => {
  it('is empty by default, which means no scheduled backfill', () => {
    // A server that began hitting a provider merely because it was deployed is worse than one that
    // needs a variable set.
    expect(parseBackfillTargets('')).toEqual([]);
    expect(parseBackfillTargets('   ')).toEqual([]);
  });

  it('parses one target', () => {
    expect(parseBackfillTargets('EURUSD:dukascopy:2022-01-01:2024-02-01')).toEqual([
      {
        symbolCode: 'EURUSD',
        provider: 'dukascopy',
        fromMs: Date.UTC(2022, 0, 1),
        toMs: Date.UTC(2024, 1, 1),
      },
    ]);
  });

  it('parses several, ignoring surrounding whitespace', () => {
    const targets = parseBackfillTargets(
      ' EURUSD:dukascopy:2022-01-01:2024-02-01 , USDJPY:dukascopy:2024-01-01:2024-02-01 ',
    );
    expect(targets.map((t) => t.symbolCode)).toEqual(['EURUSD', 'USDJPY']);
  });

  it('refuses an entry with the wrong number of fields, showing the entry', () => {
    expect(() => parseBackfillTargets('EURUSD:dukascopy:2022-01-01')).toThrow(
      /EURUSD:dukascopy:2022-01-01/,
    );
  });

  it('refuses an unparseable date rather than scheduling an epoch-zero range', () => {
    expect(() => parseBackfillTargets('EURUSD:dukascopy:not-a-date:2024-02-01')).toThrow(
      /bad from date/,
    );
    expect(() => parseBackfillTargets('EURUSD:dukascopy:2022-01-01:nope')).toThrow(/bad to date/);
  });

  it('refuses a backwards range', () => {
    expect(() => parseBackfillTargets('EURUSD:dukascopy:2024-02-01:2022-01-01')).toThrow(
      /from is not before to/,
    );
  });
});
