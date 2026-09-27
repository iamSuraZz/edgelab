# What is verified, and how

One line per phase, naming the evidence rather than the intent. A claim here means it was
observed — a command was run, a number was read off real data. Anything believed but not
exercised says so.

Split out of PROJECT.md, which has a ~120-line budget and was losing the argument to this log.

---

What is verified, in one line each:

- **02** 31,688 EURUSD M1 bars from Dukascopy (Jan 2024), 100% with spreads, resampling cleanly
  to all 21 timeframes (`pnpm verify`); MT5 CSV round-trips 1,440 rows → 1,440 duplicates → 0
  new. Sessions are America/New_York (D3), W1 opens Sunday (D2), and flat zero-volume filler is
  dropped at normalization (D4) — 1,432 such bars purged, 99.65% completeness, 4 open minutes
  missing across a weekend.
  `twelvedata`/`binance` built but never exercised; **`exness-ticks` column layout unverified**
  (no sample file) so it detects headers and fails loudly.
- **03** All 6 fixtures compile with inputs exposed and hold trade-level golden snapshots;
  `orderLog` classified three ways; warmup gate working, with a contract test asserting gating
  _changes_ netprofit (the only way to catch a silent break of the private `_prepared` seam).
  ~90k bars/sec; the documented 5000-bar cap does not apply to custom providers.
  Four of the five hand-verified fill cases match TradingView exactly; the fifth found that
  **PineTS ignores `process_orders_on_close`** (and four sibling flags), so `compile()` now
  warns — see `docs/pinets-notes.md`. Pool isolation proven against real thread deaths:
  timeout, heap exhaustion, throw and `process.exit` each fail only their own job.
- **04** `pnpm backtest` runs all 6 fixtures on EURUSD H1 for Jan 2024: full KPI summary,
  **cross-check PASS on every one**, runs persisted with trades, 4 compressed series blobs
  (16 kB → 3.2 kB) and 131 metric rows each. Spread visibly bites — 29 trades × $8 = $232 on
  ema-cross. Two engine behaviours the run surfaced: PineTS sizes in CONTRACTS, so
  `default_qty_value=1` is one euro; and it **cancels an over-margined order silently**, so 1 lot
  on $10k at the default 100% margin yields zero trades and no explanation. Hence
  `--lots`/`--leverage` and an explicit "orders placed but none filled" warning.
- **05** `buildMetricsReport()` is pure. Two ratio flavours on purpose: ours (daily, sample
  stdev, annualized by sqrt(P) with **P observed from the data** — ~260 fx vs ~365 crypto) and
  a TradingView-style secondary (monthly, rf 2%/12, population stdev, not annualized). The
  worked example in `docs/spec/05-metrics.md` is asserted by a test, so doc and code cannot
  drift.
- **06** Verified while planning that `lookahead_on` IS implemented and `dataCutoffTs`
  truncates HTF bars — but **truncation-based prefix-invariance cannot detect `lookahead_on`**
  (the leak is intra-bucket), and without a one-HTF-bucket margin it flags _clean_ scripts
  too. The working detector is a **causality check** against true bucket boundaries: 200/200
  leaky bars caught, 0 false positives.
- **07** Three non-root images build and run (`web` uid 101, `api`/`worker` uid 100); web
  serves and starts independently of the API. `docker-compose.prod.yml` validates and
  publishes **no ports** — Traefik-only, basic auth, nightly `pg_dump` pruning only after a
  successful dump.
