# 00 — Scaffold

> Saved verbatim from the phase prompt before implementation, per the PROJECT.md convention.

---

You are building "EdgeLab", my personal Pine Script backtesting platform. This task only creates the project brain (PROJECT.md) and the scaffold. No features yet.

PRODUCT GOAL
- I paste a TradingView Pine Script strategy (v5 or v6), choose symbol, timeframe and date range, and get a TradingView-grade backtest, a full metrics report, and integrity/overfitting checks.
- Instruments are Exness-style: forex majors and crosses, XAUUSD, XAGUSD, index CFDs, oil, crypto.
- Timeframes: the full MT5 set M1 M2 M3 M4 M5 M6 M10 M12 M15 M20 M30 H1 H2 H3 H4 H6 H8 H12 D1 W1 MN1. Only M1 is stored; everything else is resampled from it.

STACK (pnpm workspaces + Turborepo, Node 22+, TypeScript strict)
- apps/web: React + Vite, Tailwind CSS + shadcn/ui, TanStack Query/Table/Virtual, Zustand, react-hook-form + zod, Monaco editor, TradingView Lightweight Charts v5.
- apps/api: NestJS REST API with SSE for job progress.
- apps/worker: BullMQ workers (queues: ingest, backtest, validation) running CPU-heavy work in a piscina thread pool.
- packages/db: Drizzle schema, migrations, client.
- packages/shared: zod schemas, DTOs, timeframe registry, metric dictionary (label, unit, formula text, higher-is-better).
- packages/data: provider adapters, symbol registry, resampler, file importers.
- packages/engine: Pine execution behind a PineEngine interface, run orchestration, cost overlay, currency conversion, equity reconstruction.
- packages/metrics and packages/validation: pure analytics.
- Infra: PostgreSQL + TimescaleDB, Redis 7, docker-compose for local dev.

CONVENTIONS (write these into PROJECT.md)
- Application code uses UTC epoch milliseconds; the DB uses timestamptz. Bar time = bar open time.
- Computation (resampler, equity, metrics, checks) is pure and unit-tested; I/O sits behind small interfaces so tests can use fakes.
- A phase is done only when pnpm lint, pnpm typecheck and pnpm test are green.
- Secrets come only from .env through a zod-validated config module. Never log API keys, return them from the API, or send them to the browser.
- Every phase prompt I paste is saved verbatim to docs/spec/NN-name.md before implementation.
- If a spec is ambiguous or a library doesn't behave as described, stop and tell me instead of guessing.
- Keep PROJECT.md under ~120 lines: goal, architecture map, commands, conventions, and a "Current status" section updated at the end of every phase.

SCAFFOLD
- Root: pnpm-workspace.yaml, turbo.json, tsconfig.base.json (strict, noUncheckedIndexedAccess), ESLint + Prettier, .editorconfig, .gitignore, .env.example.
- docker-compose.yml: timescale/timescaledb and redis:7 with named volumes and healthchecks.
- apps/api: GET /health checking DB and Redis; typed config module.
- apps/worker: BullMQ connection and a no-op "ping" job.
- apps/web: app shell with left sidebar (Studio, Data, Library, Runs, Settings), top bar, dark theme by default with a light toggle, placeholder pages.
- .env.example: DATABASE_URL, REDIS_URL, TWELVEDATA_API_KEY, ACCOUNT_CURRENCY=USD, API_PORT=3001, WEB_PORT=5173, DATA_CACHE_DIR=./.cache
- Root scripts: dev (all apps in parallel), build, lint, typecheck, test, db:migrate, db:studio.

DONE WHEN: docker compose up -d, pnpm i and pnpm dev work; the shell renders; /health is ok; lint, typecheck and test pass; PROJECT.md and a README exist. Commit "chore: scaffold".
