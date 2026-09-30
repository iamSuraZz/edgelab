# EdgeLab

Personal Pine Script backtesting platform. Paste a TradingView strategy (v5/v6), choose
symbol + timeframe + date range, get a TradingView-grade backtest, a full metrics report,
and integrity/overfitting checks.

Instruments are Exness-style: forex majors and crosses, XAUUSD, XAGUSD, index CFDs, oil,
crypto. Timeframes are the full MT5 set (M1…MN1). **Only M1 is stored; everything else is
resampled from it.**

## Architecture map

| Path                  | Role                                                                      |
| --------------------- | ------------------------------------------------------------------------- |
| `apps/web`            | React + Vite, Tailwind 4 + shadcn/ui, TanStack Query/Table/Virtual,       |
|                       | Zustand, react-hook-form + zod, Monaco, Lightweight Charts v5             |
| `apps/api`            | NestJS REST API, SSE for job progress. `GET /health` probes DB + Redis    |
| `apps/worker`         | BullMQ workers (`ingest`, `backtest`, `validation`) + piscina thread pool |
| `packages/shared`     | zod schemas/DTOs, timeframe registry, metric dictionary, domain types     |
| `packages/db`         | Drizzle schema, migrations, client, the epoch-ms ↔ timestamptz boundary   |
| `packages/data`       | provider adapters, symbol registry, resampler, file importers             |
| `packages/engine`     | `PineEngine` interface, run orchestration, cost overlay, FX, equity       |
| `packages/metrics`    | pure analytics (trade stats, ratios)                                      |
| `packages/validation` | pure integrity + overfitting checks                                       |

Dependency direction is strictly one-way: `shared` ← `data`/`metrics` ← `engine`/`validation`
← apps. `shared` never imports anything internal.

## Commands

```bash
docker compose up -d     # TimescaleDB + Redis 7
pnpm i
pnpm dev                 # all apps in parallel (turbo builds packages first)
pnpm build               # turbo, topological
pnpm lint                # eslint . --max-warnings 0 (one pass, whole repo)
pnpm typecheck           # turbo, per-package tsc --noEmit
pnpm test                # vitest run (aliases packages to source — no build needed)
pnpm test:e2e            # API + worker in-process vs the docker stack; needs stored bars
pnpm db:generate         # drizzle-kit generate after a schema change
pnpm db:migrate          # migrations + hypertable + compression + seed symbols
pnpm db:studio           # drizzle-kit studio

pnpm ingest EURUSD dukascopy 2024-01-01 2024-04-01   # direct backfill, resumable
pnpm verify EURUSD 2024-01-01 2024-04-01             # resample every TF + quality report
pnpm run import:file mt5 EURUSD <abs.csv> 120        # 120 = broker server UTC offset
```

`pnpm import` is a pnpm BUILT-IN (it converts foreign lockfiles) — ours is `import:file`.

## Working agreement

- **One slice per session** (slices are defined in `docs/spec/08-roadmap.md`). A slice is done
  only when its DONE WHEN has been **verified by running it** — in the browser for UI slices —
  and `pnpm lint`, `pnpm typecheck` and `pnpm test` are green.
- **Start every session by reading "Current status" below.** If the previous slice is not done,
  finish it and stop there.
- **If the session gets long, stop after a completed STEP** with a clean commit and a handoff
  note in "Current status". Never leave a step half-built; never start the next slice.
- **Ask questions at the start of a slice.** Mid-slice, take the conservative option, record it
  under "Mid-slice decisions" in `docs/decisions.md`, and keep going.
- `docs/decisions.md` **overrides the specs** where they disagree.

## Conventions

- **Time.** Application code uses UTC epoch milliseconds. The DB uses `timestamptz`.
  Convert only in `packages/db/src/time.ts`. **A bar's time is its OPEN time.**
- **Purity.** Resampler, equity, metrics and checks are pure and unit-tested. I/O sits
  behind small interfaces (`MarketDataProvider`, `BarStore`, `FxRateSource`, `PineEngine`)
  so tests use fakes, not mocks of the world.
