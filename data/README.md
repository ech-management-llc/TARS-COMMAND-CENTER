# `data/` — market snapshot drop-zone

`app.js` (the Market Signals tiles on the **FINANCIALS** tab) fetches these JSON
files from this folder at page load. The files are **market data snapshots**
(Reventure / US Census / DealCheck) that currently live in the PRIVATE MEGA_BRAIN
vault. The **vault → repo push pipeline that mirrors them here does not exist yet**
— it is a TARS-side follow-up (out of scope for the v0.6.3 build).

Until that pipeline ships, these files are absent and each tile shows
`awaiting first snapshot push` (graceful absence — no error, no fake data).

## Files the page reads

| File | Tile | Notes |
|------|------|-------|
| `REVENTURE_LATEST.json`      | Reventure — Market      | cap rate + vacancy by county |
| `CENSUS_VACANCY_LATEST.json` | Census — Rental Vacancy | gross rental vacancy, ACS 5-yr |
| `DEALCHECK_PORTFOLIO.json`   | DealCheck — Portfolio   | ECH portfolio properties |

## Behavior

- **Missing file** → tile renders `awaiting first snapshot push`.
- **Stale snapshot** (timestamp older than 48h) → tile shows a `STALE >48h` badge.
- **Public repo (TD-008):** these snapshots are market data only. NO secrets, NO
  PII, NO ECH entity financials may be committed here.

## Minimal schema the tiles read

The renderer is defensive (graceful if fields are missing). It reads an
array (`counties` / `markets` / `properties`) for the headline count and a
timestamp for the stale check. The push pipeline should mirror the vault snapshot
shapes; a minimal example:

```json
{
  "scraped_at": "2026-06-05T12:00:00Z",
  "counties": [
    { "county": "Henderson", "state": "TX", "cap_rate": 0.072, "vacancy": 0.061 }
  ]
}
```

Recognized timestamp keys (first present wins): `scraped_at`, `generated_at`,
`timestamp`, `last_updated`. Recognized count arrays: `counties`, `markets`
(Reventure/Census) or `properties` (DealCheck). Finalize exact shapes when the
push pipeline is built.
