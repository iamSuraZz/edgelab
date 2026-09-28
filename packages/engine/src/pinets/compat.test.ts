import { describe, expect, it } from 'vitest';

import {
  compatibilityDiagnostics,
  declaredArguments,
  indentationProblems,
  stripCommentsAndStrings,
  usesStrategyWithLowerTf,
} from './compat';

describe('stripCommentsAndStrings', () => {
  it('blanks line comments but keeps the newline', () => {
    const out = stripCommentsAndStrings('a = 1 // comment\nb = 2\n');
    expect(out).toBe('a = 1           \nb = 2\n');
    expect(out.split('\n')).toHaveLength(3);
  });

  it('blanks string contents, so keywords inside strings cannot be mistaken for code', () => {
    const out = stripCommentsAndStrings('x = "process_orders_on_close=true"');
    expect(out).not.toContain('process_orders_on_close');
    expect(out).toHaveLength('x = "process_orders_on_close=true"'.length);
  });

  it('does not treat // inside a string as a comment', () => {
    const out = stripCommentsAndStrings('u = "http://x" \nreal = 1');
    expect(out).toContain('real = 1');
  });

  it('handles single quotes and preserves every column position', () => {
    const src = "a = 'hi' + b";
    const out = stripCommentsAndStrings(src);
    expect(out).toHaveLength(src.length);
    expect(out.indexOf('+ b')).toBe(src.indexOf('+ b'));
  });
});

describe('declaredArguments', () => {
  it('reads named arguments of the strategy call with their line numbers', () => {
    const src = `//@version=5
strategy("T",
  overlay=true,
  pyramiding=3)
`;
    const args = declaredArguments(stripCommentsAndStrings(src));
    expect(args.map((a) => a.name)).toEqual(['overlay', 'pyramiding']);
    expect(args.find((a) => a.name === 'pyramiding')?.value).toBe('3');
    expect(args.find((a) => a.name === 'overlay')?.line).toBe(3);
  });

  it('ignores the positional title', () => {
    const args = declaredArguments(stripCommentsAndStrings('strategy("My Title", overlay=true)'));
    expect(args.map((a) => a.name)).toEqual(['overlay']);
  });

  it('does not split on a comma inside a nested call', () => {
    const args = declaredArguments(
      stripCommentsAndStrings('strategy("T", default_qty_value=math.max(1, 2), pyramiding=2)'),
    );
    expect(args.map((a) => a.name)).toEqual(['default_qty_value', 'pyramiding']);
    expect(args[0]?.value).toBe('math.max(1, 2)');
  });

  it('does not mistake == for a named argument', () => {
    const args = declaredArguments(stripCommentsAndStrings('strategy("T", overlay = a == b)'));
    expect(args.map((a) => a.name)).toEqual(['overlay']);
  });

  it('is empty when there is no declaration', () => {
    expect(declaredArguments('plot(close)')).toEqual([]);
  });
});

describe('indentationProblems', () => {
  it('accepts 4-space steps', () => {
    expect(indentationProblems('if a\n    b = 1\n    if c\n        d = 2\n')).toEqual([]);
  });

  it('flags a 2-space block body', () => {
    expect(indentationProblems('if a\n  b = 1\n')).toEqual([2]);
  });

  it('flags a 6-space body and reports the 1-based line', () => {
    expect(indentationProblems('x = 1\nif a\n      b = 2\n')).toEqual([3]);
  });

  it('ignores tab indentation, which cannot be measured in spaces', () => {
    expect(indentationProblems('if a\n\tb = 1\n')).toEqual([]);
  });

  it('ignores a wrapped expression, whose indentation Pine does not constrain', () => {
    // An unbalanced bracket on the previous line means this is a continuation.
    expect(indentationProblems('x = math.max(1,\n  2)\n')).toEqual([]);
    // A trailing operator means the same.
    expect(indentationProblems('x = 1 +\n  2\n')).toEqual([]);
    expect(indentationProblems('cond = a and\n   b\n')).toEqual([]);
  });

  it('ignores blank lines and unindented code', () => {
    expect(indentationProblems('a = 1\n\n\nb = 2\n')).toEqual([]);
  });
});