- **Undefined vs zero.** A metric that is genuinely undefined returns `null`, never `0`,
  `NaN` or `Infinity`. No losing trades means no profit factor.
- **Done means green.** A phase is done only when `pnpm lint`, `pnpm typecheck` and
  `pnpm test` all pass.
- **Secrets.** Only `.env` → the zod-validated loader in `@edgelab/shared/config`.
  Nothing else reads `process.env`. Never log an API key, return one from the API, or ship
  one to the browser. `ConfigService` has no getter for the provider key — callers ask
  `providerConfigured`. Config errors report key _names_ only, never values.
  `@edgelab/shared/config` is a separate subpath so browser bundles cannot reach it.
- **Specs.** Every phase prompt is saved verbatim to `docs/spec/NN-name.md` _before_
  implementation.
- **Ambiguity.** If a spec is ambiguous or a library misbehaves, stop and ask. Do not
  guess. Open questions get a `NOTE (flagged for confirmation)` comment at the site.
- Keep this file under ~120 lines.

## Where the detail lives

- **`docs/engineering-notes.md`** — toolchain pins and why (TypeScript 6 not 7, pinets
  0.9.34 not 0.10.0, the `@Inject` rule) plus the market-data invariants (M1-only storage,
  compression, the session model, bid/ask joining).
- **`docs/pinets-notes.md`** — every verified PineTS API, the instrumentation seam, and the
  traps that fail silently. Read it before touching the engine.
- **`docs/verified.md`** — what has actually been observed, phase by phase, with the evidence.
- **`docs/spec/`** — the verbatim prompt behind each phase.

## Current status — NOT v1.0

Green: `build` 9/9, `typecheck` 17/17, `lint` clean, **982 tests** (`pnpm test`).
CI runs all five checks on every push — see `.github/workflows/ci.yml`.

**Verified against the real docker stack:**

| check             | result | covers                                               |
| ----------------- | ------ | ---------------------------------------------------- |
| `pnpm test:e2e`   | 36/36  | **slice B DONE WHEN**, and **all of slice D step 2** |
| `pnpm test:smoke` | 23/23  | **slice C DONE WHEN**, and slice F's browser work    |

**Slices A, B and C are DONE and verified.** **Slice D is IN PROGRESS — step 1 (validation engine

- `pnpm validate`) is done and exercised on the real stack; steps 2 and 3 are not started, so its
  DONE WHEN ("in the browser") is not met.** Slice E's currency layer is **done and hand-verified**; its
  Data page and dashboard work is not started. Slice F is built and browser-verified except the
  deployment. See `docs/spec/08-roadmap.md` for the slices and `docs/decisions.md` for D1–D8, A1–A5
  and the verification-sprint findings, which override the specs.

> **The verification sprint found eight real defects in code that compiled, linted and passed 616
> unit tests.** Worth remembering before trusting any future "code complete" claim here: the API
> had never successfully booted (Nest could not resolve a single class-typed dependency under
> esbuild), SSE died after one frame so every job looked stuck, `Error.name` does not survive a
> worker thread the way this repo's notes claimed, the measured per-bar spread never reached the
> cost overlay so every backtest was charged ~2x, ingest could silently skip years in two distinct
> ways, the engine was handed the wrong currency's capital, the cross-check compared yen against
> dollars, and the Studio's Chart tab rendered at zero height. Full detail in `docs/decisions.md`.

### Data actually stored

**Every symbol now holds exactly ONE feed (A6).** A run whose range spans two is refused.

| symbol            | bars    | range                | feed       |
| ----------------- | ------- | -------------------- | ---------- |
| EURUSD            | 216,810 | 2022-01..06, 2024-01 | dukascopy  |
| USDJPY            | 31,748  | 2024-01              | dukascopy  |
| BTCUSD            | 10,080  | 2024-01-01..08       | binance    |
| EURUSD.twelvedata | 6,238   | 2024-02-01..07       | twelvedata |

