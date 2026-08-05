# HB Pediatric / Adult Classification Fix

**Branch:** `fix/hb-pediatric-adult-reliability`  
**Affected component:** Panorama agent rule matching for hepatitis B vaccines

---

## Symptom

Scanning lot `Y020519` (RECOMBIVAX HB adult) with barcode `1727072910Y020519`
caused VaxLink to select the **HB-pediatric** Panorama agent instead of **HB**.
The barcode encodes only an expiry date (AI 17) and lot number (AI 10) — no GTIN.

The same class of bug existed for lot `Y016312`, which was previously partially
addressed with a GTIN-only override that silently did nothing on lot-only barcodes.

---

## Root cause — three separate failure modes

### 1. Lot override only worked when a GTIN was scanned

The existing `GTIN_TRADENAME_CODE_OVERRIDES` table in `background.js` maps
`00067055046339` (adult RECOMBIVAX HB) → tradename code `6951000087100`.
It fires inside `lookupVaccineLot` via:

```js
const gtinOverrideCode = resolveTradenameCodeOverrideByGtin(options.gtin);
```

When the barcode has no AI(01) field, `options.gtin` is `null` and the override
never runs. The NVC's first tradename reference for the lot was then used — which
for most RECOMBIVAX HB lots is the **pediatric** tradename (listed first in
the NVC FHIR bundle).

### 2. Most RECOMBIVAX HB lots have dual tradename links in the NVC

Inspection of the NVC bundle shows that most RECOMBIVAX HB lots carry **two**
tradename references:

```
[HB] RECOMBIVAX HB pediatric   (code 6931000087109 — 5 mcg/0.5 mL)
[HB] RECOMBIVAX HB             (code 6951000087100 — 10 mcg/mL)
```

The pediatric reference is always listed first. Without an override,
`byCodeCandidates[0]` unconditionally resolves to the pediatric tradename
for all dual-linked lots.

Engerix B lots are single-linked in the NVC (either pediatric or adult, never
both), so they were unaffected by this specific problem.

### 3. Strength-based fallback rules used "N mcg" phrases that never appear

Earlier agent rules in `panorama-agent-rules.js` included strength-based
fallback clauses such as `{ all: ['recombivax', '5 mcg'] }`.

The `extractTradenameStrength()` function in `background.js` reads the
`nvc-strength` FHIR extension, which stores strength as a **bare number
string** (`"5"`, `"10"`, `"20"`, `"40"`). There is no unit in the value.
The function's display-fallback (`extractStrengthFromTradenameDisplay`) also
returns only the number. Neither path ever produces `"5 mcg"` as a token
in the source text passed to `buildPanoramaAgentSourceText`, so the
strength-based rules were silently inert against real NVC data.

---

## NVC data structure — key facts discovered

Running the lookup pipeline against the full NVC bundle revealed:

| NVC code | Tradename display | Picklist label | generic_name | strength |
|---|---|---|---|---|
| `6951000087100` | RECOMBIVAX HB 10 mcg/mL … | **RECOMBIVAX HB** | [HB] Hepatitis B **regular strength** vaccine | `10` |
| `6931000087109` | RECOMBIVAX HB 5 mcg/0.5 mL … | **RECOMBIVAX HB** | [HB] Hepatitis B **pediatric strength** vaccine | `5` |
| `6911000087104` | Engerix B 20 mcg/mL … | **Engerix B** | [HB] Hepatitis B **regular strength** vaccine | `20` |
| `6921000087107` | Engerix B 10 mcg/0.5 mL … | **Engerix B** | [HB] Hepatitis B **pediatric strength** vaccine | `10` |
| `6941000087103` | RECOMBIVAX HB 40 mcg/mL … | **RECOMBIVAX HB dialysis** | [HB] Hepatitis B **dialysis strength** vaccine | `40` |

**Critical observations:**

- The Panorama picklist labels (`enPublicPicklist` designation) are **identical**
  for pediatric and adult variants of both brands. "Engerix B" means both the
  10 mcg/0.5 mL pediatric vial and the 20 mcg/mL adult vial. "RECOMBIVAX HB"
  means both the 5 mcg pediatric and 10 mcg adult formulations.

