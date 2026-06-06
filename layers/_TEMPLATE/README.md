# Layer scaffold — "create a new layer"

A **layer = a tile = a department** of a business (Financials, Rent Roll, Documents…).
The home renders entirely from the registry, so **adding a layer never touches the core.**

> **Net rule:** drop a folder in `/layers/` + add one entry to `config/layers.json`. That's it.

This folder is the skeleton. Copy it, rename, fill it in.

---

## The 6 steps to add a layer

1. **Copy this folder** to `/layers/<your-layer-id>/` (kebab-case id, e.g. `maintenance`).
2. **Build the drill-in** at `/layers/<id>/artifact/index.html` — a standalone page
   (link `../../../artifact.css` for the shared theme). It must run as a public page:
   **no `window.cowork`, no MCP, no secrets/PII.** Read committed `./data/*.json` or show an
   honest placeholder. Start from `artifact/index.html` in this template.
3. **Add a data stub** at `/layers/<id>/data/` if the tile shows live numbers, and commit the
   JSON to the repo's top-level `/data/` when the push pipeline fills it. Until then the tile
   shows a graceful "awaiting snapshot" — never a blank, never a fake number.
4. **Register it** — add one object to the `layers` array in `config/layers.json`
   (see `layer.entry.json` here for the exact shape). Order in the array = order on the home.
5. **Give it an employee** (optional but standard) — add an `employee` object
   (`name`, `role`, `avatar`) and `chips` (suggested questions). The core renders the chat;
   you don't write any chat code.
6. **Reload.** The tile appears, routes to your drill-in, and carries its employee.
   No core file was edited.

---

## Fields (see `layer.entry.json`)

| field | meaning |
|---|---|
| `id` | unique kebab-case id; also the folder name |
| `title` / `icon` / `desc` | what the tile shows |
| `group` | `status` · `portfolio` · `market` · `artifact` (which section it renders in) |
| `enabled` | `false` hides the tile with no code change |
| `entitled` | the licensing boundary — `false` hides it for tenants who haven't bought it |
| `data.type` | `fl_api` · `json_file` · `computed` · `static` (how the glance value is sourced) |
| `data.source` | URL / `./data/x.json` / a named computed source |
| `status_rules` | named rule set the core uses to color the tile |
| `drilldown` | `./layers/<id>/artifact/index.html` or `null` (glance-only) |
| `employee` | `{ name, role, avatar }` — the on-call agent for this layer |
| `chips` | suggested questions shown in the employee chat |

## Entitlement (licensing)

The core filters tiles by `enabled !== false && entitled !== false`. For ECH v1 everything is
entitled; for a paid tenant, flip `entitled:false` on the layers they haven't purchased and the
tile simply doesn't render. The boundary lives in the core today, stubbed all-on.

## The employee's memory

Each employee reads/writes the tenant's source-of-truth store through the shared memory
abstraction (`agents.js` → `Memory`), configured in `config/tenant.json`
(`local` / `cloud` / `drive`). You don't wire storage per layer — you declare the employee and
the core handles the rest.

## One codebase → web + desktop + mobile

Keep the drill-in a clean static page with no browser-only hard dependencies, so the whole app
stays wrappable (Tauri/Capacitor) with no rewrite. Mobile-first; it must look native on a phone.