**Slice D's two-year gate is CLEARED (A10).** `EURUSD.twelvedata` holds 2022-01-02 .. 2024-02-07 —
623 trading days over 2022-01-01..2024-01-01 with **no gap longer than four days**, fetched in 148
requests inside the free 800/day budget. That feed is the target of the two-year acceptance run.

The contiguous 2022-01..06 dukascopy EURUSD (185,122 bars) remains the working set for building each
check. Binance and Twelve Data supply no spread, so bars from them fall back to
`symbol.defaultSpreadPoints` — correct, but it means cost figures are not comparable across feeds.

**The two-year acceptance feed is `EURUSD.twelvedata` (A10), not the dukascopy series.** Twelve
Data's earliest EUR/USD 1min bar is 2020-04-07, so it reaches the window; `/earliest_timestamp`
confirmed it. The backfill of 2022-01-01 → 2024-01-01 runs inside the free 800/day budget.

Dukascopy remains the canonical `EURUSD` series and keeps its nightly job. After three consecutive
rate-limited nights, `pnpm backfill` and `GET /api/data/coverage` report
`dukascopy blocked since <date>` (A11) rather than only exiting zero.

> Playwright's own `chromium_headless_shell-1208` download is corrupt on this machine (it extracted
> to `ABOUT`/`LICENSE` only — most likely antivirus). Run the browser tests with
> `PLAYWRIGHT_CHROMIUM_PATH` pointing at the intact `chromium-1243/chrome-win64/chrome.exe`;
> `playwright.config.ts` reads that override. Vite also binds IPv6 only here, so use `localhost`
> rather than `127.0.0.1`.

### Slice D — what exists, what does not

**Step 1 is PARTIAL — only the look-ahead family landed.** The prerequisites below are done and
verified on real data. Steps 2 (endpoint + SSE) and 3 (Integrity tab) are not started, so the
roadmap's "in the browser" is NOT met.

| prerequisite                                                       | state                        |
| ------------------------------------------------------------------ | ---------------------------- |
| One feed per series; mixed-range runs refused (A6)                 | done, proven on real data    |
| `pnpm run data:split-feed` — stray Twelve Data week moved out      | done                         |
| `pnpm backfill` — paced, resumable, `rate-limited` exits zero (A7) | done                         |
| Nest boot guard — 2 assertions, both mutation-verified (A8)        | done                         |
| CI on the public repo (A9)                                         | see badge / Actions tab      |
| Exness imports + MT5 parity test (A12)                             | **NOT PLANNED** — no exports |

**Execution bias, the OOS split (A32), rolling out-of-sample (A34), walk-forward optimisation (A35)
**STEP 1 IS COMPLETE.** All seventeen checks run in one pass, in 6.7s on six months of H1:

    Sealed holdout · Look-ahead (static lint, prefix invariance, future splice, causality)
    Execution (fill audit, bid/ask asymmetry, M1 intrabar replay, cost stress)
    Out-of-sample split · Rolling out-of-sample · Regime mix · Timeframe matrix
    Monte Carlo · Bar integrity · Trades within data window · Trade sample size

Walk-forward optimisation (A35) sits beside them as an opt-in CLI check, because 1,204 engine runs
cannot live in a suite that answers in seconds. **STEP 2 IS DONE.** Both `POST /backtests/:id/validate` and `POST /backtests/:id/optimize` run as
jobs on one shared queue at concurrency 1 (A50), with SSE progress and cancel. Results persist with
their context — feed, data version, engine, seal id and view count, requested vs effective range —
and `GET /backtests/:id/validations`, `/optimizations` and `GET /validations/:id` serve them so the
tab loads past results instead of re-running. `pnpm test:e2e` is **36/36**. **Step 3 is UNDERWAY** (spec saved verbatim to `docs/spec/06b-integrity-tab.md`): the tab shell,
the two-question verdict header (A52), check cards with "why it matters" tooltips, n/a reasons and
clickable evidence that jumps to the Chart tab are built and compile. **Still to build: the six
visuals, the walk-forward optimisation panel, the "Test on holdout" action — then the four DONE
WHEN conditions, none of which has been run in a browser yet** — after which the DONE WHEN, which
requires this exercised in a browser, can be met for the first time. Each must run through `pnpm validate` on the 2022 data before the next
starts. A24 records four constraints agreed ahead of those steps; A26 (trailing-stop replay), A30
(regime mix in the OOS report) and A31 (spread on resting fills from the replay) are post-slice-D
follow-ups.

