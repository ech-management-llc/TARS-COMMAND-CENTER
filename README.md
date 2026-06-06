# TARS Command Center (TCC) — Platform v1

A tile-based operations **command center**, built as a **modular, multi-tenant platform**.
ECH Management is the first (reference) tenant; the architecture is business-agnostic — any
business is just a different set of layers.

> **Positioning:** plug-and-play, zero-thinking, confidence for a non-technical owner.
> Honest display always — every value is live, a graceful "awaiting snapshot", or an honest
> placeholder. Never blank, never faked.

Live: **https://tcc.echmanagement.services** · static PWA on GitHub Pages (serves `main`).
Stack: **vanilla HTML/CSS/JS, no framework, no build step.** Chart.js via CDN where needed.

---

## How it works — the registry

The home **does not hardcode any tiles.** It renders from two config files:

- **`config/tenant.json`** — tenant identity + branding (title, accent), the global agent, the
  memory store location, market defaults, and the entitlement mode. *Zero ECH specifics live in
  the core JS — they live here.*
- **`config/layers.json`** — the ordered **layer registry**. Each entry = one tile
  (`id, title, icon, group, enabled, entitled, data, status_rules, drilldown, employee`).
  Array order = render order.

`app.js` (generic core) reads these, filters by `enabled && entitled`, renders the tile groups
(`status · portfolio · market · artifact`), and routes a tile tap to the **drill-in of the same
name**. `agents.js` renders the global + per-layer AI employees and the pluggable memory store.

### Adding a layer — drop a folder + one registry entry (no core edit)

1. Copy `layers/_TEMPLATE/` → `layers/<your-id>/`.
2. Build `layers/<your-id>/artifact/index.html` (standalone page; link `../../../artifact.css`).
3. Add a data stub if it shows live numbers (graceful absence is built in).
4. Add one object to the `layers` array in `config/layers.json` (see `layers/_TEMPLATE/layer.entry.json`).
5. Add an `employee` + `chips` for the on-call agent (the core renders the chat).
6. Reload. The tile appears, routes, and carries its employee. **No core file changed.**

Full checklist: [`layers/_TEMPLATE/README.md`](layers/_TEMPLATE/README.md).

---

## Repo layout

```
index.html · styles.css · app.js · agents.js   core platform (generic)
artifact.css                                    shared drill-in theme
config/tenant.json · config/layers.json         tenant + layer registry
data/*.json                                     committed data snapshots (graceful if absent)
layers/<id>/artifact/index.html                 each layer's drill-in (standalone public page)
layers/_TEMPLATE/                               the "create a new layer" skeleton
manifest.json · sw.js · icon-*.png · CNAME      PWA + Pages wiring
```

## AI employees + memory

- **Global "TARS"** employee pinned at the top — sees every layer.
- **Per-layer employee** on every drill-in, scoped to that layer.
- A **pluggable memory store** (`local` / `cloud` / `drive`, set in `tenant.json`) is the
  source-of-truth substrate agents load each session and append back to.
- **Source-of-truth layering (locked):** PRIMARY = the storage folder · the **Document Navigator
  is the indexed VIEW of that same folder** (not a separate copy) · BACKUP = a scheduled mirror.
- v1 ships the chat UI + the memory abstraction; the conversational backend is an **honest stub**
  (it surfaces real data it can read and states plainly that free-form answers need a live model —
  it does not fabricate).

## Data sources

- **Foundation Layer API** (live, public): `GET https://api.foundationlayerhq.com/api/dashboard/latest`
  → capital rules + headline metrics + entities. Money is currently $0 (pre-ledger) and rendered
  honestly with a **"LIVE WIRE — real numbers pending"** badge. CORS is allowed for the production
  origin (and `http://localhost:3000` for local dev).
- `data/REVENTURE_LATEST.json` (total housing vacancy + cap rate) and
  `data/CENSUS_VACANCY_LATEST.json` (rental-specific vacancy) — committed, county-keyed.
- `data/DEALCHECK_PORTFOLIO.json` and `data/FRED_LATEST.json` — not present yet → graceful
  "awaiting first snapshot". No live browser calls to third parties; the page reads committed
  JSON + the FL API only.

## Accounts contract

Every money tile resolves through **one accounts model**: Plaid pulls accounts/balances into the
Foundation Layer backend; an account-to-entity map assigns each account to its entity; TCC reads
the FL API (never Plaid directly). Plaid is in **sandbox**, so money renders an honest $0 — real
linkage + dollars land at Plaid production.

## One codebase → three shells

The web PWA is the source of truth. It is built to be **wrapped** later as a desktop app
(Tauri/Electron) and mobile app (Capacitor) with no rewrite: mobile-first responsive, full PWA
(installable, offline shell), clean static bundle, no browser-only hard dependencies. The wrappers
are **not** built here — the architecture just doesn't block them.

## Local dev

```
python -m http.server 3000   # port 3000 so the FL API CORS allows the origin
```
Open http://localhost:3000. The service worker is cache-first; during development, clear it
(DevTools → Application → Service Workers → Unregister, then clear caches) after edits, or use
the in-app **↻ REFRESH** which re-pulls the live sources.

## Deploy

GitHub Pages serves `main`. Work happens on feature branches; the flip to `main` is the owner's
call after review. **Do not auto-merge to `main`.**
