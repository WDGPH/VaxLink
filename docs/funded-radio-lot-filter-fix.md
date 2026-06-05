# Funded Radio Lot Filter Fix

**Branch:** `fix/funded-radio-lot-filter`  
**Affected component:** Panorama lot selection in `content.js`  
**Related issues:** #12 (NPF barcode scans as PF), #19 (Recombivax PF 0.5ml scans as NPF)

---

## Symptom

Nurses reported that scanning certain vaccine barcodes caused the wrong funding
status to appear in Panorama — publicly funded vaccines were recorded as
non-publicly funded, or vice versa.

---

## Root cause

### The funded radio is a lot-list filter, not a field VaxLink fills

The Panorama immunization form contains a radio button group above the lot
dropdown:

```
( ) Show All   ( ) Publicly Funded   ( ) Non-Publicly Funded
```

This radio **filters which lots are visible** in the lot dropdown. It does not
directly set the funding status on the record — that is a read-only field
Panorama auto-populates from whichever lot is selected.

When the radio is set to **Non-Publicly Funded**, only NPF lots appear in the
lot dropdown. If a nurse had previously set it to filter NPF lots and VaxLink
then tries to fill a publicly funded lot, one of two failure modes occurs:

1. **Lot not found** — the lot is not in the filtered list, so VaxLink's
   `fillPanoramaLotFromSelect` and `fillPanoramaLotFromPanelItems` both return
   `false`. VaxLink falls back to typing the lot number directly. Panorama may
   accept the typed value but resolve it to an NPF lot entry, or show the lot
   as unrecognized.

2. **Wrong lot selected** — in rare cases where an NPF lot has the same number
   as a PF lot (different products), Panorama selects the visible NPF lot,
   causing the wrong funding status and trade name to populate.

### The publicly funded checkbox is read-only

The `addimmsdetails_vaccDetailssection1createImms_publiclyfunded` checkbox that
shows the final funding status is rendered with `disabled="disabled"`. Panorama
sets it after lot selection. VaxLink cannot and should not write to it directly.

### Selector evidence from DOM (pano3.html)

```
input[id*="fundedRadio:selectOneRadio"][value="SHOW_ALL"]        ← index :0
input[id*="fundedRadio:selectOneRadio"][value="PUBLICLY_FUNDED"] ← index :1
input[id*="fundedRadio:selectOneRadio"][value="NON_PUBLICLY_FUNDED"] ← index :2
```

The radio's `onchange` fires a PrimeFaces AJAX call that refreshes the lot
panel (`lotNumberSelect`, `lotNumberAutoComplete`, and related lot detail
fields). The refresh completes asynchronously — the lot dropdown is repopulated
only after the AJAX round-trip finishes.

---

## Fix

### `resetPanoramaFundedRadioToShowAll()` — `content.js`

A new function finds the "Show All" radio input and clicks it if it is not
already selected:

```js
function resetPanoramaFundedRadioToShowAll() {
  const radio = document.querySelector(
    'input[id*="fundedRadio:selectOneRadio"][value="SHOW_ALL"]'
  );
  if (!radio) return 'not_found';
  if (radio.checked) return 'already';
  const box = radio.closest('.ui-radiobutton')?.querySelector('.ui-radiobutton-box');
  if (box) box.click();
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
  return 'clicked';
}
```

Return values:

| Value | Meaning |
|---|---|
| `'not_found'` | Radio not present — page is not at the lot selection step yet, or selector changed |
| `'already'` | Already on Show All — no action needed, proceed to lot fill |
| `'clicked'` | Just clicked — AJAX is now in flight, must wait before filling |

### Integration into `schedulePanoramaLotOrTradeSelection()` — `content.js`

A `fundedRadioEnsured` flag (scoped to each call of
`schedulePanoramaLotOrTradeSelection`) gates the radio check so it runs once
per fill attempt, after the agent is confirmed but before the lot fill:

```js
let fundedRadioEnsured = false;

// inside runAttempt():
if (!resolved && hasResolvedAgent && !busy) {
  if (!fundedRadioEnsured) {
    const radioResult = resetPanoramaFundedRadioToShowAll();
    fundedRadioEnsured = true;
    if (radioResult === 'clicked') return; // wait for AJAX to refresh lot panel
  }
  resolved = tryFillPanoramaLotOrTrade(data) || hasPanoramaLotOrTradeSelection(data);
}
```

**Why after agent, not at the start:**  
The lot filter radio is not rendered until after the agent is selected and
Panorama loads the lot section. Checking too early returns `'not_found'` and
sets `fundedRadioEnsured = true` prematurely, preventing the actual reset.
Gating on `hasResolvedAgent` ensures the radio exists in the DOM before we look
for it.

**Why return early on `'clicked'`:**  
Clicking the radio fires a PrimeFaces AJAX call. The lot dropdown is
repopulated asynchronously. If we attempt the lot fill immediately, the list
still reflects the previous filter state. Returning early lets the existing
`isPrimeFacesAjaxBusy()` guard on the next `runAttempt` pass hold off the lot
fill until Panorama finishes refreshing.

**Why `fundedRadioEnsured = true` even on `'clicked'`:**  
We only need to reset the filter once. Clicking it again on subsequent attempts
would re-trigger the AJAX unnecessarily and could cause a fill timing loop.

---

## Why "Show All" rather than "Publicly Funded"

Setting the filter to "Publicly Funded" would hide NPF lots. For clinics that
administer both PF and NPF vaccines, a nurse scanning an NPF vaccine would find
no lot match. "Show All" is the safest default: it never hides a valid lot
regardless of its funding category, and the correct funding status is always
determined by whichever lot Panorama resolves — not by VaxLink.

---

## Sequence after fix

```
1. Agent fill completes (PrimeFaces AJAX settles)
2. runAttempt: fundedRadioEnsured = false → calls resetPanoramaFundedRadioToShowAll()
   a. If already Show All → fundedRadioEnsured = true, proceed to lot fill
   b. If NPF or PF was selected → click Show All, fundedRadioEnsured = true, return early
3. PrimeFaces AJAX refreshes lot panel (isPrimeFacesAjaxBusy() returns true)
4. Next runAttempt: busy = false, fundedRadioEnsured = true → lot fill proceeds
5. Lot matched from full (unfiltered) lot list
6. Panorama auto-populates tradename, route, dose, manufacturer, publicly funded checkbox
```

---

## Testing

This fix requires a live Panorama session to verify. Manual test steps:

1. Open a new immunization record in Panorama.
2. Manually set the funded radio to **Non-Publicly Funded**.
3. Scan a publicly funded vaccine barcode (e.g. Recombivax HB pediatric).
4. Confirm VaxLink:
   - Resets the radio to Show All before filling the lot
   - Fills the correct lot
   - Panorama shows the correct tradename and "Publicly Funded" checkbox checked
5. Repeat with the radio set to **Publicly Funded** and scan an NPF barcode.
6. Confirm VaxLink resets to Show All and the correct NPF lot is filled.

There are no automated tests for this fix — the radio interaction requires a
live PrimeFaces page. The existing 66-test suite continues to pass.

---

## Selectors to watch

If Panorama updates its component IDs, the radio selector may need updating.
The stable part of the ID is `fundedRadio:selectOneRadio` — the prefix
(`recordImmsForm:immsDetails_dataTable:immsDetails_Factory:immsDetailssection_LotInfo`)
follows the standard Panorama JSF naming pattern and is unlikely to change
independently of a major form restructure.
