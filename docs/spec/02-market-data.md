# 02 — Market data layer

> **Amended by [docs/decisions.md](../decisions.md)** — D2 (W1 opens Sunday), D3 (tz-database sessions), D4 (drop flat zero-volume filler bars), D7, D8.
> Where this spec and that file disagree, the decisions file wins.

> Saved verbatim from the phase prompt before implementation, per the PROJECT.md convention.

---

Phase 2: Market data layer. First save this prompt to docs/spec/02-market-data.md, then implement it.

SYMBOL REGISTRY (table symbols, seeded, editable in Settings)
- Fields: symbol (canonical, e.g. EURUSD), assetClass (fx|metal|index|energy|crypto), baseCcy, quoteCcy, digits, mintick, pipSize, contractSize (units per lot: fx 100000, XAUUSD 100, XAGUSD 5000, crypto 1; index/energy editable), pointValue (default 1), defaultSpreadPoints, providerSymbols (json per provider), sessionType (fx24x5 | crypto24x7).
- Seed EURUSD GBPUSD USDJPY USDCHF AUDUSD NZDUSD USDCAD EURJPY GBPJPY EURGBP XAUUSD XAGUSD BTCUSD ETHUSD, plus US500/US30/USTEC-style indices and oil only if Dukascopy offers them. Take instrument ids from dukascopy-node's own instrument list; never guess ids.

STORAGE
- Hypertable candles_m1(symbol_id, ts timestamptz, open, high, low, close, volume, spread nullable, source), primary key (symbol_id, ts), compression for chunks older than 30 days.
- Bulk load with COPY (pg-copy-streams); ignore duplicates.
- Coverage view per symbol: first/last bar, bar count, gaps.

PROVIDER ADAPTERS (packages/data), one interface:
  fetchM1(symbol, from, to, onProgress): AsyncIterable<Bar[]>; capabilities().
  All output normalized to UTC ms, deduped, validated (high >= max(open, close), low <= min(open, close), finite numbers).
- dukascopy (no key): dukascopy-node. Fetch M1 bid AND M1 ask for the same range; store bid OHLC plus spread = ask.close - bid.close. Chunk by month, use its disk cache in DATA_CACHE_DIR, pause between batches.
- twelvedata (TWELVEDATA_API_KEY): time_series, interval=1min, outputsize=5000, paging backwards by end_date. Token bucket of 8 requests/min plus a daily budget of 800 tracked in Redis; show remaining budget in the UI. Missing key = adapter disabled, not a crash.
- binance (no key): spot klines 1m, paginated, for crypto.
- exness-ticks importer: I download monthly ZIPs by hand from Exness's public Tick History page and upload them. Stream-parse (never load whole files into memory), detect the header instead of hardcoding columns, aggregate ticks to M1 on bid with mean spread per minute and tick count as volume.
- mt5-csv importer: MetaTrader 5 "Export Bars" files (tab or comma separated; <DATE> <TIME> <OPEN> <HIGH> <LOW> <CLOSE> <TICKVOL> <VOL> <SPREAD>; dates like 2024.01.02; SPREAD in points). Ask for the broker's server-time UTC offset at upload and convert to UTC.

RESAMPLER (pure, heavily tested)
- resample(m1Bars, tf, opts) for every MT5 timeframe. Intraday buckets aligned to UTC; D1 boundary = opts.dayStartOffsetMinutes (default 0 = 00:00 UTC, configurable for NY-close brokers); W1 starts Monday (configurable); MN1 = calendar month.
- open = first, high = max, low = min, close = last, volume = sum, spread = mean; also return each bar's close time. Never emit bars for empty buckets.
- Property tests: M1->M5->M15 equals M1->M15; volume conserved; high/low bounds hold; no bar crosses a bucket boundary.
- Timeframe registry in packages/shared maps MT5 code <-> Pine timeframe string ("1","2",...,"60","120","240","720","D","W","M") <-> duration.

DATA QUALITY REPORT per symbol and range: unexpected gaps (weekend-aware for fx), duplicate timestamps, zero-range bars, spikes (true range > 10x rolling median), spread outliers.

JOBS + API
- BullMQ ingest job with progress, resumable from the last stored bar.
- GET /symbols, PATCH /symbols/:id, POST /data/ingest {provider, symbol, from, to}, POST /data/import (multipart), GET /data/coverage, GET /candles?symbol&tf&from&to (resampled; LRU cache keyed by symbol|tf|range|dataVersion), GET /jobs/:id/events (SSE).

UI: Data page
- Provider cards with status (key present or missing, Twelve Data credits left).
- Download form with live progress bar; drop-zone for Exness tick ZIPs and MT5 CSVs.
- Coverage table with a per-day bar-count calendar heatmap and data-quality warnings.
- Candle preview (Lightweight Charts) with an MT5-style timeframe chip bar.

DONE WHEN: 3 months of EURUSD M1 download from Dukascopy and display correctly on every MT5 timeframe, an MT5 CSV import works, and resampler tests pass. Update PROJECT.md status and commit.