**A3 is settled (A33): transpile is NOT worth caching.** Measured — script setup is flat at ~14ms
regardless of window, execution is ~39ms + **0.042ms/bar**. Caching would save ~110ms across a
four-fold walk-forward, while `runPretranspiled` bypasses the instrumentation seam and would cost the
order log (which A23/A28 depend on) and the warmup gate. `setupMs`/`executeMs` are now in
`EngineStats` and printed by `pnpm backtest`.

**The A34 check was renamed to what it is (A35): "Rolling out-of-sample (fixed parameters)".** It
runs the script's own inputs on rolling folds — a stability check, not walk-forward optimization,
since nothing is selected in sample. Its ratio is called RETENTION; WFE is reserved for the
optimization. It disagrees with the single OOS split in BOTH directions, which is why both exist:

| fixture            | OOS split | rolling out-of-sample              |
| ------------------ | --------- | ---------------------------------- |
| rsi-mean-reversion | **pass**  | **warn** — 1 of 2 folds, ret -0.20 |
| supertrend-atr     | **fail**  | **pass** — 3 of 4 folds, ret 1.36  |
| bollinger-breakout | **fail**  | **fail** — 1 of 3 folds, ret -0.37 |

**All three ratios normalise by window length (A36).** Comparing raw returns over a 3:1 fold scored an
unchanged strategy at 0.33, and over the 70/30 split at 0.43 — artefacts of the layout that read as
decay. Each window's return is now divided by its length in calendar days (simple, not compounded)
before the ratio, so 1.0 means the same earning rate. This flipped `supertrend-atr`'s rolling verdict
from warn to **pass**: 0.45 was the layout, 1.36 is the strategy.

A full validation is now **13 checks, ~30 engine runs, 2.6s** on six months of H1.

**The sealed holdout is enforced at `readM1` (A37)** — the one function every reader goes through, so
the Studio's date presets, the backtest job, the validation runner and the optimiser are all sealed
by construction rather than by remembering. Overlapping reads are TRUNCATED, not refused; sealed bars
require `readM1Unsealed`, which counts the view before returning anything. Proven on EURUSD 2022 H1
at a 20% holdout: 185,122 bars unsealed, **147,580 sealed** (37,542 withheld), 0 bars for a read
wholly inside the seal, and the view counter going 0 -> 1 on a deliberate unseal. `test:e2e` stays
25/25 because an unsealed symbol reads exactly as before.

> **Left to finish:** the `pnpm holdout` CLI (seal / status / drop) and a validation check that
> reports "holdout viewed N times" in the report rather than only in the database.

**Walk-forward OPTIMIZATION is built and opt-in (A35)** — `pnpm optimize <runId> --inputs` prints the
setup form prefilled from the script's `InputSpec`, `--spec <file>` runs it. Up to three inputs, an
objective and a trade floor; combinations capped at 300 with seeded SAMPLING above that, never
truncation. Per fold it picks a winner in sample and runs it out of sample as its own run, then
reports the stitched OOS equity, WFE, parameter drift and a 2-input sensitivity heatmap. Runs across
the piscina pool with a measured ETA.

On `rsi-mean-reversion` it **FAILS** where the cheaper checks do not: in-sample returns of 8-15%
become out-of-sample returns within half a percent of zero (median WFE **0.06**), and the winning
`rsiLen` lands on a different value every fold — 20, 24, 6, 14, a mean step of 56% of its range. The
same fixture PASSES the single OOS split and only WARNS on the rolling check.

