import type { OrderLogEntry, OrderOutcome } from '../pine-engine';
import { InstrumentationUnavailableError } from '../pine-engine';

/**
 * Intercepts strategy.* calls during a run, for two purposes:
 *   a) the order log — every call with bar, time and resolved arguments;
 *   b) the trading-window gate — suppress entry/order before a cutoff so indicators warm
 *      up on earlier bars without opening positions.
 *
 * Mechanism (verified by execution on pinets 0.9.34 and 0.10.0 — see
 * docs/pinets-notes.md section 5): `Context.pine.strategy` holds OWN, writable methods
 * assigned per Context instance, and the transpiled per-bar body destructures
 * `const { strategy } = $.pine` then calls `strategy.entry(...)` as a member expression
 * resolved at call time. Patching that object is therefore picked up. The Context is
 * created inside run(), so we enter via the cached `Indicator._prepared.fn`.
 *
 * Fidelity is asserted by a contract test: with the gate disabled, an instrumented run
 * must reproduce the pristine netprofit and plot series exactly.
 */

/** Positional argument order as implemented by the runtime. */
const SIGNATURES = {
  entry: [
    'id',
    'direction',
    'qty',
    'limit',
    'stop',
    'oca_name',
    'oca_type',
    'comment',
    'alert_message',
    'disable_alert',
  ],
  order: [
    'id',
    'direction',
    'qty',
    'limit',
    'stop',
    'oca_name',
    'oca_type',
    'comment',
    'alert_message',
    'disable_alert',
  ],
  exit: [
    'id',
    'from_entry',
    'qty',
    'qty_percent',
    'profit',
    'limit',
    'loss',
    'stop',
    'trail_price',
    'trail_points',
    'trail_offset',
    'oca_name',
    'comment',
    'comment_profit',
    'comment_loss',
    'comment_trailing',
    'alert_message',
    'alert_profit',
    'alert_loss',
    'alert_trailing',
    'disable_alert',
  ],
  close: ['id', 'comment', 'qty', 'qty_percent', 'alert_message', 'immediately', 'disable_alert'],
  close_all: ['comment', 'alert_message', 'immediately', 'disable_alert'],
  cancel: ['id', 'immediately'],
  cancel_all: [],
} as const;

export type StrategyMethod = keyof typeof SIGNATURES;

const METHODS = Object.keys(SIGNATURES) as StrategyMethod[];

/**
 * ONLY these are gated. An allowlist, never a denylist, so a method added by a future
 * pinets release cannot silently fall into the gated set.
 *
 * Deliberately excluded: exit/close/close_all/cancel must still be able to unwind a
 * position opened before the cutoff. And `any` is NOT in SIGNATURES at all because
 * `strategy.any()` is the strategy() DECLARATION, re-invoked every bar to rebuild config —
 * suppressing it destroys the run.
 */
const GATED: ReadonlySet<StrategyMethod> = new Set<StrategyMethod>(['entry', 'order']);

const PATCH_FLAG = '__edgelabInstrumented';

/** Minimal shape of the pinets objects we touch, so nothing else imports pinets. */
interface PreparedLike {
  fn: (ctx: unknown) => unknown;
}

interface IndicatorLike {
  prepare(): PreparedLike;
  _prepared?: PreparedLike;
}

interface PendingOrderLike {
  [key: string]: unknown;
}

interface ContextLike {
  idx: number;
  data?: { openTime?: unknown };
  pine?: { strategy?: Record<string, unknown> };
  strategy?: { pending_orders?: PendingOrderLike[] };
}

export interface InstrumentOptions {
  /**
   * Entries/orders before this time are suppressed. Compared against BAR TIME, not bar
   * index, so the cutoff is invariant under resampling. Omit to disable gating.
   */
  readonly tradingWindowStartMs?: number;
}

export interface Instrumentation {
  readonly orderLog: OrderLogEntry[];
  /** Calls suppressed by the gate. */
  suppressed(): number;
  /** Calls that went through but produced no order. */
  noops(): number;
}

