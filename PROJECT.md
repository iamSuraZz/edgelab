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

Green: `build` 9/9, `typecheck` 16/16, `lint` clean, **681 tests** (`pnpm test`).
CI runs all five checks on every push — see `.github/workflows/ci.yml`.

**Verified against the real docker stack:**

| check             | result | covers                                            |
| ----------------- | ------ | ------------------------------------------------- |
| `pnpm test:e2e`   | 25/25  | **slice B DONE WHEN**                             |
| `pnpm test:smoke` | 23/23  | **slice C DONE WHEN**, and slice F's browser work |

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

Still to build in step 1, in this order: **A1b future-splice** (the leaky fixture currently escapes
prefix invariance — see the box below), then wire the causality layer through the adapter's
instrumentation seam, then execution bias, OOS + walk-forward, timeframe matrix + regimes, and
Monte Carlo. Each must run through `pnpm validate` on the 2022 data before the next starts.

Observed on real EURUSD H1, January 2024:

| fixture        | backtest           | `pnpm validate` verdict        |
| -------------- | ------------------ | ------------------------------ |
| lookahead-leak | PF 37.54, +$18,650 | **fail** (static lint, line 8) |
| lookahead-off  | PF 0.70, −$1,807   | **pass**                       |

The leaky fixture's fantasy PF is itself the tell, and the clean twin is an ordinary loser — which
is the point of shipping them as a pair: a check that failed both would have found nothing.

| Piece                                                   | State                       |
| ------------------------------------------------------- | --------------------------- |
| `security-log.ts` seam                                  | done, **wired to nothing**  |
| `lookahead.ts` causality (A1a)                          | done, 14 tests, **unwired** |
| `static-lint.ts` — tokenizer, line numbers              | done, 18 tests              |
| `prefix-invariance.ts` — cutoffs + margin (A1)          | done, 16 tests              |
| `same-bar.ts` estimate (A5)                             | done, 11 tests              |
| A2 statuses `pass/warn/fail/n·a` + Inconclusive verdict | done                        |
| `validateRun` + `pnpm validate <runId>`                 | done, run on the real stack |
| **Future-splice provider (A1b)**                        | **not started — see below** |
| Execution bias (fill audit, intrabar, cost stress)      | **not started**             |
| OOS split, walk-forward, sealed holdout                 | **not started**             |
| Timeframe matrix, regimes, Monte Carlo                  | **not started**             |
| `POST /backtests/:id/validate` + SSE (step 2)           | **not started**             |
| "Integrity & Overfitting" tab (step 3)                  | **not started**             |

> **Read before continuing: prefix invariance does NOT catch the leaky fixture.** Measured, not
> assumed — it passes 6 of 6 cutoffs. Truncation only removes data at the end, so a bounded
> look-ahead perturbs decisions only within one HTF bucket of the cutoff, which is exactly the
> region the A1 margin must exclude to avoid failing every honest HTF strategy. The two
> requirements conflict. It still catches UNBOUNDED leaks (`last_bar_index`, `barstate.islast`,
> whole-series normalisation), and its passing message now says only that.
>
> The leak is therefore caught by the **static lint alone** right now. **Build A1b (future splice)
> first** in the next step: keep every bar and timestamp, replace the data after each cutoff with a
> different real segment rescaled to the cutoff price. Nothing is removed, no margin is needed, and
> an intra-bucket leak diverges on the first affected bar.

| Phase              | Core            | API                  | UI                   |
| ------------------ | --------------- | -------------------- | -------------------- |
| 02 market data     | done, verified  | **code, unverified** | **code, unverified** |
| 03 Pine engine     | done, verified  | **code, unverified** | **code, unverified** |
| 04 runs/costs/eqty | **done** (CLI)  | **code, unverified** | **code, unverified** |
| 05 metrics         | done, verified  | **code, unverified** | **code, unverified** |
| 06 validation      | **step 1 done** | ✗                    | ✗                    |
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

Open questions: whether the validation
sample-size guard should report `n/a` rather than `fail` on structurally short walk-forward
segments. _Settled:_ W1 anchor and fx session DST by D2/D3; `strategy.*` inside
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