> The first ETA was **21x low**: A33's engine model omits the M1 read in front of every candidate and
> pool startup. Caching bars per thread per window cut a 79.9s run to 24.2s with an identical
> verdict; the estimate is now fitted to two measured runs (~11s startup + ~444ms per run per thread)
> and predicts 23.9s against 27.1s actual.

**The OOS split discriminates on its first real run.** Each segment is its own run from the same
starting capital (A24), never a slice — a slice would inherit position sizes grown by in-sample
profits. On EURUSD H1 2022-01-01 .. 2022-07-01: `rsi-mean-reversion` passes (PF 1.10 -> 1.75), while
**`supertrend-atr` (+5,187.75 -> -487.88) and `bollinger-breakout` (+4,270.92 -> -3,219.33) both
fail** — two of the three fixtures that looked profitable over the full window do not survive.

**Price basis is now explicit per feed (A19).** `bid` for Dukascopy and MT5 imports, `mid` for Twelve
Data, `last` for Binance klines (trade prints, treated as mid, labelled separately). `deriveQuotes`
is the one function that turns a stored price plus a spread into a bid and an ask; the cost overlay,
the asymmetry check and — next — the M1 replay all read it. The basis is derived from the run's feed,
never configured, because the feed guard already refuses a run that straddles two.

**The EURUSD.twelvedata cost total did not move, which is the correct result** — that feed carries no
per-bar spread (0 of 738,570 bars), so half at entry plus half at exit equals a full spread at one
leg. The basis changes WHERE a cost lands, not how much, until the spread or the FX rate differs
between the two fills; on a fixture whose bars carry 0.00008 and 0.0002 the same long costs $8 on bid
and $14 on mid. **The mid-vs-bid error was never worth money in the cost total — it is worth money in
the price LEVELS, and that is where the asymmetry check finds it.**

> **The acceptance feed was 11% short and it was our fault (A14).** Twelve Data omits volume for
> forex, so D4's "flat AND zero-volume" rule collapsed to "drop every flat bar" and deleted 73,850
> real minutes, clustered in the thin hours. Fixed, re-imported, and the feed now holds slightly MORE
> minutes than the bid feed over the window they share. **Still open: this feed is MID, not bid**
> (+0.65x spread above the bid feed), and the cost overlay assumes bid — so its cost attribution is
> wrong on this feed even though the total is close.

**Cost stress is done, and its cross-check found a real bug (A27).** The empirical break-even from
the stress re-runs matches the metrics report's analytical figure **exactly** on a zero-slippage run
(0.84 pips/side either way, break-even at 5.22x costs). Switching slippage on exposed that
`slippagePoints` was **never passed to the engine**: total costs rose from 355 to 3,025 while net
profit did not move, because the waterfall attributed a cost the engine had never charged. Fixed by
passing it as a strategy prop — the same run then went from +1,499.61 to -1,588.05. **Slippage is now measured per fill (A28)**, not
computed from `2 x slippagePoints x mintick`, so the costs shown equal the costs charged by
construction. That measurement settled a question an aggregate could not: **PineTS slips LIMIT fills**
(15.00 ticks on all of market, stop and limit against a 0.00-tick control), where TradingView never
slips a limit order. Recorded in `docs/pinets-notes.md` and surfaced as a `divergent-strategy-prop`
warning — not an "ignored prop" one, since the prop is applied.

**That slippage is now REFUNDED (A29).** A limit order cannot fill worse than its price; its real
risk is not filling at all, which the phantom-target check already measures. The measured amount is
credited back as its own waterfall line — "limit-fill slippage refunded: engine divergence" — and the
P&L identity `grossBeforeCosts - totalCosts === netProfit` still holds because the refund is a
correction, not a cost. On the bracket fixture with `slippage=15`: **$450.00 refunded**, net profit
-1,588.05 -> -1,138.05, total costs 3,023.05 -> 2,573.05, each by exactly that. The analytical
break-even now counts only chargeable sides (a limit fill cannot degrade), shared with the cost
stress rather than recomputed; on the zero-slippage control the two agree **exactly** at 1.06 pips
per side. Schema: `run_trades.slippage_refund`, migration 0004.

