import { describe, expect, it } from 'vitest';

import { collapseUnchanged, diffLines, diffStats } from '../src/lib/diff';

describe('diffLines', () => {
  it('reports no changes for identical text', () => {
    const lines = diffLines('a\nb\nc', 'a\nb\nc');
    expect(lines.every((l) => l.kind === 'same')).toBe(true);
    expect(diffStats(lines)).toEqual({ added: 0, removed: 0 });
  });

  it('finds a single changed line as one removal and one addition', () => {
    const lines = diffLines('a\nb\nc', 'a\nB\nc');

    expect(lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      'same:a',
      'removed:b',
      'added:B',
      'same:c',
    ]);
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
  });

  it('numbers old and new lines independently', () => {
    // Inserting a line means every later NEW number is one ahead of its OLD counterpart.
    const lines = diffLines('a\nc', 'a\nb\nc');

    expect(lines).toEqual([
      { kind: 'same', oldLine: 1, newLine: 1, text: 'a' },
      { kind: 'added', oldLine: null, newLine: 2, text: 'b' },
      { kind: 'same', oldLine: 2, newLine: 3, text: 'c' },
    ]);
  });

  it('keeps the common subsequence rather than rewriting everything', () => {
    // The naive answer — remove all four, add all four — is also a valid edit script. The point
    // of the LCS is that it is not the one a reader wants.
    const lines = diffLines('one\ntwo\nthree\nfour', 'one\ntwo\nTHREE\nfour');
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
  });

  it('treats CRLF as the same line ending, not as a change to every line', () => {
    const lines = diffLines('a\r\nb\r\nc', 'a\nb\nc');
    expect(diffStats(lines)).toEqual({ added: 0, removed: 0 });
  });

  it('handles a wholly new file', () => {
    const lines = diffLines('', 'a\nb');
    // Splitting '' yields one empty line, which matches the absence of trailing content.
    expect(diffStats(lines).added).toBeGreaterThan(0);
    expect(lines.some((l) => l.text === 'a' && l.kind === 'added')).toBe(true);
  });
});

describe('collapseUnchanged', () => {
  it('drops long unchanged runs and records how many lines it hid', () => {
    const oldText = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const newText = oldText.replace('line 20', 'line twenty');

    const hunks = collapseUnchanged(diffLines(oldText, newText), 2);

    expect(hunks).toHaveLength(1);
    // Two lines of context either side, plus the removal and the addition.
    expect(hunks[0]!.lines).toHaveLength(6);
    expect(hunks[0]!.gapBefore).toBe(20 - 2);
  });

  it('returns nothing when there is nothing to show', () => {
    expect(collapseUnchanged(diffLines('a\nb', 'a\nb'))).toEqual([]);
  });

  it('keeps every line when the whole file is interesting', () => {
    const hunks = collapseUnchanged(diffLines('a\nb', 'x\ny'), 3);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.gapBefore).toBe(0);
  });
});
