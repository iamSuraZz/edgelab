import type { Diagnostic } from '../pine-engine';

/**
 * Compatibility lint for things PineTS 0.9.34 accepts but does not behave like TradingView
 * on. Every finding here was verified against the installed build, not assumed — see
 * `docs/pinets-notes.md`.
 *
 * This is a tokenizer, not a parser: it strips comments and string literals and then looks
 * at what is left. Spec 06 takes the same approach for the look-ahead lint, for the same
 * reason — a full Pine parser is a project of its own and PineTS already has one.
 */

/**
 * `strategy()` properties PineTS declares in its schema, accepts without complaint, and then
 * never reads in the broker emulator.
 *
 * Verified by searching the minified bundle: each name appears only in the declaration
 * schema table and the defaults object, never in the order-fill path. The fill path is
 * unconditional — `if (order.bar >= ctx.idx) continue` then `fillPrice = open[0]` — so a
 * market order always fills at the NEXT bar's open, whatever these are set to.
 */
export const IGNORED_STRATEGY_PROPS: ReadonlyMap<string, string> = new Map([
  [
    'process_orders_on_close',
    'PineTS always fills market orders at the next bar’s open. TradingView would fill ' +
      'at THIS bar’s close, so entries and exits land one bar later here and the trade ' +
      'prices will differ from TradingView.',
  ],
  [
    'calc_on_order_fills',
    'PineTS evaluates the script once per bar, so the extra intrabar evaluations after a ' +
      'fill never happen. A strategy that depends on reacting within the fill bar will ' +
      'behave differently from TradingView.',
  ],
  [
    'calc_on_every_tick',
    'PineTS is bar-based and has no tick stream, so this has no effect. (It is also a ' +
      'look-ahead risk on TradingView, which spec 06 flags separately.)',
  ],
  [
    'backtest_fill_limits_assumption',
    'PineTS fills a limit order the moment the bar’s range touches the level, with no ' +
      'required penetration in ticks.',
  ],
  ['close_entries_rule', 'PineTS closes entries FIFO unconditionally, so "ANY" is not honoured.'],
]);

/** Properties whose default already matches PineTS, so setting them is a no-op worth no noise. */
const HARMLESS_DEFAULTS: ReadonlyMap<string, string> = new Map([
  ['process_orders_on_close', 'false'],
  ['calc_on_order_fills', 'false'],
  ['calc_on_every_tick', 'false'],
  ['backtest_fill_limits_assumption', '0'],
  ['close_entries_rule', 'FIFO'],
]);

/**
 * Replace comments and string literals with spaces, preserving line and column positions so
 * diagnostics still point at the right place.
 */
export function stripCommentsAndStrings(source: string): string {
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
      // Pine has no escape-continuation across lines; a newline ends a broken literal.
      if (ch === '\\' && i + 1 < source.length && source[i + 1] !== '\n') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        continue;
      }
      out[i] = ch === '\n' ? '\n' : ' ';
      if (ch === quote || ch === '\n') quote = null;
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

export interface DeclaredArgument {
  readonly name: string;
  /** Raw value text as it appears in the STRIPPED source — string contents are blanked. */
  readonly value: string;
  /** 1-based line the argument name is written on. */
  readonly line: number;
  /**
   * Absolute offsets of the value, UNTRIMMED, so a caller can slice the original source and
   * recover a string literal's contents. Untrimmed because a blanked string literal is
   * indistinguishable from whitespace in the stripped text, so its extent cannot be measured
   * there — the caller trims against the original.
   */
  readonly valueSpanStart: number;
  readonly valueSpanEnd: number;
}

/**
 * Named arguments of the first `strategy(...)` or `indicator(...)` call.
 *
 * Parses the STRIPPED source so a comma inside a string literal cannot split an argument, but
 * reports offsets into it, which are identical to the original's because stripping replaces
 * characters one for one rather than deleting them. A caller that needs a string value reads
 * it from the original source at those offsets.
 */
export function declaredArguments(strippedSource: string): DeclaredArgument[] {
  const match = /\b(?:strategy|indicator)\s*\(/.exec(strippedSource);
  if (match === null) return [];

  const open = match.index + match[0].length;
  let depth = 1;
  let end = open;
  while (end < strippedSource.length && depth > 0) {
    const ch = strippedSource[end]!;
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (depth === 0) break;
    end += 1;
  }

  const body = strippedSource.slice(open, end);
  const lineOf = (absoluteOffset: number): number =>
    strippedSource.slice(0, absoluteOffset).split('\n').length;

  const out: DeclaredArgument[] = [];
  let argStart = 0;
  let nesting = 0;

  const flush = (stop: number): void => {
    const raw = body.slice(argStart, stop);
    const eq = raw.indexOf('=');
    if (eq > 0 && raw[eq + 1] !== '=' && raw[eq - 1] !== '=') {
      const name = raw.slice(0, eq).trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        // The line is the one the NAME sits on, which is not where the argument text starts:
        // after a comma the remainder of that line is whitespace and the name is on the next.
        const nameOffset = open + argStart + (raw.length - raw.trimStart().length);
        out.push({
          name,
          value: raw.slice(eq + 1).trim(),
          line: lineOf(nameOffset),
          valueSpanStart: open + argStart + eq + 1,
          valueSpanEnd: open + stop,
        });
      }
    }
    argStart = stop + 1;
  };

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch === '(' || ch === '[') nesting += 1;
    else if (ch === ')' || ch === ']') nesting -= 1;
    else if (ch === ',' && nesting === 0) flush(i);
  }
  flush(body.length);

  return out;
}

