/**
 * Static look-ahead lint for Pine source.
 *
 * A tokenizer, not a parser — spec 06 is explicit about that, and it is the right call: a full
 * Pine grammar is a large thing to own and keep current, and the patterns worth catching are
 * lexical. What a tokenizer must still get right is what NOT to read, which is why comments and
 * string literals are blanked before anything is matched. Without that, the word `lookahead_on`
 * inside a comment warning people about look-ahead bias is itself reported as a leak.
 *
 * This is the cheap first layer. It runs in milliseconds on the source alone and catches the
 * common mistakes with a line number. It cannot prove a script is clean — only the dynamic
 * prefix-invariance test can come close to that — so a pass here means "nothing obvious", never
 * "no leak".
 *
 * Pure. No I/O.
 */

export type LintSeverity = 'error' | 'warning';

export interface LintFinding {
  readonly rule: string;
  readonly severity: LintSeverity;
  /** 1-based, as an editor counts. */
  readonly line: number;
  readonly message: string;
  /** The offending source line, trimmed, for the report. */
  readonly snippet: string;
}

/**
 * Blank out comments and string literals, preserving every byte offset and newline.
 *
 * Replacing rather than removing is what keeps line numbers honest: the scan below works on
 * offsets into this string and maps them back to lines in the ORIGINAL source, so the two must
 * stay the same length.
 */
export function blankCommentsAndStrings(source: string): string {
  const out = source.split('');
  let i = 0;
  let inLineComment = false;
  let quote: string | null = null;

  while (i < source.length) {
    const ch = source[i]!;

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      else out[i] = ' ';
      i += 1;
      continue;
    }

    if (quote !== null) {
      // Pine has no escape-continuation across lines; a newline ends a string as surely as a
      // quote does, and treating it otherwise would swallow the rest of the file.
      if (ch === quote || ch === '\n') quote = null;
      if (ch !== '\n') out[i] = ' ';
      i += 1;
      continue;
    }

    if (ch === '/' && source[i + 1] === '/') {
      inLineComment = true;
      out[i] = ' ';
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      out[i] = ' ';
      i += 1;
      continue;
    }

    i += 1;
  }

  return out.join('');
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

function snippetAt(source: string, line: number): string {
  return (source.split('\n')[line - 1] ?? '').trim();
}

/**
 * Split a call's argument list at the top level.
 *
 * Nesting matters: `request.security(sym, tf, ta.ema(close, 20)[1], lookahead=...)` has four
 * arguments, not five, and a naive split on commas finds five and then reads the wrong one as
 * `lookahead`.
 */
