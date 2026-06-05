# TCC Last Bump

**Last activity:** 2026-06-05 PM2 — v0.6.3 production rebuild (branch `v0.6.3`, NOT merged)
**Session:** Claude Code — TCC v0.6.3 cutover-ready build (flip GATED on Jerry + Phase 1d step 3 ledger data)
**Operator:** Jerry Eads
**Branch discipline:** all work on `v0.6.3`. `main` (live production) untouched.

## What v0.6.3 did

- **Split the 157KB monolith** → `index.html` + `styles.css` + `app.js`. The single
  file had exceeded the GitHub MCP edit window for a month (TD-012). CSS + JS —
  the most-churned layers — are now small, independently editable files.
  **TD-012 is structurally addressed** (note for the register). Caveat: index.html
  is still ~108KB of bespoke preserved content (not migrated to a data model — see
  the extract-split commit body).
- **Financial row (FL cutover payload):** new **FINANCIALS** tab fetches
  `GET https://api.foundationlayerhq.com/api/dashboard/latest` (public, TD-087) and
  renders 4 Capital Rules tiles, headline metrics, the 6-entity table, data-freshness
  badges, and the generated-at stamp. Ledger values are all 0 today, so an honest
  **LIVE WIRE — awaiting ledger flows (Phase 1d step 3)** badge shows. API-unreachable
  degrades to a last-success state; never blank, never fake.
- **Market tiles:** read `./data/*.json` (Reventure / Census / DealCheck). The
  vault->repo push pipeline doesn't exist yet (TARS follow-up), so tiles show
  `awaiting first snapshot push`; snapshots older than 48h get a STALE badge.
- **PWA:** service-worker cache bumped to `tars-cc-v5-v063`; `styles.css` + `app.js`
  added to the precache.

## The flip (Jerry's gated step)

Merge `v0.6.3` -> `main` to go live. Gated on Phase 1d step 3 real ledger data per
the 2026-05-17 cutover directive. Build is cutover-READY; Jerry flips.