/** Unwrap a pinets Series to its current value. */
function currentValue(v: unknown): unknown {
  if (v !== null && typeof v === 'object' && typeof (v as { get?: unknown }).get === 'function') {
    try {
      return (v as { get(i: number): unknown }).get(0);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * True when `v` looks like the runtime's named-arguments bag rather than a positional
 * value: a plain object that is not a Series and not an array.
 */
function isNamedArgBag(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  if (typeof (v as { get?: unknown }).get === 'function') return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Replay the runtime's own resolution rule: positional until the first named-args bag,
 * after which named keys win. Series are unwrapped to their current bar value so the log
 * records numbers rather than opaque objects.
 */
export function resolveArgs(
  method: StrategyMethod,
  args: readonly unknown[],
): Record<string, unknown> {
  const names = SIGNATURES[method] as readonly string[];
  const out: Record<string, unknown> = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (isNamedArgBag(arg)) {
      for (const [k, v] of Object.entries(arg)) {
        if (k.startsWith('__')) continue; // internal sentinels such as __callsiteId
        out[k] = currentValue(v);
      }
      continue;
    }
    const name = names[i];
    if (name === undefined) continue;
    out[name] = currentValue(arg);
  }

  return out;
}

/**
 * Install interception on `indicator`, returning the live order log.
 *
 * Throws InstrumentationUnavailableError rather than degrading if the seam is missing —
 * a silent failure here would produce a backtest that ignores the warmup cutoff and
 * reports an empty order log while still looking plausible.
 */
export function instrument(indicator: unknown, options: InstrumentOptions = {}): Instrumentation {
  const ind = indicator as IndicatorLike;

  if (typeof ind?.prepare !== 'function') {
    throw new InstrumentationUnavailableError('Indicator.prepare is not a function');
  }

  const prepared = ind.prepare();
  if (typeof prepared?.fn !== 'function') {
    throw new InstrumentationUnavailableError('prepare() returned no fn');
  }
  if (ind._prepared === undefined || ind._prepared.fn !== prepared.fn) {
    // If prepare() stopped returning the cached object by reference, mutating it would
    // no longer reach the runtime and the gate would silently stop applying.
    throw new InstrumentationUnavailableError(
      'prepare() did not return the cached _prepared object by reference',
    );
  }

  const orderLog: OrderLogEntry[] = [];
  const cutoff = options.tradingWindowStartMs;
  const userFn = prepared.fn;

  // Sync, not async: returning a Promise the runtime ignores would make ctx.result a
  // Promise. Verified that both work, but sync is the honest shape.
  const wrapper = (rawCtx: unknown): unknown => {
    const ctx = rawCtx as ContextLike;
    const ns = ctx?.pine?.strategy;

    if (ns !== undefined && ns[PATCH_FLAG] !== true) {
      Object.defineProperty(ns, PATCH_FLAG, { value: true, enumerable: false });

      for (const method of METHODS) {
        const original = ns[method];
        if (typeof original !== 'function') continue;
        const fn = original as (...a: unknown[]) => unknown;

        ns[method] = function patched(this: unknown, ...args: unknown[]): unknown {
          const time = currentValue(ctx.data?.openTime);
          const timeMs = typeof time === 'number' ? time : null;

          const gate =
            cutoff !== undefined && GATED.has(method) && timeMs !== null && timeMs < cutoff;

          // Clone for the log BEFORE calling through, and pass args on unmutated.
          const loggedArgs = resolveArgs(method, args);

          if (gate) {
            orderLog.push({
              method,
              bar: ctx.idx,
              time: timeMs,
              outcome: 'suppressed',
              args: loggedArgs,
              resolved: null,
            });
            return undefined;
          }

          const before = ctx.strategy?.pending_orders?.length ?? 0;
          const returned = fn.apply(this, args);
          const pending = ctx.strategy?.pending_orders ?? [];

          // The runtime keeps no call log and prunes pending_orders, so diffing it is the
          // only way to tell "placed" from "silently dropped" (pyramiding cap, margin).
          const placed = pending.length > before;
          const outcome: OrderOutcome = placed ? 'placed' : 'noop';
          const tail = placed ? pending[pending.length - 1] : undefined;

          orderLog.push({
            method,
            bar: ctx.idx,
            time: timeMs,
            outcome,
            args: loggedArgs,
            resolved: tail === undefined ? null : { ...tail },
          });

          return returned;
        };
      }
    }

    return userFn(rawCtx);
  };

  ind._prepared.fn = wrapper;

  return {
    orderLog,
    suppressed: () => orderLog.filter((r) => r.outcome === 'suppressed').length,
    noops: () => orderLog.filter((r) => r.outcome === 'noop').length,
  };
}
