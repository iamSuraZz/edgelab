# Deploying EdgeLab to Coolify

Written against Coolify's current Docker Compose documentation, not from memory. The three rules that
shape everything below:

- **Coolify generates the Traefik labels** for a Git-based compose application, from the domain you
  set in its UI. You maintain proxy labels yourself _only_ in Raw Compose Deployment. So the compose
  file Coolify reads carries **no** router, service or TLS labels.
- **A domain is bound to one service** through the magic variable `SERVICE_FQDN_<SERVICE>_<PORT>`,
  where `<SERVICE>` is the compose service name with hyphens and dots replaced by underscores.
- **`exclude_from_hc: true`** marks a one-shot container so it does not decide the application's
  health. Plain `docker compose` rejects that key, which is why there are two compose files.

| file                               | used by                                                        | why it differs                                                                           |
| ---------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `docker-compose.coolify.yml`       | **Coolify** — point it here                                    | `exclude_from_hc`, `SERVICE_FQDN`, no hand-written Traefik labels, unpinned volume names |
| `docker-compose.prod.yml`          | a hand-rolled Traefik host, and the local backup restore check | explicit Traefik labels, pinned volume names, declares the external `proxy` network      |
| `docker-compose.restore-check.yml` | the restore check only                                         | the one file that publishes a port                                                       |

`test/compose.test.ts` asserts the first two agree on images, environment keys and services, because
a deployment file that has quietly forked from the verified one is a stack nobody has tested.

---

## 1. Create the application

1. **Project → New Resource → Public Repository.**
2. Repository URL: `https://github.com/iamSuraZz/edgelab`, branch `main`.
3. **Build Pack: Docker Compose.**
4. **Docker Compose Location:** `/docker-compose.coolify.yml`
5. Save. Do **not** deploy yet — the environment variables come first, and a deploy without
   `POSTGRES_PASSWORD` fails on purpose rather than inventing one.

## 2. Set the environment variables

Configuration → Environment Variables. Only the first is mandatory.

| variable             | value                | notes                                                                                                 |
| -------------------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`  | a long random string | **Required.** Generate with `openssl rand -base64 32`. See the warning below about changing it later. |
| `POSTGRES_USER`      | `edgelab`            | optional, defaults to `edgelab`                                                                       |
| `POSTGRES_DB`        | `edgelab`            | optional                                                                                              |
| `TWELVEDATA_API_KEY` | your key             | **Leave empty to disable that provider rather than crash.** Needed for the two-year seed in step 6.   |
| `ACCOUNT_CURRENCY`   | `USD`                | optional                                                                                              |
| `WORKER_POOL_SIZE`   | leave **unset**      | unset means the CPUs this container is actually allowed. Set a number only to spend fewer.            |
| `BACKFILL_TARGETS`   | empty at first       | see step 7. Empty means no scheduled backfill at all.                                                 |
| `BACKFILL_CRON`      | leave unset          | defaults to `17 3 * * *` UTC                                                                          |
| `BACKUP_KEEP_DAYS`   | leave unset          | defaults to 7                                                                                         |

> **`POSTGRES_PASSWORD` only takes effect on the FIRST deploy.** Postgres reads it when it
> initialises an empty data directory and ignores it afterwards, so changing it later leaves the
> database on the old password and every service failing to authenticate. (This is exactly how a
> local verification run failed: a pre-existing volume ignored the new password and the migration
> died on `CREATE SCHEMA`.) To rotate it, change it inside the database with `ALTER ROLE` **and** in
> Coolify, in that order.

## 3. Give the web service a domain, and only the web service

1. Open the **`web`** service inside the application.
2. Put your domain in its **Domains** field, e.g. `https://edgelab.example.com`.
3. Leave every other service's Domains field **empty**.

`SERVICE_FQDN_WEB_8080` is already declared on `web` in the compose file; Coolify fills it in and
generates the router for port 8080.

**Do not give the `api` service a domain.** It has no authentication of its own — the browser reaches
it through nginx inside `web`, on the internal network. A domain on `api` would publish an
unauthenticated API beside the authenticated UI.

