---
name: vaxlink-nvc-maintenance
description: Maintain VaxLink GS1 barcode parsing, vaccine metadata lookup, NVC bundle refresh, and inventory mapping. Use when working on `popup-parser.js`, `background.js`, `lookupVaccineInfo`, bundle fetches, expiry logic, or barcode-to-lot enrichment in `apps/extension`.
---

# VaxLink NVC Maintenance

## Focus

Use this skill for the data path, not UI selectors.
The goal is a fast, predictable mapping from barcode to structured vaccine metadata.

## Operating Rules

- Keep GS1 parsing strict and explicit.
- Preserve last-known-good bundle behavior when refresh fails.
- Treat lot lookup as enrichment, not a source of truth for scanner parsing.
- Keep inventory exports stable because downstream tools may depend on the column set.
- Avoid committing downloaded bundle snapshots unless explicitly requested.

## Primary Files

- `apps/extension/popup-parser.js`
- `apps/extension/popup.js`
- `apps/extension/background.js`
- `apps/extension/popup-inventory.js`
- `scripts/fetch-nvc.sh`

## What To Preserve

- AI/GS1 parsing of `01`, `10`, `17`, and `21`.
- NVC lookup keyed by lot and optionally GTIN.
- JSON/CSV inventory export columns.
- Local bundle refresh cadence and fallback bundle handling.