**Stop and target levels now come from the ORDER LOG, not from clustering exit prices (A23), and are
paired per exit id (A25).** A `partial-exits` fixture with two simultaneous brackets replays 998 of
1,171 trades against their own bracket's levels with none ambiguous.
Clustering only ever worked for a fixed bracket; the new `atr-bracket` fixture has 183 distinct
adverse exit distances across 296 trades, so both execution checks would have reported `n/a` on it.
Reading `strategy.exit` arguments — already resolved per bar, so an ATR expression arrives as a
number — both now produce results. Trailing stops are `n/a` explicitly. The fixed-bracket run
reproduces its clustered baseline exactly, which is what proves the rewrite.

**The M1 intrabar replay is done and it found real flips on BOTH feeds (A22).** It walks every
resting-order trade minute by minute with sells on the bid and buys on the ask, and catches the error
no exit-based check can: a stop crossed on an earlier bar whose stored prices never reached it.

| feed               | basis | exits | missed stops | phantom targets | P&L correction |
| ------------------ | ----- | ----- | ------------ | --------------- | -------------- |
| EURUSD (dukascopy) | bid   | 89    | **1**        | 0               | -255.00        |
| EURUSD.twelvedata  | mid   | 361   | **4**        | 10              | -850.00        |

Zero phantom targets on the bid feed is the correctness signal — long targets must reproduce exactly
there — and the mid feed's 10 phantoms match A20's 10 flips, found independently. Trade 73 on the
clean feed entered and exited inside ONE H1 bar whose M1 low went well through its stop, and the
engine booked the target: the engine resolves intrabar ambiguity optimistically.

**Every execution-bias total now also reports per fill, in pips and ticks (A21)**, split by gap type.
That immediately exposed a defect: the same-bar estimate was scoring 361 bracket exits as market
fills, inflating it to 1.26 pips per fill. Corrected, it is **-0.01 per fill (-0.00 pips)** over the
361 genuine market entries — near zero, because on an M1-resampled feed one bar's close and the next
bar's open are adjacent minutes.

**Bid/ask asymmetry is done and verified on both feeds (A20)**, and it discriminates: on the
dukascopy bid feed all 89 level exits are flattered by $99.07, entirely on the shorts, with no
outcome changed; on the twelvedata mid feed **10 of 361 level exits would not have triggered at all**
on the side of the book they actually fill on. A flipped outcome is a `fail`, the level error alone a
`warn`. Which exits rest in the book is read from the source (`strategy.exit` ids), not guessed.

The **fill audit** is done and verified: 1,096 fills on the clean fixture all sit inside their bar and
all landed on a bar open — independent evidence for next-bar-open execution — while
`rsi-mean-reversion` warns on 1 touch fill worth $1.00 of penetration cost.

**The look-ahead family is complete and verified on the 2022 acceptance data** (EURUSD H1,
2022-01-03 .. 2022-06-30):

| fixture        | backtest            | static lint | prefix invariance | future splice | verdict  |
| -------------- | ------------------- | ----------- | ----------------- | ------------- | -------- |
| lookahead-leak | PF 22.92, +$145,206 | fail        | **pass (6/6)**    | **fail**      | **fail** |
| lookahead-off  | PF 1.03, +$1,622    | pass        | pass (6/6)        | pass (6/6)    | **pass** |

The leak is caught at the first cutoff on trade 97 — `exitBar` 468 on the real series, 467 once the
following week was replaced. That prefix invariance passes the same run 6 of 6 is the argument for
keeping both layers: truncation covers unbounded leaks, splicing covers bounded ones.

