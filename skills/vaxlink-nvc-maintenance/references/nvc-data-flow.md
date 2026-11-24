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
- Keep the product code and lot available when deciding the formulation. Labels
  can omit the formulation, and the same strength can mean different things
  across brands. Check pediatric, adult and dialysis cases against the catalogue
  when changing classification rules.

## Inventory expectations

- Keep raw barcode, lot, expiry, and source fields stable.
- Preserve `scanned_at` and derived timestamps when present.
- Keep export columns consistent unless a consumer change is coordinated.

## Update rules

1. Refresh the bundle locally.
2. Verify lookup behavior against a known lot.
3. Keep the previous bundle if the refresh fails.
4. Never commit raw NVC bundle snapshots.
