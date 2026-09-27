/**
 * A line diff for the Library's version comparison.
 *
 * Hand-written rather than pulled from npm: the need is one screen showing what changed between
 * two revisions of a Pine script, and the standard libraries bring patch formats, word-level
 * diffing and a dependency to keep current for it.
 *
 * Pure and unit-tested, like the rest of the analysis code.
 */

export type DiffKind = 'same' | 'added' | 'removed';

export interface DiffLine {
  readonly kind: DiffKind;
  /** 1-based line number in the OLD text; null for an added line. */
  readonly oldLine: number | null;
  /** 1-based line number in the NEW text; null for a removed line. */
  readonly newLine: number | null;
  readonly text: string;
}

export interface DiffStats {
  readonly added: number;
  readonly removed: number;
}

/**
 * Longest common subsequence of two line arrays, as a table of lengths.
 *
 * O(n·m) in both time and memory. A Pine script is hundreds of lines, so the table is at worst
 * a few hundred thousand small integers — well inside what a browser does without noticing, and
 * far simpler to get right than Myers' algorithm.
 */
function lcsTable(a: readonly string[], b: readonly string[]): Uint32Array[] {
  const table: Uint32Array[] = [];
  for (let i = 0; i <= a.length; i += 1) table.push(new Uint32Array(b.length + 1));

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

/**
 * Diff two texts line by line.
 *
 * Both texts are split on `\n` after stripping `\r`, so a file saved on Windows does not read as
 * a rewrite of every single line.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.replace(/\r\n/g, '\n').split('\n');
  const b = newText.replace(/\r\n/g, '\n').split('\n');
  const table = lcsTable(a, b);

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', oldLine: i + 1, newLine: j + 1, text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push({ kind: 'removed', oldLine: i + 1, newLine: null, text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: 'added', oldLine: null, newLine: j + 1, text: b[j]! });
      j += 1;
    }
  }

  for (; i < a.length; i += 1) {
    out.push({ kind: 'removed', oldLine: i + 1, newLine: null, text: a[i]! });
  }
  for (; j < b.length; j += 1) {
    out.push({ kind: 'added', oldLine: null, newLine: j + 1, text: b[j]! });
  }

  return out;
}

export function diffStats(lines: readonly DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'added') added += 1;
    else if (line.kind === 'removed') removed += 1;
  }
  return { added, removed };
}

/**
 * Drop runs of unchanged lines longer than `context`, replacing each with a gap marker.
 *
 * A Pine script edited in one place is otherwise 200 identical lines with three interesting ones
 * somewhere inside, and the reader has to hunt for them.
 */
export interface DiffHunk {
  readonly gapBefore: number;
  readonly lines: readonly DiffLine[];
}

export function collapseUnchanged(lines: readonly DiffLine[], context = 3): DiffHunk[] {
  const interesting = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let k = index - context; k <= index + context; k += 1) {
      if (k >= 0 && k < lines.length) interesting.add(k);
    }
  });

  const hunks: DiffHunk[] = [];
  let current: DiffLine[] = [];
  let gap = 0;

  lines.forEach((line, index) => {
    if (interesting.has(index)) {
      current.push(line);
      return;
    }
    if (current.length > 0) {
      hunks.push({ gapBefore: gap, lines: current });
      current = [];
      gap = 0;
    }
    gap += 1;
  });

  if (current.length > 0) hunks.push({ gapBefore: gap, lines: current });
  return hunks;
}
