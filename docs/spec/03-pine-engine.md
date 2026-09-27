# 03 — Pine Script engine and editor

> **Amended by [docs/decisions.md](../decisions.md)** — D1 (pinets 0.9.34 pin, indentation warning, security_lower_tf error), D6 (cross-currency runs rejected), D8.
> Where this spec and that file disagree, the decisions file wins.

> Saved verbatim from the phase prompt before implementation, per the PROJECT.md convention.

---

Phase 3: Pine Script engine and editor. Save this prompt to docs/spec/03-pine-engine.md. Show me a plan before writing code.

ENGINE
- Use PineTS (npm "pinets", docs at https://docs.luxalgo.com/developers/pinets). It transpiles native Pine v5/v6, implements the strategy.\* broker emulator and request.security, and accepts custom data providers. Pin an exact version.
- Before coding, read the installed package's type definitions plus these doc pages: Initialization and Usage, Indicator (runtime input/property overrides, input schema), Strategy Namespace, Data Providers, Language Coverage, API Coverage. Write what you verified (exact APIs, limitations, known divergences from TradingView) to docs/pinets-notes.md. Do not invent APIs.
- Put it behind an interface in packages/engine so it can be replaced later:
    PineEngine.compile(source) -> { ok, diagnostics[{line, col, message, severity}], meta { kind: strategy|indicator, version, title, declaredProps, inputs: InputSpec[] } }
    PineEngine.run(params) -> RunResult
  InputSpec = { key, title, type (int|float|bool|string|source|timeframe|session), default, min, max, step, options, group, tooltip }.
- README note: PineTS is AGPL-3.0; fine for my self-hosted personal use.

INSTRUMENTATION HOOK (later phases depend on this)
- Find a reliable way to intercept strategy.entry/order/exit/close/close_all/cancel calls during a run: wrap the namespace if the API allows, otherwise keep a minimal patch with patch-package. Use it for:
  a) orderLog: every call with bar index, time and resolved arguments (id, direction, qty, limit, stop, profit, loss, trail_price, trail_points, trail_offset, from_entry);
  b) trading-window gate: ignore entry/order calls before the requested start date, so indicators warm up on earlier bars without opening positions.
- If neither approach works, document why in pinets-notes.md and fall back to no warmup and an empty orderLog. Never fake data.

DATA BRIDGE
- DbProvider extends PineTS BaseProvider and serves every timeframe from candles_m1 through our resampler (same alignment as the chart), so request.security gets consistent higher-timeframe bars.
- getSymbolInfo comes from the symbol registry (mintick, pointvalue, currency, type, session). mintick must be exact because strategy.exit profit/loss are in ticks.
- DbProvider takes an optional dataCutoffTs: no bar on any timeframe may contain M1 data at or after the cutoff (needed for look-ahead tests).

RUN PARAMETERS (UI overrides; default to the script's strategy() values; show a notice when overridden)
- initial_capital, default_qty_type/value, pyramiding, commission_type/value, slippage (ticks), process_orders_on_close, margin_long/short from a leverage setting (margin % = 100 / leverage), input overrides.

CURRENCY
- The engine's currency conversion is a passthrough, so handle it ourselves. When quoteCcy != account currency, run the engine in the quote currency (initial capital converted at the first bar's rate). The reporting layer converts P&L and equity to the account currency bar by bar using the conversion pair (USDJPY for JPY, GBPUSD for GBP, etc.). If that pair's data is missing, queue its download and tell me.

RUN RESULT (engine-agnostic; everything later builds on it)
- trades[]: id, entryId, side, qty, entryTime, entryBar, entryPrice, exitTime, exitBar, exitPrice, exitId, exitComment, commission, netPnl (engine currency), maxRunup, maxDrawdown, status.
- plots[]: title, color, values aligned to bars (chart overlays).
- orderLog[]; engineStats (netprofit, trade counts, runtime ms, bars processed) for cross-checks.

SAFETY + SPEED
- Runs execute in piscina worker threads with a timeout (default 120 s) and a memory limit; a bad script never crashes the worker. Each thread has its own small DB pool and bar cache.
- Benchmark an EMA-cross strategy on 100k, 500k and 1M bars; record bars/sec in pinets-notes.md; the UI warns before runs likely to exceed ~60 s.

EDITOR (Studio page, left pane)
- Monaco with a Monarch tokenizer for Pine (keywords; namespaces ta. math. strategy. input. request. str. array. color.; literals; //@version) and autocomplete for common built-ins.
- Debounced POST /pine/compile -> inline error markers and a Compatibility panel (unsupported features, plus warnings for anything pinets-notes.md lists as diverging from TradingView, e.g. OCA groups).
- Inputs form generated from InputSpec (min/max/step/options/groups), like TradingView's settings dialog.
- Six example strategies in packages/engine/fixtures, selectable from a dropdown: EMA cross; RSI mean-reversion with strategy.exit SL/TP; Bollinger breakout; Supertrend with ATR stop; MACD with a higher-timeframe trend filter via request.security (non-repainting form); Donchian breakout with trailing stop.

TESTS
- Golden tests: each fixture on a deterministic synthetic OHLC series; snapshot the trades.
- Hand-verified cases:
  - a market entry fills at the next bar's open;
  - strategy.exit loss=N fills at entry - N\*mintick for longs;
  - the pyramiding cap is respected;
  - an opposite strategy.entry reverses the position;
  - process_orders_on_close fills at the same bar's close.

DONE WHEN: every fixture compiles and shows its inputs, and POST /backtests/dry-run returns trades for EURUSD M15 from the DB. Update PROJECT.md and commit.
