# 07 — Library, comparison, polish and deployment

> **Amended by [docs/decisions.md](../decisions.md)** — D8 (build order replaced by docs/spec/08-roadmap.md).
> Where this spec and that file disagree, the decisions file wins.

> Saved verbatim from the phase prompt before implementation, per the PROJECT.md convention.

---

Phase 7: Library, comparison, polish and deployment. Save this prompt to docs/spec/07-polish-deploy.md, then implement.

LIBRARY & HISTORY
- Library page: strategies with versions (diff between versions), tags, notes, duplicate, import/export .pine files.
- Runs page: sortable table of runs (strategy, version, symbol, timeframe, range, key metrics, validation verdict). Select 2–4 runs -> Compare view: metrics side by side with the best highlighted, equity curves overlaid and normalized to 100.
- Every run has its own URL, plus "re-run identical" and "re-run on latest data".

UI POLISH (neat, calm, data-dense)
- 8px spacing scale, Inter for UI, JetBrains Mono for code and numbers, tabular numerals, muted borders, one accent colour. Colour-blind-safe profit/loss colours, always paired with +/- signs.
- Skeleton loaders, helpful empty states, toasts that show the real error message.
- Keyboard shortcuts: Ctrl/Cmd+Enter run, Ctrl/Cmd+S save version, ? shows the list.
- Resizable Studio panes (editor | settings | results) remembered in localStorage. Comfortable on a 1280px laptop; read-only results view on mobile.
- Accessibility: visible focus rings, aria-labels on icon buttons, AA contrast in both themes.

PERFORMANCE
- Profile a 1-year M5 run and a walk-forward job and fix hotspots. Cache resampled bars and stream big trade lists.
- Keep the UI smooth with 10k+ trades (virtualization, memoized charts, downsampled equity curve for display).

QUALITY
- Playwright E2E: paste a fixture -> run -> KPIs appear -> run validation -> click a trade -> chart jumps to it.
- Friendly handling of: Pine compile errors, missing data ranges (one-click download), provider rate limits (show when credits reset), worker timeouts.

DEPLOYMENT (my Coolify server with Traefik in front)
- Multi-stage, non-root Dockerfiles for api, worker and web (static build served by nginx or Caddy).
- docker-compose.prod.yml with healthchecks, restart policies, and named volumes for Postgres and the data cache. Nothing exposed except through Traefik labels.
- Traefik basic-auth middleware (single-user app), documented for Coolify.
- Nightly pg_dump into a volume with 7-day retention.
- README: setup, data download walkthrough, deployment, and third-party licences (PineTS AGPL-3.0; keep the Lightweight Charts attribution enabled, as its licence requires).

DONE WHEN: E2E passes, docker-compose.prod.yml builds and runs, and PROJECT.md "Current status" says v1.0. Commit and tag v1.0.0.
