/**
 * Pine fixtures the validation suite owns.
 *
 * They live HERE, not in `packages/engine`, for a dependency reason: engine and validation are
 * siblings — `shared` <- `data`/`metrics` <- `engine`/`validation` <- apps — so validation cannot
 * import the engine's fixture list, and a test that did so only worked because the test runner
 * aliases packages to source. An app wires the two together.
 *
 * They are also deliberately not in the Studio's example dropdown: a script whose whole purpose is
 * to cheat is not an example anyone should run by accident.
 */

export interface ValidationFixture {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
}

/**
 * DELIBERATELY LEAKY. Spec 06's DONE WHEN fixture.
 *
 * `lookahead_on` with no `[1]` offset makes `request.security` return the H4 bar's FINAL value on
 * every chart bar inside that bar — including the ones before it closed. The strategy therefore
 * knows where the next four hours end before trading them, which is not a subtle bias: it is the
 * future, handed over for free.
 *
 * Kept as a fixture because a validation suite that has never seen a real leak is untested. The
 * line number below is asserted, so do not reformat this block without updating the tests.
 */
const LOOKAHEAD_LEAK = `//@version=5
strategy("Look-ahead leak", overlay=true, initial_capital=10000,
     default_qty_type=strategy.fixed, default_qty_value=1)

htf = input.timeframe("240", "Leaky timeframe")

// THE LEAK: lookahead_on and no [1]. Returns the H4 close before the H4 bar has closed.
htfClose = request.security(syminfo.tickerid, htf, close, lookahead=barmerge.lookahead_on)

if close < htfClose
    strategy.entry("Long", strategy.long)

if close > htfClose
    strategy.entry("Short", strategy.short)
`;

/**
 * The clean twin of LOOKAHEAD_LEAK: identical logic, `lookahead_off` and `[1]`.
 *
 * Its job is to prove the check discriminates. A look-ahead test that fails the leaky script but
 * also fails this one has found nothing — it is just pessimistic about `request.security`.
 */
const LOOKAHEAD_OFF = `//@version=5
strategy("Look-ahead off", overlay=true, initial_capital=10000,
     default_qty_type=strategy.fixed, default_qty_value=1)

htf = input.timeframe("240", "Trend timeframe")

// Non-repainting: lookahead_off AND [1], so only a CLOSED H4 bar is ever read.
htfClose = request.security(syminfo.tickerid, htf, close[1], lookahead=barmerge.lookahead_off)

if close < htfClose
    strategy.entry("Long", strategy.long)

if close > htfClose
    strategy.entry("Short", strategy.short)
`;

export const VALIDATION_FIXTURES: readonly ValidationFixture[] = [
  {
    id: 'lookahead-leak',
    name: 'Look-ahead leak (deliberately broken)',
    description: 'request.security with lookahead_on and no [1]. Must FAIL the look-ahead check.',
    source: LOOKAHEAD_LEAK,
  },
  {
    id: 'lookahead-off',
    name: 'Look-ahead off (clean twin)',
    description: 'Identical logic with lookahead_off and [1]. Must PASS the look-ahead check.',
    source: LOOKAHEAD_OFF,
  },
];

export function getValidationFixture(id: string): ValidationFixture {
  const f = VALIDATION_FIXTURES.find((x) => x.id === id);
  if (f === undefined) throw new Error(`Unknown validation fixture: ${id}`);
  return f;
}
