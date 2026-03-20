# NVC Data Flow

## Core sources

- Default bundle source: `https://nvc-cnv.canada.ca/fhir/v2/Bundle/NVC`
- Local fetch script: `scripts/fetch-nvc.sh`
- Extension lookup path: `lookupVaccineInfo` in `background.js`

## Parsing and enrichment

- Parse GS1 AIs `01`, `10`, `17`, and `21`.
- Keep barcode parsing separate from bundle enrichment.
- Use lot lookup to enrich `trade_name`, `manufacturer`, and expiry metadata.
- Preserve barcode expiry if it is present on the scan.

## Inventory expectations

- Keep raw barcode, lot, expiry, and source fields stable.
- Preserve `scanned_at` and derived timestamps when present.
- Keep export columns consistent unless a consumer change is coordinated.

## Update rules

1. Refresh the bundle locally.
2. Verify lookup behavior against a known lot.
3. Keep the previous bundle if the refresh fails.
4. Do not commit live bundle snapshots without permission.
