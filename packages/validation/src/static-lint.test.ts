import { describe, expect, it } from 'vitest';
import { VALIDATION_FIXTURES, getValidationFixture } from './fixtures';

import { blankCommentsAndStrings, lintLookahead } from './static-lint';

/**
 * The static look-ahead lint.
 *
 * The discriminating cases matter more than the obvious one. Any regex finds `lookahead_on`; the
 * work is in NOT finding it inside a comment, and in not flagging the documented non-repainting
 * idiom where `lookahead_on` is paired with an offset.
 */

describe('blankCommentsAndStrings', () => {
  it('keeps offsets and newlines identical', () => {
    const source = 'a = 1 // comment\nb = "text"\n';
    const blanked = blankCommentsAndStrings(source);

    expect(blanked).toHaveLength(source.length);
    expect(blanked.split('\n')).toHaveLength(source.split('\n').length);
  });

  it('blanks a line comment but not the code before it', () => {
    const blanked = blankCommentsAndStrings('x = close // lookahead_on');

    expect(blanked).toContain('x = close');
    expect(blanked).not.toContain('lookahead_on');
  });

  it('blanks string contents', () => {
    expect(blankCommentsAndStrings('t = "lookahead_on"')).not.toContain('lookahead_on');
  });

  it('ends a string at a newline rather than swallowing the file', () => {
    // An unterminated quote must not blank everything after it.
    const blanked = blankCommentsAndStrings('a = "oops\nb = close\n');
    expect(blanked).toContain('b = close');
  });
});

describe('lintLookahead — the leak', () => {
  it('fails the leaky fixture at the request.security line', () => {
    const source = getValidationFixture('lookahead-leak').source;
    const result = lintLookahead(source);

    expect(result.errorCount).toBe(1);

    const finding = result.findings.find((f) => f.severity === 'error')!;
    expect(finding.rule).toBe('lookahead-on-without-offset');
    expect(finding.snippet).toContain('request.security');
    expect(finding.snippet).toContain('lookahead_on');

    // The reported line really is the offending one in the original source.
    expect(source.split('\n')[finding.line - 1]).toContain('lookahead=barmerge.lookahead_on');
  });

  it('PASSES the clean twin', () => {
    const result = lintLookahead(getValidationFixture('lookahead-off').source);
    expect(result.errorCount).toBe(0);
  });

  it('passes every shipped example strategy', () => {
    // A lint that cried wolf on the fixtures we ship would be ignored within a day.
    for (const fixture of VALIDATION_FIXTURES.filter((f) => f.id !== 'lookahead-leak')) {
      expect(lintLookahead(fixture.source).errorCount, fixture.id).toBe(0);
    }
  });
});

describe('lintLookahead — discrimination', () => {
  it('ignores lookahead_on mentioned only in a comment', () => {
    const source = `//@version=5
// Never use lookahead_on without [1] — request.security(sym, tf, close, lookahead=barmerge.lookahead_on)
x = close
`;
    expect(lintLookahead(source).errorCount).toBe(0);
  });

  it('accepts lookahead_on WITH an offset, the non-repainting idiom', () => {
    const source = `//@version=5
v = request.security(syminfo.tickerid, "240", close[1], lookahead=barmerge.lookahead_on)
`;
    expect(lintLookahead(source).errorCount).toBe(0);
  });

  it('accepts an offset on a nested call', () => {
    const source = `//@version=5
v = request.security(syminfo.tickerid, "240", ta.ema(close, 20)[1], lookahead=barmerge.lookahead_on)
`;
    expect(lintLookahead(source).errorCount).toBe(0);
  });

  it('rejects an offset of [0], which is no offset at all', () => {
    const source = `//@version=5
v = request.security(syminfo.tickerid, "240", close[0], lookahead=barmerge.lookahead_on)
`;
    expect(lintLookahead(source).errorCount).toBe(1);
  });

  it('reads lookahead given POSITIONALLY', () => {
    // request.security(symbol, timeframe, expression, gaps, lookahead)
    const source = `//@version=5
v = request.security(syminfo.tickerid, "240", close, barmerge.gaps_off, barmerge.lookahead_on)
`;
    expect(lintLookahead(source).errorCount).toBe(1);
  });

  it('is not fooled by a comma inside a nested call when counting positions', () => {
    // ta.ema(close, 20) contains a comma; a naive split would read `20)` as the gaps argument and
    // `barmerge.gaps_off` as lookahead, missing the real one.
    const source = `//@version=5
v = request.security(syminfo.tickerid, "240", ta.ema(close, 20), barmerge.gaps_off, barmerge.lookahead_on)
`;
    expect(lintLookahead(source).errorCount).toBe(1);
  });

  it('says nothing about lookahead_off', () => {
    const source = `//@version=5
v = request.security(syminfo.tickerid, "240", close, lookahead=barmerge.lookahead_off)
`;
    expect(lintLookahead(source).errorCount).toBe(0);
  });

  it('reports one finding per leaky call', () => {
    const source = `//@version=5
a = request.security(syminfo.tickerid, "240", close, lookahead=barmerge.lookahead_on)
b = request.security(syminfo.tickerid, "60", high, lookahead=barmerge.lookahead_on)
`;
    const result = lintLookahead(source);
    expect(result.errorCount).toBe(2);
    expect(result.findings.map((f) => f.line)).toEqual([2, 3]);
  });
});

describe('lintLookahead — warnings', () => {
  it('warns on time-dependent identifiers with their line', () => {
    const source = `//@version=5
a = barstate.isrealtime
b = timenow
c = last_bar_index
`;
    const result = lintLookahead(source);

    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(3);
    expect(result.findings.map((f) => f.line)).toEqual([2, 3, 4]);
  });

  it('does not match a suspect token inside a longer identifier', () => {
    expect(lintLookahead('x = mytimenow + timenowish\n').warningCount).toBe(0);
  });

  it('warns on calc_on_every_tick = true but not on false', () => {
    expect(lintLookahead('strategy("s", calc_on_every_tick = true)\n').warningCount).toBe(1);
    expect(lintLookahead('strategy("s", calc_on_every_tick = false)\n').warningCount).toBe(0);
  });
});
