/**
 * Intercepts `request.security` during a run, recording what each call returned on each chart
 * bar. This is the evidence the look-ahead causality check reasons over (amendment A1a).
 *
 * Mechanism, verified by probe against pinets 0.9.34: `ctx.pine.request` holds `security` as an
 * OWN, WRITABLE property, so assigning over it is picked up — the same seam `instrument.ts` uses
 * for `strategy.*`. A patch installed this way was called once per chart bar across a 234-bar run.
 *
 * WHAT THE SEAM DOES NOT GIVE US. The call returns a Promise resolving to a plain number, with no
 * bucket identity attached; `request._cache` exposes no enumerable keys; and `request.context` is
 * the CHART context, not the secondary one — it reports `isSecondaryContext: false` and its `idx`
 * tracks the chart bar exactly. So interception establishes WHEN a call happened and WHAT it
 * returned, and the caller attributes that value to a bucket by matching it against the HTF series
 * (see `lookahead.ts`). That split is deliberate: the fragile part — which value the script
 * actually saw — is observed rather than re-derived, so it cannot drift from the real run.
 */

/** One `request.security` call, as observed. */
export interface SecurityCall {
  /** Chart bar index the call was made on. */
  readonly bar: number;
  /** Chart bar OPEN time, UTC ms. */
  readonly barTime: number;
  /** Requested symbol, as the script wrote it. */
  readonly symbol: string;
  /** Requested timeframe, in Pine's own notation ("60", "D", …). */
  readonly timeframe: string;
  /**
   * Whether the call asked for `lookahead_on`, as written. A static fact about the call site —
   * the causality check tests behaviour, not this, but it makes a finding far easier to explain.
   */
  readonly lookaheadOn: boolean;
  /** Value the call returned, once resolved. Null when it was not a finite number. */
  readonly value: number | null;
  /** Call site ordinal within the bar, so two different securities on one bar stay distinct. */
  readonly callIndex: number;
}

export interface SecurityLog {
  readonly calls: SecurityCall[];
  /** Resolves once every intercepted Promise has settled. */
  settle(): Promise<void>;
  /** True when the seam was installed. False means the check must report `n/a`, not "clean". */
  installed(): boolean;
}

interface RequestNamespace {
  security?: unknown;
  [key: string]: unknown;
}

interface ContextLike {
  idx: number;
  data?: { openTime?: unknown };
  pine?: { request?: RequestNamespace };
}

const PATCH_FLAG = '__edgelabSecurityPatched';

/** Positional order of `request.security`, as the runtime implements it. */
const POSITIONAL = ['symbol', 'timeframe', 'expression', 'gaps', 'lookahead'] as const;

/**
 * Install the interceptor into a prepared indicator.
 *
 * Follows the same rules as `instrument.ts`: patch inside a wrapper around `_prepared.fn`, because
 * the Context does not exist until `run()` creates it, and guard with a flag so a re-entrant call
 * does not double-wrap.
 */
export function interceptSecurity(preparedFn: (ctx: unknown) => unknown): {
  wrapped: (ctx: unknown) => unknown;
  log: SecurityLog;
} {
  const calls: SecurityCall[] = [];
  const pending: Promise<void>[] = [];
  let didInstall = false;
  let barOfLastCall = -1;
  let callIndexInBar = 0;

  const wrapped = (rawCtx: unknown): unknown => {
    const ctx = rawCtx as ContextLike;
    const ns = ctx.pine?.request;

    if (ns !== undefined && ns[PATCH_FLAG] !== true && typeof ns.security === 'function') {
      Object.defineProperty(ns, PATCH_FLAG, { value: true, enumerable: false });
      didInstall = true;

      const original = ns.security as (...args: unknown[]) => unknown;

      ns.security = function patched(this: unknown, ...args: unknown[]): unknown {
        const resolved = resolveSecurityArgs(args);
        const barTime = currentValue(ctx.data?.openTime);
        const bar = ctx.idx;

        if (bar !== barOfLastCall) {
          barOfLastCall = bar;
          callIndexInBar = 0;
        }
        const callIndex = callIndexInBar;
        callIndexInBar += 1;

        const returned = original.apply(this, args);

        const record = (value: unknown): void => {
          calls.push({
            bar,
            barTime: typeof barTime === 'number' ? barTime : 0,
            symbol: String(resolved.symbol ?? ''),
            timeframe: String(resolved.timeframe ?? ''),
            lookaheadOn: isLookaheadOn(resolved.lookahead),
            value: typeof value === 'number' && Number.isFinite(value) ? value : null,
            callIndex,
          });
        };

        // The call is async, so the value is recorded when it settles. The run cannot finish
        // before these resolve — the script awaits them — but `settle()` makes that explicit
        // rather than relying on ordering.
        if (isPromise(returned)) {
          pending.push(
            returned.then(record, () => {
              record(null);
            }),
          );
        } else {
          record(currentValue(returned));
        }

        return returned;
      };
    }

    return preparedFn(rawCtx);
  };

  return {
    wrapped,
    log: {
      calls,
      settle: async () => {
        await Promise.all(pending);
      },
      installed: () => didInstall,
    },
  };
}

/* ------------------------------------------------------------------ helpers */

function isPromise(v: unknown): v is Promise<unknown> {
  return (
    v !== null && typeof v === 'object' && typeof (v as { then?: unknown }).then === 'function'
  );
}

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

function isNamedArgBag(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  if (typeof (v as { get?: unknown }).get === 'function') return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Replay the runtime's argument resolution: positional until the first named-args bag, after which
 * named keys win. Mirrors `resolveArgs` in instrument.ts, for the same reason — the log has to
 * record what the runtime saw, not what the signature suggests.
 */
export function resolveSecurityArgs(args: readonly unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (isNamedArgBag(arg)) {
      for (const [k, v] of Object.entries(arg)) {
        if (k.startsWith('__')) continue;
        out[k] = currentValue(v);
      }
      continue;
    }
    const name = POSITIONAL[i];
    // `expression` is a live Series whose current value is meaningless out of context, and the
    // log has no use for it — the RETURNED value is what matters.
    if (name !== undefined && name !== 'expression') out[name] = currentValue(arg);
  }

  return out;
}

/**
 * Whether a `lookahead` argument asks for lookahead_on.
 *
 * The runtime represents the barmerge constants as numbers, but a script can also pass the
 * constant through a variable, so both the numeric and the string spelling are accepted. Anything
 * unrecognised is treated as OFF, which is the conservative reading: it makes the causality check
 * scrutinise the call rather than excuse it.
 */
export function isLookaheadOn(value: unknown): boolean {
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') return value.includes('lookahead_on');
  return false;
}