## 4. Turn on basic auth

The built-in path, which keeps Coolify's generated labels intact:

1. `web` service → **Configuration → General → HTTP Basic Authentication.**
2. Enable it, set a **Username** and **Password**.
3. Leave **Readonly labels** enabled.
4. Save and redeploy.

Coolify hashes the password and writes the middleware labels itself. Nothing goes in the repository.

<details>
<summary>Generating the hash yourself (only if you prefer explicit labels)</summary>

```bash
# Prints `user:$2y$05$...` — the whole line is the label value.
docker run --rm httpd:2.4-alpine htpasswd -nbB '<username>' '<password>'
```

Then on the `web` service, disable **Readonly labels** and add:

```
traefik.http.middlewares.edgelab-auth.basicauth.users=<the htpasswd line>
coolify.traefik.middlewares=edgelab-auth
```

`coolify.traefik.middlewares` is the shorthand that attaches a middleware to Coolify's generated
router, so you do not have to know the router's UUID. **In a compose file every `$` in the hash must
be doubled** (`$$2y$$05$$...`) or compose will try to expand it. Prefer the built-in toggle and avoid
this entirely. Use one mechanism or the other, never both — two middlewares means two prompts.

</details>

## 5. Deploy

Press **Deploy** and watch the logs. The expected order:

1. `db` and `redis` become healthy.
2. `migrate` runs and **exits 0**:
   `drizzle migrations applied` → `timescale: hypertable created` → `symbols: 19 inserted` →
   `migrate: done`. It stays exited; `exclude_from_hc` keeps that from counting as unhealthy.
3. `api` and `worker` start — they wait on `migrate` completing, not merely starting.
4. `web` becomes healthy on its own `/healthz`, which nginx serves locally so the UI reports healthy
   even if the API is down.

The worker's first log lines say what it decided:

```
worker: listening on backtest, ingest, validation, backfill
worker: worker pool: N thread(s), from N+1 CPU(s) available to this container
worker: no nightly backfill scheduled (BACKFILL_TARGETS is empty)
```

Then open the domain. The browser should challenge you for the basic-auth credentials.

### Confirm SSE survives the proxy

The one thing not fully reproducible locally. Open the Data page, start a download, and watch the
progress bar. It must advance smoothly, and a long validation must not sit frozen. If progress
arrives only in one jump at the end, something between Traefik and nginx is buffering: nginx is
already configured not to (`proxy_buffering off`, `gzip off`, 24h timeouts) and the API sends
`X-Accel-Buffering: no`, so check that **no compression middleware** has been attached to the router.
A heartbeat comment goes out every 15s, which keeps an idle stream alive through a proxy that drops
quiet connections.

## 6. Seed data on the server

Nothing is stored at first. Use the **Data page** rather than the CLI — it is the verified path, and
it shows progress and remaining provider credits while it runs.

**The two-year Twelve Data feed fits inside one day's free budget.** It is the acceptance feed the
validation checks were measured against: 2022-01-01 → 2024-01-01 took **148 requests** against the
free tier's 800/day.

1. Open `https://your-domain/data`.
2. Check the **Twelve Data** card says `ready` and shows `800 / 800` credits. If it says
   `TWELVEDATA_API_KEY is not set`, the variable did not reach the container — set it and redeploy.
3. In the download form choose symbol **`EURUSD.twelvedata`**, provider **Twelve Data**, from
   `2022-01-01` to `2024-01-01`.
4. Press **Download** and leave the tab open. Progress is live.
5. When it finishes, expand the row in **Coverage**: the heatmap should be dense across weekdays and
   completeness should be high. Then press **Preview** and step through M1 → M15 → H1 → H4; the bar
   count must fall roughly by each timeframe's factor, which is the resampler working.

Dukascopy needs no key and serves `EURUSD` directly, but it rate-limits hard — use step 7 for it
rather than waiting on a foreground download.

