# Decisions

Amendments to the phase specs in `docs/spec/`. The specs stay as written; this file
overrides them where they disagree. Newest last.

Mid-slice decisions taken without asking are recorded here too, per the working agreement in
PROJECT.md.

---

## 2026-09-27 — session decisions 1–8

**D1 · PineTS stays at exactly 0.9.34.** `compile()` additionally emits a **warning** when
block indentation is not a multiple of 4 (TradingView rejects such scripts even though 0.9.34
accepts them) and an **error** when `strategy.*` appears together with
`request.security_lower_tf` (the truncated-body path runs on a secondary instance and bypasses
our instrumentation, so order logging and the warmup gate would silently not apply).
_Amends spec 03._

**D2 · Bar alignment follows Exness MT5 (GMT+0 servers).** D1 starts 00:00 UTC; the NY-close
offset stays available via `dayStartOffsetMinutes`. **W1 starts Sunday 00:00 UTC for all
symbols**, changing the resampler default from Monday; Monday remains selectable via
`weekStartDay`. _Amends spec 02._

**D3 · Sessions are defined in `America/New_York` via the tz database, never as fixed UTC
hours.** FX opens Sunday 17:00 and closes Friday 17:00 New York time, so the UTC boundary
moves with US daylight saving automatically. This replaces the empirically-derived fixed
22:00 UTC boundary. Metals, indices and energies get their weekly open/close and daily breaks
derived from the data the same way and stored in the same structure. _Amends spec 02._

**D4 · Filler bars are dropped everywhere, not just on Sundays.** MetaTrader only forms a bar
when ticks arrive, so a flat bar with zero volume is synthetic.

Verified against the stored January 2024 EURUSD data before adopting the rule:

| bar shape           | count  | volume = 0 | volume > 0 |
| ------------------- | ------ | ---------- | ---------- |
| flat (`high = low`) | 1,825  | 1,432      | 393        |
| non-flat            | 31,295 | 0          | 31,295     |

No non-flat bar has zero volume, which confirms zero-volume bars are filler. But 393 flat bars
carry real volume — genuine minutes where price did not move — so the rule is **drop flat AND
zero-volume**, never flat alone. Applies to holidays and mid-week gaps too, not only weekends.
_Amends spec 02._

**D5 · Financing rollover defaults to 17:00 `America/New_York`** (Exness documents 21:00 UTC
in summer and 22:00 UTC in winter, which is the same instant expressed in fixed UTC). Triple
charge stays configurable, default Wednesday. _Amends spec 04._

**D6 · Cross-currency runs are rejected until the currency layer exists.** A run whose symbol
quote currency differs from the account currency fails with a clear message rather than
silently reporting P&L in the wrong currency. Equity reconstruction is built around a
`quoteToAccount(ts)` rate function — the identity function for USD-quoted symbols — so the
currency layer drops in later without reshaping the equity code. _Amends specs 03 and 04._

**D7 · The generic CSV importer layout stands** as implemented (header detection, sniffed
delimiter, ISO or epoch timestamps). No change.

**D8 · Build order replaces the phase order.** See `docs/spec/08-roadmap.md`. Specs 02–07
remain the detailed reference for _what_ each area must do; the roadmap governs _when_.

### Mid-slice decisions

**Exness MT5 parity test skipped.** `packages/data/fixtures/exness-mt5/` does not exist, so
the M1→H1/D1/W1 parity test in step 1 could not be written. The resampler's alignment is
instead covered by unit tests asserting the D2 boundaries directly. Drop EURUSD M1, H1, D1 and
W1 exports for one month into that directory and the parity test becomes the real check.

**The filler-bar rule lives in `normalizeBars`, not in each adapter** (step 1, D4). Every
provider already passes through that one boundary, so "everywhere" is free and cannot be
forgotten by a future adapter. The Dukascopy **ask** side opts out with
`dropFillerBars: false`: a flat zero-volume ask bar is still the best ask quote for that
minute, and dropping it would lose the spread on a real bid bar whose ask side happened to be
quiet. The bid side is what gets stored, so filler never reaches the database.

**`openMinutesBetween` is exact rather than fast** (step 1, D3). The first cut multiplied whole
weeks by a per-week constant, which is wrong twice a year: a 168-hour UTC window spans 169
local hours in the spring-forward week and 167 in the autumn one. It now walks whole UTC hours
and descends to minutes only for the two or three hours a week that straddle a session edge —
exact everywhere, and ~60× cheaper than minute-stepping. This figure feeds `completeness`,
which exists to be trusted.

**1,432 stored filler bars purged** (step 1, D4), leaving 31,688 EURUSD M1 rows of 33,120.
`symbols.data_version` bumped to 1 so any resample cache keyed on it is invalidated. The
measured split matched the D4 table above exactly, including the 393 flat bars with real volume
that were correctly kept.

**PineTS ignores five `strategy()` properties; `compile()` warns** (step 2). Spec 03's fifth
hand-verified fill case expects `process_orders_on_close` to fill at the same bar's close.
PineTS 0.9.34 accepts the property and never reads it — the fill path is unconditional, so
market orders always fill at the next bar's open. Same for `calc_on_order_fills`,
`calc_on_every_tick`, `backtest_fill_limits_assumption` and `close_entries_rule="ANY"`.

The conservative option was taken: the test asserts the **real** behaviour and records what
TradingView would have produced alongside it, and `compile()` emits an `ignored-strategy-prop`
warning per property so the divergence can never be silent. A warning rather than an error,
because the run is still meaningful — unlike D1's `security_lower_tf` case, where
instrumentation silently stops applying. Full detail and the decompiled fill path are in
`docs/pinets-notes.md`. _Amends spec 03._

**Engine trade ids are ours, not PineTS's** (step 2). PineTS numbers `closedtrades` and
`opentrades` independently, so a run that reverses a position returns two different trades both
calling themselves `trade_1`. `EngineTrade.id` is now `t1`-based, assigned by us in entry order
the way a trade list reads, and PineTS's own value is kept as `engineId` for cross-checking.
Without this, `run_trades` in step 3 would have had colliding primary keys.

**Piscina 5 has no `taskTimeout`.** The option existed in piscina 4, was removed in 5, and is
silently ignored — which the scaffold's pool was passing, so the documented 120s timeout did not
exist. Timeouts now come from `RunOptions.signal`, which does terminate a synchronous infinite
loop because piscina's abort handler tears the thread down rather than politely asking it to
stop. Memory is capped with `resourceLimits.maxOldGenerationSizeMb`; note that this governs the
V8 heap only, so a runaway `ArrayBuffer` allocation escapes it. Verified against real thread
deaths — throw, spin, heap exhaustion and `process.exit` — in
`apps/worker/src/pool/isolated-pool.test.ts`.

**The pool has no Pine task yet** (step 2). The isolation mechanism is built and proven, but
the task that runs a Pine script inside it belongs to slice B, where the API actually invokes
it. Step 4's CLI runs the engine in-process. Adding a pine task now would be a shipped surface
with no caller.

**The scaffold's `CostModel` is replaced by `CostConfig`** (step 3). The scaffold modelled a
single fixed `spreadPoints` and simulated fill prices itself; the engine now owns fills, and
spec 04 needs per-bar spreads, four financing modes and a rollover calendar. `CostConfig` lives
in `packages/shared/src/costs.ts`, with `ZERO_COSTS` as the configuration the cross-check runs.

**Engine qty is in UNITS, `CostedTrade.qty` is in LOTS.** PineTS multiplies price deltas by
`syminfo.pointvalue` and treats `default_qty_value` as contracts, so `strategy.fixed, 1` on
EURUSD is one euro, not one lot. The overlay divides by `contractSize` on the way out. A
cost in the quote currency is `priceDelta × units × pointValue` — the same identity
`packages/metrics/src/cost-drag.ts` inverts for break-even cost per side, so the two cannot
disagree.

**The cross-check compares the engine against a ZERO-cost overlay, not the costed one** (step 3).
The engine's `netprofit` contains no spread or financing, so comparing it to the costed figure
would fail every run that charged anything. Applying the overlay twice — once at the configured
costs and once at zero — costs no extra engine run and keeps the comparison honest.

**`equity_points` (a row per bar) is replaced by `run_series` (compressed blobs)**, as spec 04
requires. A one-year M5 run is ~75,000 bars; four series of that as rows is ~300,000 rows for
one run, and the series are only ever read whole. Encoding is columnar JSON + gzip, which
measured 16 kB → 3.2 kB on a real 530-bar run. `peak`/`drawdown` are recomputed on decode
rather than stored, but the SEED peak is stored: it starts at the initial capital, so a curve
whose first bar is already underwater would otherwise decode with no drawdown.

**Migrations were generated in two passes.** `drizzle-kit generate` needs a TTY to ask whether
`runs` → `backtest_runs` is a rename, and there is none here. Removing the old tables and
generating, then adding the new ones and generating, produces two unambiguous migrations
(`0001` drops, `0002` creates) and a correct snapshot. Safe because none of those tables had
ever held a row.

**`pnpm backtest` defaults to 1 lot at 1:100 leverage** (step 4). Both defaults are forced by
engine behaviour rather than preference:

- At the fixtures' declared `default_qty_value=1`, a month of EURUSD trading moves the account
  by a few cents and every KPI rounds to zero — faithful to the script, useless as a report.
- At the engine's default 100% margin, one lot needs ~$110,000, so on a $10,000 account
  **PineTS cancels every order silently** and the run reports zero trades with no explanation.
  Spec 03's `margin % = 100 / leverage` fixes it. The CLI now also warns explicitly when entry
  orders were placed but nothing filled, because that failure is otherwise unreadable.

**The `--lots` override is recorded on the run row** in `backtest_runs.props`, so a run that was
sized by the CLI rather than by its script stays reproducible.

### Slice B (jobs + API)

**The backtest runs in a piscina thread with its OWN DB pool** (spec 03), not with bars passed
in from the main thread. A one-year M5 run needs ~370,000 M1 bars; structured-cloning those into
the thread on every job costs ~30 MB of copying for data the thread can read itself. Piscina
loads the task module once per thread, so a module-level pool is naturally thread-local.

**Progress leaves the thread over a transferred `MessagePort`.** There is no other channel: a
worker thread cannot reach `job.updateProgress()`, and piscina does not expose its own message
plumbing. The port must be TRANSFERRED, not cloned — a cloned port arrives detached and silently
drops every message, which would look exactly like a job that reports no progress.

**Errors crossing back out of a thread keep `message`, `stack` and `cause` — NOT `name`.**
Structured clone drops own properties, so the first cut — `Object.assign(new Error(msg), {detail})`
— arrived with `detail` undefined.

_Corrected during the verification sprint._ The second cut put the classification in `Error.name`
(`NoDataError`, …), and that was **wrong**: structured clone normalises an Error's name to one of
the seven built-ins, so `NoDataError` arrives as plain `"Error"`. The mistake survived review
because a built-in subclass like `TypeError` DOES round-trip, so any check using one suggests
`name` is safe. The consequence in production was that "No EURUSD data in that range" reached the
user coded as `task-script-error` — "your script has a bug" — and only running `pnpm test:e2e`
against a real stack exposed it.

Classification now travels in **`cause`**, as `{ edgelabCode }`. `cause` survives, and survives as
an arbitrary cloneable value. The job layer walks the cause chain because the pool wraps whatever
a task throws in `TaskScriptError`, putting a tagged error one hop deeper.
`apps/worker/src/pool/structured-clone.test.ts` pins all of this against the platform.

**Cancellation is out of band.** BullMQ has no cancel: `job.remove()` only works while a job is
still waiting, and once a processor is running nothing in the queue can reach it. So the API
publishes on a per-job Redis channel and the worker — the only process holding the
AbortController — aborts the piscina task, which terminates the thread. A job still waiting is
removed from the queue instead. `DELETE /backtests/:id/job` picks the path from the job's state.

**Job events are PUBLISHED and also SET with a TTL.** Pub/sub has no history, so a client that
subscribes after a fast job finished would wait forever for an event that already happened. The
SSE endpoint replays the stored last-known state, then switches to live events, then re-checks
after subscribing to close the gap in between.

**SSE is written against the raw `Response`, not Nest's `@Sse()`.** The decorator wraps an
Observable and offers no clean way to replay state before live events or to end the stream on a
terminal one — both of which this endpoint needs.

**The API does not depend on `@edgelab/worker` in production.** Queue names are duplicated as
literals in `apps/api/src/infra/queues.module.ts` rather than imported, so deploying the API does
not drag piscina, pinets and the provider SDKs into its image. The worker IS a devDependency,
for the end-to-end test only.

**Import runs inline; ingest is queued.** An uploaded file lives in the API process's memory, so
handing it to the worker would mean shipping the bytes through Redis or a shared volume. Ingest
has no such problem and belongs on the queue. Ingest is also NOT run in the piscina pool, unlike
the backtest: it is network-bound, and the thing a thread protects against — user code wedging or
exhausting memory — has no analogue when the code is ours.

**Series are downsampled by min/max bucketing, not by striding.** A stride can walk straight past
the spike that IS the drawdown, so the chart would show a shallower history than actually
happened. Each bucket keeps its extremes, so every peak and trough survives at full amplitude.
`?points` is therefore a target, not a cap — up to two points per bucket.

**The end-to-end test boots the API and the workers in-process** against the dockerised DB and
Redis, on port 0. Chosen over requiring `pnpm dev` (fragile ordering, confusing failures when a
process is mid-restart) and over the prod compose stack (which publishes no ports by design, per
spec 07, so reaching it would need an override file). It lives behind `pnpm test:e2e` rather than
in `pnpm test`, so a fresh clone without Docker still gets 519 green unit tests.

**BLOCKED: slice B's DONE WHEN is unverified.** Docker Desktop's WSL2 backend will not start on
this machine — `wsl -d docker-desktop` reports `HCS_E_HYPERV_NOT_INSTALLED`, and
`HypervisorPresent` is False while `VirtualizationFirmwareEnabled` is True. Firmware VT-x is on;
Windows is not launching the hypervisor, and no `hypervisorlaunchtype` is set in the BCD. Fixing
it needs an elevated boot-config change plus a reboot, which is not mine to make. Consequences:

- `pnpm test:e2e` has never been executed. It typechecks and lints, nothing more.
- Migration `0003_foamy_human_torch.sql` (`backtest_runs.queue_job_id`) is GENERATED but NOT
  APPLIED. Run `pnpm db:migrate` before the first API-driven run, or every insert into
  `backtest_runs` will fail on the missing column.

### Slice C (Studio UI)

**The symbol list shows only instruments with stored bars, and the date range is clamped to the
selected symbol's coverage.** Offering a symbol or a window that cannot run just moves the failure
from a disabled control to a red banner two minutes later. The picker shows each symbol's coverage
inline for the same reason — "which symbols can I actually use" is the first question the panel
has to answer.

**Series are downsampled for transport, and the UI trusts that.** `GET /backtests/:id/series`
returns min/max-bucketed points by default; the Overview chart renders them as-is rather than
re-fetching `?full=1`, because the bucketing preserves every peak and trough at full amplitude.

**Equity and drawdown are two synchronised charts, not one with two scales.** A drawdown is always
at or below zero and an equity curve is a large positive number; sharing an axis squashes the
drawdown into the baseline, which is the one thing it exists to show.

**Monaco gets a Monarch tokenizer, not a Pine parser.** Colouring and bracket matching are all the
editor needs; the real parse is `POST /pine/compile`, whose diagnostics become the inline markers.
Reimplementing Pine's semantics client-side would duplicate PineTS badly and drift from it.
Completions are a curated ~45 built-ins with signatures rather than a dump of all ~1,500 — a popup
that lists everything is one you stop reading.

**The editor emits 4 spaces and never a tab** (`tabSize: 4`, `insertSpaces`, `detectIndentation:
false`), because D1 records that TradingView rejects indentation that is not a multiple of 4 even
though PineTS 0.9.34 accepts it. The compile warning catches pasted code; this stops the editor
from creating the problem in the first place.

**The run's `props` are left empty and sizing is expressed as lots + leverage.** The API derives
`default_qty_value`, `margin_long` and `margin_short` from them (spec 03's margin % = 100 /
leverage), so the browser never has to know the symbol's contract size or replicate that formula.

**A failed compile is not an HTTP error and is not rendered as one.** The editor calls
`/pine/compile` on every debounced keystroke; treating a mid-word script as a failure would make
normal typing look broken. Diagnostics are the payload. A failed compile REQUEST — the API being
down — is reported separately, so "cannot reach the API" never appears as a syntax error on line 1.

**API error messages are shown verbatim.** "No EURUSD data in 2030-01-01 .. 2030-02-01. Stored
coverage is 2024-01-01 .. 2024-01-31." is the whole point of the slice-B error envelope, and any
paraphrase in the client throws it away exactly when it is most useful.

