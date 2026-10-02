# EdgeLab

A personal Pine Script backtesting platform. Paste a TradingView strategy (v5 or v6),
choose an instrument, timeframe and date range, and get a TradingView-grade backtest with
a full metrics report plus integrity and overfitting checks.

Instruments follow Exness-style CFD specs — forex majors and crosses, XAUUSD, XAGUSD,
index CFDs, oil and crypto. All 21 MT5 timeframes (M1 through MN1) are available; only M1
history is stored and everything else is resampled from it on demand.

> **Status: scaffold.** The monorepo, infrastructure, app shell and the pure-computation
> foundations are in place. Pine execution and the UI features are not built yet — see
> [PROJECT.md](PROJECT.md#current-status) for exactly what exists and what doesn't.

## Licensing note

The Pine Script engine is [PineTS](https://www.luxalgo.com/pinets), pinned to `0.9.34` and
licensed **AGPL-3.0-only**. That is fine for self-hosted personal use, which is what EdgeLab
is for. Be aware that AGPL's network clause means that if you ever expose this to other
users over a network, the source-offer obligation applies to the combined work — so keep it
private, or be ready to publish.

Why 0.9.34 and not the latest: 0.10.0 enforces a 4-column indentation rule and rejects Pine
indented with 2, 3 or 8 spaces, which would reject real pasted scripts. Details and the
full verified API surface are in [docs/pinets-notes.md](docs/pinets-notes.md).

## Requirements

- Node.js 22+ (developed on 26)
- pnpm 11+
- Docker (for PostgreSQL/TimescaleDB and Redis)

## Getting started

```bash
cp .env.example .env      # then fill in TWELVEDATA_API_KEY
docker compose up -d      # TimescaleDB on :5432, Redis on :6379
pnpm i
pnpm db:generate          # first time only, or after a schema change
pnpm db:migrate           # applies migrations and creates the bars_m1 hypertable
pnpm dev
```

- Web: http://localhost:5173
- API: http://localhost:3001
- Health: http://localhost:3001/health

The Vite dev server proxies `/api` and `/health` to the API, so the browser only ever
talks to one origin.

## Layout

```
apps/
  web/        React + Vite UI (Tailwind 4, shadcn/ui, TanStack, Zustand)
  api/        NestJS REST API + SSE
  worker/     BullMQ workers (ingest, backtest, validation) + piscina pool
packages/
  shared/     zod DTOs, timeframe registry, metric dictionary, domain types
  db/         Drizzle schema, migrations, client
  data/       provider adapters, symbol registry, resampler, importers
  engine/     PineEngine interface, orchestration, costs, FX, equity
  metrics/    pure analytics
  validation/ pure integrity + overfitting checks
docs/spec/    the verbatim prompt behind each phase
```

## Scripts

| Command            | What it does                                           |
| ------------------ | ------------------------------------------------------ |
| `pnpm dev`         | Every app in parallel; turbo builds packages first     |
| `pnpm build`       | Topological build of all packages and apps             |
| `pnpm lint`        | One ESLint pass over the repo, warnings are errors     |
| `pnpm typecheck`   | Per-package `tsc --noEmit`                             |
| `pnpm test`        | Vitest; resolves packages to source, no build required |
| `pnpm format`      | Prettier write                                         |
| `pnpm db:generate` | Generate a migration from the Drizzle schema           |
| `pnpm db:migrate`  | Apply migrations + Timescale hypertable setup          |
| `pnpm db:studio`   | Drizzle Studio                                         |

## Conventions

Two that matter most when reading the code:

- **Time is UTC epoch milliseconds everywhere in application code**; the database uses
  `timestamptz`, and conversion happens only in `packages/db/src/time.ts`. A bar's
  timestamp is its **open** time.
- **Secrets come only from `.env` through a zod-validated config module.** API keys are
  never logged, never returned from the API, and never sent to the browser.

The full set, plus the toolchain pins and their reasons, lives in [PROJECT.md](PROJECT.md).

## Testing

Computation is pure and unit-tested; I/O sits behind small interfaces so tests use fakes.
148 tests currently cover the resampler, importer, registries, cost overlay, equity and
drawdown reconstruction, trade statistics, risk ratios, config validation and the
validation checks.

```bash
pnpm test           # once
pnpm test:watch     # watch mode
```

## Deployment (Coolify + Traefik)

Three multi-stage, non-root images and a compose stack that publishes **no ports at all** —
the proxy is the only way in.

**[docs/deploy.md](docs/deploy.md) is the deployment guide**: the exact Coolify UI steps, every
environment variable, how to generate the basic-auth credential, how to seed the two-year feed from
the Data page inside one day's free provider budget, and how to verify the nightly backup _restores_
rather than merely exists.

| file                               | used by                                           |
| ---------------------------------- | ------------------------------------------------- |
| `docker-compose.coolify.yml`       | **Coolify** — it generates the Traefik labels     |
| `docker-compose.prod.yml`          | a hand-rolled Traefik host, and the restore check |
| `docker-compose.restore-check.yml` | the restore check only; the one file with a port  |

Migrations are **not** a manual step: a one-shot `migrate` service runs them and the API and worker
wait for it to complete, because a production database starts empty.

```bash
# A hand-rolled Traefik host. On Coolify, follow docs/deploy.md instead.
cp .env.prod.example .env        # then fill it in, on the server
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

| service  | image                             | user      | notes                               |
| -------- | --------------------------------- | --------- | ----------------------------------- |
| `web`    | nginx-unprivileged + Vite build   | `uid 101` | the only Traefik-exposed service    |
| `api`    | node:22.14-alpine                 | `uid 100` | healthcheck hits the real `/health` |
| `worker` | node:22.14-alpine                 | `uid 100` | BullMQ + piscina, nightly backfill  |
| `db`     | timescale/timescaledb 2.17.2-pg17 | —         | internal network only               |
| `redis`  | redis:7.4.2-alpine                | —         | internal network only               |
| `backup` | postgres:17.2-alpine              | —         | nightly `pg_dump` + restore check   |

### Basic auth

Single-user app, so the proxy guards the whole thing, and only the `web` service is ever exposed —
the API has no authentication of its own and is reached through nginx on the internal network.

On **Coolify** use its built-in HTTP Basic Authentication toggle; nothing goes in the repository. See
[docs/deploy.md](docs/deploy.md#4-turn-on-basic-auth).

On a hand-rolled Traefik host, generate the credential and **double every `$`** before putting it in
`.env`, because compose treats `$` as interpolation:

```bash
docker run --rm httpd:2.4-alpine htpasswd -nbB you 'your-password' | sed 's/\$/\$\$/g'
```

Set `TRAEFIK_NETWORK` to the external network Traefik already runs on.

### Backups

`docker/backup.sh` takes one dump immediately on start (so a fresh deploy is covered, and a
misconfiguration surfaces now rather than at 03:00) and then nightly at `BACKUP_HOUR` UTC.
It prunes **only after a successful dump**, so a broken database cannot quietly age out the
last good backup. Restore with:

```bash
docker compose -f docker-compose.prod.yml exec -T db \
  sh -c 'gunzip | psql -U edgelab -d edgelab' < edgelab-YYYYMMDDTHHMMSSZ.sql.gz
```

### Two things worth knowing

**Image size.** `api` and `worker` are ~885 MB because the whole workspace tree is copied
from the build stage, dev dependencies included. pnpm's `node_modules` is a symlink forest,
so a production-only reinstall or a `prune` in a later stage breaks the workspace links. For
a single-user self-hosted deployment that is a fair trade for a build that actually works;
shrinking it via `pnpm deploy` is a follow-up, not a blocker.

**nginx upstream resolution.** Every `proxy_pass` in `docker/nginx.conf` goes through a
variable with `resolver 127.0.0.11`. This is load-bearing, not style: a literal
`proxy_pass http://api:3001` makes nginx resolve the name at config-parse time and refuse to
start with `host not found in upstream "api"` whenever the API container is not already up —
and it pins the first IP forever, so a redeployed API silently becomes unreachable.

## Third-party licences

- **[PineTS](https://www.luxalgo.com/pinets) — AGPL-3.0-only.** The Pine Script engine,
  pinned to `0.9.34`. Fine for self-hosted personal use. AGPL's network clause means that if
  you ever expose this to other users over a network, the source-offer obligation applies to
  the combined work.
- **[TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) —
  Apache-2.0 with an attribution requirement.** The on-chart TradingView attribution logo
  **must stay enabled**. Do not set `attributionLogo: false` when building the chart
  component — many tutorials and snippets do, and it breaks the licence terms.
- TimescaleDB (Apache-2.0 / Timescale License), PostgreSQL, Redis, nginx, and the npm
  dependencies listed in `pnpm-lock.yaml` under their respective licences.
