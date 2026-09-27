# Engineering notes

Detail lifted out of PROJECT.md to keep it under its ~120-line budget. Read this before
touching the toolchain or the market-data layer.

## Toolchain pins worth knowing

- **TypeScript is pinned to 6.0.3, not 7.x.** `typescript-eslint@8.70.1` declares
  `typescript: ">=4.8.4 <6.1.0"`; TS 7 would break `pnpm lint`. Revisit when
  typescript-eslint supports 7.
- TS 6 deprecated `moduleResolution: node10` and `baseUrl` — the repo uses `nodenext`
  (which emits CommonJS, since no package sets `"type": "module"` except `apps/web`) and
  bare `paths`.
- ESLint is **not** type-aware by design (fast, non-brittle); `pnpm typecheck` is the
  source of truth for types.
- `consistent-type-imports` is off in `apps/api`: `emitDecoratorMetadata` needs those
  imports as runtime values for Nest DI.
- **Every injected constructor parameter in `apps/api` must carry an explicit
  `@Inject(Token)`.** Dev runs under tsx (esbuild), which cannot emit
  `design:paramtypes`, so type-only DI silently injects `undefined` in dev while working
  in the tsc build. Explicit tokens behave identically in both.
- **`pinets` is pinned to `0.9.34` exactly** (AGPL-3.0). 0.10.0 rejects Pine indented with
  2/3/8 spaces, which would reject real pasted scripts. Only `src/pinets/` may import it.
  Read **`docs/pinets-notes.md`** before touching the engine — it records every verified
  API, the instrumentation seam, and the traps that fail silently.

## Market-data specifics worth knowing

- **Only M1 is stored** in `candles_m1` (Timescale hypertable, 1-month chunks,
  segmentby=symbol_id, compressed after 30 days). Bulk load is COPY into an UNLOGGED TEMP
  table then `INSERT … ON CONFLICT DO NOTHING` — COPY cannot express upsert.
- Backfilling a compressed chunk leaves it **partially compressed** and
  `timescaledb_information.chunks.is_compressed` still says `true`, so ingest calls
  `recompressAfterBackfill()`.
- **fx session = Sunday 22:00 → Friday 22:00 UTC**, derived empirically (Dukascopy Fridays
  carry exactly 22h of bars). DST moves it an hour; 22:00 is the permissive choice.
- Dukascopy's `ignoreFlats:false` (needed for bid/ask alignment) emits a **synthetic full
  24h of flat Sunday bars**; the adapter drops closed-market bars before storing.
- Bid and ask are joined **by timestamp, never positionally** — the two series can differ
  in length, and a zip would misassign every spread.
- `dataVersion` on `symbols` is bumped per ingest and is part of the candle cache key, so a
  re-download invalidates cached resamples without a flush.