**Two smoke suites, split by what they need.** `studio.smoke.ts` is the slice-C acceptance test and
needs the full stack; `shell.smoke.ts` needs only the dev server and covers the empty and error
states — the states a new user sees first and the easiest to leave broken. The split means a
machine without Docker can still catch a crash on mount or a broken import.

**BLOCKED: slice C's DONE WHEN is unverified, for the same reason as slice B.** Docker/WSL2 still
will not start (`HypervisorPresent: False`), so:

- `studio.smoke.ts` has never been run — it needs the API, the worker, Postgres and Redis.
- "the KPIs on screen match the API" is unverified; the assertion is written and typechecked.
- `shell.smoke.ts` WAS run in a real browser and **all 8 pass**. Getting there found three
  defects, none of which typecheck, lint or 519 unit tests could see:

  1. **The app did not mount at all** — a blank white page. `@edgelab/shared` emits CommonJS, and
     Vite discovers a CJS module's named exports with cjs-module-lexer, which cannot see through
     `export * from './costs'`. `import { DEFAULT_COSTS }` therefore threw at runtime. Fixed by
     aliasing workspace packages to their TypeScript source in `vite.config.ts`, as
     `vitest.config.mts` already did — which is exactly why the unit tests never caught it.
  2. **The editor took the page down.** In a Monarch tokenizer `@version` is an ATTRIBUTE
     REFERENCE, not a literal `@`, so the rule threw "language definition does not contain
     attribute 'version'". Fixed with a `[@]` character class, which breaks the
     `@`-followed-by-word-character pattern Monarch substitutes on.

  3. **The resize test wiped the state it was asserting on.** `addInitScript` re-runs on every
     document, including `page.reload()`, so clearing localStorage there destroyed the stored
     pane ratio before the app booted — and the app correctly came back at its default. The
     app was right; the test was wrong. The clear is now guarded by a sessionStorage sentinel,
     which survives a reload but not a new browser context.

  The first two would have shipped. The third would have read as a product bug forever.

**Monaco loads from a CDN** (`cdn.jsdelivr.net`), which is `@monaco-editor/react`'s default
loader. For a self-hosted personal tool that is a real limitation — offline, the editor never
appears. Bundling Monaco locally is deferred to slice F's polish pass, and noted here so it is a
decision rather than an oversight.

## 2026-09-27 — slice D amendments (Integrity & Overfitting)

These amend spec 06 and were given with the slice. Recorded here because `docs/decisions.md`
overrides the specs where they disagree.

**A1 · Look-ahead keeps three layers** — static lint → causality check → prefix-invariance with a
one-HTF-bucket margin — with two changes.

**A1a · Causality prefers interception over re-derivation.** Log which HTF bucket each
`request.security` call actually used, by intercepting it the way `strategy.*` is intercepted.
Judge each bar at its CLOSE time, because `lookahead_off` legitimately returns a bucket's value on
the chart bar where that bucket closes. Ties count as causal; report **inconclusive** when most
bars are ambiguous (booleans, flat series). A `lookahead_off` script joins the clean fixtures.

**A1b · Add a future-splice test**, as a `DbProvider` option. Keep every bar and timestamp, but
replace the M1 data after each cutoff with a different real segment, rescaled to start at the
cutoff price. Orders placed and trades closed before the cutoff must be identical to the original
run. Nothing is truncated, so no margin is needed, and it catches intra-bucket leaks from any
source. Truncation-with-margin stays, for length-dependent leaks (`last_bar_index`,
`barstate.islast`).

**A2 · Sample-size guard reports `n/a` with a reason** when a segment is structurally too short.
The overall verdict becomes **Inconclusive**, never Pass, whenever a critical check is `n/a`. The
walk-forward form estimates OOS trades per fold from the full-sample trade rate and warns before
starting.

**A3 · Walk-forward cost is measured, not assumed.** Time transpile versus run first; if
`runPretranspiled` accepts an inputs map, transpile once per worker thread. Base the ETA on that
measurement.

**A4 · Spread stress, costed OOS metrics and the sealed holdout are unblocked**, since phase 4
exists.

### What the interception probe established

`request.security` **is** interceptable, the same way `strategy.*` is: `ctx.pine.request` holds
`security` as an own, writable property, and a patch assigned there is called once per chart bar
(234 calls over a 234-bar run). That much of A1a works.

But interception alone does **not** reveal the bucket:

- `request.security` returns a **Promise**, resolving to a plain number — the HTF value at that
  chart bar, with no bucket identity attached.
- `request._cache` has no enumerable own keys at call time or after resolution.
- `request.context` is the **CHART** context, not the secondary one: it reports
  `isSecondaryContext: false`, and its `idx` and `data.openTime` track the chart bar exactly
  (chartIdx 57 → secIdx 57, both 2024-01-02T22:30 on an M15 run). It is the parent, not the HTF
  context.

So the design is the hybrid A1a describes, and the fallback is taken **on evidence**: interception
supplies the exact per-bar returned value — better than re-deriving it, which could drift from
what the script actually saw — and bucket attribution is then value matching against our own HTF
series, with ties causal and an explicit `inconclusive` when most bars are ambiguous.

If a future pinets exposes the secondary context, the value-matching step can be replaced without
touching the rest of the check.

## 2026-09-27 — slice E (data & results)

**Only the currency layer's arithmetic was built.** The rest of slice E is blocked; see below.

**D6 is superseded, but not yet removed.** `packages/engine/src/conversion.ts` implements spec 03's
currency layer: pick the conversion pair, get its DIRECTION right, look the rate up bar by bar, and
name the download when the pair's bars are missing. D6's blanket refusal of non-USD quote
currencies stays in `costs.ts` until the layer is wired into `orchestrateRun` — removing the guard
before the replacement is connected would let a cross-currency run through with no conversion at
all, which is the exact failure D6 exists to prevent.

**Direction is the whole problem.** A pair BBBQQQ quotes "QQQ per one BBB", which reads backwards
relative to the conversion it performs. JPY→USD needs `1 / USDJPY`; GBP→USD needs `GBPUSD`
unchanged. Inverting USDJPY the wrong way is wrong by a factor of ~151² — 7,550,000 instead of
331.13 — which still looks like money, so it gets its own test.

**The rate is the last one AT OR BEFORE the instant**, never a later one. Using a later bar's rate
would be look-ahead committed in the reporting layer, the same class of error slice D exists to
catch.

**The pre-series fallback is the FIRST known rate, not 1.** Falling back to 1 would silently report
unconverted yen as dollars.

### Slice E blockers

- **Item 2 cannot be done at all.** Twelve Data and Binance need Docker to store what they fetch
  (the key IS configured, 97 chars). The Exness importer was to be fixed against
  `packages/data/fixtures/exness-ticks/sample.csv` — **that file does not exist, and neither does
  `packages/data/fixtures/`**. The Exness column layout therefore remains the open question it has
  been since phase 02.
- **Items 1 and 4** (Data page, dashboard completion) are buildable and browser-verifiable against
  a stubbed API, but were not reached.
- **DONE WHEN #1** needs a real USDJPY run, so it needs Docker plus USDJPY bars. What exists is the
  hand check of the arithmetic it rests on, as a test.

## Verification sprint (2026-09-27)

Everything below was found by running code that had only ever been typechecked. The theme is
uncomfortable and worth stating plainly: **every single "code complete, DONE WHEN unverified"
claim in slices B–F was wrong in at least one way that made the feature unusable.** Eight real
defects, in code that compiled, linted and passed 616 unit tests.

### A5 — same-bar execution is ESTIMATED, not re-run

Spec 06 asked for the same-bar check to be a re-run with `process_orders_on_close` flipped, diffed
against the original. **That is impossible**: the engine ignores that flag and its siblings, so
both runs would be byte-identical and the check would report a reassuring zero forever. A check
that cannot fail is worse than no check.