/**
 * Lines whose leading indentation is not a multiple of 4 spaces.
 *
 * TradingView rejects such scripts outright; PineTS 0.9.34 accepts them, so a script that
 * only ever ran here would break the moment it was pasted back into TradingView (D1).
 *
 * Continuation lines are skipped: Pine allows a wrapped expression to be indented freely, so
 * flagging those would bury the real finding in noise.
 */
export function indentationProblems(strippedSource: string): number[] {
  const lines = strippedSource.split('\n');
  const problems: number[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === '') continue;

    const indent = /^[ \t]*/.exec(line)![0];
    if (indent === '') continue;
    // A tab is one level by definition, so a tab-indented file cannot be measured in 4s.
    if (indent.includes('\t')) continue;
    if (indent.length % 4 === 0) continue;

    const previous = lastNonBlankBefore(lines, i);
    if (previous !== null && looksLikeContinuation(previous)) continue;

    problems.push(i + 1);
  }

  return problems;
}

function lastNonBlankBefore(lines: readonly string[], index: number): string | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (line.trim() !== '') return line;
  }
  return null;
}

function looksLikeContinuation(previousLine: string): boolean {
  const trimmed = previousLine.trimEnd();
  // An unbalanced bracket, or a trailing operator/comma, means the expression continues.
  const opens = (trimmed.match(/[([]/g) ?? []).length;
  const closes = (trimmed.match(/[)\]]/g) ?? []).length;
  if (opens > closes) return true;
  return /[,+\-*/%?:=<>]$|\b(?:and|or|not)$/.test(trimmed);
}

/** True when the script both declares a strategy and calls `request.security_lower_tf`. */
export function usesStrategyWithLowerTf(strippedSource: string): boolean {
  return (
    /\brequest\.security_lower_tf\s*\(/.test(strippedSource) &&
    /\bstrategy\s*\./.test(strippedSource)
  );
}

/**
 * Every compatibility finding for a script, as diagnostics.
 *
 * Errors here mean "we refuse to run this because the result would be quietly wrong";
 * warnings mean "this runs, but will not match TradingView, and here is exactly how".
 */
export function compatibilityDiagnostics(source: string): Diagnostic[] {
  const stripped = stripCommentsAndStrings(source);
  const diagnostics: Diagnostic[] = [];

  if (usesStrategyWithLowerTf(stripped)) {
    diagnostics.push({
      line: lineOfMatch(stripped, /\brequest\.security_lower_tf\s*\(/),
      col: null,
      message:
        'request.security_lower_tf cannot be combined with strategy.* calls. PineTS runs the ' +
        'lower-timeframe body on a secondary instance that bypasses our instrumentation, so ' +
        'the order log and the warmup gate would silently not apply to it.',
      severity: 'error',
      code: 'unsupported-security-lower-tf',
    });
  }

  for (const arg of declaredArguments(stripped)) {
    const explanation = IGNORED_STRATEGY_PROPS.get(arg.name);
    if (explanation === undefined) continue;
    // Read the value from the ORIGINAL source: stripping blanks string contents, so
    // `close_entries_rule="FIFO"` is indistinguishable from `="ANY"` in the stripped text.
    const written = source.slice(arg.valueSpanStart, arg.valueSpanEnd);
    // Setting it to the value PineTS already behaves as is not a divergence.
    if (HARMLESS_DEFAULTS.get(arg.name) === normaliseLiteral(written)) continue;

    diagnostics.push({
      line: arg.line,
      col: null,
      message: `${arg.name} is accepted but IGNORED by PineTS ${'0.9.34'}. ${explanation}`,
      severity: 'warning',
      code: 'ignored-strategy-prop',
    });
  }

  for (const line of indentationProblems(stripped)) {
    diagnostics.push({
      line,
      col: null,
      message:
        'Indentation is not a multiple of 4 spaces. PineTS accepts this but TradingView ' +
        'rejects it, so this script would not compile if pasted back.',
      severity: 'warning',
      code: 'indentation-not-multiple-of-4',
    });
  }

  return diagnostics;
}

function normaliseLiteral(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '');
}

function lineOfMatch(source: string, pattern: RegExp): number | null {
  const match = pattern.exec(source);
  if (match === null) return null;
  return source.slice(0, match.index).split('\n').length;
}
