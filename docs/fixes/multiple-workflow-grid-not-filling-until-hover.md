# Bug: Multi-Immunization Grid Not Auto-Filling Until Nurse Hovers

**Branch:** `fix/agent-selection-first-page`  
**Affected workflow:** Multiple immunization mode — historicalfactoryTable grid page

---

## Symptom

After scanning multiple vaccines and navigating to the multi-immunization entry grid, VaxLink does **not** fill the agent dropdowns and date fields automatically. The fill only happens when the nurse moves the cursor over the "Enter Details" button (or any other interactive element on the page).

---

## Root Cause — async/sync startup race

### `activeWorkflowMode` starts as `'single'`

```js
// content.js line 19
let activeWorkflowMode = 'single';
```

The real mode is fetched from storage in `initHandsFreeScanner()`:

```js
chrome.storage.local.get([WORKFLOW_MODE_KEY, ...], (stored) => {
  activeWorkflowMode = normalizeWorkflowMode(stored);  // sets 'multiple'
});
```

This callback is **asynchronous** — it fires after all current synchronous code finishes.

### On Panorama SPA navigations the page is already loaded

Panorama uses PrimeFaces SPA-style navigation. When a nurse moves from one Panorama page to another, the browser does not do a full page reload — the content script re-injects into a document where `document.readyState === 'complete'`.

The bottom of `content.js`:

```js
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initClickReductionFeatures);
} else {
  initClickReductionFeatures();  // ← runs RIGHT NOW, synchronously
}
```

`initClickReductionFeatures()` runs **before** the storage callback fires.

### `initClickReductionFeatures` checks mode and finds `'single'`

```js
function initClickReductionFeatures() {
  initPanoramaMultipleGridWatcher();  // sets up observer, calls checkGrid() once
  if (activeWorkflowMode === 'multiple') {
    setTimeout(() => tryAutoDrain(), 1200);  // ← skipped: mode is 'single'
  }
}
```

Inside `initPanoramaMultipleGridWatcher`, `checkGrid()` is called immediately:

```js
const checkGrid = () => {
  if (activeWorkflowMode !== 'multiple') return;  // ← 'single' → exits
  ...
};
```

### The PrimeFaces DOM-mutation burst all see mode `'single'`

When a PrimeFaces page finishes loading it fires a burst of DOM mutations (rendering, AJAX completion, component initialization). Every one of those triggers the `MutationObserver` → `checkGrid()` → exits at the mode guard. The observer is running but completely blind.

### Storage callback fires — but nothing re-triggers

A few milliseconds later the storage callback sets `activeWorkflowMode = 'multiple'`. The original code does nothing else in that callback. By now the PrimeFaces DOM burst has ended and the observer is silent.

### The hover "accidentally" fixes it

When the nurse moves the cursor over "Enter Details", PrimeFaces adds a `ui-state-hover` CSS class to the button element. The `multiGridObserver` watches `attributeFilter: ['class', ...]` — that single class mutation wakes the observer → `checkGrid()` → mode is now `'multiple'` → schedules `maybeAutoFillPanoramaMultipleGrid` → grid fills.

The delay between "storage resolves" and "nurse hovers" is however long the nurse spends looking at the empty grid — typically 5–30 seconds.

---

## Timeline comparison

```
BEFORE FIX (readyState = 'complete' on inject)
─────────────────────────────────────────────
t = 0 ms     initHandsFreeScanner() → fires async storage.get (not done yet)
t = 0 ms     initClickReductionFeatures() runs synchronously
               checkGrid() → mode='single' → BAIL
               tryAutoDrain setTimeout → SKIPPED (mode='single')
t = 0–50 ms  PrimeFaces DOM burst → checkGrid() ×N → all BAIL (mode='single')
t ≈ 5 ms     storage callback fires → mode='multiple'  (too late, nothing re-triggers)
             ...silence...
t = ???      nurse hovers → CSS class mutation → checkGrid() → FILLS ✓ (too late)

AFTER FIX
─────────
t = 0 ms     initHandsFreeScanner() → fires async storage.get
t = 0 ms     setTimeout(initClickReductionFeatures, 0)  ← deferred one tick
t ≈ 5 ms     storage callback fires → mode='multiple'
               → setTimeout(maybeAutoFillPanoramaMultipleGrid, 250)
               → setTimeout(tryAutoDrain, 1200)
t ≈ 5 ms     initClickReductionFeatures() runs (deferred tick fires)
               checkGrid() → mode='multiple' → schedules fill ✓
               tryAutoDrain setTimeout registered ✓
t ≈ 255 ms   maybeAutoFillPanoramaMultipleGrid → fills grid ✓
```

---

## Fix

### Layer 1 — Re-kick from storage callback (primary)

```js
// content.js — inside chrome.storage.local.get callback in initHandsFreeScanner
chrome.storage.local.get([WORKFLOW_MODE_KEY, ...], (stored) => {
  activeWorkflowMode = normalizeWorkflowMode(stored);
  adminDateTimeAutofillEnabled = normalizeAdminDateTimeAutofillSetting(stored);
  vlog('active workflow mode', activeWorkflowMode);

  // Re-kick mode-dependent paths that already bailed when mode was 'single'.
  if (activeWorkflowMode === 'multiple') {
    setTimeout(() => void maybeAutoFillPanoramaMultipleGrid(), 250);
    setTimeout(() => tryAutoDrain(), 1200);
  }
});
```

The 250 ms gap lets PrimeFaces settle. `maybeAutoFillPanoramaMultipleGrid` guards internally with `isPrimeFacesAjaxBusy()` — if still busy it bails, and the MutationObserver will catch the next AJAX-complete mutation.

### Layer 2 — Defer `initClickReductionFeatures` one tick (belt-and-suspenders)

```js
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initClickReductionFeatures);
} else {
  setTimeout(initClickReductionFeatures, 0);  // was: initClickReductionFeatures()
}
```

Yields one task tick so the storage IPC has a better chance to fire and set the mode before `initClickReductionFeatures` reads it.

---

## Key architectural rules to carry forward

| Rule | Detail |
|---|---|
| `activeWorkflowMode` is **not synchronously available** at script start | Always treat it as async-resolved; never write mode-dependent logic that assumes the value is correct during top-level synchronous execution |
| `chrome.storage.onChanged` fires on mode **changes only** | Does not help on page loads where mode was already `'multiple'` when the page navigated |
| The MutationObserver is already set up when storage resolves | The fix does not need to re-initialize the observer — it just needs to call `checkGrid()` (or equivalent) once with the correct mode set |
| On **full page loads** (readyState = 'loading') there is no race | DOMContentLoaded fires hundreds of ms after the fast storage read; this path was always correct |
| On **SPA navigations** (readyState = 'complete') the race is real | The `else` branch runs synchronously, before the storage callback |