Replaced with a warning plus an analytical estimate, `packages/validation/src/same-bar.ts`. For
each market fill it prices the gap between where we fill (the next bar's open) and where
TradingView would fill with the flag on (the signal bar's close), times size, in account currency,
signed so **positive means our fill was worse**.

It is a lower bound and says so in every result: it holds the strategy's decisions fixed, whereas a
real same-bar run could decide differently once its equity diverges. The value is the order of
magnitude — "this result depends on two ticks per trade" is a different conclusion from "this is
robust to it". Fills on bar 0 are reported `unassessable` rather than scored zero, so they cannot
dilute the mean.

### Why the PF 0.09 results were not a bug

Three fixtures appearing to report _exactly_ 0.09 was the strongest signal that something was
shared and wrong. They do not. Hand-computed from the stored trades:

| fixture            | gross win | gross loss | PF     | shown |
| ------------------ | --------- | ---------- | ------ | ----- |
| ema-cross          | 548.00    | 6255.00    | 0.0876 | 0.09  |
| bollinger-breakout | 450.00    | 4995.00    | 0.0901 | 0.09  |
| supertrend-atr     | 450.00    | 5133.00    | 0.0877 | 0.09  |
| rsi-mean-reversion | 1728.00   | 864.00     | 2.0000 | 2.00  |

Three different numbers that render the same at two decimal places. The metric is correct.

What was checked before concluding that:

- **Sign convention**, from first principles (`sign-convention.test.ts`). A long held through a
  rising market earns `(exit − entry) × qty`; its short twin loses exactly the mirror image. The
  zero-cost cross-check _cannot_ catch a sign error — it only proves our reconstruction agrees with
  the engine, so a side flipped in both agrees perfectly and is wrong twice.
- **Signal direction.** `ta.crossover(fast, slow)` → long, verified against the plotted EMA values
  at the entry bar on a V-shaped series.
- **Fills against stored M1.** Trade 15 entered at 1.08939, which is exactly H1 bar 291's open,
  resampled from 60 complete M1 bars. No spike, no bad bar, no bid/ask join error.
- **Arithmetic.** −0.00416 × 100,000 = −416.00 gross, to the cent.
- **A longer window.** The same fixture over six months of 2022 gives PF 0.74 at a 26.9% win rate
  over 119 trades — an ordinary losing trend-follower. January 2024 was 29 trades in a choppy
  month; 1 winner in 29 is unlikely, not impossible.

The residual explanation is the strategies themselves: ema-cross, bollinger-breakout and
supertrend-atr are all always-in-market reversal systems with no protective exit, which is what
gets whipsawed. The two fixtures with a real `strategy.exit` (rsi-mean-reversion, donchian) behave
completely differently on the same data. The −57% return is a SIZING artifact of `--lots 1` on a
$10,000 account — one standard lot is ~$108,000 of notional, so 22 pips is 2.2% of equity.

### Provider spread coverage

Dukascopy supplies a per-bar spread (113 distinct values over January 2024 EURUSD, mean 3.5
points). **Binance and Twelve Data supply none** — bars from those adapters come back with
`spread: null`, so runs on them fall back to `symbol.defaultSpreadPoints`. That is the fallback
working as intended, but it means a cost comparison across providers is not like for like.

## Slice D step 1 (2026-09-28)

**A1 has a measured blind spot, and A1b is the fix rather than a nice-to-have.**

Prefix invariance does NOT catch the leaky fixture. Observed, not theorised: `lookahead-leak`
passes 6 of 6 truncation cutoffs while the static lint fails it at line 8.

The reason is structural. Truncation only removes data at the END, so a leak with a BOUNDED
horizon — `request.security` with `lookahead_on` sees at most to the end of the current HTF bucket
— only perturbs decisions inside that bucket of the cutoff. That is exactly the region the A1
margin must exclude, because without the margin every honest HTF strategy fails: its last bucket
before the cutoff genuinely differs. Margin big enough to avoid false positives ⇒ margin big enough
to hide a bounded leak. The two requirements are in direct conflict.

So truncation-based prefix invariance catches **unbounded** leaks (`last_bar_index`,
`barstate.islast`, anything normalised over the whole series) and nothing else. That is still worth
having, and the check now says so in its passing message instead of implying it proved causality.

**A1b — splice different future data rather than truncating — is what closes this.** Nothing is
removed, so no margin is needed, and an intra-bucket leak diverges on the first affected bar. It is
the first thing step 2 should build, ahead of the endpoint.

**Verdict severities.** The static lint is `critical`: an error there is a specific named leak at a
known line. A clean lint is never reported as more than "nothing obvious in the source" — it has
read the text, not the behaviour, and overclaiming there is the most dangerous thing this feature
could do.

**Validation fixtures live in `packages/validation`, not `packages/engine`.** Engine and validation
are siblings in the dependency order, so validation cannot import the engine's fixture list; the
first version of the lint test only worked because the test runner aliases packages to source. An
app wires the two together. They are also kept out of the Studio dropdown — a script whose only
purpose is to cheat is not an example to offer anyone.

**`dataCutoffTs` is a per-RUN parameter, not an engine option.** Prefix invariance varies it per
truncated run, and the alternative was constructing a new engine per cutoff.

## Slice D continuation — prerequisites (2026-09-28)

### A6 · One series, one feed

**Measured first:** the EURUSD series was already contaminated. 216,810 dukascopy bars
(2022-01-02 .. 2024-01-31) and 6,238 twelvedata bars (2024-02-01 .. 07) in the same
`symbol_id`, from the adapter exercise during the verification sprint.

Why that matters more than it looks: providers disagree about what a minute IS. Dukascopy stores
bid with a measured spread; Twelve Data supplies neither a spread nor volume, and its bars come
from a different consolidation of a different set of venues. Resampling across the join produces
H1 bars whose open comes from one vendor's convention and whose close comes from another's, and a
backtest over that boundary is measuring the vendor change as if it were the market.

Three rules follow:

1. **A run whose range spans more than one source is refused**, naming both sources and the
   boundary. Refusing is right rather than warning: the result would be arithmetically fine and
   semantically meaningless, which is the worst kind of wrong.
2. **A different feed is a different dataset.** `EURUSD.exness` is its own symbol row sharing
   EURUSD's instrument metadata (digits, mintick, contract size), never rows appended to `EURUSD`.
   Comparing two feeds is then an explicit act — two runs, two symbols — instead of an accident.
3. **The stray Twelve Data week moves out** to its own dataset rather than being deleted: it is
   real data that cost an API call, and it is the fixture that proves rule 1 fires.

### A7 · Backfill is paced, not backed off

Dukascopy answered HTTP 429 through all six backoff attempts up to 160s on three separate
sessions, so the two-year backfill never progressed past 2022-06. Backoff is the wrong instrument:
it reacts after the limit is already hit, and by then the connection is being throttled.

The ingest job now paces requests below the limit by construction, stops cleanly on a persistent
429 rather than exhausting retries, records how far it reached, and resumes the next night. The
resumability that makes this safe already exists and was verified on real data — the cursor
advances to the end of the contiguous run covering the requested start.

### A8 · The boot test exists because the API once could not start

Seven constructors took a class-typed dependency with no `@Inject` and one module never imported
its dependency's module, and the whole API aborted on startup — undetected because nothing in
`pnpm test` ever built the Nest graph. `pnpm typecheck` cannot catch it: the types are correct, it
is the runtime metadata that is absent.

The test compiles the FULL module graph under the same esbuild transform dev uses, with no
decorator metadata, and with the connection-opening providers stubbed. It must fail exactly as dev
fails. A test that enabled `emitDecoratorMetadata` would pass on the broken code and be worse than
no test.

**CI: not added.** The instruction was conditional on a git remote and `git remote -v` is empty, so
a workflow file would be dead configuration. The five commands it should run are lint, typecheck,
test, test:e2e and test:smoke against TimescaleDB and Redis service containers.

### A6 addendum · where the feed guard runs, and where it must not

The guard lives on the **main thread**, in the BullMQ job, not inside the piscina task.

It was in the task first, and it broke the no-data e2e test: that test started reporting
`task-timeout` instead of `no-data`. Confirmed by removing only that one call — 25/25 with it gone,
24/25 with it present. A worker thread resolves its own module graph outside vitest's aliases, and
the extra import stalled the thread past its 120s limit. Nothing about the check needs a thread —
it is one indexed query, measured at 0.11 ms — and running it outside also keeps the refusal off
the structured-clone path entirely.

Worth remembering as a general rule: an import added to a piscina task is not free, and its cost
does not show up anywhere near the change.

### A7 addendum · the 429 is not about our pacing

Measured after building the paced job: Dukascopy refuses the **first** request of a session, before
any pacing could apply. So the block is longer-lived than one run — IP-level, hours or days — and
no in-run spacing can avoid it. Pacing is still right (it stops us provoking a fresh block), but the
thing that actually recovers the backfill is the nightly retry.

This is why `rate-limited` had to be a distinct terminal state exiting zero. The correct response to
"not tonight" is to come back tomorrow, and a job that reported failure for that would be muted
within a week. Recorded in `ingest_jobs`, which had existed since migration 0000 with nothing
reading or writing it.

**Still pending, and now the honest blocker for slice D's two-year gate:** the backfill cannot get
past 2022-07 while the block holds. The six contiguous months of 2022 are the acceptance data.

## Public repo and CI (2026-09-28)

### A9 · CI runs on synthetic bars, never a provider

The five checks (lint, typecheck, test, test:e2e, test:smoke) run on TimescaleDB and Redis service
containers with **no secrets at all**, and `TWELVEDATA_API_KEY` is set to the empty string
deliberately — that disables the adapter, so nothing in CI can reach an external provider.

It has to be that way round rather than "be careful not to call one". Dukascopy is rate-limiting us
outright, and Twelve Data's free tier is 800 requests a day shared with real work; a per-push job
would burn it on the first busy afternoon and make the budget useless for the thing it exists for.
Vendor bars are also not ours to commit to a public repo.

So CI seeds `packages/data/src/synthetic.ts` — deterministic bars from two superimposed sines plus a
drift. The shape is not decoration: both suites assert EURUSD has more than 10,000 stored bars AND
that a strategy actually trades (the smoke test clicks a trade), so a flat or monotonic series would
pass the precondition and then fail everything downstream in ways that look like engine bugs. The
generator also never emits a bar that is both flat and zero-volume, because D4 treats those as filler
and drops them — a naive generator produces a series that is silently discarded at import.

Stored under source `synthetic`, which puts it under the one-feed rule (A6): seeding into a symbol
that already holds real bars is refused rather than quietly creating a mixed series.

**No unit test needed skipping.** Checked rather than assumed: no `.test.ts` in the repo performs a
network call, so "skip any test that needs a real provider" had nothing to act on.

### A10 · Twelve Data is the two-year acceptance feed

`/earliest_timestamp` for EUR/USD at 1min returns **2020-04-07 16:54**, which reaches well past
2022-01-01. So plan B is live: `EURUSD.twelvedata` is being backfilled 2022-01-01 → 2024-01-01 and
becomes the target of slice D's two-year acceptance run.

Budget arithmetic: ~750k M1 bars at 5,000 per request is ~150 requests against a 800/day limit, so it
fits inside one day. `api_usage` confirmed 795 credits free when it started.

Dukascopy stays the canonical `EURUSD` series and keeps its nightly job. Twelve Data supplies no
spread, so runs on that feed fall back to `symbol.defaultSpreadPoints` — which is correct behaviour,
but it does mean cost figures are not comparable between the two feeds.

An aside worth recording because it cost real time: a naive `cut -d=` on the `.env` line produced a
97-character "key" and a 401. The line carries an inline comment; `process.loadEnvFile` strips it and
a shell split does not. Also confirmed `process.loadEnvFile` does NOT override an existing shell
variable, so config CAN be overridden per-command locally.

### A11 · A blocked source says so, rather than exiting zero forever

One `rate-limited` night is normal and exiting zero is right for it. A STREAK is different
information — the source is blocked, not busy — and a job that reports success every morning is
exactly how nobody notices.

After **three** consecutive rate-limited runs, `pnpm backfill` and `GET /api/data/coverage` both show
`<provider> blocked since <date>`. Three is long enough that a weekend maintenance window does not
trip it and short enough to notice within a working week. One success resets the streak.

Coverage carries it because coverage shows which bars exist and cannot say why the rest do not; after
three nights that distinction is the only thing worth reading.

### A12 · Exness imports and the MT5 parity test are NOT PLANNED

`packages/data/fixtures/exness-mt5/` and `.../exness-ticks/` do not exist and never have. The tick
importer's column aliases have carried a `NOTE (flagged for confirmation)` since phase 02 and cannot
be resolved against nothing.

Closed as **not planned** rather than left open. It has been flagged in every status table for
several sessions, and a permanent "blocked" row is indistinguishable from noise. Both directories are
now gitignored: broker and provider data stays local, because it is licensed vendor data and not ours
to republish.

If a real export ever arrives, the primitive it needs is already built and tested —
`ensureFeedSymbol` creates `EURUSD.exness` sharing EURUSD's instrument metadata — and the work is
wiring the importer to it plus the parity test. Until then it is not on the list.

### A10 addendum · the two-year gate is cleared

Done: `EURUSD.twelvedata` holds 664,720 M1 bars, 2022-01-02 .. 2024-02-07. Over the acceptance
window 2022-01-01..2024-01-01 that is 623 trading days with **no gap longer than four days**, fetched
in 148 requests in 18 minutes — well inside the free 800/day budget.

### A13 · CI found a bug local runs could not

The first green CI run cost four attempts, and the third failure was worth the whole exercise:
`mintick = 10 ** -digits` produced 0.000009999999999999999 on the runner's Node and the literal
`1e-5` here, one ULP apart. Exponentiation is _implementation-approximated_ in ECMAScript;
string-to-number conversion is exactly specified. Since mintick is the unit of nearly all price
arithmetic in this repo, backtest results depended on which Node built them.

That is precisely the class of defect a single-machine project cannot find, and it argues for keeping
CI green as a gate rather than a decoration.

Two smaller CI notes. `pnpm/action-setup` fails if given a `version` input while package.json pins
`packageManager` — let it read the pin. And job logs need repository admin rights even on a public
repo, so the workflow emits test failures as **annotations** (`--reporter=github-actions`), which are
readable without auth and show inline on the diff.

## A1b future splice — landed (2026-09-28)

The layer that closes the gap A1 could not. Verified on the 2022 acceptance data, EURUSD H1,
2022-01-03 .. 2022-06-30:

| fixture        | backtest            | static lint | prefix invariance | future splice  |
| -------------- | ------------------- | ----------- | ----------------- | -------------- |
| lookahead-leak | PF 22.92, +$145,206 | fail        | **pass (6/6)**    | **fail**       |
| lookahead-off  | PF 1.03, +$1,622    | pass        | pass (6/6)        | **pass (6/6)** |

The leak is caught at the FIRST cutoff, on trade 97: `exitBar` was 468 on the real series and 467
once the week after 2022-01-28 was replaced. Prefix invariance passes the same run 6 of 6 — the
table is the argument for keeping both.

**Why it works where truncation cannot.** Splicing removes nothing: every bar and timestamp survives
and only the prices after the cutoff change. So the higher-timeframe bucket straddling the cutoff
still exists and still closes, it just closes somewhere else. A causal strategy read byte-identical
data before the cutoff and must decide identically, so **no margin is needed** — and no margin means
no blind spot. Truncation needs its margin precisely because it deletes that bucket, and an honest
HTF strategy legitimately behaves differently when it is gone.

Three choices worth recording:

**Multiplicative rescaling.** The graft is scaled so it continues from the cutoff price. An additive
shift would give a donor from a different price level percentage moves the instrument never makes;
a graft that opened at the donor's own level would be a gap no instrument made, and a strategy could
react to the gap rather than to the leak.

**A BOUNDED splice window — one week.** The first attempt replaced the entire remainder, which needs
a disjoint donor as long as the run. No early cutoff can supply that, and the clean fixture reported
`n/a` for want of 104,809 donor bars — a check that returns `n/a` on honest code is a check that gets
switched off. A week covers a D1 bucket and most of a W1 one, which bounds the horizon this test
targets: `lookahead_on` on timeframe X sees at most to the end of the current X bucket. The
discontinuity where the real series resumes lies in the future relative to the cutoff, so it cannot
reach the decisions being compared. Bounding it also improved the diagnosis — the leak went from a
trade-count mismatch at the fourth cutoff to a named `exitBar` divergence at the first.

**The donor is real data, disjoint, and from the oldest available history.** Real so the grafted
future has the instrument's own volatility and session rhythm. Disjoint from everything at or after
the cutoff so the donor cannot BE the future it stands in for, which would make the test silently
vacuous. Oldest so the graft is least likely to look like a smooth continuation of the recent past.
When no disjoint donor exists the check reports `n/a` with the reason rather than splicing with
overlapping data.

**The pass is now worth something.** The static lint can only say it recognised nothing, and prefix
invariance is structurally blind to a bounded leak. Future splice is the one look-ahead layer whose
clean result is a positive statement: at these cutoffs, on this data, the strategy demonstrably read
nothing it should not have.

## A1a causality — wired (2026-09-28)

The look-ahead family is now complete. All four layers, on the 2022 acceptance data:

| layer                            | lookahead-leak                        | lookahead-off           |
| -------------------------------- | ------------------------------------- | ----------------------- |
| static lint                      | **fail** (line 8)                     | pass                    |
| prefix invariance (A1)           | pass 6/6                              | pass 6/6                |
| future splice (A1b)              | **fail** (trade 97, exitBar 468→467)  | pass 6/6                |
| request.security causality (A1a) | **fail** (bar 0, bucket 60 min ahead) | pass, 3,070 bars judged |

Each layer earns its place by what it says that the others cannot.

- The **lint** reads source: instant, a line number, and blind to anything it does not recognise.
- **Prefix invariance** catches UNBOUNDED leaks (`last_bar_index`, `barstate.islast`, whole-series
  normalisation) and provably misses bounded ones.
- **Future splice** catches bounded leaks behaviourally and is the only layer whose PASS is a
  positive statement.
- **Causality** is the only layer that says WHICH read leaked: "on bar 0 a `request.security("240")`
  call returned 1.13727, which matches only the bucket closing 60 minutes after that chart bar
  closed". The others prove a leak exists; this one hands you the call site.

**The seam is installed inside `instrument()`, not by the adapter.** The `_prepared` handling is the
fragile part — `prepare()` must return the cached object by reference or the patch silently stops
reaching the runtime — and exactly one place should know it. The two seams compose: `strategy.*` and
`request.security` are different namespaces, and the security interceptor wraps the already
instrumented function, so both patches land on the same Context in one pass.

**Recording is off by default and on only for the single full run.** The truncated and spliced runs
re-execute the strategy a dozen times and have no use for the log.

**The adapter awaits `settle()` before reading the log.** `request.security` returns a Promise, so
the interceptor records a pending value and fills it in on resolution; reading early would report
every call as `value: null` and the check would see nothing but unmatched observations.

**Three outcomes are kept distinct, and the distinction is the point.** `null` calls means the seam
was never installed — "we were not watching", reported `n/a`. An empty log means it WAS watching and
the script made no calls — reported `pass`, verified against ema-cross. And values matching too many
buckets is `n/a` with the count, because a boolean or flat series matches half the chart and says
nothing either way.

One verdict per requested timeframe: a script reading both H4 and D1 is judged against each series
separately, since merging them would make every value ambiguous against the other's buckets.

## Execution bias — fill audit (2026-09-28)

First of spec 06 §2. Verified on the 2022 acceptance data:

| fixture            | fills | result                                          |
| ------------------ | ----- | ----------------------------------------------- |
| lookahead-off      | 1,096 | pass — all inside their bar, all at a bar open  |
| ema-cross          | 238   | pass — same                                     |
| rsi-mean-reversion | 174   | **warn** — 1 touch fill, penetration cost $1.00 |

**Only one condition fails: a fill outside its bar's `[low, high]`.** That is not a modelling choice
or a pessimistic assumption — it is an engine or data bug, and everything computed downstream of it is
meaningless. Hence `critical`.

**A touch fill is a WARNING, quantified.** A limit or stop at a level the bar only grazed is recorded
as filled, but in life the level must be traded THROUGH and a wick may fill nobody. That makes the
result optimistic rather than wrong, so the report carries what net P&L would be if every touch had
required one tick of penetration — always adverse, so the adjusted figure is never flattering.

An incidental confirmation worth noting: every fill in the two `strategy.entry`-only fixtures landed
exactly on a bar open — 1,096 of 1,096 and 238 of 238. That is independent evidence for the
documented next-bar-open execution, arrived at from the trade records rather than from the engine's
own claim about itself.

**A unit bug I made twice.** The first version multiplied `mintick` by `qty`, which reported the
penetration cost as `0.00` — because `CostedTrade.qty` is in LOTS, so the product is 0.00001 × 1. The
same confusion had already produced a wrong figure in the same-bar estimate. The parameter is now
named `valuePerTickPerQty` and documents its unit, because "mintick" reads like it is safe to
multiply by a quantity and it is not. The real figure is `mintick × contractSize × pointValue` = $1.00
per lot for a 5-digit pair.

## A14 · Twelve Data coverage — D4 was deleting real minutes

**The 15% shortfall was ours, not the provider's.** Measured against the volume-carrying Dukascopy
series over the window they share, 2022-01-03 .. 2022-06-30:

| feed               | before fix | flat bars | after fix   |
| ------------------ | ---------- | --------- | ----------- |
| EURUSD (dukascopy) | 185,008    | 1.35%     | unchanged   |
| EURUSD.twelvedata  | 164,544    | **0.00%** | **185,386** |

Twelve Data omits volume for forex — every bar arrives with `volume: 0`, which the adapter documents
as "the honest value, not a guess". D4 drops a bar that is flat AND zero-volume, and requires both
precisely because flatness alone is not evidence of filler. On a feed with no volume that conjunction
collapses to "drop every flat bar", which is the exact rule D4's own docstring says is wrong.

The signature was unmistakable once broken down by hour: missing minutes clustered at 21:00 UTC
(2,718), then 22-23 and 02-05 — the thinnest liquidity of the day, where a minute is most likely to
be genuinely flat. Whole-range checks could not see it; "no gap longer than four days" is blind to an
hour missing every night.

`normalizeBars` now takes `volumeIsMeaningful`, default true, and the rule is skipped when a feed does
not report volume. A real flat minute kept is a small inaccuracy; a real flat minute deleted is a hole
that every downstream check then reads as the market being closed. Re-imported: **664,720 → 738,570
bars (+73,850, +11.1%)**, and the feed now holds slightly MORE minutes than the bid feed over the
shared window, with 80,088 flat bars retained.

**This feed is MID, not bid.** Its closes sit +0.0000269 above Dukascopy's bid where the average bid
spread is 0.0000413 — a ratio of 0.65, and the matched set excludes the widest-spread quiet minutes,
so the true figure is nearer 0.5. The cost overlay assumes bars are BID and charges a full spread on
the side that buys at the ask. On a mid feed the correct treatment is half a spread each side, so the
overlay currently mis-attributes cost on this feed even though the total is close. **Not yet fixed** —
recorded so the two-year acceptance numbers are read with it in mind.

## A15 · Branded unit types

Four unit mix-ups have shipped, every one silent: account-vs-quote capital (out by ~148x on JPY), the
cross-check comparing yen with dollars, and the lots-vs-units tick bug TWICE — once in the same-bar
estimate, once in the fill audit a session later. The common cause is that all of these are `number`,
so the compiler is indifferent to multiplying a lot count by a tick.

`packages/shared/src/units.ts` adds `Lots`, `Units`, `Price`, `PriceDelta`, `QuoteMoney` and
`AccountMoney` as compile-time brands. Zero runtime cost — the values are plain numbers, the
constructors are identity functions — and the only way between brands is a named function that takes
the factor it needs (`lotsToUnits(q, contractSize)`, `quoteToAccountMoney(m, accountPerQuote)`).

The brands are applied to `CostedTrade`, and what that caught is the point: **exactly two production
sites mint a CostedTrade** — the cost overlay and the DB read — and the compiler found both. It also
forced `priceDeltaToQuote` and `financingCostQuote` to take `Units`, so a `Lots` value passed there no
longer compiles. That is precisely the bug from A5 and the fill audit, now unwritable.

Verified two ways: four `@ts-expect-error` assertions in `units.test.ts` fail the build if the brands
ever stop separating, and a scratch probe confirmed enforcement across the package boundary rather
than only within `shared`.

A caveat worth knowing: `pnpm typecheck` run from a package directory catches strictly more than
`npx tsc` from the repo root, because module resolution differs by CWD. The package script is
authoritative. Test factories now brand their defaults and accept plain-number overrides, so fixtures
stay legible.

Coverage is `CostedTrade`, the cost overlay, equity reconstruction and the DB boundary. The metrics
inputs and the validation check signatures still take plain numbers — worth doing, not yet done.

## A16 · Splice window is derived, not fixed

The splice window is now the longest timeframe the script actually requests through
`request.security`, floored at one week.

A fixed week was wrong: the leak horizon is one bucket of whatever was asked for, so a script reading
MN1 with `lookahead_on` sees up to a month ahead and a one-week splice leaves most of that month
untouched — the leak outlasts the perturbation and the check passes a leaking run. The causality seam
(A1a) already records every requested timeframe, so this is known rather than guessed. MN1 is treated
as 31 days, erring long: an over-wide splice costs donor history, an under-wide one misses leaks.

Re-verified after the change — the leaky fixture still fails, the clean twin still passes 6 of 6.

## A17 · Sealed holdout is back on the list

Spec 06 §3 includes a sealed holdout — reserve the most recent X% of data, exclude it from normal
runs, unseal once and record that it was viewed, and report "holdout viewed N times". It had dropped
off the remaining-work list. It now sits after walk-forward, which is the right order: the holdout is
the last thing a strategy should touch, and walk-forward is what it is being protected from.

## A18 · Brands reach the checks that got it wrong

A15 branded `CostedTrade`, the cost overlay, equity and the DB boundary. It stopped one layer short
of the validation checks — which is where both lots-vs-units bugs actually happened. They now take
branded inputs: `AuditTrade` carries `Lots`/`Price`/`AccountMoney`, and `MarketFill.qty` is `Units`
because the `pointValue` beside it is per unit.

That found a third instance of the same bug, still live. `marketFillsFromTrades` took a trade's
`qty` — LOTS — and handed it to an estimate that multiplies by a per-UNIT `pointValue`, so every
same-bar figure was out by the contract size and the report read "-0.00" over 176 fills. The
function now takes `contractSize` and converts. Two regression tests pin it: a 2-lot trade yields
200,000 units, and a one-lot gap of 1.0 prices at 100,000 rather than 1.

`valuePerTickPerQty` is renamed `valuePerTickPerLot`, because "per qty" is precisely the ambiguity
that caused this.

Metrics came almost free: `MetricsInput.trades` was already `CostedTrade[]`, so only `initialCapital`
and `openPnl` needed brands. Following them outward took the brand to the real mint sites — the CLI's
`--capital` argument, the worker pool task, and the validation runner — which is where a plain number
should become money and nowhere else. `initialCapitalInQuote` now takes `AccountMoney` and returns
`QuoteMoney` through the named `accountToQuoteMoney`, so bug #1's account-vs-quote confusion has a
type boundary rather than a comment.

Metric OUTPUTS are still plain numbers. That surface is large and every field is account money, so
it buys much less than the input side did; not done, and deliberately.

## A19 · Price basis is a property of the feed

Every stored price is one number, and until now the whole codebase assumed that number was the BID.
That is true of Dukascopy and of MT5-style broker exports, and false of Twelve Data, whose closes sit
about half a spread above the bid feed over the same minutes. A19 makes the basis explicit and
carries it through the run.

| source                 | basis  | why                                                                |
| ---------------------- | ------ | ------------------------------------------------------------------ |
| dukascopy, mt5, exness | `bid`  | quote feeds, bid side                                              |
| twelvedata             | `mid`  | measured +0.65x spread above the bid feed over 185k shared minutes |
| binance                | `last` | klines are TRADE prints, not quotes at all                         |
| anything else          | `bid`  | assumed, and reported as assumed                                   |

**Binance is `last`, treated as mid, and kept as its own label.** A spot kline is the last trade of
the minute; trades print at whichever side of the book they hit, so over a bar they land on both
sides and the mid is the honest approximation. It is not folded into `mid` because a report should
be able to say "last-traded prices, treated as mid" rather than claim a quote we never received. An
unknown feed falls back to `bid`, which is the conservative direction for a cost model — it charges a
buyer the full spread — and `describeBasis` says the basis was assumed rather than declared.

One function does the derivation: `deriveQuotes(bar, basis, spread)`, with `quoteFor` for a single
level. The invariant `ask - bid === spread` holds on every basis and is asserted on every field. The
spread itself still comes from the cost overlay's `spreadPriceAt`, so per-bar spreads, the configured
figure and the symbol default all keep working unchanged.

The basis is DERIVED from the run's feed, never configured. The feed guard (A6) already refuses a run
that straddles two sources and returns the single one, so a basis set by hand could only ever drift
away from the data underneath it.

**Three consumers.** The cost overlay charges `spreadShare(basis, side)`: a bid feed charges the
whole spread on the buying leg (long at entry, short at exit — exactly what it did before), a mid
feed charges half on every fill. A round trip still costs exactly one spread on every basis. The
asymmetry check uses the same arithmetic for levels. The M1 replay will use `fillSide` — sells
trigger on the bid, buys on the ask.

**The EURUSD.twelvedata cost breakdown did not move, and that is the correct result.**

    before   143 trades   spread 1136.00   longs 568.00   shorts 568.00   per trade 1.62 .. 8.00
    after    143 trades   spread 1136.00   longs 568.00   shorts 568.00   per trade 1.62 .. 8.00

This feed carries no per-bar spread at all — 0 of 738,570 bars — so every bar falls back to the same
0.8-point default, and half at entry plus half at exit equals a full spread at one leg. The basis
moves WHERE a cost is charged, not how much, whenever the spread and the FX rate are identical at
both fills. It diverges as soon as they are not: on the test fixture, whose bars carry 0.00008 at
entry and 0.0002 at exit, one long costs $8 on a bid basis and $14 on a mid basis.

So the mid-vs-bid error was never worth money in the cost TOTAL. It was worth money in the price
LEVELS, which is where the asymmetry check now finds it.

## A20 · Bid/ask asymmetry at stop and target levels

A resting order triggers when a QUOTE reaches it, not when the stored price does. A long exits by
SELLING, so its stop and target trigger on the bid; a short exits by BUYING, so its levels trigger on
the ask. The engine has one number per bar and triggers everything off it.

The error is ALWAYS adverse: a target gets harder to reach and a stop gets easier, on both sides, on
every basis. The spread never pays you. That is what makes it worth a check rather than a footnote —
a backtest flattered by targets that filled is flattered in a direction that is knowable.

Which exits are levels is read from the SOURCE, not guessed from prices. A trade's exit reason is the
id of the order that closed it: a reversal closes with the opposing ENTRY's id (`Long`/`Short` in our
fixtures), a bracket with its own (`Bracket`). `levelExitIdsFromSource` pulls the ids out of every
`strategy.exit` call, with comments and strings blanked first. An id given as a variable cannot be
resolved statically, so those exits are skipped and counted rather than assumed to be levels.

Verified on the 2022–2023 acceptance data, `rsi-mean-reversion`, H1, both feeds:

| feed               | basis | level exits | total error | flips  |
| ------------------ | ----- | ----------- | ----------- | ------ |
| EURUSD (dukascopy) | bid   | 89          | $99.07      | 0      |
| EURUSD.twelvedata  | mid   | 361         | —           | **10** |

The bid feed behaves exactly as predicted: the entire error lands on the shorts, long levels are
exact, and nothing flips. The mid feed fails: **10 of 361 level exits would not have triggered at
all** on the side of the book they actually fill on — e.g. trade 83's short target at 1.0561 needed
the stored price to reach 1.05606. Those trades are not merely mispriced, they did not happen, which
is why a flip is a `fail` and the level error alone is a `warn`.

A flip is scored only for TARGETS. A stop moves in the direction that makes it trigger sooner, so it
always still triggers — adverse, but not an outcome that can vanish.

## A21 · Every execution-bias total also reports per fill, in pips and ticks

A total in account currency is the worst unit for noticing that something is wrong. "$9,080.99" over
an unstated number of fills is unfalsifiable at a glance; "$12.58 per fill, 1.26 pips" is checkable
against what an H1 EURUSD bar actually does. All three execution-bias checks now report both, derived
from the PRICE gap each already computes — never by dividing money by a position size, which would
reintroduce the very lots-vs-units question these figures exist to expose.

Fills are also split by what sat between the signal bar and the fill: `normal` (one timeframe step),
`session` (a rollover or holiday) and `weekend`. The weekend test is calendar-based rather than a
duration threshold, because a Friday-to-Monday D1 step is only three days and no threshold separates
it from an ordinary one.

**It found a defect on its first run.** The same-bar estimate reported 1.26 pips per fill adverse,
and the breakdown showed 718 of 722 fills were `normal` gaps — so it was not weekend risk, and a
one-minute close-to-open move on H1 EURUSD is a fraction of that and randomly signed. The cause:
`marketFillsFromTrades` documents that only MARKET fills are comparable against the previous bar's
close, and `validateRun` was not passing `isMarketFill`. All 361 bracket exits were being scored as
if they had filled at the next bar's open, when they filled at their own LEVEL. On a losing run that
is systematically adverse, because stops outnumber targets.

    before   9080.99 over 722 fills   12.58/fill   1.26 pips
    after      -5.02 over 361 fills   -0.01/fill  -0.00 pips

The corrected figure is the honest one and it is near zero, which is itself the finding: on an
M1-resampled feed one bar's close and the next bar's open are adjacent minutes, so
`process_orders_on_close` would barely move this strategy's entries. The level-exit classifier from
A20 is what makes the exclusion possible.

## A22 · Missed stops are flips, and only an M1 replay can see them

A20's flip rule examines exits that HAPPENED, so it can only find phantom targets — a level the
correct quote never reached on the bar the engine closed on. It is blind to the opposite and worse
error: the side that trades crossing the stop on an EARLIER bar, on which the stored prices never
did. The trade really closed at a loss; the engine kept it open, often to a target. A missed stop
changes the SIGN of a trade and appears in no report the run produces.

The M1 replay walks every resting-order trade from entry to the close of its exit bar, minute by
minute, deriving both sides of the book from the feed's basis — a long's stop and target both trigger
on the BID because a long exits by selling; a short's both trigger on the ASK. The first level
genuinely touched wins. When one minute touches both, the STOP wins: a minute is still a bar with the
same ambiguity a step down, there is no deeper data to appeal to, and the pessimistic reading is the
only direction that cannot flatter a result.

**Levels are recovered from the run's own exits**, because the engine keeps no order log. A resting
order fills AT its level, so every favourable exit sits one target-distance from its entry and every
adverse exit one stop-distance; a supermajority vote on each cluster recovers both. This is not
circular with what the replay tests — the replay asks WHEN a level was reached, and the level is
correct even when the timing is not. Without two tight clusters the check reports `n/a`: a trailing
or dynamic stop needs a real order log, and inventing levels would manufacture flips rather than find
them.

Verified on `rsi-mean-reversion`, H1, 2022-01-01 .. 2024-01-01, both feeds:

| feed               | basis | exits | missed stops | phantom targets | P&L correction |
| ------------------ | ----- | ----- | ------------ | --------------- | -------------- |
| EURUSD (dukascopy) | bid   | 89    | **1**        | 0               | -255.00        |
| EURUSD.twelvedata  | mid   | 361   | **4**        | 10              | -850.00        |

Two things make this credible. **Zero phantom targets on the bid feed** is exactly right and was not
arranged: on a bid feed the engine triggers on the stored price and a long exits on the bid, which
are the same number, so long targets must reproduce exactly. And the mid feed's **10 phantom targets
match A20's 10 flips**, found independently from the whole holding period rather than from the exit
bar.

The five missed stops are the new finding, and they are invisible to every other check. Trade 73 on
the clean dukascopy feed entered and exited inside the SAME H1 bar (2022-05-31 14:00), whose M1 low
reached 1.06889 — well through its 1.07026 stop — and the engine booked the +20-pip target. That is
textbook intrabar ambiguity, and the engine resolved it OPTIMISTICALLY.

**A window bug was caught here and is worth recording.** The first version walked from entry to
`exitMs` and reported a third of all exits as phantom targets on the bid feed, where long targets are
exact by construction. A trade's `exitMs` is its exit BAR's open time (this repo's convention), and
the level that closed the trade was reached somewhere INSIDE that bar — so the replay has to walk to
the bar's CLOSE. The implausible number is what exposed it, which is the argument for A21.

## A23 · Levels come from the order log, not from clustering exit prices

A22 recovered stop and target levels by clustering exit distances. That works for a fixed bracket and
is useless for most real strategies: an ATR stop, a percentage stop, a swing-level stop or a trailing
stop produces a different level on every trade, the clusters never form, and both execution checks
report `n/a` — precisely on the strategies whose stops are worth checking.

The order log already records every `strategy.exit` call with its arguments RESOLVED at that bar, so
an ATR expression arrives as a number. It is now the authoritative source for the M1 replay and for
the asymmetry check's stop-versus-target classification. Clustering survives only as a fallback for a
run with no order log.

Measured on the new `atr-bracket` fixture, EURUSD H1 2022-01-01 .. 2024-01-01: **183 distinct adverse
exit distances across 296 trades**, spanning 0 to 0.00976. Clustering's supermajority vote returns
null on that, so both checks would have said `n/a`. With the order log both produce results — 3
asymmetry flips and 4 replay flips out of 102 level exits.

Four things this required getting right, three of which were only visible on real data:

1. **`profit`/`loss` are TICKS from the entry; `stop`/`limit` are absolute prices.** Tick distances
   are resolved against the trade's own entry price. An absolute price wins when both are given,
   which is Pine's own precedence.
2. **A level set on bar N applies from bar N+1.** Pine runs the script at the bar's close, so the
   resting order it creates cannot be hit on the bar that created it.
3. **An exit call that UPDATES an order reports `noop`, not `placed`,** because PineTS's
   `pending_orders` does not grow. Filtering the log to `placed` would discard every level update —
   the entire ATR case. Only our own `suppressed` rows are excluded.
4. **Absolute levels are scoped to the position; tick levels are not.** An absolute stop is derived
   from `strategy.position_avg_price`, so a row belonging to the previous position is a different
   price entirely. Ignoring that reported **56 of 102** ATR exits as missed stops. Applying the same
   bound to TICK levels then skipped the entry bar of every fixed-bracket trade and turned
   unassessable trades into false phantom targets — 39 instead of 10. Only the absolute form needs
   the bound, and the fixed-bracket run reproducing its clustered baseline **exactly** (14 flips, 4
   missed stops, 10 phantom targets, -850.00) is what proves the distinction is right.

**Trailing stops are reported `n/a` explicitly.** A trail's level depends on the path taken since it
armed, so it is not a level until simulated, and replaying it as a fixed one would manufacture flips.
The spec allowed either simulating or declining; declining is the conservative option and the failure
mode of the alternative is inventing findings, which is the one thing these checks must never do.

Known limitation, reported rather than hidden: when a script uses several exit ids the most recent
call wins. `ExitLevelIndex.distinctIds` counts them so a multi-bracket script is visible.

## A24 · Recorded ahead of the remaining steps

Four constraints for work not yet started, recorded now so they are not rediscovered late.

**OOS split — run the out-of-sample segment as its own run from initial capital**, with warmup
supplied through the gate rather than by slicing the full run's bars. Slicing is the obvious
implementation and it is wrong under any equity-proportional sizing: the OOS slice inherits position
sizes grown by in-sample profits, so a strategy looks better out of sample exactly when it did well
in sample. A separate run from the same starting capital is the only comparison that means anything.

**Walk-forward — WFE is `n/a` when the in-sample return is <= 0.** Walk-forward efficiency is
out-of-sample return over in-sample return. Two negatives divide into a flattering positive, so a
strategy that lost money in both halves would report an encouraging number. Undefined is the honest
answer, and this repo already says a genuinely undefined metric is `null` and never 0.

**Sealed holdout — the seal has to hold everywhere data is read**, not only in the validation runner:
the Studio's date presets, the timeframe matrix and walk-forward all load bars, and a seal that only
one path honours is not a seal. The unseal count is only meaningful if every reader goes through the
same gate.

**Regimes — label each trade with the regime known at its ENTRY**, computed from D1 values up to the
previous day's close. Classifying a trade by the regime of the day it ran in uses that day's close to
describe a decision taken before it, which is look-ahead inside the very report meant to detect
look-ahead.

## A25 · Several exit ids: pair by id, or report n/a

A23 left a known limitation — with more than one exit id in play, the most recent call won. That is
guesswork, and it fails in the ordinary case rather than an exotic one: a partial-exit strategy with
a `TP1`/`TP2` pair has two brackets live on every trade, and pairing a `TP1` fill with `TP2`'s level
manufactures a flip.

Trades already carry the id of the order that closed them (`exitReason`), so the fix is to track
levels per id and match. When the closing id cannot be identified — it names no bracket, as a
reversal's does — the trade is reported `n/a`, following the trailing-stop rule for the same reason:
inventing a finding is worse than declining one.

Proven with a new `partial-exits` fixture: two `strategy.exit` calls, one with `qty_percent=50`, both
live on every position. EURUSD H1 2022-01-01 .. 2024-01-01 produces 1,171 closed trades, of which
**998 were replayed with their own bracket's levels and none were ambiguous** — the per-id path
works, so the n/a fallback is not what carries this case.

Unchanged, as required:

| fixture       | levels     | flips | missed stops | phantom targets |
| ------------- | ---------- | ----- | ------------ | --------------- |
| rsi (fixed)   | ticks      | 14    | 4            | 10              |
| atr-bracket   | ATR prices | 4     | 0            | 4               |
| partial-exits | two ids    | 17    | 10           | 7               |

## A26 · Follow-up after slice D: trailing-stop replay

Not now, and recorded so it is not lost. Trailing stops are currently `n/a` in the M1 replay (A23).

If a trail simulation is ever written, it must first reproduce the ENGINE's own trailing exits
exactly, on the ENGINE's bars, before it is allowed to run on M1. A trail depends on the path taken
since it armed, so a simulation that disagrees with the engine on the engine's own data is measuring
its own bugs — and it would report them as flips, which is precisely the failure mode every one of
these checks is built to avoid. Agreement on the coarse series is the only evidence that the finer
one is telling the truth.

## A27 · Cost stress, cross-checked against the analytical break-even

The stress re-runs the backtest with spread, slippage and financing scaled together and interpolates
the multiplier at which net profit reaches zero. Zero is in the ladder deliberately: it is the only
point that separates "costs killed this" from "this never had an edge". The ladder extends to 5x,
10x and 20x only while the strategy is still alive at the top, so the common case stays cheap.

Surviving every multiplier tested is a **pass**, not `n/a` — it is the strongest result this check
can give. `n/a` is reserved for a strategy that loses money with execution switched off entirely,
where there is no cost sensitivity to measure.

**The cross-check.** The metrics report already states a break-even per side analytically, as
`netProfit / (2 x totalUnits x pointValue)`. Under linear cost scaling with a fixed trade set the two
are the same quantity, so agreement is the null result and disagreement is the finding. Measured on
`rsi-mean-reversion`, EURUSD H1 2022-01-01 .. 2022-07-01, no slippage:

    break-even 5.22x actual costs; empirical 0.84 pips/side, analytical 0.84 pips/side

Exact. And it should be: with `slippagePoints: 0` only the spread scales, and the overlay charges
exactly one spread per round trip on every price basis (A19) — the basis decides which fill carries
it, not how many. So the basis cannot move this figure.

**The cross-check found a real bug the moment slippage was switched on.** With 15 ticks of slippage
the same run reported total costs rising from 355 to 3,025 while net profit did not move at all — and
the break-even disagreed by **751%**. Cause: `config.slippagePoints` was never passed to the engine.
Slippage has to travel as a strategy PROP, because it moves a fill price and therefore changes which
orders survive a margin check; the overlay cannot apply it afterwards. Meanwhile the cost waterfall
attributes `slippageCost` and adds it back to recover gross, asserting it is already inside the
engine's P&L. It was not. Anyone configuring slippage got overstated total costs, overstated gross,
and a wrong cost drag, with net profit silently unaffected.

Fixed by passing `slippage: costs.slippagePoints` in the engine overrides (Pine measures it in ticks,
which is what `slippagePoints` already is). The same run then moved from +1,499.61 to **-1,588.05**.

**Two things measured rather than assumed while doing this.** First, PineTS charges slippage on BOTH
legs, including a bracket exit resting at its own level — the $3,088 swing over 89 trades is $34.70
per trade against $15 per fill, 2.3 fills' worth. TradingView documents the opposite for limit
orders, so this is an engine difference worth recording; the analytical factor of 2 is right here. An
earlier draft of this check asserted the fill-mix explanation and it was **plausible and wrong**,
which is the failure mode every check in this slice is built to avoid. Second, Pine's `slippage` prop
is an int, so the stress quantises it to whole ticks and 0.5x of 15 is 8, not 7.5; the analysis reads
each run's own reported costs rather than the nominal multiplier, so the rounding appears in the
numbers instead of being absorbed.

**Residual disagreement, explained.** With slippage on, the two figures sit **6.1%** apart (-0.95
against -0.89 pips). The named cause is that scaling costs changed the trade set — moving fill prices
changes which orders survive a margin check — so net profit is not linear in the multiplier while the
analytical form assumes it is. That non-linearity is itself a result worth reporting: an edge whose
break-even moves when execution moves is more fragile than a single number suggests.

## A28 · Slippage measured per fill: PineTS slips limit fills, TradingView does not

A27 concluded that PineTS charges slippage on both legs from an aggregate: switching slippage on moved
net profit by $34.70 per trade against $15 per fill. That reasoning was not sound. The same change
also moves fill prices, which changes which orders survive and where they exit, so the swing mixes
slippage-per-fill with a changed trade set and cannot separate them. The conclusion happened to be
right; the evidence did not support it.

Measured properly now: every fill is compared against the price it would have had with slippage off —
a market fill against its bar's open, a stop or limit fill against its resting level from the order
log, or against the bar's open where price gapped through the level, since a gap is not slippage.

`rsi-mean-reversion`, EURUSD H1, 2022-01-01 .. 2022-07-01:

| fill type | control, `slippage=0` | `slippage=15`         |
| --------- | --------------------- | --------------------- |
| market    | 89 fills, 0.00 ticks  | 89 fills, 15.00 ticks |
| stop      | 53 fills, 0.00 ticks  | 59 fills, 15.00 ticks |
| limit     | 36 fills, 0.00 ticks  | 30 fills, 15.00 ticks |

**Limit fills are slipped**, by exactly the configured amount, like every other type. TradingView
never slips a limit order — it fills at its price or better by definition — so this is a real
divergence. Recorded in `docs/pinets-notes.md` and surfaced as a `divergent-strategy-prop`
compatibility warning, deliberately NOT as the existing "ignored prop" warning: telling a user that
`slippage` is ignored while it is charging them on every fill would be worse than silence.

The control is what makes the measurement trustworthy — all three fill types measure exactly 0.00
ticks with slippage off, so the reference prices are right rather than approximately right. And the
fill counts moving between the two runs (53 -> 59 stops, 36 -> 30 limits) is the confound made
visible: it is precisely why the aggregate could not answer this.

**The classifier had to be rewritten to see it.** The first version identified a stop or limit fill by
proximity to its level, within five ticks. With fifteen ticks of slippage configured, every slipped
limit fill missed that tolerance and was reclassified as a market fill — so the run reported ZERO
limit fills on a bracket strategy, and market fills averaging -25 ticks against a reference that had
silently become the bar open. Proximity cannot identify a fill when the quantity being measured is
how far the fill moved. Classification now comes from the exit ID in the order log, which says which
order closed each trade; only stop-versus-target is decided by distance, and those two can never be
confused because a long's target is always above its stop.

**The waterfall's slippage line is now these measured amounts**, not `2 x slippagePoints x mintick x
units`. On this fixture the two agree to the cent, because every fill does slip by the configured
amount — but that is a coincidence of this strategy, not a guarantee, and a gap fill referenced
against the bar's open would break it. The point is that the costs shown are now the costs charged by
construction rather than by luck.

Cross-check re-run afterwards, unchanged: zero-slippage agrees exactly (0.84 pips per side either
way, break-even 5.22x actual costs); with slippage the two sit 6.1% apart with the moving trade set
as the named cause.

## A29 · Limit-fill slippage is refunded

A28 established that PineTS slips limit fills and TradingView does not. This decides what to do
about it: credit it back.

A limit order cannot fill worse than its price in a real market — that is what a limit order is. Its
real risk is not filling at all, and the phantom-target check (A22) already measures exactly that,
trade by trade. Charging slippage on top penalises every take-profit for a risk it does not carry,
skews any comparison between exit styles (a bracket strategy pays twice, a signal-exit strategy
once), and makes TradingView comparison impossible whenever slippage is on.

The measured per-fill amount (A28) is added back as its own waterfall line — "limit-fill slippage
refunded: engine divergence" — rather than folded silently into P&L. A correction the user cannot see
is indistinguishable from a bug.

**The P&L identity stays exact.** The engine already took the slippage out of the fill price, so the
refund appears in gross and is NOT subtracted again on the way to net:

    grossPnl = enginePnl + commission + slippageCost + slippageRefund
    netPnl   = enginePnl + slippageRefund - spreadCost - financingCost

`totalCosts` excludes the refund deliberately — it was never a cost that was charged and returned, it
is a correction — so `grossBeforeCosts - totalCosts === netProfit` continues to hold.

Verified on `rsi-mean-reversion`, EURUSD H1 2022-01-01 .. 2022-07-01 with `slippage=15`: 30 limit
fills at $15 each is **$450.00 refunded**, net profit improves from -1,588.05 to **-1,138.05** and
total costs fall from 3,023.05 to 2,573.05 — each by exactly $450.00.

**The analytical break-even now counts only chargeable sides.** A limit fill cannot degrade, so it is
not a side execution can get worse on. The denominator is a per-trade count rather than a flat factor
of two, and the same array is shared with the cost stress rather than recomputed — computing it twice
is how two figures that should be identical end up several percent apart for a reason nobody can
name. On the zero-slippage control this moves the figure from 0.84 to 1.06 pips per side, which is
the honest number: 36 of the 89 trades exit on a limit and contribute one side, not two.

Cross-check re-run afterwards. The control agrees **exactly** — 1.06 pips per side either way,
break-even at 5.22x actual costs. With slippage on the two sit 11.6% apart, with the same named cause
as before: scaling costs changes the trade set and the fill mix, so a single baseline denominator
cannot describe every point on the ladder while the analytical form assumes linearity.

The compatibility warning now says the platform corrects for the divergence rather than merely
reporting it, so a user reading it knows their net P&L already matches TradingView's treatment and
only the engine's intermediate fill prices differ.

Schema: `run_trades.slippage_refund` (migration 0004). Persisted rather than derived, because a
stored run should show what was actually credited.

## A30 · Regime mix belongs in the OOS report

Recorded now, to be done when regimes land (step 5). Each segment of the OOS split — and each
walk-forward fold — reports the regime mix of its own window alongside its metrics.

Without it, a strategy that performed differently out of sample is indistinguishable from one whose
out-of-sample window simply contained a different market. Trending-to-ranging is the ordinary case
over a two-year span, and calling that overfitting is a false positive that would discredit the whole
report. Per A24, regimes are labelled from D1 values up to the previous day's close, so the mix
itself carries no look-ahead.

## A31 · Follow-up after slice D: spread on resting fills from the replay, not per fill

Not now. Recorded so the reasoning is not lost.

The cost overlay charges spread per round trip regardless of how each leg filled (A19). That is right
for a MARKET fill, which genuinely crosses the book at the moment it happens. It is the wrong model
for a stop or a limit: a resting order does not pay a spread when it fills, it fills when the
relevant side of the book reaches its level. The cost of the spread there is not a charge at all —
it is a difference in TIMING, and sometimes in whether the fill happened.

The M1 replay already measures exactly that. It walks each holding period with sells on the bid and
buys on the ask and reports what really triggered, including stops that fired earlier than the engine
thought and targets that never fired at all (A22), with the P&L correction attached. So the honest
model is: market fills keep the per-fill spread charge, and stop and limit fills take their spread
effect from the replay's measured correction instead.

Doing it now would be premature. The replay currently reports `n/a` for trailing stops (A23) and for
unresolvable multi-bracket exits (A25), so a straight substitution would silently un-charge the
spread on precisely the trades it cannot measure — turning a modelling gap into free execution. That
has to be closed first, which is what A26 (trailing-stop replay) is for.

## A32 · Out-of-sample split

The first 70% of the window is where fit is measured, the last 30% is the honesty test. The question
is never whether the out-of-sample half made money — it is whether the edge the in-sample half showed
SURVIVED into data the strategy was not shaped around.

**Each segment is its own run from the same starting capital** (A24), not a slice of the full run.
Slicing is the obvious implementation and it is wrong under any equity-proportional sizing: the
out-of-sample slice would inherit position sizes grown by in-sample profits, so a strategy would look
better out of sample exactly when it did well in sample. Warmup needs no special handling — the
engine already loads bars before `fromMs` and its gate suppresses orders on them, so the second
segment starts warm without trading early.

70/30 rather than 50/50: the out-of-sample half only has to be long enough to produce a usable number
of trades, and every bar given to it is a bar the in-sample half cannot use to establish there was an
edge at all.

**Two `n/a` cases, both deliberate.** Fewer than ten trades in either segment, because a ratio
between two small samples describes the samples. And an in-sample half that lost money — there is
then no edge whose persistence could be tested, which is neither a pass nor a failure of the split.
Every ratio guards its denominator rather than checking the result afterwards, per A24.

**It discriminates on real data.** EURUSD H1, 2022-01-01 .. 2022-07-01, split at 70%:

| fixture            | in-sample | out-of-sample | verdict  |
| ------------------ | --------- | ------------- | -------- |
| rsi-mean-reversion | PF 1.10   | PF 1.75       | **pass** |
| supertrend-atr     | +5,187.75 | **-487.88**   | **fail** |
| bollinger-breakout | +4,270.92 | **-3,219.33** | **fail** |

Two of the three fixtures that looked profitable over the full window do not survive the split. That
is the check earning its place on the first real run.

**A near-zero denominator is the soft form of the A24 trap.** `macd-htf-filter` returned 0.60% in
sample and 11.49% out of sample, which the ratio rendered as "kept 1911%" — a division result
presented as a triumph. The ratio is now withheld below a 1% in-sample return, with the reason
stated: the in-sample half barely established an edge to test. Still a pass, since it did make money
out of sample; just not a headline number that means nothing.

Regime mix per segment is still to come with step 5 (A30), so a regime shift between the halves is
not mistaken for overfitting.

## A33 · A3 settled: transpile is not worth caching

A3 said to measure transpile against run before building walk-forward, and to transpile once per
worker thread if `runPretranspiled` accepts an inputs map. Measured, on `rsi-mean-reversion`,
EURUSD H1, by splitting engine time into setup (parse, transpile, overrides, seam installation — no
bars, no I/O) and execution:

| window             | bars  | setup | execute |
| ------------------ | ----- | ----- | ------- |
| 2022-01 .. 2022-02 | 506   | 15ms  | 60ms    |
| 2022-01 .. 2022-04 | 1,539 | 12ms  | 94ms    |
| 2022-01 .. 2022-07 | 3,099 | 14ms  | 168ms   |

Setup is FLAT at ~14ms and does not grow with the window. Execution fits ~39ms fixed plus
**0.042ms per bar**. So a run costs about `53ms + 0.042 x bars`, and caching the transpile would save
14ms of it.

**Not worth doing, and not for the reason A3 anticipated.** The saving is real but small — 14ms
against 187ms on a six-month H1 run, and walk-forward at four folds is eight runs, so about 110ms
total. Against that, `runPretranspiled` bypasses the instrumentation seam entirely (recorded in
`docs/pinets-notes.md` under open questions), which means no order log and no warmup gate. The order
log is what A23 reads stop and target levels from and what A28 classifies fills with; the gate is
what makes each fold's warmup honest. Trading those for 110ms would break the checks walk-forward
exists to serve.

`setupMs` and `executeMs` are now reported in `EngineStats` and printed by `pnpm backtest`, so the
next person asking this question measures rather than re-derives.

## A34 · Walk-forward

Rolling, not anchored: the in-sample window is a fixed width that moves forward, so every fold is
fitted on the same amount of data. An anchored window grows, and later folds would then be fitted on
more history than earlier ones — the thing being measured would change as the measurement proceeded.

Layout is `folds + ratio` equal blocks; fold i trains on blocks [i, i+ratio) and tests on block
i+ratio. Four folds at a 3:1 ratio. Four rather than ten because each fold is two engine runs and,
more importantly, because a finer layout produces test windows too small to hold enough trades — at
which point the check reports `n/a` and has said nothing. The fold count is a statement about trade
frequency, not statistical power.

**This settles the open question the repo has carried since slice D began**: a structurally short
walk-forward segment reports `n/a`, never `fail`. A fold that produced three trades has not tested
anything, and failing it would punish a strategy for the fold layout rather than for its behaviour.
Two `n/a` cases: fewer than two assessable folds, and no fold that trained profitably at all —
nothing there is overfitted because nothing was fitted.

WFE follows A24 exactly: null when the in-sample return is not strictly positive, and flagged
unstable below a 1% in-sample return, with the median taken over stable folds only so a 20x outlier
from a near-zero denominator cannot drag the summary.

**Measured on real data, and it disagrees with the single OOS split in BOTH directions**, which is
the argument for keeping both:

| fixture            | OOS split | walk-forward                       |
| ------------------ | --------- | ---------------------------------- |
| rsi-mean-reversion | **pass**  | **warn** — 1 of 2 folds, WFE -0.07 |
| supertrend-atr     | **fail**  | **warn** — 3 of 4 folds, WFE 0.45  |
| bollinger-breakout | **fail**  | **fail** — 1 of 3 folds, WFE -0.12 |

`supertrend-atr` fails a single split but holds in three folds of four while keeping under half its
in-sample return — the split landed on one bad window. `rsi-mean-reversion` is the reverse: it passes
the single split and holds in only one fold of two. One split can survive, or fail, by luck; rolling
folds are what tell the two apart.

A full validation is now 13 checks and about 30 engine runs, in 2.6s on six months of H1.

## A35 · The rolling check is not walk-forward optimization

A34 shipped rolling folds running the script's OWN input values. That is a useful stability check and
it stays in the default suite, but calling it walk-forward was wrong: nothing is selected in sample,
so nothing's GENERALISATION is being tested. A strategy whose inputs were tuned by hand on this very
data sails through it.

It is now `overfitting-rolling-oos`, "Rolling out-of-sample (fixed parameters)", and its
out-of-sample-over-in-sample ratio is called RETENTION rather than walk-forward efficiency. WFE is
reserved for the check where a parameter set was actually chosen.

**Walk-forward optimization is a separate, opt-in check.** Per fold it sweeps up to three inputs,
picks a winner in sample, and runs that winner out of sample as its own run from initial capital
(A24). Opt-in because four folds at the 300-combination cap is 1,204 engine runs.

Four decisions inside it, each of which could quietly invalidate the result:

- **The trade floor is applied BEFORE ranking, not as a tiebreak.** A set that took two trades and
  won both has the best profit factor in almost any grid; letting it win is precisely how an
  optimiser selects noise.
- **Above the cap the grid is SAMPLED, not truncated.** Taking the first 300 of an enumerated grid
  sweeps the first input thoroughly and never moves the last — a search in appearance only. Sampling
  is seeded, so a spec is reproducible.
- **Ties break towards the middle of a range.** An extreme of a swept range is more likely a boundary
  artefact than a real optimum.
- **Drift is scored on its own account.** A procedure can be profitable and still be fitting noise:
  if the optimum jumps across half its range every fold, the next fold's winner is a coin flip.

Verified on `rsi-mean-reversion`, EURUSD H1 2022-01-01 .. 2022-07-01, sweeping `rsiLen` 6..24 and
`oversold` 20..40 for net profit — **FAIL**:

    fold 0: rsiLen=20 oversold=35   IS 13.90% -> OOS -0.31%   WFE -0.07
    fold 1: rsiLen=24 oversold=30   IS  8.58% -> OOS -0.10%   WFE -0.03
    fold 2: rsiLen=6  oversold=20   IS 14.73% -> OOS  0.75%   WFE  0.15
    fold 3: rsiLen=14 oversold=30   IS  7.56% -> OOS  0.47%   WFE  0.18

    drift: rsiLen 20 -> 24 -> 6 -> 14, mean step 56% of range, 4 distinct values in 4 folds

In-sample returns of 8-15% become out-of-sample returns within half a percent of zero — median WFE
**0.06** (normalised per day, A36), so essentially none of the fitted edge survives. The optimum lands on a different value
every fold, and the sensitivity grid shows two separate hot cells with a dead zone between them
rather than a plateau. The same fixture PASSES the single OOS split and only WARNS on the rolling
check; the optimization is what says the selection procedure is worthless.

**The first ETA was 21x low, and fixing it found a real inefficiency.** Estimating from A33's engine
model (53ms + 0.042ms/bar) predicted 3.8s for a run that took 79.9s, because that model contains
neither the M1 read in front of every candidate nor pool startup. Caching bars per thread per window
— every candidate in a fold reads the SAME window, only the inputs differ — cut it to 24.2s with a
byte-identical verdict. The estimate is now fitted to two measured runs at 7 threads (40 runs in
13.8s, 204 in 24.2s): ~11s pool startup plus ~444ms per run per thread. It now predicts 23.9s against
27.1s actual, which is the right order of accuracy for a progress estimate.

## A36 · Ratios normalise by window length

WFE, the rolling check's retention and the OOS split's return ratio all compared RAW returns over
windows of different lengths. With 3:1 folds a strategy performing identically in both windows scored
0.33; with the 70/30 split it scored 0.43. Those numbers are properties of the fold layout, not of
the strategy, and every retention figure this repo has reported read as decay when nothing had
decayed.

All three now divide each window's return by its length in CALENDAR DAYS before taking the ratio, so
1.0 means "earned at the same rate in both windows".

**Simple division, not compounding.** De-compounding a six-week window into a daily rate takes a
root, which amplifies whatever happened inside a short window — and the out-of-sample window is
always the short one here. The quantity wanted is "how fast was it earning", and over windows this
short the arithmetic reading is the honest one.

A24's guards stay on the RAW in-sample return. "Was there an edge to retain" is a question about the
window's actual result, and dividing by its length cannot change that sign — so the non-positive
guard and the near-zero stability floor are unchanged.

**One recorded verdict changes.** `supertrend-atr` on the rolling check read 0.45 and warned; per day
it is **1.36**, and it now passes — it held in three folds of four and earned FASTER out of sample
than in. The sharper reading is that it fails a single 70/30 split while passing the rolling check
outright, which strengthens rather than weakens the argument for keeping both. Two figures move
without changing their verdict: `rsi-mean-reversion` -0.07 to -0.20, `bollinger-breakout` -0.12 to
-0.37. The walk-forward optimisation's median WFE moves 0.02 to 0.06 and remains a failure.

The thresholds keep their numeric values — warn below 0.5, and so on — because for the first time
they now mean what they always claimed to: half the in-sample earning rate.

## A37 · The sealed holdout is enforced at the bar reader

Spec 06 §3's holdout reserves the most recent share of a symbol's data. The point is not secrecy —
it is that looking is RECORDED, so a result on the holdout means something the first time and
progressively less after that. A holdout viewed nine times is in-sample data with extra steps, and
the only thing that makes that visible is the count.

**The seal is applied in `readM1`, which is the one function every reader goes through** — the
Studio's date presets, the backtest job, the validation runner, the rolling folds, walk-forward
optimisation. A24 called this out and it is the whole design: enforcing it in the validation runner
would be theatre, because five other paths load bars and any one of them would hand the holdout over
without comment. Reading sealed bars requires `readM1Unsealed`, which increments the view count
BEFORE returning anything, so there is no route to the data that leaves no trace.

**Truncation, not refusal.** A run whose range overlaps the seal still runs, on the data it is
allowed. Refusing would push people towards unsealing for ordinary work, which is exactly the habit
the seal exists to prevent. What it must never do is return sealed bars while reporting the requested
range, so the caller is told what was withheld.

**`sealed_from` is an instant, frozen at sealing, not a fraction.** A fraction would move as new data
arrived, so yesterday's out-of-sample result would quietly become part of today's training set.

**Re-sealing is refused.** Moving a seal is the one operation that makes the view count meaningless:
look at the data, move the boundary, and the counter reads zero over ground already walked. Dropping
a holdout is explicit and separate.

The seal is consulted on every read, so it is cached per client and per symbol, invalidated only by
the two writes that can change it. Deliberately not time-based — a cache that expires on its own
would mean enforcement quietly weakening while the process runs.

Verified against the real stack on EURUSD, 2022-01-01 .. 2022-07-01 at a 20% holdout:

    unsealed read   185,122 bars, last 2022-06-30T23:59
    sealed at       2022-05-25T19:12
    sealed read     147,580 bars, last 2022-05-25T19:11   (37,542 withheld)
    read wholly inside the seal   0 bars
    view count 0 -> readM1Unsealed returns 185,122 -> count 1

The last sealed bar sits one minute before the seal instant, which is the half-open boundary
behaving. `pnpm test:e2e` stays 25/25: with no holdout sealed, every read is unchanged.

Still to build: the `pnpm holdout` CLI (seal / status / drop), and a validation check that reports
"holdout viewed N times" beside the verdict so a weakened holdout is visible in the report rather
than only in the database.

## A38 · A seal is retired, never deleted

A37 let a holdout be dropped. That quietly undid the thing A37 was careful about: `sealHoldout`
refuses to RE-seal because moving a boundary resets the view count over ground already walked — and
drop-then-seal reached the same result in two commands instead of one. A loophole reachable in two
steps is not closed.

Seals are now rows with an identity and a `retired_at`, never removed. A symbol has at most one
ACTIVE seal, enforced by a partial unique index in the database rather than by the repository, and
any number of retired ones. `describeHoldout` takes the whole history, so a fresh seal reporting
"never viewed" also reports that three earlier seals over the same ground were retired after twelve
views between them. Every report names the seal it ran under — without an id, "viewed 0 times" cannot
distinguish a pristine holdout from a fresh one over well-trodden data.

Proven end to end: seal, retire, re-seal. The new seal reports _"1 earlier seal(s) on this symbol
were retired after 0 view(s) in total, so this data is not untouched"_, and the history lists both.
The three retired seals now on EURUSD are from this verification and stay on the record, which is the
feature behaving.

There is deliberately no `--unseal` command. Reading past a seal happens through `readM1Unsealed` at
the point of use, which counts the view first; a command that dumped the holdout would make looking
feel like administration rather than a decision.

## A39 · Truncation is announced, never silent

A37 truncated a read at the seal and said nothing. A run that covers less than it appears to is worse
than one that refuses, because its numbers look like an answer.

`readM1` now returns `{ bars, truncation }`. The truncation is part of the RETURN TYPE, not a
callback or a queryable "last truncation", because both of those rely on remembering to look — the
same failure that putting the seal at `readM1` was chosen to avoid. The compiler listed all sixteen
call sites; the ones that load a run's own range surface the cut, and conversion-pair loads take a
`readM1Bars` helper because they read the window the run was already truncated to.

Withheld bars are COUNTED, not derived from the withheld duration: bars are not evenly spaced and a
figure computed across a weekend would overstate the loss badly.

Verified on EURUSD H1 with a seal at 2022-05-27 and a run requested to 2022-07-01:

    pnpm backtest  NOTE: a sealed holdout cut this range at 2022-05-27 — 35621 M1 bars withheld.
                   The run below covers less than you asked for.
                   3,099 bars -> 2,503, 89 trades -> 71
    pnpm validate  FAIL Sealed holdout — every figure in this report describes the shorter window

A truncated run FAILS validation rather than warning: its figures answer a different question from
the one asked. A run entirely before the seal emits nothing, and `pnpm test:e2e` stays 25/25 with no
holdout sealed, so the announcement has no false positives.

The holdout is now complete: `pnpm holdout <SYMBOL> [--status | --seal <fraction> | --retire]`, the
seal enforced at `readM1` (A37), the history preserved (A38), and truncation announced in both the
backtest output and the validation report (A39).

## A40 · Three constraints for the remaining checks

**Regime labels get their full lookback, or none.** Direction needs 200 D1 bars before the window and
the volatility percentile needs 252. Days without that history are labelled `unclassified` rather
than computed from an expanding window: an expanding window makes the first weeks' labels mean
something different from the rest, so a regime breakdown would compare a 30-bar direction against a
200-bar one and call both "trending". The unclassified share is reported, because a breakdown that
silently covers half the run is worse than one that says so. Verified on `EURUSD.twelvedata`, whose
two years give the lookback real coverage — the six-month dukascopy working set would be almost
entirely unclassified once 252 D1 bars are required, which is itself the argument for the rule.

**A timeframe-matrix cell is `n/a` when the chart timeframe is HIGHER than one the script requests
through `request.security`.** A script reading H1 inside an M15 chart is doing something coherent;
the same script on a D1 chart is asking for a lower timeframe than its own bars, which PineTS and
TradingView resolve differently and neither resolves usefully. Running it anyway produces a number,
and a number from an incoherent configuration is worse than a blank. The causality log (A1a) already
records every requested timeframe, so this is known rather than guessed, and the reason is printed in
the cell.

**Holdout truncation records the EFFECTIVE range as the run's range**, with the requested range
recorded beside it, and the check drops from `fail` to `warn`.

A39 kept the requested range on the run and failed the check, which was the wrong shape twice over.
A run whose stored range says one thing while its bars say another is a lie in the database, and
every downstream consumer — the report header, the compare view, the metrics window — would have to
remember to correct for it. Recording what actually ran makes the numbers match their stated window
by construction, and the requested range beside it is what makes the truncation visible.

And `fail` was the wrong severity: it is reserved for a strategy failing a check. A truncated run is
not a failing strategy, it is a shorter question honestly answered. `warn` says so without implying
the strategy did anything wrong.

**Implemented, and it moved where the fact lives.** `backtest_runs.requested_range_to` is set only
when a seal cut the request; `range_to` is the effective end. That has a consequence worth stating:
re-validating such a run is NEVER truncated, because its stored range no longer reaches the seal. The
check therefore reads the truncation from the RUN RECORD rather than from its own bar read — the
first version read the latter and silently reported `ok`. Verified end to end:

    backtest   NOTE: cut at 2022-05-27 — 35621 M1 bars withheld
    stored     range_from 2022-01-01  range_to 2022-05-27  requested_range_to 2022-07-01
    validate   warn Sealed holdout — recorded against the shorter window it actually covered,
               so every figure here matches its stated range

## A41 · Regime D1 bars close at the New York close

The regime classifier builds its own daily series anchored at **17:00 America/New_York, DST-aware** —
not the Exness-style 00:00 UTC day the rest of the platform uses.

The Exness day splits the FX week into SIX daily bars, because the market opens Sunday 22:00 UTC
(21:00 in summer) and that stub runs only until midnight. Three things follow, all of which corrupt a
regime label:

- **SMA(200) covers 33 weeks instead of 40.** A "200-day" direction filter that actually spans a
  sixth less calendar time is measuring a different thing from the one it is named after, and the
  discrepancy is invisible in the output.
- **ATR is dragged down.** A two-hour bar has a fraction of a day's true range, and one in six bars
  being a stub pulls the average below what a day of movement actually is — so the volatility
  percentile reads calmer than the market was.
- **ADX is distorted** for the same reason: directional movement over two hours is not comparable
  with directional movement over a day, and the smoothing mixes them.

**The New York anchor alone does NOT deliver five sessions, and measuring it is what showed that.**
The first implementation gave 5.81 sessions a week and a 200-bar span of 33.7 weeks — barely better
than the 33.1 it was supposed to fix. The cause: the feed carries 8,708 Sunday bars over a year
because the market opens Sunday evening, and 17:00 New York is 21:00 UTC in summer but 22:00 in
winter — so in winter the boundary lands exactly on those opening bars and cuts 41 sessions of a
single bar each. The anchor had MOVED the stub, not removed it.

The FX week's first session runs from the Sunday open to Monday's close, so a Sunday boundary should
not exist at all. Dropping it (`fxSessionBoundaries`) is what actually works. Measured over one year
of EURUSD.twelvedata:

|                                | FX week (NY close, no Sunday) | Exness day (00:00 UTC) |
| ------------------------------ | ----------------------------- | ---------------------- |
| daily sessions                 | 260                           | 312                    |
| sessions per week              | **5.00**                      | 6.00                   |
| span of 200 bars               | **39.6 weeks**                | **33.1 weeks**         |
| mean daily range               | 0.01017                       | 0.00880                |
| stub bars (<25% of mean range) | **0**                         | 34                     |

So SMA(200) really does cover 40 weeks rather than 33, and the Exness day understates a day's range
by **13.5%** — which is the ATR distortion, now quantified rather than asserted.

The existing `dailyLocalInstants`/`localClock` helpers do the DST-aware anchoring — the cost overlay
uses them at the same 17:00 New York instant for swap rollovers (D5) — so this reuses machinery that
is already tested rather than introducing a second notion of a day.

**Scope: regime labelling only.** Charts, strategy runs, the resampler and every stored timeframe
keep the Exness day. A broker's day is what a trader's platform shows and what a strategy's own D1
calls return; changing that to suit a classifier would be the tail wagging the dog. The regime series
is an internal analytical construct and stays one.

## A42 · Regime classifier

Built on the A40/A41 rules. Verified on both feeds, and the two results are the argument for the
rules rather than a formality:

    EURUSD.twelvedata, 2 years   warn — trending-up -2904 (138 trades, 38%),
                                 trending-down -1200 (50, 14%), ranging +276 (28, 8%).
                                 Exactly one regime made money at all.
    EURUSD dukascopy, 6 months   n/a — 100% of daily sessions lack the full lookback,
                                 leaving 100% of trades unclassified.

The six-month run is entirely unclassified, exactly as A40 predicted, and that is the honest output:
a 252-session volatility lookback cannot be satisfied by 130 sessions, and shortening it until
numbers appear would mean labelling a quarter's volatility as though it were a year's.

On the two-year feed 60% of trades are classified and the breakdown says something the headline
metrics cannot: the strategy loses in both trending directions and makes its only money ranging. A
`warn`, never a `fail` — earning in one regime is a fact about a strategy, not a defect. What makes
it worth saying is that a regime-confined edge is a bet the regime persists, and nothing else in the
report discloses that bet.

Direction is SMA distance as a percentage of price rather than slope, because slope has units of
price per bar and is not comparable between EURUSD at 1.08 and XAUUSD at 2400. Volatility is a
trailing rank rather than a z-score: volatility is not normally distributed, and "higher than 90% of
the last year" is directly actionable where "2.7 sigma" is not.

## A43 · Monte Carlo reshuffles the quantity that sizing makes stationary

Recorded ahead of building it. What gets reshuffled depends on how the strategy sizes:

- **percent-of-equity sizing** — reshuffle per-trade RETURNS, as percentages.
- **fixed lots or units** — reshuffle dollar P&L.

Shuffling dollar amounts under percent-of-equity sizing is wrong in a way that flatters the result
and is invisible in the output. Under that sizing a late-period trade is large because the account
had grown by then; its dollar figure encodes the equity curve that produced it. Reshuffling drops
that $4,000 win onto a $10,000 starting account as though the strategy could have made it there, and
the resulting distribution has a fatter right tail and a shallower drawdown than anything reachable.
The percentage is the quantity sizing holds constant, so it is the one that can be permuted.

The mirror error exists too: reshuffling percentages under FIXED sizing manufactures compounding the
strategy never had, because a fixed-lot trade's dollar result does not scale with equity. Each sizing
mode makes exactly one of the two quantities stationary, and that is the one to shuffle.

The sizing mode is knowable rather than guessed — `default_qty_type` is a declared strategy property
and the order log records the resolved `qty` of every entry — so this is a branch on a fact, not a
heuristic. When the mode cannot be determined the check reports `n/a` rather than picking one.

## A44 · Timeframe matrix

A ladder of M15, M30, H1, H4, D1 — each cell its own run from the same starting capital (A24). M1 and
MN1 are excluded at opposite ends: on M1 the cost assumptions dominate every result, and MN1 produces
too few bars over any window this platform stores to say anything.

**It reports the SHAPE of the row, never its maximum.** A matrix read as a menu is a way to overfit
one more dimension, which is the opposite of the point. The finding it exists for is the base
timeframe standing alone — profitable where it was chosen and nowhere near it — and that is the only
condition scored `fail`. Exactly half the cells profitable warns rather than passes: a coin flip
across bar sizes is not evidence of robustness in either direction.

**A40's rule is wired to the causality log, not to the source text.** A cell is `n/a` when the chart
timeframe is COARSER than something the script requests through `request.security`, and the reason is
printed in the cell. Verified on `macd-htf-filter`, which requests H4:

    D1: The script requests 240 through request.security, which is FINER than a D1 chart...

Measured on the 2022 H1 data, and both fixtures tell the same story from different angles:

| fixture            | M15    | M30    | H1    | H4  | D1  | verdict |
| ------------------ | ------ | ------ | ----- | --- | --- | ------- |
| rsi-mean-reversion | -4,374 | -824   | 1,500 | 461 | —   | warn    |
| macd-htf-filter    | -297   | -1,940 | 4,066 | 945 | n/a | warn    |

Both make money on H1 and H4 and lose on the shorter bars, which is a coherent shape rather than a
single spike — hence `warn` and not `fail`. **The closing claim of the first version of this entry —
that costs were probably doing the work on the short bars, and that the cost stress would settle it —
was wrong twice over, and A45 corrects it.**

## A45 · Each matrix cell reports gross beside net

The cost stress (A27) runs on the BASE timeframe only, so it cannot say whether costs or the signal
sink the shorter-bar cells — which is the first question a row that worsens as bars shrink provokes.
Gross against net answers it from figures each cell already produced, at no extra run, and the
verdict text now names which of the two it is.

**It immediately disproved A44's speculation.** That entry guessed costs were doing the work on the
short bars. Measured:

| fixture            | cell | gross  | net    | costs        |
| ------------------ | ---- | ------ | ------ | ------------ |
| rsi-mean-reversion | M15  | -3,200 | -4,374 | 1,174        |
|                    | M30  | -206   | -824   | 618          |
|                    | H1   | +1,855 | +1,500 | 19% of gross |
|                    | H4   | +564   | +461   | 18% of gross |
| macd-htf-filter    | M15  | -83    | -297   | 214          |
|                    | M30  | -1,715 | -1,940 | 225          |
|                    | H1   | +4,160 | +4,066 | 2% of gross  |
|                    | H4   | +999   | +945   | 5% of gross  |

**Zero cells were sunk by costs. Both fixtures lose money GROSS on M15 and M30** — the signal itself
fails at those bar sizes, and no amount of cheaper execution would rescue either. Costs do about what
one would expect for the trade counts involved. The distinction matters because the two call for
opposite responses, and a row saying only "loses on M15" withholds the half that decides what to do.

One denominator guard, in the same family as A24, A32 and A36: the cost share is reported only when
gross is strictly POSITIVE. Against a negative gross the ratio flips sign and reads as though costs
were a credit — the first run printed "M15 costs -37% of gross" on a cell that lost 3,200 before
costs. It now prints the cost amount instead.

## A46 · Follow-up after slice D: one ratio helper with a declared denominator rule

Four times in this slice a ratio has been wrong because its denominator was not guarded, and each was
found separately, after the fact, by reading output that looked odd:

- **A24/A32** — walk-forward efficiency and the OOS return ratio against a non-positive in-sample
  return: two losses divide into a flattering positive number.
- **A32** — the same ratio against a near-zero positive return: 0.60% against 11.49% printed as
  "kept 1911%".
- **A36** — raw returns over windows of different lengths, scoring an unchanged strategy at 0.33.
- **A45** — cost share against a negative gross, printing "costs -37% of gross" on a cell that lost
  money before costs.

The pattern is identical every time: a ratio is formed, the result is inspected afterwards, and the
inspection is forgotten in the next place. A shared helper that will not compute a ratio without
being told the rule — `strictlyPositive`, `minimumMagnitude`, `sameScale` — turns four remembered
conventions into one the compiler asks for at every call site.

Not now: the four call sites are correct as they stand, and replacing working guards mid-slice buys
nothing. It belongs with the other post-slice-D cleanups (A26, A31).

## A47 · Monte Carlo, and what reshuffling actually tells you

Built under A43: per-trade RETURNS are permuted under percent-of-equity sizing, dollar P&L under
fixed. `cash` counts as fixed — a fixed cash amount per trade does not scale with equity either. The
mode is READ from `default_qty_type` on the compile result, with a run-level override winning exactly
as the engine treats it, and `unknown` is a real outcome reported as `n/a` rather than a guess.

**The final result is invariant under reshuffling, and that is the point rather than a defect.**
Summing dollars and multiplying growth factors are both commutative, so every ordering of the same
trades ends in the same place. Only the PATH moves. Two things follow:

- The check reports a distribution of DRAWDOWN, not of returns. A single backtest shows one draw from
  that distribution, and the drawdown it happens to display is not the drawdown to size from.
- **A Monte Carlo that reports a spread of final returns has shuffled the wrong quantity.** That is
  the diagnostic A43 exists to prevent, and it is now a property the tests assert directly: two runs
  with different seeds must produce an identical final return under both sizing modes.

Verified on `rsi-mean-reversion`, EURUSD H1 2022:

    median drawdown 8.7%, 95th percentile 14.0%, against the 8.3% this run actually showed

So the observed curve is slightly better than typical but well inside the distribution — a `pass`. A
run in the bottom quarter warns, because sizing taken from a favourable draw is sized from luck; any
ordering reaching zero fails outright, since the same trades in a different sequence would have ended
the account.

One test fixture needed correcting, and the correction is worth keeping: putting every loss LAST does
not produce a favourable ordering, it produces the worst one — a peak is built and then given back
without recovery. A favourable ordering is an evenly alternating one, where no losing run ever
accumulates.

## Step 1 of slice D is complete

All seventeen checks now run in one pass, in 6.7s on six months of H1:

    Sealed holdout · Look-ahead (static lint, prefix invariance, future splice, causality)
    Execution (fill audit, bid/ask asymmetry, M1 intrabar replay, cost stress)
    Out-of-sample split · Rolling out-of-sample · Regime mix · Timeframe matrix
    Monte Carlo · Bar integrity · Trades within data window · Trade sample size

Walk-forward optimisation (A35) sits beside them as an opt-in check with its own CLI, because 1,204
engine runs cannot live in a suite that answers in seconds.

What remains for slice D is step 2 (`POST /backtests/:id/validate` with SSE progress) and step 3 (the
"Integrity & Overfitting" tab) — after which the DONE WHEN, which requires the whole thing exercised
in a browser, can be met for the first time.

## A48 · Bootstrap, and reading both tails of the reshuffle

Two gaps in A47, both from spec 06.

**The bootstrap resamples WITH replacement**, under the same A43 quantity rule. Unlike the reshuffle
it genuinely moves the final return, and that spread is the point: it answers the question permuting
cannot, which is whether the profit could plausibly be luck. Reported as the 5th/50th/95th percentile
final return and the share of resamples that lose money. The invariance test stays on the RESHUFFLE
only — it is a property of permutation, not of resampling, and asserting it on the bootstrap would
assert the check is broken.

On `rsi-mean-reversion`, EURUSD H1 2022, it changed the verdict from `pass` to `warn`:

    bootstrap final return  -8.2% / 15.1% / 36.3%  (5th / 50th / 95th)
    15.4% of resamples lose money

The run itself returned about the median, so its ordering was unremarkable — but roughly one trade
set in six drawn from the same distribution would have lost money, which no other check in the suite
discloses.

**Thresholds as one-sided confidence statements about the profit**: above 5% losing is not
significant at the conventional level and warns; above 33% is a third of equally plausible trade sets
losing and fails. My first cut put the failure at 50%, which is unreachable for a profitable run —
the bootstrap centres on the observed mean, so half the resamples can only lose if the run itself
made nothing, and the OOS split already catches that. A threshold that can only fire on a losing run
adds nothing.

**Both tails of the reshuffle are read, for opposite reasons.** Below the 5th percentile the
ordering was lucky and the reported drawdown understates risk. Above the 95th the realised sequence
was worse than permutation generally produces, which means the losses CLUSTERED — and random
permutation destroys exactly that serial dependence, so the distribution understates the risk there
too, by modelling a process the strategy does not have. Both warn, and both say the same practical
thing.

The 95th-percentile drawdown is now named explicitly as the figure to size around: the backtest
showed one ordering, and sizing from its curve is sizing from that draw.

## A49 · Step 2, part one: the validation endpoint

`POST /backtests/:id/validate` enqueues the suite on the existing BullMQ plumbing,
`GET /backtests/:id/validations` lists past results, `GET /validations/:id` fetches one with its
report, and `DELETE /validations/:id/job` cancels through the same out-of-band Redis channel the
backtest cancel uses.

**The job runs in the worker process, not a piscina thread.** That breaks the pattern the backtest
job set, deliberately: `validateRun` performs about thirty engine runs of its own and the timeframe
matrix dispatches more, so putting it in a pool thread would have a pool task spawning pool tasks.
Its CPU cost is already bounded by the pool those inner runs use. Concurrency is 1 for the same
reason — two validations at once would contend for that pool and finish slower than in sequence.

**A completed run is required.** Validation re-executes the strategy and compares against the stored
result; a run still in flight has no stored result to compare against.

**The stored context is reported BY the run, not assembled by the job.** Feed, data version, engine
id and version, the seal in force with its view count AT THAT MOMENT, and the effective range with
the requested one beside it. Every one of those can change under a run while its id stays the same,
so a caller reconstructing them later could attach different values to the same verdict. The list
endpoint omits the report, which is large; the tab renders headlines from the summary columns and
fetches a report only when a card is opened.

**The e2e caught a real defect: progress went backwards.** `report(90, 'judging')` was written when
judging WAS the last step, and every check added since landed after it — so the bar ran
99 -> 90 -> 100. Then a second, subtler one: the splice loop already reports up to 90, so numbering
the new checks from 86 put them underneath it. Renumbered to 91-99, and `pnpm test:e2e` asserts
monotonicity the same way it does for a backtest, because a bar that jumps backwards is worse than
no bar.

Now 31/31 against the real stack.

## A50 · Optimisation shares the validation queue, concurrency 1 across both

Walk-forward optimisation goes on the SAME BullMQ queue as validation rather than its own, so the
worker's concurrency of 1 applies across both kinds.

The reason is the one A49 gave for validation's concurrency: both saturate the same piscina pool. A
validation performs about thirty engine runs and dispatches its timeframe matrix there; an
optimisation dispatches 1,204. Running one of each at once would have them competing for the same
threads and finishing slower than in sequence, while looking to the user like two things making
progress. A separate queue would need its own concurrency limit and a way to coordinate with this
one — which is a distributed semaphore reinvented to solve a problem that not creating the second
queue does not have.

The cost is that a queued optimisation blocks a quick validation behind it for minutes. That is the
right trade for a single-user platform: the alternative is both running and neither finishing, and
the queue position is visible.

## A51 · Step 2 complete: the optimisation endpoint

`POST /backtests/:id/optimize` takes the setup form, `GET /backtests/:id/optimizations` lists past
results, and both share `GET /validations/:id` and `DELETE /validations/:id/job` with validation —
the two are the same resource with different `kind`, so a tab that renders one renders the other.

**The spec is validated at the API boundary, not in the job.** An inverted range, a fourth input or
a zero step is refused in milliseconds rather than after the pool has spun up; `combinations` and
`gridSize` come back with the 201 so the caller sees the size of what it asked for before anything
runs. The API gained a dependency on `@edgelab/validation` to do it — which is cheap, since that
package is pure and depends only on `shared` and `metrics`, and the alternative was duplicating the
grid arithmetic where it could drift.

The job NAME is a literal in the API rather than imported from `@edgelab/worker`, for the same
reason the queue names already are: importing it would pull piscina, pinets and every provider SDK
into the API image.

Progress is scaled to 1..99 rather than 1..100. The ETA is fitted, not exact (A35), so a bar that
reached 100 before the work finished would be worse than one arriving slightly late.

`pnpm test:e2e` is now **36/36**, covering both jobs: the grid size reported before starting, an
impossible spec refused, monotonic progress on the shared queue, and the stored result carrying its
fold table, parameter drift and the spec it swept.

## A52 · The header answers two questions, not one

The report shows two separate answers rather than a single verdict.

**"Is this backtest honest?"** — the critical checks: look-ahead, execution realism, data integrity,
and the holdout. This has a verdict, because it is a question with an answer: pass, fail, or
Inconclusive when a critical check could not run and therefore cleared nothing.

**"Does the edge hold up?"** — the robustness checks: OOS split, rolling out-of-sample, regimes,
timeframe matrix, Monte Carlo, and walk-forward optimisation where present. These get COUNTS of
pass/warn/fail/n·a and deliberately no combined score.

A lone "Pass" badge on a losing strategy reads as an endorsement. The checks are saying "we found no
lying"; a reader sees "approved". Splitting the questions makes the first badge mean exactly what it
measures, and leaves the second as a list that has to be read. The passing headline says so
explicitly: _"no look-ahead, and execution is modelled realistically. This says nothing about whether
the strategy is any good."_

**No combined robustness score, on purpose.** There is no honest way to average "profitable in 2 of 4
timeframes" against "15% of bootstrap resamples lose money", and any weighting invented to do it
would be a judgement smuggled in as arithmetic. The counts are the summary.

**The holdout is an HONESTY check despite its `overfitting-` id.** A viewed holdout does not mean the
edge is fragile — it means this particular claim is weaker evidence than it appears, which is a
statement about the result's standing rather than about the strategy.

The split lives in `packages/validation/src/two-questions.ts` and is derived from check ids, so a new
check lands on the right side by being named consistently and an unrecognised one surfaces as
`unclassified` rather than being silently dropped. Both the CLI and the tab read it, so they cannot
disagree about which check answers which question.

## A53 · The chart's focus is a TIME, not a trade

The evidence jump resolved a bar index to "the trade that opened or closed on it". That leaves the
most important evidence unclickable, because look-ahead findings name bars that frequently carry no
trade at all — the causality check's first peek on the leaking fixture is **bar 0**, and prefix
invariance names the bar a DECISION changed on, which is usually not a bar anything traded.

Two changes:

**The checks emit a clickable instant.** A bar INDEX was never usable by the UI in the first place:
it indexes the engine's bar array, warmup included, while the chart draws only the requested range,
so the two do not correspond. Look-ahead evidence now carries a numeric `*AtMs` key beside its
human-readable ISO string — `divergedAtMs` on prefix invariance and future splice, `peekedAtMs` on
causality. Any key ending `AtMs` is clickable by convention, so a future check joins in by naming
its field consistently rather than by being added to a list.

**The store's focus is an instant.** `focusAt(atMs)` scrolls and marks; `focusTrade(seq, atMs)` is
the case that ALSO highlights the trade. `focusAt` clears any trade highlight, because leaving the
previous trade marked while centring somewhere else attributes the evidence to the wrong place.

The chart marks an instant with a vertical marker rather than a horizontal level: the claim being
made is "here, at this time", and there is no price associated with a look-ahead divergence, so
drawing one would invent a claim the evidence does not make. Lightweight Charts has no vertical-line
primitive, so it is a two-point series registered in the same ref the trade lines use — which means
the next focus clears it without a special case.

**Verified on the leaky fixture** (EURUSD H1 2022 H1, PF 23.17):

    lookahead-future-splice   fail   divergedAtMs = 2022-04-14T09:00
    lookahead-causality       fail   peekedAtMs   = 2022-01-02T23:00

The causality peek is the FIRST bar of the range, with no trade on it — precisely the evidence the
trade-resolution left unclickable. `lookahead-static` correctly has no instant: it names a source
LINE, not a bar, and reports `firstLine` instead.

## A54 — The runs list had never returned a row: drizzle unparses timestamps for raw queries

**Found by opening the Integrity tab's own prerequisite.** `GET /api/backtests` — listed as "done" in
slice F and "browser-verified" — threw `TypeError: value.getTime is not a function` on **every**
request, from `fromDbTime(r.range_from)` in `listRuns`.

`drizzle-orm/node-postgres` installs its own `getTypeParser`, which returns TIMESTAMP, TIMESTAMPTZ,
DATE and INTERVAL **unparsed** so drizzle's per-column mappers can own the conversion. A typed select
therefore yields a `Date`; a raw `db.execute`, which has no column mappers to run, yields the ISO
string postgres sent. `listRuns` is the repo's ONE raw query — `client.ts`'s `select 1` is the only
other, and it reads no timestamp — so it is the only site affected, and it was wrong on every row.

It compiled because the row type _declared_ `range_from: Date`. A hand-written annotation on a raw
query is an assertion, not a check, and this one was false.

**Decision: `fromDbTime` takes `DbTimestamp = Date | string`** and parses both, because the boundary
is where the convention already says conversion lives — pushing `Date.parse` into `runs-repo` would
put a second conversion outside `time.ts`. `listRuns`'s annotation now says `DbTimestamp`, so the
types describe what the driver actually sends. Five tests cover both shapes, an offset that is not
UTC, and a string that is not a timestamp at all.

> Slice F's "browser-verified" was true of the _page_ and false of the _endpoint_: `shell.smoke.ts`
> runs without a backend, so the Runs page was only ever proven against fixtures. Verified here
> against the docker stack — the list returns all runs with their KPIs.

## A55 — The price chart rendered at zero height on the run report page

The verification sprint fixed "the Studio's Chart tab rendered at zero height" by putting a
`min-h-[20rem]` floor on the tab's wrapper. That floored the WRAPPER. The chart inside it kept
`h-full min-h-0`, and `min-h-0` is an explicit instruction to have no floor at all.

Measured in the browser on `/runs/:runId`, walking up from the chart:

| element                        | used height |
| ------------------------------ | ----------- |
| `[data-testid=price-chart]`    | **0px**     |
| wrapper `h-full min-h-[20rem]` | 320px       |
| `min-h-0 flex-1 overflow-auto` | 320px       |

A percentage height resolves only against a parent with a definite `height`. Through this chain the
parent's 320px comes from a `min-height` floor rather than from `height`, so `h-full` resolved to 0
and Lightweight Charts sized itself to nothing. Playwright reports the element as _hidden_, which is
what it is: present in the DOM, zero pixels on screen.

**Decision: the chart fills its container by `absolute inset-0`, not by `h-full`.** An absolutely
positioned box with all four insets set takes its size from the containing block directly, with no
percentage to resolve, so it cannot collapse this way again whatever the ancestors do. The tab
wrapper becomes `relative` — it is the containing block, and its `min-h-80` floor is now what the
chart actually inherits.

> Same root cause as the sprint's finding, one level down, and it survived because the sprint's fix
> was verified by looking at the Studio. Caught here only because slice D's DONE WHEN clicks a piece
> of evidence and demands the chart jump to it — the first test that ever asserted the chart was
> _visible_ rather than present.

**The focus note now always names the marked bar**, instead of only speaking up when an instant had
to be snapped or fell outside the range. The marker is a dotted line on a canvas: on its own it asks
the reader to find it and trust it. Naming the bar turns "the chart moved" into "the chart is showing
the bar the evidence named", and it is the only part of the jump a test can assert at all.

`HoldoutAction`'s `retiredSeals` became `number | null` in the same pass. The tab does not carry a
retired count, and passing `0` would have stated "no seal was ever retired on this symbol" —
a claim, not a default — on a symbol where four had been.

## A56 — The optimisation ETA ignores the window it is estimating

Measured on the two-year acceptance run: **estimated 14.2s, actual 84.6s** — 6x low, on the dataset
slice D's acceptance gate is defined against.

`estimateOptimization` accepts `barsPerFold` and never reads it. Both calibration runs behind its
constants were six months of H1, so the model is a flat cost per run whatever window it is asked
about. The three measurements now on record:

| runs | threads | in-sample fold | actual | predicted |
| ---- | ------- | -------------- | ------ | --------- |
| 40   | 7       | ~3,100 bars    | 13.8s  | 13.5s     |
| 204  | 7       | ~3,100 bars    | 24.2s  | 23.9s     |
| 51   | 7       | 8,760 bars     | 84.6s  | 14.2s     |

Bars per fold rose 2.8x and cost per run-slot rose **22.8x**, so this is not the engine term — A33
puts that at 0.042ms/bar. The likely dominant term is the M1 read behind each candidate, which
scales with the M1 SPAN and the number of distinct windows times threads, not with the run count,
and which the model does not contain at all.

**Decision: do NOT re-fit from one new point.** Three heterogeneous measurements cannot determine a
two-parameter model, and inventing a coefficient to make this run fit is precisely the error the
check it belongs to exists to catch. The estimate now carries `calibratedBarsPerFold` and
`isLowerBound`, and the CLI prints "estimated at least 14.2s" with the calibration named whenever a
run's folds exceed the calibration by more than half. **A figure known to be low is worse than no
figure** when the reader is deciding whether to wait for it.

> **Follow-up (after slice D):** instrument the M1 read separately from engine time inside the
> optimisation task and fit a two-term model — pool startup plus a per-window read plus a per-run
> engine cost. That needs deliberate measurement across at least two window sizes and two fold
> counts, not a back-fit.

### The acceptance gate

Both halves ran end to end on `EURUSD.twelvedata`, 2022-01-01 .. 2024-01-01, H1, 361 trades:

- **full suite** — 17 checks, **68s**, verdict `fail`;
- **walk-forward optimisation** — 16 combinations, 3 folds, 51 runs on 7 threads, **84.6s**,
  verdict `n/a`.

The optimisation's `n/a` is A24's guard, not a gap: every fold's best in-sample candidate still lost
money (-492, -1,068, -475), so there is no in-sample edge whose persistence WFE could measure. The
suite's three `n/a`s are the same guard in three places — cost stress has no break-even to find
because the run is unprofitable at 0x costs, and neither OOS check has a profitable in-sample half.
**A strategy with nothing to overfit is the one case where these checks must say so instead of
scoring it**, and on the acceptance data they do.

## A57 — A job could be told it had finished when it was still queued

`pnpm test:e2e` was flaking on the two optimisation tests, about one run in two. The failing
assertion was `expected 97 to be 100`, and the test returned in **17ms** — it had not waited for
anything. 97 is not a number the optimisation progress can produce (8 runs scale to 86 or 98); it is
the timeframe-matrix step of a **validation**. The client had been handed a different job's state.

Two defects, each hiding the other:

1. **`JobsService` never knew about the validation queue.** It was added in step 2 and the SSE
   lookup was not updated, so a validation or optimisation job that had not yet published an event —
   one sitting behind another at concurrency 1 (A50) — could not be found.
2. **`jobStateKey` and `jobEventChannel` are namespaced by job id alone**, and BullMQ numbers jobs
   from 1 _within each queue_. `backtest` job 7, `ingest` job 7 and `validation` job 7 share one
   Redis key and one channel.

Together: the unfound validation job fell through to the queue scan, matched the _backtest_ job of
the same number, and was answered with that job's state — which was terminal, so the API sent `end`
and closed the stream. **The client was told a job had finished while it was still in the queue.**

**Decision: fix both.** Job ids are now `randomUUID()` at all four `add()` sites, and the validation
queue is in the lookup. Either fix alone leaves a hole — unique ids without the queue turn the
collision into an honest 404, and the queue without unique ids leaves the key still shared with
whatever else numbered a job the same.

Guarded by an e2e that asserts **every frame names its own queue**, not merely that a stream opened.
Mutation-verified: dropping the validation queue from the lookup fails it.

> This is the third time the same shape has bitten this repo — the sprint's "SSE died after one
> frame", and now a stream that ends early on someone else's terminal state. A progress stream that
> LIES is worse than one that hangs: a hang is visible, and "completed" is acted on.

## A58 — The integrity smoke test asserts screen against source, and skips when its run is absent

Two problems with the first version of `integrity.smoke.ts`, both found by CI going red on it:

**It hardcoded dates from one dataset.** `2022-04-14` and `2022-01-02` are properties of the
dukascopy EURUSD series, not of the feature. Any other stack producing perfectly correct output
would have failed. It now reads the report over the API and asserts the UI shows **what the check
found** — the line number from `firstLine`, the splice's `divergedAtMs`, the causality check's
`peekedAtMs` — which is both the stronger claim and a portable one.

**It failed where it should have skipped.** CI seeds one synthetic month and never creates a
look-ahead-leak run, so the suite went red on a missing precondition. It now `test.skip`s with the
command that would create the run. A skip naming what is missing is honest; quietly asserting
nothing would not be.

> Also fixed: the helper read `GET /api/backtests` with its default limit of **50**, and a single
> `pnpm test:e2e` creates enough runs to push an older fixture run off the end — which presents as
> "no leaky run exists" and skips the whole suite. It asks for 500.

**CI therefore does not exercise these four tests**, and that is stated rather than implied: the
verification of record for slice D's DONE WHEN is the local run against the real 2022 series, 4/4.
Full smoke locally is **27 passed**.

## A59 — The holdout is testable, and the test is the only thing that spends it

`POST /backtests/:id/holdout-test` runs one check against the sealed range. It is a separate
endpoint rather than a flag on `validate`, and it names the check in its body with no default,
because this is the only request in the API whose cost is permanent: the view is recorded before a
single bar comes back. Nothing should reach sealed data as a side effect of asking for something
else, and a body that could be empty would let a mis-wired client burn a holdout by accident.

**One check is supported — `overfitting-holdout` — and the rest are refused BY NAME.** The other
sixteen interrogate the run you already have; this one re-runs the strategy on data it has never
seen. Accepting their ids and running this one instead would spend a holdout on a question nobody
asked.

The run is its OWN run from the original starting capital (A24), never a continuation: a
continuation inherits position sizes grown by in-sample profits, so the holdout result would partly
re-measure the in-sample period. The comparison is the OOS split's — same `SegmentMetrics`, same
per-calendar-day normalisation (A36), same refusal to divide by a non-positive baseline. A holdout
is an out-of-sample test whose only special property is that the data was WITHHELD rather than
merely later, and a second scoring rule would make the two incomparable for nothing.

**A clean pass on an already-viewed holdout is reported as `warn`.** The arithmetic cannot tell the
first look from the fifth — the numbers are identical — so the distinction has to be carried by the
count or it is lost. A `fail` is never softened that way: a loss is a loss however often you look.
The cost is stated on every outcome including `n/a`, so the cheapest-looking result is not the one
that quietly spent the holdout.

### Two defects the first end-to-end run exposed

The route worked, and reported **`viewCount 0 -> 0`** while the database said `1`.

1. **`recordHoldoutView` matched on `symbolId` alone, so it incremented every seal the symbol had
   ever had — retired ones included.** A retired seal's count is finished history, and A38 keeps
   those rows precisely so the record survives; bumping them rewrites it. Now scoped to the active
   seal. The four retired EURUSD seals had been bumped from 0 to 1 by this and were reset, which is
   safe only because `pnpm holdout --status` had recorded them as "never viewed" minutes earlier.
2. **The seal cache is per-client, and the view is recorded in a WORKER THREAD** — its own client,
   its own cache — so the main process kept serving the count it last saw. `getHoldout` stays
   cached, because it is consulted on every bar read and the BOUNDARY only moves via this module;
   `readHoldoutFresh` is the uncached read, used by every reporting path. Reporting a stale count
   understates what a holdout has cost, which is the one number the mechanism exists to keep honest.

Both are covered by e2e assertions — the count rises by exactly one, and a retired seal is untouched
— on a seal the test creates and retires itself so it cannot disturb the machine's own.

## A60 — CI creates the fixture runs, so the integrity tests run instead of skipping

A58 made the integrity smoke tests skip when no leaky run exists, which stopped CI going red on a
missing precondition — and left four tests that asserted nothing on every push. CI now seeds a
second island of synthetic bars (2022-01-01 .. 2022-07-01, beside the 2024 month the e2e suite is
written against) and creates BOTH fixture runs before the smoke step.

Both, because the leaky one alone proves only that the tab can say "No". The clean twin is identical
logic with `lookahead_off` and a `[1]` offset, so it must come back honest; the pair is what makes
the verdict mean anything.

**The data-dependent assertions were made adaptive first.** Three of them were pinned to what the
real dukascopy series happens to produce:

| assertion          | now                                                                   |
| ------------------ | --------------------------------------------------------------------- |
| static lint fails  | unconditional — it reads the SOURCE, so it holds on any series        |
| splice names a bar | only when the splice actually reported a `divergedAtMs`               |
| the chart jump     | uses ANY look-ahead check carrying a time, not causality specifically |
| Monte Carlo panel  | when `n/a`, asserts the REASON is shown instead (A2)                  |

The clean twin deliberately does NOT assert the overall honesty verdict. That aggregates the
execution checks, which depend on the bars — a fill landing on a bar extreme is a property of the
synthetic generator, not of this fixture.

**And the skip is disallowed in CI.** A workflow step creating the runs still leaves a green suite
if that step silently stops working — a skipped test and a passing one are the same colour. So the
absence of a fixture run is a SKIP locally (not every machine carries one) and an ERROR under `CI`,
naming the command that should have created it. Without that, "CI runs the integrity tests" is a
claim nothing checks.

> **Rehearsed locally before pushing**, on `GBPUSD` (no stored bars) seeded with the same synthetic
> range and the same two `pnpm backtest` invocations CI runs: **5/5 green**, then the rehearsal data
> was deleted. Debugging a browser suite through CI round-trips is how a "small config change" costs
> an afternoon. Worth noting from it: the clean twin earns +232,688 on synthetic bars — the
> generator is trivially predictable, which is exactly why the honesty assertion was dropped.

## A61 — Provider cards report capability, credits and blockage, never the key

`GET /api/data/providers` builds each card from the ADAPTER's own `capabilities()` rather than a
list kept in the API, so a provider cannot advertise something its implementation does not do.

The API constructs the adapters **without credentials**, purely to read that shape. `ConfigService`
has no getter for the provider key by design (PROJECT.md's secrets rule), so the API cannot build a
working Twelve Data client and does not pretend to: the adapter supplies the shape, config supplies
PRESENCE, and only the key-dependent fields are overridden. What reaches the browser is `enabled`
plus, when it is false, a `disabledReason` naming the environment VARIABLE — never a value.

Three things on the card that a connected/not-connected badge would hide:

| shown           | why                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| credits left    | from the SAME Redis counters the fetcher spends, so it is the number that will refuse the next request — not an estimate of it                                             |
| spread supplied | Binance and Twelve Data supply none, so their bars fall back to `defaultSpreadPoints` and their cost figures are not comparable with Dukascopy's. A property of the SOURCE |
| blocked since   | A11: a source refusing for several nights running is blocked, not quiet, and a card that stays green while every nightly job fails is what A11 was written about           |

Credits go amber under a fifth remaining and rose under a twentieth: a backfill needs headroom, and
a green light at 40 requests left is a green light into a wall.

> Fixing this exposed a latent bug in the web client: `request()` set `content-type:
application/json` whenever a body was present, which would have broken the file import — only the
> browser can write a multipart `content-type`, because only it knows the boundary. A hand-written
> header produces a body the server cannot parse and an error that reads "no file uploaded".