function splitArgs(text: string): { args: string[]; end: number } {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  let i = 0;

  for (; i < text.length; i += 1) {
    const ch = text[i]!;

    if (ch === '(' || ch === '[') {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ')' && depth === 0) break;
    if (ch === ')' || ch === ']') {
      depth -= 1;
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  if (current.trim() !== '') args.push(current.trim());
  return { args, end: i };
}

/** Does an expression read a CLOSED higher-timeframe bar, i.e. carry a `[n]` with n >= 1? */
function hasHistoryOffset(expression: string): boolean {
  // Every bracket group in the expression, so `ta.ema(close, len)[1]` and `close[1]` both count.
  for (const match of expression.matchAll(/\[\s*(\d+)\s*\]/g)) {
    if (Number(match[1]) >= 1) return true;
  }
  return false;
}

/** Positional index of `lookahead` in `request.security`, per the Pine signature. */
const LOOKAHEAD_POSITION = 4;
/** Positional index of the requested expression. */
const EXPRESSION_POSITION = 2;

function namedArg(args: readonly string[], name: string): string | null {
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (eq === -1) continue;
    if (arg.slice(0, eq).trim() === name) return arg.slice(eq + 1).trim();
  }
  return null;
}

function positionalArg(args: readonly string[], index: number): string | null {
  // Named arguments may be mixed in after the positional ones, and they do not occupy a slot.
  const positional = args.filter((a) => !/^[A-Za-z_]\w*\s*=(?!=)/.test(a));
  return positional[index] ?? null;
}

/**
 * Identifiers that reveal the present or the end of the data, and so cannot be part of a decision
 * that is supposed to be reproducible bar by bar.
 *
 * Warnings rather than errors: each has legitimate uses — drawing a label on the last bar, say —
 * and this lint cannot tell decoration from trading logic. It reports; a human judges.
 */
const SUSPECT_IDENTIFIERS: readonly { readonly token: string; readonly why: string }[] = [
  {
    token: 'barstate.isrealtime',
    why: 'true only on the live bar, so a backtest and live trading take different branches',
  },
  { token: 'timenow', why: 'the wall clock, which has no meaning inside a historical bar' },
  { token: 'varip', why: 'persists across intrabar ticks, so its value depends on replay detail' },
  {
    token: 'last_bar_index',
    why: 'the end of the data — knowing it early is knowing how long the test runs',
  },
  { token: 'last_bar_time', why: 'the end of the data, as a timestamp' },
];

export interface LintResult {
  readonly findings: readonly LintFinding[];
  readonly errorCount: number;
  readonly warningCount: number;
}

export function lintLookahead(source: string): LintResult {
  const scannable = blankCommentsAndStrings(source);
  const findings: LintFinding[] = [];

  /* ------------------------------------------------- request.security look-ahead */

  for (const match of scannable.matchAll(/request\.security(?:_lower_tf)?\s*\(/g)) {
    const openParen = match.index + match[0].length;
    const { args } = splitArgs(scannable.slice(openParen));

    const lookahead = namedArg(args, 'lookahead') ?? positionalArg(args, LOOKAHEAD_POSITION);
    if (lookahead === null || !lookahead.includes('lookahead_on')) continue;

    const expression = namedArg(args, 'expression') ?? positionalArg(args, EXPRESSION_POSITION);
    if (expression !== null && hasHistoryOffset(expression)) {
      // lookahead_on WITH an offset is the documented non-repainting idiom: the offset steps back
      // far enough that the value being read is already settled.
      continue;
    }

    const line = lineAt(source, match.index);
    findings.push({
      rule: 'lookahead-on-without-offset',
      severity: 'error',
      line,
      message:
        'request.security uses lookahead_on with no [1]-or-greater offset, so it returns the ' +
        'higher-timeframe value before that bar has closed. Add [1], or use lookahead_off.',
      snippet: snippetAt(source, line),
    });
  }

  /* ----------------------------------------------------- suspect identifiers */

  for (const { token, why } of SUSPECT_IDENTIFIERS) {
    // Word-boundary on both sides so `timenow` does not match inside `mytimenow`, and the dotted
    // tokens are escaped.
    const pattern = new RegExp(`(?<![\\w.])${token.replace('.', '\\.')}(?![\\w])`, 'g');
    for (const match of scannable.matchAll(pattern)) {
      const line = lineAt(source, match.index);
      findings.push({
        rule: 'time-dependent-identifier',
        severity: 'warning',
        line,
        message: `\`${token}\` is ${why}.`,
        snippet: snippetAt(source, line),
      });
    }
  }

  /* -------------------------------------------------- calc_on_every_tick = true */

  for (const match of scannable.matchAll(/calc_on_every_tick\s*=\s*true/g)) {
    const line = lineAt(source, match.index);
    findings.push({
      rule: 'calc-on-every-tick',
      severity: 'warning',
      line,
      message:
        'calc_on_every_tick = true makes live behaviour depend on intrabar ticks that a bar-based ' +
        'backtest never sees. EdgeLab ignores the flag, so the two will not agree.',
      snippet: snippetAt(source, line),
    });
  }

  return {
    findings,
    errorCount: findings.filter((f) => f.severity === 'error').length,
    warningCount: findings.filter((f) => f.severity === 'warning').length,
  };
}