> **Do not seed synthetic bars into a symbol you then backfill.** A symbol may hold only one feed; a
> run whose range spans two is refused by design, and `runIngest` does not currently stop you from
> creating that situation. One feed per symbol, or use the `.<feed>` suffix form.

## 7. Schedule the nightly backfill

Only after a manual download has worked, so a failure is attributable.

Set on the application:

```
BACKFILL_TARGETS=EURUSD:dukascopy:2022-01-01:2024-02-01
```

Comma-separate more targets. Redeploy, and the worker log should say:

```
worker: scheduled backfill:EURUSD:dukascopy at "17 3 * * *" UTC
```

It runs inside the worker — there is no host cron entry. Each night it resumes where it stopped, and
a rate-limited night is a clean stop that records its cursor rather than a failure. Check progress on
the Data page: a source that has refused for several nights running shows
`dukascopy blocked since <date>` on its provider card instead of staying green.

## 8. Check the backup, and prove it restores

A nightly `pg_dump` lands in the `edgelab-backups` volume with 7-day retention, and one is taken
immediately on deploy so a fresh install is covered without waiting a day.

**That the file exists:**

```bash
docker compose -f docker-compose.coolify.yml exec backup ls -la /backups
docker compose -f docker-compose.coolify.yml logs backup | tail -20
```

Expect `edgelab-<timestamp>.sql.gz` and a line like
`retention 7d: pruned 0 file(s), 1 remain`. The `pg_dump` warnings about circular foreign keys on
`hypertable`, `chunk` and `continuous_agg` are **expected** — they are TimescaleDB's catalog, and the
restore procedure below is what handles them.

**That it actually restores** — the part `ls` cannot tell you:

```bash
docker compose -f docker-compose.coolify.yml exec backup /usr/local/bin/restore-check.sh
```

It restores the newest dump into a scratch database using `timescaledb_pre_restore()` /
`timescaledb_post_restore()`, then verifies the gzip, that `candles_m1` came back as a **hypertable**
and not a plain table, that the compression policy survived, and that three row counts match the
live database. It ends in `PASS` or a named failure.

To go further and serve the application from the restored copy:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.restore-check.yml up -d api worker web
E2E_BASE_URL=http://localhost:8099 pnpm --filter @edgelab/web test:journey
docker compose -f docker-compose.prod.yml up -d api worker web      # back to the real database
```

A dump can restore with matching row counts and still have lost an index the application needs; the
first symptom would be a failed backtest weeks later.

## 9. Point the end-to-end test at the deployment

The same test CI runs, aimed at the server:

```bash
E2E_BASE_URL=https://edgelab.example.com \
E2E_BASIC_AUTH_USER=<username> \
E2E_BASIC_AUTH_PASSWORD=<password> \
  pnpm --filter @edgelab/web test:journey
```

It pastes a strategy, runs it, reads the KPIs, validates it, reads the verdict, clicks a trade and
checks the chart moved — creating everything it needs, so it does not care what the server already
holds. `httpCredentials` answers the basic-auth challenge on every request **including the SSE
stream**, which a hand-written `Authorization` header on the first navigation would not cover.

It needs bars for `EURUSD` over 2024-01-01 → 2024-02-01, so either complete step 6 for that range or
adjust the constants at the top of `journey.smoke.ts`.

---

## Rollback

Coolify keeps previous deployments: open the application's **Deployments** tab and redeploy an
earlier one. The database is a named volume and is **not** rolled back with it, so a deploy that
shipped a migration needs the migration's own reversal — there is no automatic down-migration here.
Take a dump first:

```bash
docker compose -f docker-compose.coolify.yml exec backup /bin/sh /usr/local/bin/backup.sh &
```

## What is not covered

- **No horizontal scaling.** A single worker owns the validation queue at concurrency 1, by design:
  the checks saturate a thread pool and two at once finish slower than one after the other.
- **No log shipping.** `docker logs` and Coolify's log view are it.
- **No TLS configuration here.** Traefik and Coolify own certificates; this application never sees a
  certificate or terminates TLS.