describe('usesStrategyWithLowerTf', () => {
  it('is true only when both appear', () => {
    const lower = 'x = request.security_lower_tf(syminfo.tickerid, "1", close)';
    expect(usesStrategyWithLowerTf(`${lower}\nstrategy.entry("L", strategy.long)`)).toBe(true);
    expect(usesStrategyWithLowerTf(lower)).toBe(false);
    expect(usesStrategyWithLowerTf('strategy.entry("L", strategy.long)')).toBe(false);
  });
});

describe('compatibilityDiagnostics', () => {
  const clean = `//@version=5
strategy("Clean", overlay=true, pyramiding=2)
if ta.crossover(close, ta.sma(close, 20))
    strategy.entry("L", strategy.long)
`;

  it('says nothing about a clean script', () => {
    expect(compatibilityDiagnostics(clean)).toEqual([]);
  });

  it('warns once per ignored property, and only for the ones actually set', () => {
    const src = `//@version=5
strategy("X", process_orders_on_close=true, calc_on_every_tick=true, pyramiding=2)
plot(close)
`;
    const codes = compatibilityDiagnostics(src);
    const ignored = codes.filter((d) => d.code === 'ignored-strategy-prop');
    expect(ignored).toHaveLength(2);
    expect(ignored.every((d) => d.severity === 'warning')).toBe(true);
    expect(ignored.map((d) => d.message).join(' ')).toContain('calc_on_every_tick');
  });

  it('warns about close_entries_rule="ANY" but not "FIFO", which is what PineTS does anyway', () => {
    const any = compatibilityDiagnostics('//@version=5\nstrategy("X", close_entries_rule="ANY")\n');
    expect(any.filter((d) => d.code === 'ignored-strategy-prop')).toHaveLength(1);

    const fifo = compatibilityDiagnostics(
      '//@version=5\nstrategy("X", close_entries_rule="FIFO")\n',
    );
    expect(fifo.filter((d) => d.code === 'ignored-strategy-prop')).toHaveLength(0);
  });

  it('ERRORS on request.security_lower_tf combined with strategy calls (D1)', () => {
    const src = `//@version=5
strategy("Lower", overlay=true)
arr = request.security_lower_tf(syminfo.tickerid, "1", close)
if array.size(arr) > 0
    strategy.entry("L", strategy.long)
`;
    const diagnostics = compatibilityDiagnostics(src);
    const error = diagnostics.find((d) => d.code === 'unsupported-security-lower-tf');
    expect(error?.severity).toBe('error');
    expect(error?.line).toBe(3);
  });

  it('allows request.security_lower_tf in a plain indicator', () => {
    const src = `//@version=5
indicator("Lower")
arr = request.security_lower_tf(syminfo.tickerid, "1", close)
plot(array.size(arr))
`;
    expect(compatibilityDiagnostics(src)).toEqual([]);
  });

  it('is not fooled by an ignored property mentioned in a comment or string', () => {
    const src = `//@version=5
strategy("X", overlay=true) // process_orders_on_close=true would be ignored
note = "calc_on_every_tick=true"
plot(close)
`;
    expect(compatibilityDiagnostics(src)).toEqual([]);
  });
});

describe('divergent strategy props', () => {
  it('warns that slippage also slips LIMIT fills, unlike TradingView', () => {
    const d = compatibilityDiagnostics('//@version=5\nstrategy("S", slippage=15)\n');
    const found = d.find((x) => x.code === 'divergent-strategy-prop');

    expect(found).toBeDefined();
    expect(found!.message).toContain('LIMIT');
    expect(found!.message).toContain('honoured');
  });

  it('does not call it ignored, because it is applied', () => {
    const d = compatibilityDiagnostics('//@version=5\nstrategy("S", slippage=15)\n');
    expect(
      d.some((x) => x.code === 'ignored-strategy-prop' && x.message.includes('slippage')),
    ).toBe(false);
  });

  it('stays quiet for slippage=0, which asks for nothing', () => {
    const d = compatibilityDiagnostics('//@version=5\nstrategy("S", slippage=0)\n');
    expect(d.some((x) => x.code === 'divergent-strategy-prop')).toBe(false);
  });
});