- The `nvc-linked-generic-concept` extension **always** contains the word
  `"pediatric"` for pediatric codes and `"regular strength"` for adult codes.
  This is the primary reliable signal — it flows into `vaccineInfo.generic_name`
  and from there into `buildPanoramaAgentSourceText`.

- The `nvc-strength` extension returns bare numbers, not `"N mcg"` phrases.

---

## Fix — three layers

### Layer 1: Lot-level tradename override (`background.js`)

Added `LOT_TRADENAME_CODE_OVERRIDES`, a companion to `GTIN_TRADENAME_CODE_OVERRIDES`
keyed by normalized lot number (uppercase, alphanumeric only — same as
`normalizeLotMapKey`):

```js
const LOT_TRADENAME_CODE_OVERRIDES = Object.freeze({
  'Y016312': '6951000087100',  // RECOMBIVAX HB adult
  'Y020519': '6951000087100',
});
```

A new `resolveTradenameCodeOverrideByLot(lot)` function is called alongside the
GTIN override. Both are combined with `||` — GTIN takes priority when present,
lot override fires when no GTIN was scanned:

```js
const gtinOverrideCode = resolveTradenameCodeOverrideByGtin(options.gtin);
const lotOverrideCode  = resolveTradenameCodeOverrideByLot(lotNumber);
const effectiveOverrideCode = gtinOverrideCode || lotOverrideCode;
```

The effective override is then used for tie-breaking when a lot has multiple
tradename candidates. If the override code is not found among the candidates
(e.g. because this lot was later corrected in the NVC), the first candidate is
used as before — the override degrades gracefully.

**Adding new lots:** when a new adult lot is reported as misclassified, add its
lot number to `LOT_TRADENAME_CODE_OVERRIDES` pointing to `6951000087100`.

### Layer 2: Strength-based rule terms use bare number tokens (`panorama-agent-rules.js`)

All strength-based clauses now use the bare numbers that the NVC actually provides:

| Old (non-functional) | New (works with NVC data) |
|---|---|
| `{ all: ['recombivax', '5 mcg'] }` | `{ all: ['recombivax', '5'], notAny: ['dialysis', '10', '40'] }` |
| `{ all: ['engerix', '10 mcg'], … }` | `{ all: ['engerix', '10'], notAny: ['dialysis', '20', '40'] }` |
| `{ all: ['hepatitis b', '5 mcg'], … }` | `{ all: ['hepatitis b', '5'], notAny: ['hepatitis a', 'dialysis', '10', '20', '40'] }` |

The `'10'` check in the Engerix-B pediatric clause is unambiguous because:
- Engerix-B adult is 20 mcg — `'20'` is in `notAny`  
- RECOMBIVAX HB adult is 10 mcg, but its source text contains `'recombivax'` not `'engerix'`,
  so the two brands never cross-match on bare strength alone

### Layer 3: Engerix-B adult clause explicitly blocks strength `'10'`

The old HB adult rule had a single catch-all clause:

```js
{ any: ['engerix b', 'recombivax hb', 'heplisav', 'hepatitis b'], notAny: ['dialysis', 'pediatric', …] }
```

This fired for `{ tradename: 'Engerix B', strength: '10' }` because the name
`'engerix b'` matched and nothing in `notAny` blocked it — the `'10'` token was
not guarded. Combined with the new pediatric strength clause also firing, both
HB and HB-pediatric would be produced simultaneously.

The fix splits the adult rule into brand-specific clauses. The Engerix-B adult
clause now explicitly blocks on `'10'`:

```js
{ all: ['engerix b'], notAny: ['dialysis', 'pediatric', '10', '5'] },
```

When `strength='10'` (pediatric dose) only the HB-pediatric rule fires.  
When `strength='20'` or strength is absent, the adult clause fires normally.

---

## Why these approaches were chosen

**Lot override over modifying NVC tie-breaking heuristics**

The dual-link in the NVC is a data quality issue at PHAC. We do not know
whether PHAC will fix it or leave both links. A heuristic that always picks
"adult when dual-linked" would silently break any future single-pediatric lot
that PHAC happens to add. The override table is explicit: only lots we have
confirmed are adult get overridden. Everything else follows NVC data.

**Generic-name signal over display-label parsing**

