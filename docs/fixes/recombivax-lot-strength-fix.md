# Recombivax Lot Strength Normalization Fix

## Summary

We observed a local NVC data inconsistency for lot `Y016312` (trade name: `RECOMBIVAX HB`) where UI output could show:

- pediatric labeling
- dose `0.5 ML`
- strength `10`

That combination is internally inconsistent for this product family.

## Why This Happened

The lot concept for `Y016312` in local `nvc-bundle.json` references **two** tradename concepts:

1. Pediatric tradename (`code: 6931000087109`)
2. Regular/adult tradename (`code: 6951000087100`)

The pediatric tradename concept itself can include multiple `nvc-strength` extension values (`10` and `5`).
Our previous implementation returned the **first** `nvc-strength` value it encountered, which could surface `10` even when the resolved tradename context was pediatric.

## Fix Implemented

File updated:

- `apps/extension/background.js`
- `apps/extension/content.js`
- `apps/extension/popup.js`

Behavior change in `extractTradenameStrength(concept)`:

1. Collect all `nvc-strength` values (deduplicated).
2. If only one value exists, use it.
3. If multiple values exist, parse strength from the tradename display text (for example, `"5 micrograms per 0.5 milliliter"`), and prefer that parsed value.
4. Fallback to the first collected value only when display text does not provide a parseable strength.

New helper functions:

- `collectTradenameStringValues(concept, extensionUrl)`
- `extractStrengthFromTradenameDisplay(concept)`

Additional scan-time disambiguation:

1. Content script now sends `gtin` alongside `lot` in `lookupVaccineInfo`.
2. Background lot lookup accepts GTIN context and supports deterministic GTIN-to-tradename override mapping.
3. For `00067055046339`, lookup prefers tradename code `6951000087100` (regular/adult RECOMBIVAX HB) when lot references are ambiguous.
4. Popup lookup now also sends GTIN and caches by `lot+gtin` (not lot-only), so the same lot can resolve differently when needed by GTIN context.

## Why This Approach

- It is minimally invasive: only strength selection logic changes.
- It remains resilient to malformed/duplicated upstream extension values.
- It preserves existing behavior where data is unambiguous.
- It prevents pediatric records from inheriting incorrect adult strength when both values are present.
- It adds a scan-context signal (GTIN) to break ties when one lot maps to multiple tradenames.

## Validation

Local validation against the same bundle after the change shows:

- `6931000087109` (pediatric) -> strength `5`
- `6951000087100` (regular/adult) -> strength `10`

Syntax check also passes for `apps/extension/background.js`.

## Notes

This is a client-side normalization safeguard. Upstream NVC lot/tradename linkage and duplicated strength values should still be reported as a source-data quality issue.
