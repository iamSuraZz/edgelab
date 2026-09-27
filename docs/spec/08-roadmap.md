# 08 — Build order

Supersedes the phase ordering of specs 02–07 (decision D8, `docs/decisions.md`). Those specs
remain the detailed reference for _what_ each area must do; this file governs _when_.

One slice per session. A slice is done only when its DONE WHEN has been verified by running it
— in the browser for UI slices — and lint, typecheck and test are green. See the working
agreement in PROJECT.md.

---

## A · Backend core

Make the whole chain work in code, driven by a CLI, with no UI in the way.

- Data fixes: W1 Sunday alignment, tz-database sessions, filler-bar dropping (D2–D4)
- Finish the engine: the five hand-verified fill tests, trade-level golden snapshots for all
  six fixtures, piscina isolation with a timeout and memory limit
- Cost overlay, equity reconstruction (close-to-close, intrabar-worst, daily/monthly), buy &
  hold, the zero-cost cross-check, and the five tables
- `pnpm backtest` CLI: engine → costs → equity → metrics, persisted, printing a KPI summary

**Done when** the CLI prints a full KPI summary for every fixture on EURUSD H1 for January
2024, the cross-check passes, and the runs are in the database.

Reference: specs 02, 03, 04, 05.

## B · Jobs and API

- BullMQ `backtest` and `ingest` jobs with progress, cancellable, running in the piscina pool
- SSE job events bridged from the worker
- `POST /pine/compile`, `POST /backtests`, `GET /backtests/:id`, `GET /candles`,
  `GET /symbols`, `PATCH /symbols/:id`, `GET /data/coverage`
- Wire `CandlesService` (already written) into a module

**Done when** a backtest runs end to end over HTTP with live progress, and the API is the only
way the CLI-verified chain is reached.

Reference: specs 02, 03, 04.

## C · Studio UI

- Monaco with the Pine Monarch tokenizer, debounced compile, inline markers, Compatibility
  panel
- Inputs form generated from `InputSpec`; settings panel; run button with progress and cancel
- Chart tab (candles, markers, script plots), Trades tab (virtualized), KPI strip

**Done when** a fixture can be pasted, run and read in the browser.

Reference: specs 03, 04, 05.

## D · Validation

- Static lint, causality check, prefix-invariance with margin
- Execution checks, IS/OOS split, walk-forward, regimes, Monte Carlo
- Integrity & Overfitting tab

**Done when** the leaky fixture fails and the clean one passes, in the browser.

Reference: spec 06.

## E · Data page, currency layer, dashboard completion

- Data page: provider cards, download progress, drop-zone, coverage heatmap, quality warnings
- Currency layer behind `quoteToAccount(ts)` (D6), which lifts the cross-currency restriction
- Remaining dashboard tabs, formula tooltips, JSON export

**Done when** a non-USD-quoted symbol backtests correctly and the full report renders.

Reference: specs 02, 04, 05.

## F · Library, polish, v1.0

- Library page with version diffs, tags, import/export
- Runs page and Compare view; per-run URLs
- UI polish pass, accessibility, Playwright E2E, performance profiling
- Tag v1.0.0

**Done when** the E2E suite passes and the deployment stack runs the real thing.

Reference: spec 07.