The picklist display label ("RECOMBIVAX HB", "Engerix B") is intentionally
short and contains no formulation detail. The `nvc-linked-generic-concept`
extension carries the formulation signal ("[HB] Hepatitis B pediatric strength
vaccine") reliably across all NVC releases because PHAC uses it to describe
what the product treats, not how it is marketed. Relying on it is more durable
than scraping marketing copy.

**Bare number tokens in strength rules**

`extractTradenameStrength()` normalizes multiple `nvc-strength` extension
values by cross-referencing the display text. The display always contains
`"N micrograms"`, so the function reliably returns the number string. There is
no unit suffix. Rules that expect `"N mcg"` will never match NVC data.
The bare number `'5'` only appears as a standalone source-text token from the
`strength` field — it does not appear in tradename, generic_name, disease,
manufacturer, or route for any HB vaccine.

**Not using `dose_value` / `dose_unit`**

These are separate fields (`nvc-typical-dose-size` and
`nvc-typical-dose-size-uom`) but they are **not** included in
`buildPanoramaAgentSourceText`. Adding them would make more data available for
matching but would also risk unintended rule interactions. The strength field
alone is sufficient to distinguish all formulations currently in the NVC.

---

## Key architectural rules to carry forward

| Rule | Detail |
|---|---|
| The primary pediatric signal is `generic_name` | The NVC `nvc-linked-generic-concept` extension always contains "pediatric" for pediatric formulations. This flows through `lookupTradenameByCode` → `vaccineInfo.generic_name` → `buildPanoramaAgentSourceText`. Any new brand-specific rule should verify this extension exists before adding name-only clauses. |
| Strength tokens are bare numbers | `extractTradenameStrength()` returns `"5"`, `"10"`, `"20"`, `"40"` — never `"5 mcg"`. Write strength-based rule terms accordingly. |
| Engerix-B adult and RECOMBIVAX HB adult share the same strength token `"10"` | Engerix-B pediatric is 10 mcg/0.5 mL; RECOMBIVAX HB adult is 10 mcg/mL. Brand-specific clauses (`all: ['engerix b'], notAny: ['10']` vs `all: ['recombivax hb'], notAny: ['5']`) are required to avoid cross-brand confusion. |
| The lot override is the only mechanism for lot-only barcodes | AI(17)+AI(10) barcodes with no GTIN are common. `LOT_TRADENAME_CODE_OVERRIDES` is the only tie-breaker available in that case. When a new adult lot is reported as misclassified, add it there. |
| GTIN override takes priority over lot override | For barcodes that carry both a GTIN and a lot (AI(01)+AI(17)+AI(10)), the GTIN override runs first. This is correct because the GTIN uniquely identifies the product SKU — it is a more specific signal than the lot. |
| Dual-linked RECOMBIVAX lots default to pediatric | Without an override, the NVC's first tradename reference for dual-linked lots is pediatric. This is the NVC's stated data. Only lots confirmed to be adult should be added to `LOT_TRADENAME_CODE_OVERRIDES`. |
| `buildPanoramaAgentSourceText` does not include `dose_value` or `dose_unit` | Only `tradename`, `generic_name`, `disease`, `antigen`, `manufacturer`, `route`, and `strength` contribute to agent rule matching. If a future rule needs dose volume (`0.5 mL` vs `1 mL`), `buildPanoramaAgentSourceText` must be updated in `content.js` first. |

---

## Validation

Integration test `tests/hb-nvc-lots.test.js` runs the full lookup pipeline
(tradename resolution, override application, agent rules) against every HB
lot in the live NVC bundle and asserts:

```
HB (adult):     72
HB-pediatric:  117
HB-dialysis:    29
Ambiguous:       0   ← no lot produces both HB and HB-pediatric simultaneously
Unclassified:    0   ← every lot produces exactly one HB classification
Lot overrides applied: Y016312, Y020519
```

The test skips gracefully when `apps/extension/nvc_bundle.json` is absent (run
`bash scripts/fetch-nvc.sh` to download it locally before running).

Unit tests in `tests/hb-classification.test.js` cover all HB formulation
variants, all override scenarios, brand/strength combinations, dialysis
isolation, HA co-infection guard, French-labelled tradenames, and the exact
`1727072910Y020519` scan scenario.