| Piece                                                      | State                         |
| ---------------------------------------------------------- | ----------------------------- |
| `security-log.ts` seam                                     | done, **wired to nothing**    |
| `lookahead.ts` causality (A1a)                             | done, 14 tests, **unwired**   |
| `static-lint.ts` — tokenizer, line numbers                 | done, 18 tests                |
| `prefix-invariance.ts` — cutoffs + margin (A1)             | done, 16 tests                |
| `same-bar.ts` estimate (A5)                                | done, 13 tests                |
| `price-basis.ts` (A19) — one derivation, three consumers   | done, 16 tests                |
| `per-fill.ts` (A21) — pips/ticks + gap breakdown           | done, 11 tests                |
| A2 statuses `pass/warn/fail/n·a` + Inconclusive verdict    | done                          |
| `validateRun` + `pnpm validate <runId>`                    | done, run on the real stack   |
| **Future-splice (A1b)** — the layer that catches the leak  | done, 15 tests, verified      |
| Fill audit + **bid/ask asymmetry (A20)**                   | done, verified on real data   |
| **M1 intrabar replay (A22)** — missed stops + phantoms     | done, 14 tests, verified      |
| Cost stress (A27)                                          | done, verified on real data   |
| OOS split, walk-forward, sealed holdout                    | **not started**               |
| Timeframe matrix, regimes, Monte Carlo                     | **not started**               |
| `POST /backtests/:id/validate` + SSE (step 2)              | **done, e2e 31/31**           |
| `POST /backtests/:id/optimize` + SSE (step 2)              | **done, e2e 36/36**           |
| Integrity tab: header, cards, evidence jump (step 3)       | built, **not browser-tested** |
| Integrity tab: visuals, optimisation panel, holdout action | **not started**               |
| "Integrity & Overfitting" tab (step 3)                     | **not started**               |

| Phase              | Core            | API                  | UI                   |
| ------------------ | --------------- | -------------------- | -------------------- |
| 02 market data     | done, verified  | **code, unverified** | **code, unverified** |
| 03 Pine engine     | done, verified  | **code, unverified** | **code, unverified** |
| 04 runs/costs/eqty | **done** (CLI)  | **code, unverified** | **code, unverified** |
| 05 metrics         | done, verified  | **code, unverified** | **code, unverified** |
| 06 validation      | **step 1 DONE** | ✗                    | ✗                    |
| 07 deployment      | done, verified  | n/a                  | ✗                    |

**The CLI end-to-end backtest is verified; the HTTP one is not.** `pnpm backtest` chains engine →
costs → equity → metrics, persists the run and prints the KPIs. Slice B adds the same chain over
HTTP — BullMQ `backtest`/`ingest` jobs in the piscina pool, SSE progress, cancellation, and the
endpoints below — but none of it has been exercised against a running stack. **No UI at all yet.**

```
POST /api/pine/compile        POST /api/strategies      GET  /api/strategies[/:id]
POST /api/strategies/:id/versions                       GET  /api/symbols
POST /api/backtests           GET  /api/backtests/:id   GET  /api/backtests/:id/trades
GET  /api/backtests/:id/series[?full=1]                 DELETE /api/backtests/:id/job
PATCH /api/symbols/:id        GET  /api/candles         GET  /api/data/coverage
POST /api/data/ingest         POST /api/data/import     GET  /api/jobs/:id/events (SSE)
```

```bash
pnpm backtest --all --symbol EURUSD --tf H1 --from 2024-01-01 --to 2024-02-01
pnpm backtest --fixture ema-cross --symbol EURUSD --tf H1 --from 2024-01-01 --to 2024-02-01 \
  --lots 1 --leverage 100 --costs costs.json
```

What is verified, phase by phase, with the evidence: **`docs/verified.md`**.

Open questions: none outstanding. _Settled:_ the sample-size guard reports `n/a`, never `fail`, on
structurally short walk-forward segments (A34); W1 anchor and fx session DST by D2/D3; `strategy.*` inside
`request.security_lower_tf` by D1 — `compile()` now rejects that combination.

### Slice E — what exists, what does not

