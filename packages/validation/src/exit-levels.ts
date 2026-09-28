/**
 * Stop and target levels, read from the engine's order log.
 *
 * The first version of the intrabar replay recovered levels by clustering exit prices: for a fixed
 * bracket every favourable exit sits one target-distance from its entry and every adverse one a
 * stop-distance. That works, and it is useless for most real strategies. An ATR stop, a percentage
 * stop, a swing-low stop or a trailing stop produces a different level on every trade, so the
 * clusters never form and the check reports `n/a` — precisely on the strategies whose stops are
 * worth checking.
 *
 * The order log already records every `strategy.exit` call with its arguments RESOLVED at that bar,
 * so an ATR expression arrives as a number. That is the authoritative source and this reads it.
 *
 * THREE THINGS THAT ARE EASY TO GET WRONG HERE:
 *
 *   1. `profit` and `loss` are distances in TICKS from the ENTRY price, while `limit` and `stop` are
 *      absolute prices. Mixing them up silently produces levels near zero.
 *   2. A level set on bar N applies from bar N+1. Pine runs a script at the bar's close, so the
 *      resting order it creates cannot be hit on the bar that created it. Applying it to bar N would
 *      let the replay trigger a stop before the strategy had asked for one.
 *   3. `strategy.exit` called every bar with the same id UPDATES the order rather than adding one.
 *      PineTS reports that as `noop` because `pending_orders` does not grow — so filtering the log
 *      to `placed` rows would discard every level update, which is the entire ATR case. Only our own
 *      `suppressed` rows are excluded.
 *
 * Pure. Takes the log as plain structural rows so `@edgelab/validation` needs no dependency on
 * `@edgelab/engine`, which it may not import.
 */

/** The shape of an order-log row this module needs. Structurally compatible with the engine's. */
export interface ExitOrderRow {
  readonly method: string;
  readonly bar: number;
  readonly outcome: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface ResolvedLevels {
  /** Absolute stop price, or null when the call set none. */
  readonly stop: number | null;
  /** Absolute target price, or null when the call set none. */
  readonly target: number | null;
  /**
   * True when the call carried any `trail_*` argument.
   *
   * A trailing stop's level depends on the path taken since it activated, so it is not a level at
   * all until simulated. Those trades are reported `n/a` explicitly rather than replayed against a
   * stale figure — a trailing stop replayed as a fixed one would manufacture flips.
   */
  readonly trailing: boolean;
  /** The bar whose call produced these levels, for reporting. */
  readonly setOnBar: number;
}

export interface LevelContext {
  readonly side: 'long' | 'short';
  readonly entryPrice: number;
  readonly mintick: number;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Resolve one `strategy.exit` call into absolute prices for a specific trade. */
export function resolveExitLevels(row: ExitOrderRow, ctx: LevelContext): ResolvedLevels {
  const a = row.args;

  const trailing =
    num(a['trail_price']) !== null ||
    num(a['trail_points']) !== null ||
    num(a['trail_offset']) !== null;

  // An absolute price wins over a tick distance when both are given, which is Pine's own behaviour.
  const stopPrice = num(a['stop']);
  const targetPrice = num(a['limit']);

  const lossTicks = num(a['loss']);
  const profitTicks = num(a['profit']);

  const away = ctx.side === 'long' ? 1 : -1;

  const stop =
    stopPrice ?? (lossTicks === null ? null : ctx.entryPrice - away * lossTicks * ctx.mintick);
  const target =
    targetPrice ??
    (profitTicks === null ? null : ctx.entryPrice + away * profitTicks * ctx.mintick);

  return { stop, target, trailing, setOnBar: row.bar };
}

/**
 * An index over the exit calls of a run, answering "which levels were in force on chart bar B".
 *
 * Levels are keyed by bar rather than by trade because `strategy.exit` describes the strategy's
 * intent at a moment, and a trade simply inherits whatever was in force while it was open. When a
 * script uses several exit ids the most recent call wins, which is a limitation worth knowing: a
 * two-bracket strategy would need per-id tracking, and this reports how many distinct ids it saw so
 * that case is visible rather than silent.
 */
export class ExitLevelIndex {
  private readonly rows: readonly ExitOrderRow[];
  readonly distinctIds: number;

  constructor(orderLog: readonly ExitOrderRow[]) {
    this.rows = orderLog
      .filter((r) => r.method === 'exit' && r.outcome !== 'suppressed')
      .slice()
      .sort((x, y) => x.bar - y.bar);

    this.distinctIds = new Set(
      this.rows.map((r) => (typeof r.args['id'] === 'string' ? r.args['id'] : '')),
    ).size;
  }

  get size(): number {
    return this.rows.length;
  }

  /**
   * The levels in force ON chart bar `bar`, i.e. the latest call made at or before `bar - 1`.
   *
   * `notBefore` is the trade's ENTRY bar, and it is not optional in spirit: a level expressed as an
   * absolute price is derived from `strategy.position_avg_price`, so a row from the PREVIOUS
   * position describes a completely different price. Without the bound, the entry bar of every
   * trade inherits the last trade's stop — which on an ATR fixture reported 56 of 102 exits as
   * missed stops, most of them against levels belonging to another position entirely.
   *
   * A tick-distance level is immune to this, because `profit`/`loss` are resolved against the
   * trade's own entry price. That is exactly why the bug was invisible on the fixed-bracket fixture
   * and reproduced its clustered baseline perfectly.
   *
   * Returns null before the strategy has armed a bracket for THIS trade, which is the honest answer
   * for the entry bar itself: the order is placed at that bar's close and cannot be hit on it.
   */
  levelsOnBar(bar: number, ctx: LevelContext, notBefore = -Infinity): ResolvedLevels | null {
    let found: ExitOrderRow | null = null;
    for (const row of this.rows) {
      if (row.bar > bar - 1) break;
      if (isPositionRelative(row) && row.bar < notBefore) continue;
      found = row;
    }
    return found === null ? null : resolveExitLevels(found, ctx);
  }
}

/**
 * Whether a call's levels only mean something for the position that was open when it was made.
 *
 * `stop` and `limit` are absolute prices, and a strategy computes them from
 * `strategy.position_avg_price` — so a row from the previous position is simply a different price.
 * `loss` and `profit` are distances in ticks, resolved here against THIS trade's entry, so they are
 * correct no matter which bar expressed them.
 *
 * The distinction matters both ways. Ignoring it reported 56 of 102 ATR exits as missed stops
 * against another position's levels; applying it to tick levels too then skipped the entry bar of
 * every fixed-bracket trade and turned unassessable trades into false phantom targets. Only the
 * absolute form needs the bound.
 */
function isPositionRelative(row: ExitOrderRow): boolean {
  return num(row.args['stop']) !== null || num(row.args['limit']) !== null;
}
