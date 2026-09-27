# PineTS notes — verified behaviour, limitations and divergences

Reference for the Pine engine adapter. **Everything here was verified** either by reading the
installed package source or by executing probes against it. Anything unverified is in the
[Open questions](#open-questions) section and is labelled as such — nothing in this document is
inferred from a tutorial.

- Package: [`pinets`](https://www.npmjs.com/package/pinets) — **pinned to `0.9.34` exactly**
- Licence: **AGPL-3.0-only**
- Docs: <https://docs.luxalgo.com/developers/pinets> (note: `www.luxalgo.com/developers/*` 404s)
- Machine-readable docs: <https://docs.luxalgo.com/llms-full.txt> — the source of truth for a
  build-time compatibility table
- Verified against: `0.9.34` and `0.10.0` side by side

---

## 1. Why 0.9.34 and not 0.10.0

Pinned **exact, no caret**, because this publisher ships behaviour changes inside patch releases
(`color.blue` hex changed, `ta.range` na-window semantics, input-override precedence). A caret on a
`0.x` package admits all of those.

Every capability this project needs works **identically** on 0.9.34 and 0.10.0 — instrumentation of
all six strategy primitives, the warmup gate, direct `IProvider` serving, and inputs/props overrides
were all executed on both and produced byte-identical results.

The decisive difference is an **ingestion regression**, not a missing feature:

> **0.10.0 enforces a 4-column indentation rule and rejects Pine indented with 2, 3 or 8 spaces.**
> 0.9.34 transpiles 2-, 3-, 4-, 8-space and tab variants with identical output
> (`closed=1, netprofit=11.0000` in every case).

For a tool whose primary input is Pine pasted from arbitrary sources, that is a hard blocker.
0.10.0's only new public surface is the footprint/order-flow API, which we do not use.

**The upgrade path stays open** — 0.10.0 removed and renamed zero exports. To keep it cheap:

1. Key input overrides on `varId`, with `id` as fallback (0.10.x adds `in_N` ids).
2. Never construct `IPineInput` literals in fixtures (0.10.0 makes `id` and `name` required).
3. If we ever upgrade, normalise script indentation to 4 spaces at save time.

---

## 2. Entry points (verified)

```ts
new PineTS(
  source: IProvider | any[],
  tickerId?: string,
  timeframe?: string,
  limit?: number,
  sDate?: number,   // epoch ms
  eDate?: number,   // epoch ms
)

await pine.run(code: Indicator | Function | String, periods?: number): Promise<Context>
```

**Mode is chosen by the runtime TYPE of the first argument — there is no flag or option:**

| Argument    | Mode                                                           |
| ----------- | -------------------------------------------------------------- |
| `String`    | native Pine transpile (what we use)                            |
| `Function`  | PineTS JS DSL                                                  |
| `Indicator` | wrapper over either, and the only way to override inputs/props |

`run()` is async and returns a `Context`. Passing a truthy **third** argument silently switches the
return type to an `AsyncGenerator` — guard any optional `pageSize` plumbing.

Constructor precedence: date range wins over `limit`; neither means the provider default.

### The 5000-bar cap does not apply to us

The docs state a "maximum limit is **5000 candles** (hard cap)". **Measured: it is not enforced by the
runtime** — it is a limit of the bundled Binance provider's fetch. With a custom provider:

| scenario                      | supplied | processed     |
| ----------------------------- | -------- | ------------- |
| `limit=6000`                  | 6,000    | 6,000 (full)  |
| `limit=12000`                 | 12,000   | 12,000 (full) |
| date range, `limit=undefined` | 12,000   | 12,000 (full) |
| raw array source              | 12,000   | 12,000 (full) |

---

## 3. Provider contract — implement `IProvider` directly

`IProvider` is only three methods, and **PineTS only ever calls the first two**:

```ts
getMarketData(tickerId: string, timeframe: string, limit?: number, sDate?: number, eDate?: number): Promise<Kline[]>
getSymbolInfo(tickerId: string): Promise<ISymbolInfo>
configure(config: any): void
```

**The runtime never aggregates timeframes itself.** Aggregation lives only inside `BaseProvider`, and
only for a timeframe your `getSupportedTimeframes()` omits. Implementing `IProvider` directly makes
that code path unreachable, so **our resampler owns alignment completely** — which is what the spec
requires.

`request.security` is not special: it calls **the same `getMarketData`** with the higher timeframe as
the `timeframe` argument. Verified by execution — a run with `request.security(…, "240", …)` produced
exactly two provider calls: `('TEST','60',80,…)` for the chart and `('TEST','240',undefined,…)` for
the security call. No aggregation was attempted.

### Load-bearing rules

- **Times are epoch MILLISECONDS.** Postgres `extract(epoch from …)` returns **seconds** — multiply by
  1000 or every timestamp is silently 1000x wrong.
- Return **ascending** by `openTime`. `limit` means the **last N bars ending at `eDate`**, so select
  `DESC` in a subquery and re-sort `ASC`.
- Emit **all 12 `Kline` fields**, using `0` (not `undefined`) for
  `quoteAssetVolume`/`numberOfTrades`/`takerBuy*`/`ignore`.
- **`closeTime` must be the SESSION CLOSE** (TradingView's `time_close`), not `openTime + duration`,
  for anything that is not 24/7. Use the exported `computeSessionClose(openTimeMs, session, timezone,
periodType, multiplier)`. Do **not** use `normalizeCloseTime()` — it is 24/7-only and mutates in
  place. `closeTime` drives bar→HTF mapping and `barstate.isrealtime`.
- Implementing `IProvider` directly means we receive the **raw** timeframe string with no
  normalisation, and we own the `;heikinashi` ticker modifier. **Case matters: `'1M'` is a month,
  `'1m'` is a minute.**
- Treat `sDate` as an **inclusive** lower bound (`>=`) and re-serve the forming bar, or the live/tail
  path never updates.
- `request.security` passes `sDate = firstChartBar − 30 days`. With `calc_bars_count` set it can pass
  `sDate = undefined`, which against a large hypertable is an unbounded scan — **enforce a server-side
  floor.**

`ISymbolInfo` has ~40 fields and **none are optional in TypeScript**, so all must be supplied. The ones
that matter to us: `mintick`, `pointvalue`, `minmove`, `pricescale`, `currency`, `basecurrency`,
`timezone`, `session`, `type`, `ticker`, `tickerid`.

---

## 4. Inputs and run-parameter overrides

```ts
const ind = Indicator.from(source);

// READ (drives the settings form)
ind.getDeclarationType(); // 'strategy' | 'indicator' | null
ind.getInputsMeta(); // IPineInput[]
ind.getPropsMeta(); // IPineProp[] — carries `mutable`
ind.usesVisibleRange();

// OVERRIDE — before run()
ind.input['length'] = 50; // key by varId
ind.prop['initial_capital'] = 75000; // key by declaration ARG NAME
ind.prop['commission_type'] = 'cash_per_order'; // bare string, NOT strategy.commission.*
```

- **Key inputs on `varId`, not title.** Duplicate titles alias only the first input, and an empty
  title is addressable only by `varId`.
- Containers are **frozen** — mutate individual keys; whole-object assignment throws.
- Writes are validated **eagerly and throw synchronously at assignment**, not at run. Wrap
  user-supplied overrides in `try/catch` and surface `[Indicator.input]` / `[Indicator.prop]` messages
  as **settings-validation errors, never as compile diagnostics**.
- `title`/`shorttitle` are `mutable: false` and throw a **misleading `unknown key`** error.
- `step` may be **absent** from the emitted meta when the script declares no explicit step — do not
  rely on it for UI sliders without a fallback.
- JS-function sources return `getInputsMeta() === []` and any `.input` write throws; only `.prop` works.

`INDICATOR_PROPS` (17 entries) and `STRATEGY_PROPS` (33) are exported for building a form before any
script exists.

### Overrides must be applied BEFORE the first `prepare()`

**Found the hard way — this silently ignored every override.** `prepare()` is idempotent and caches
`PreparedScript.inputs`, built from the input values _current at that moment_. `run()` uses that cached
map. So this order is wrong:

```ts
ind.prepare(); // bakes in the DEFAULTS
ind.input['fastLen'] = 3; // too late — silently ignored
await pine.run(ind);
```

and this order is correct:

```ts
ind.input['fastLen'] = 3; // the `.input` proxy scans lazily, so this is safe pre-prepare
ind.prepare();
await pine.run(ind);
```

The failure mode is nasty: no error, no warning, a perfectly successful run — using the defaults. Our
regression test compares the **whole plot series** between a default and an overridden run rather than
the first emitted value, because an EMA is seeded from the first close and therefore has an _identical_
`point[0]` for every length. A first-value comparison passes while the override does nothing.

---

## 5. The instrumentation seam

**Verdict: interception works, and `patch-package` is NOT required.**

`Context.pine` is a public mutable namespace bag whose `strategy` methods are **own, writable,
configurable properties assigned per-instance** by closure factories — not prototype methods and not a
module singleton. The transpiler emits `const { ta, strategy, … } = $.pine;` as the first statement of
the per-bar function and calls `strategy.entry(...)` as a member expression **resolved at call time**,
and that body re-executes every bar. So patching the object is picked up.

The only obstacle is that the `Context` is created _inside_ `run()`, so we need a pre-execution hook.
That hook is the cached `Indicator._prepared.fn`:

```ts
const prepared = ind.prepare(); // idempotent, caches on ind._prepared
const userFn = prepared.fn;
ind._prepared.fn = async (ctx) => {
  patchStrategyNamespace(ctx.pine.strategy); // once, guarded by a non-enumerable flag
  return userFn(ctx);
};
```

**Fidelity is proven**: an instrumented run with gating disabled reproduced the pristine
`run(src)` netprofit exactly (`-103.78103439885072` both) with a byte-identical EMA series.

### Rules that are not optional

- **Gate via an allowlist of exactly `['entry','order']`** — never a denylist.
- **Never gate `strategy.any()`.** That is the `strategy()` _declaration_, re-invoked every bar to
  rebuild config; suppressing it destroys the run.
- Do not gate `exit`/`close`/`close_all`/`cancel` — they must be able to unwind positions opened
  before the cutoff.
- Compare against **bar time** (`ctx.data.openTime` unwrapped), not bar index, so the cutoff is
  invariant under resampling.
- Pass the args array through **unmutated** to `orig.apply(this, args)`; clone before logging.
- **Expect the first fill one bar after the cutoff.** `processStrategyOrders` runs at the _start_ of
  each bar, so an entry admitted on bar N fills at bar N+1's open. This is correct engine behaviour —
  do not "fix" it.

### Warmup is genuinely preserved

Verified with EMA(30) over 60 bars, cutoff at bar 40: gating suppressed 5/60 calls and changed closed
trades 13 → 8 and netprofit `-103.78` → `-80.99`, while the **EMA series was identical on every bar
including all pre-cutoff bars** (`EMA@bar29 = 106.7626816563` in both). Indicator state accumulates in
`ctx.taState`, independent of the strategy namespace.

### `_prepared` is a private field — mitigations are mandatory

A future release could rename it under minification and **silently** break order logging and the gate
while still returning plausible fills. Therefore:

1. Exact version pin + committed lockfile (the field is verified present in both 0.9.34 and 0.10.0).
2. A startup assertion that **fails loudly**: after `prepare()`, assert
   `typeof ind._prepared?.fn === 'function'` and refuse to run if absent.
3. A CI contract test asserting that **enabling the gate changes netprofit** — a shape assertion alone
   would not catch a silent break.
4. Keep `pine.runPretranspiled(wrapper, prepared.inputs)` as the public-API fallback (costs: does not
   set `_usesVisibleRange`, sets `context.pineTSCode = null`, no streaming equivalent).
5. Isolate the seam in **one** adapter module.

### Argument signatures (positional order, as implemented)

| method            | args                                                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entry` / `order` | `id, direction, qty, limit, stop, oca_name, oca_type, comment, alert_message, disable_alert`                                                                                                                                                      |
| `exit`            | `id, from_entry, qty, qty_percent, profit, limit, loss, stop, trail_price, trail_points, trail_offset, oca_name, comment, comment_profit, comment_loss, comment_trailing, alert_message, alert_profit, alert_loss, alert_trailing, disable_alert` |
| `close`           | `id, comment, qty, qty_percent, alert_message, immediately, disable_alert`                                                                                                                                                                        |
| `close_all`       | `comment, alert_message, immediately, disable_alert`                                                                                                                                                                                              |
| `cancel`          | `id, immediately`                                                                                                                                                                                                                                 |
| `cancel_all`      | —                                                                                                                                                                                                                                                 |

Arg resolution replays the runtime's rule: **positional until the first plain non-Series object**,
which is the named-args bag (named wins). Unwrap `Series` with `.get(0)`.

---

## 6. Reading results

`ctx.strategy` is a `StrategyState` (undefined for indicators).

```ts
ctx.strategy.closedtrades: Trade[]   // append-only, durable
ctx.strategy.opentrades:   Trade[]
ctx.strategy.pending_orders: Order[] // PRUNED — filled/cancelled are removed
```

`Trade` maps essentially 1:1 onto our `RunResult.trades[]`:

| PineTS                                                                 | ours                                  |
| ---------------------------------------------------------------------- | ------------------------------------- |
| `id`, `entry_id`                                                       | `id`, `entryId`                       |
| `entry_price`, `entry_bar_index`, `entry_time`                         | `entryPrice`, `entryBar`, `entryTime` |
| `exit_price`, `exit_bar_index`, `exit_time`, `exit_id`, `exit_comment` | `exit*`                               |
| `size` (**signed**: + long, − short)                                   | `side` + `qty`                        |
| `profit`, `commission`, `max_runup`, `max_drawdown`, `status`          | same                                  |

- Times are **epoch ms**.
- `profit` / `commission` / `max_drawdown` / `max_runup` are **optional and `undefined` while a trade
  is open** — treat `undefined` as _open_, **never as break-even 0**.
- `size` is signed, so **use `Math.abs` when aggregating** or longs net against shorts.
- There are **no `*_percent` fields** on `Trade`; compute percentages ourselves.
- `_bracket_entry` is internal — do not read it. It exists because `entry_price` is the _ledger_ value
  and can be swapped by FIFO entry/exit pairing (a TradingView ledger convention).

### The order log must be reconstructed, not read

**The runtime keeps no record of order calls.** `pending_orders` is pruned, the internal ledger queue
is drained in place, and `closedtrades` records only fills. Orders killed by the pyramiding cap, by
margin rejection, or created as `'stop-limit'` (which has no fill case and can never fill) leave
**zero trace anywhere**.

Measured: with default pyramiding, **9 of 11 `strategy.entry` calls became complete no-ops**. Logging
requested args alone would report 11 entries where the engine placed 2.

So per intercepted call, record the requested args **and** diff `ctx.strategy.pending_orders.length`
around the call-through, capturing the new tail. Persist a three-way status:

- `suppressed` — our warmup gate stopped it
- `noop` — called through, but no order appeared (pyramiding, margin, …)
- `placed` — resolved order captured (true qty after `default_qty_type`/`default_qty_value`)

`resolved` is not meaningful for `exit`, which pushes a bracket order with `dir=0, qty=0`.

Also available: `ctx.warnings[{message, method, bar}]`, `ctx.alerts[]`, `ctx.plots` (keyed by plot
title; duplicate titles get a fragile `#N` suffix).

### `ctx.plots` shape, and NaN

```
ctx.plots['<title>'] = {
  data: [{ title, time, value, options: { color } }, …],  // ASCENDING, one point per bar
  options, title, _plotKey, _callsiteId
}
```

Plus drawing collections under `__labels__`, `__lines__`, `__boxes__`, `__linefills__`,
`__polylines__`, `__tables__` — **filter any `__`-prefixed key out**, they are not plots.

**`value` is `na` as either `null` OR `NaN`.** `value ?? null` does not catch NaN, so NaN leaks
straight through to the chart and every downstream calculation. Normalise with
`Number.isFinite(v) ? v : null`.

### A provider must NEVER throw

PineTS calls the provider from inside `request.security` **during bar execution**. A rejection there
escapes as an **unhandled rejection** — it never reaches the `run()` promise, so the run either appears
to succeed with missing data or takes the process down. Verified by test.

So the provider records errors and returns `[]`, and the adapter re-raises them after `run()` resolves.
That is what keeps "a bad script never crashes the worker" true.

---

## 7. Performance (measured)

EMA-cross strategy with entries, deterministic random walk, single thread, Node 26:

| bars      | run    | bars/sec | closed trades | heap   |
| --------- | ------ | -------- | ------------- | ------ |
| 100,000   | 1.06 s | 94,073   | 3,516         | 92 MB  |
| 500,000   | 5.04 s | 99,206   | 17,491        | 205 MB |
| 1,000,000 | 11.9 s | 83,998   | 34,990        | 233 MB |

Roughly **~90,000 bars/sec**, scaling linearly, with no bar cap.

Implications: 60 s ≈ 5M bars, so the 120 s run timeout is generous and almost no realistic request
will hit it. The UI should warn above **~4M bars** (≈45 s at the measured rate). Memory is the
tighter constraint at 1M+ bars, not time.

Also relevant: `setMaxLoops(n)` (default 500,000) mirrors TradingView's loop protection and throws on
overrun — use it as a runaway-script guard.

---

## 8. Limitations and divergences from TradingView

This section drives the editor's **Compatibility panel**. Build the table from
`https://docs.luxalgo.com/llms-full.txt` at build time, applying these corrections.

### Reading the coverage docs correctly

- **An empty status cell means NOT IMPLEMENTED.** There is exactly one ❌ in the entire doc set
  (`str.format_time`). A scraper that only looks for ❌ will mark ~60 unimplemented functions as
  supported.
- **Absence from a table is neither support nor non-support** — the tables are curated, not generated.
  Give these a distinct **`undocumented`** state: `varip`, `calc_on_every_tick`, `calc_bars_count`, bar
  magnifier, UDT method declarations, `import`/`export`/`library`.
- **Exclude `/api-coverage/others`** — it is stale and wrong (falsely marks `alert()`,
  `alertcondition()`, `indicator()`, `fill()`, `fixnan()`, `float()` and all 13 date/time + timeframe
  functions unimplemented; ~19 false negatives).
- **Trust per-namespace pages over `/api-coverage/builtin`**, which wrongly marks `strategy()`
  unimplemented.
- `lang-coverage` and the Syntax Guide **contradict each other** on `while` and `switch`. We feed
  **native Pine strings**, so trust `lang-coverage`: `while` missing, `for…in` missing, `switch`
  untested.

### Known unimplemented (blank-cell list)

`array.new_box/new_color/new_label/new_line/new_linefill/new_table`, `ask`, `bid`, `library()`,
`max_bars_back()`, `runtime.error()`, `label.set_text_font_family()`, `label.set_text_formatting()`,
`math.todegrees()`, `math.toradians()`, **all 8 non-security `request.*`**, **all 9 `session.*`**,
`str.split()`, `str.substring()`, `syminfo.prefix()`, `syminfo.ticker()`,
`table.cell_set_text_formatting()`, `table()`.

### "Constant is ✅" does not mean the feature works

- **OCA groups**: `strategy.oca.cancel/none/reduce` are all ✅, but **sibling cancel/reduce is not
  enforced by the engine** ("Deferred Phase 7"). This is exactly the case the spec calls out — warn on
  any script using `oca_name`/`oca_type`.
- `barmerge.lookahead_on` is ✅ but lookahead semantics are undocumented and untested.
- `dividends.*`/`earnings.*` constants are ✅ while `request.dividends()`/`request.earnings()` are
  unimplemented.
- `ticker.renko()/kagi()/linebreak()/pointfigure()` are ✅ but **return the plain symbol**, so requests
  silently resolve to standard data.

### Silent wrong answers (warn loudly)

- **Nested `request.security()` does not error** — the second level "returns the expression directly
  instead of creating a tertiary context".
- **28 constants have string values differing from TradingView** (all `shape.*`, `location.*`,
  `xloc.*`, `yloc.*`, `font.family_*`, `text.align_*`/`wrap_*`). Anything doing `str.tostring()` on or
  string-comparing them diverges even though both sides are "implemented".
- **Heikin Ashi is a documented no-op** with the bundled providers — the `;heikinashi` modifier is
  stripped at the provider boundary, so "the chart reports Heikin Ashi but runs on standard data". Our
  `DbProvider` owns this modifier and must either honour it or reject it explicitly.
- `chart.left_visible_bar_time`/`right_visible_bar_time` default to the full loaded range unless the
  host calls `setVisibleRange()`.

### Five declared `strategy()` properties are accepted and IGNORED

Found while writing the hand-verified fill tests (step 2 of slice A), and verified in the
installed bundle rather than inferred from the docs. Each name appears **only** in the
declaration-schema table and the defaults object; none is read anywhere in the order-fill path.

| property                          | what PineTS does instead                                               |
| --------------------------------- | ---------------------------------------------------------------------- |
| `process_orders_on_close`         | always fills at the **next bar's open**                                |
| `calc_on_order_fills`             | evaluates once per bar; no post-fill re-evaluation                     |
| `calc_on_every_tick`              | no tick stream exists, so nothing changes                              |
| `backtest_fill_limits_assumption` | fills a limit the instant the range touches it, 0 ticks of penetration |
| `close_entries_rule`              | FIFO unconditionally; `"ANY"` is not honoured                          |

The fill path is a single unconditional branch:

```js
// paraphrased from dist/pinets.min.cjs, function hh()
if (order.status !== 'pending' || order.category === 'exit' || order.bar >= ctx.idx) continue;
switch (order.type) {
  case 'market':
    filled = true;
    fillPrice = open[0]; // ALWAYS the current bar's open, and order.bar < ctx.idx
    break;
```

`order.bar >= ctx.idx → continue` is what makes same-bar execution impossible: an order can only
fill on a bar strictly later than the one it was placed on.

**Why this matters more than it looks.** `process_orders_on_close=true` is common in published
strategies, and being ignored shifts _every_ fill one bar later. On the hand-verified table in
`fills.test.ts` the same script nets 0.0000 on TradingView and 0.0020 here — not a rounding
difference, a different answer.

`compile()` therefore emits an `ignored-strategy-prop` **warning** for each of these when set to
a non-default value (`packages/engine/src/pinets/compat.ts`). Setting one to the value PineTS
already behaves as is not flagged.

### Numeric fidelity is a separate warning tier

**18 of 31 TradingView strategy oracle scripts do not match TV within eps 0.001001.** Six named
divergences: `margin_liquidation_price`, `convert_to_account`/`convert_to_symbol`, OCA enforcement,
commission rounding, per-trade `max_drawdown`/`max_runup`, and `sharpe`/`sortino` (~2 decimals).

Treat this as a distinct tier from "unsupported API": the script runs and produces numbers, they are
just not bit-identical to TradingView.

Native Pine execution is officially **experimental** — phrase warnings as "may fail", not "will fail".

### Our own currency note

PineTS's currency conversion is a passthrough, which is why the spec has us run the engine in the
instrument's **quote currency** and convert P&L to the account currency in the reporting layer.

---

## Open questions

Unverified. Do not rely on any of these without testing first.

1. **`strategy.*` inside `request.security_lower_tf`** runs truncated bodies on a _secondary_ PineTS
   instance via `runPretranspiled` — different functions that would **bypass our patch entirely**,
   leaking both order logging and the warmup gate. Treat `strategy` + `security_lower_tf` as
   unsupported until verified. Plain `request.security` is fine (verified).
2. **Live/streaming duplicate rows.** `run()` and `stream({live:false})` produce no duplicates
   (verified), but the `live:true` path with a genuinely forming bar is untested. The
   `_execTick`/`idx` dedupe is a precaution, not a validated fix.
3. **Whether TradingView itself accepts 2-space-indented Pine.** If TV is strictly 4-or-tab, then
   0.10.0's rejection is _more_ faithful and 0.9.34 accepts scripts TV would reject. Does not change
   the pin, but it changes whether an indentation normaliser is a shim or a correctness fix.
4. **`_prepared.fn` interception composed with `pine.update()`** and the `AsyncGenerator` form of
   `run()`. Only plain `run()` and `stream()` were verified.
5. **Wrapper cost at realistic scale.** Probes were 30–80 bars; the `pending_orders` diff allocates a
   shallow copy per placed order and was never profiled against the 1M-bar case.
6. **`DbProvider` under unbounded `sDate`** (the `calc_bars_count` path). Only the bounded case was
   verified.