The **currency layer is done and verified on real data.** `conversion.ts` is wired into
`orchestrateRun`, D6's guard is gone, and both of the first two USDJPY trades reconcile by hand:

    short  (144.374 - 144.405) x 100,000 = -3,100 JPY / 144.413 = -21.4662 USD
    long   (145.253 - 144.405) x 100,000 = 84,800 JPY / 145.325 = 583.5197 USD

where the divisor is the stored USDJPY M1 close at each trade's exit. Wiring it exposed two further
bugs — the engine was handed account-currency capital (out by ~148x on JPY, so every order was
cancelled for margin and the run reported a clean zero) and the cross-check compared yen against
dollars. Both fixed; see `docs/decisions.md`.

The rest of slice E — the Data page and the dashboard completion — is not started.

| Piece                                                                                           | State                   |
| ----------------------------------------------------------------------------------------------- | ----------------------- |
| `conversion.ts` — pair, direction, rate lookup, missing data                                    | done, 20 tests          |
| Wire it into `orchestrateRun`; remove the D6 guard                                              | **done, hand-verified** |
| Data page (spec 02): provider cards, download form, drop-zone, coverage heatmap, candle preview | **not started**         |
| Exercise Twelve Data and Binance on real data                                                   | **done**                |
| Exness tick importer                                                                            | **NOT PLANNED** (A12)   |
| Dashboard: monthly heatmap, cost waterfall, TV Sharpe on screen, JSON export, print stylesheet  | **not started**         |

**Exness imports and the MT5 parity test are NOT PLANNED (A12).** No export has ever existed at
`packages/data/fixtures/`, both directories are gitignored so vendor data stays local, and a
permanently "blocked" row is indistinguishable from noise. The primitive is built if one ever
arrives: `ensureFeedSymbol` creates `EURUSD.exness` sharing EURUSD's instrument metadata.

### Slice F — what exists, what does not

**v1.0.0 was NOT tagged, deliberately.** Slice F's own DONE WHEN requires "the deployed instance
runs a backtest **and a validation** end to end" — and the validation feature does not exist
(slice D is one module wired to nothing). A `v1.0.0` tag is a durable claim that the product is
complete; creating one now would misrepresent the repo to anyone who reads it later.

| Piece                                                          | State                      |
| -------------------------------------------------------------- | -------------------------- |
| `GET /api/backtests` (list, with denormalised KPIs)            | done                       |
| Runs page: sortable table, run URLs, state + "suspect" badge   | done                       |
| Compare view (2–4 runs, table + equity overlay rebased to 100) | done, browser-verified     |
| `/runs/:runId` report page + copy-link, JSON export, re-run    | done, browser-verified     |
| Print stylesheet (spec 05)                                     | done, not proofed on paper |
| Library page (versions, diff, tags, import/export .pine)       | done, browser-verified     |
| Keyboard shortcut list, skip link, focus rings                 | done, browser-verified     |
| Contrast audit (WCAG AA, asserted by test)                     | done, 4 tokens fixed       |
| Screen-reader pass                                             | **not started**            |
| Performance profiling (1-year M5, walk-forward, 10k trades)    | **blocked** — needs data   |
| Playwright E2E from spec 07                                    | 4 of 5 steps exist, unrun  |
| Rebuild prod images, deploy to Coolify, verify backup          | **cannot be done here**    |

Deployment needs credentials for your Coolify host; none are configured and it is your
infrastructure. The images and `docker-compose.prod.yml` were built and validated back in phase 07.

Spec 07's E2E is "paste a fixture → run → KPIs appear → **run validation** → click a trade → chart
jumps to it". `studio.smoke.ts` already covers every step but the validation one, which cannot be
written until slice D's Integrity tab exists. None of it has been executed — it needs the stack.

**Slice F's buildable surface is now exhausted.** Everything left is blocked on Docker (E2E run,
profiling), on the absent validation feature (the E2E's fourth step, the v1.0.0 tag), or on your
Coolify credentials. `shell.smoke.ts` is 19/19 green in a real browser and covers the Studio shell,
the run report, the Library, Compare and the keyboard/focus behaviour — all without a backend.
