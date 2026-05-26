# Bug: Wrong Agent Selected on Multi-Immunization Grid Page

**Branch:** `fix/agent-selection-first-page`  
**Affected workflow:** Multiple immunization mode — historicalfactoryTable grid page

---

## Symptom

When using multiple-workflow mode, the first page (the grid where nurses confirm the **agent + date** for each vaccine before entering lot/route details) shows the wrong agent in each dropdown row. The selections are consistently shifted — row 0 shows vaccine B's agent instead of vaccine A's, row 1 shows vaccine C's instead of B's, etc. The HUD queue itself is correct; only the autofill on the first page is wrong.

---

## Root Cause 1 — `tryAutoDrain` consuming queue items on the grid page

### What `tryAutoDrain` is supposed to do

`tryAutoDrain` pops the next queue item and fills the **single-immunization detail form** after a save clears it. It is not supposed to run on the multi-immunization grid page.

### Why it fires there anyway

Two guards fail on the grid page:

**Guard 1 — `isPanoramaImmunizationPage()` returns `true` on the grid page**

This function first checks for specific single-page DOM selectors. If none are found it falls back to:

```js
const hasTitle = /* any element with textContent === 'immunizations' */;
const hasDateAdminLabel = /* any label/th with textContent === 'date administered' */;
return hasTitle && hasDateAdminLabel;
```

The `historicalfactoryTable` grid page has an "Immunizations" section heading and a "Date Administered" column header → fallback returns `true`.

**Guard 2 — `isImmunizationFormEmpty()` always returns `true` on the grid page**

```js
function isImmunizationFormEmpty() {
  const agentSelectors = getPanoramaAgentSelectors();  // single-page selectors only
  const fields = getFields(agentSelectors).filter(canFillPanoramaControl);
  // On the grid page, these selectors match nothing → fields = [] → returns true
  return true;
}
```

`getPanoramaAgentSelectors()` returns `immsDetailssection_recordImms_agentiterm` selectors. Those don't exist on the grid page, so `fields` is always empty → the function always returns `true` (empty).

### The resulting race condition

```
t = 250 ms   maybeAutoFillPanoramaMultipleGrid fills rows with queue [A, B, C] ✓
t = 1200 ms  tryAutoDrain fires:
               isPanoramaImmunizationPage() → true  (wrong)
               isImmunizationFormEmpty()   → true  (wrong)
             → applyNextQueueItem() called
             → rows.shift() pops vaccine A from storage
             → queue in storage is now [B, C]
             → autoFillTelus(A_data) tries single-page fields → fills nothing
t = later    Any PrimeFaces DOM mutation (it fires constantly) triggers
             multiGridObserver → checkGrid() → maybeAutoFillPanoramaMultipleGrid
             → reads queue [B, C]
             → row 0 gets B's agent, row 1 gets C's agent  ✗
```

### Fix

Add an explicit grid-page guard at the top of `tryAutoDrain`:

```js
async function tryAutoDrain() {
  if (activeWorkflowMode !== 'multiple') return;
  if (!isPanoramaImmunizationPage()) return;
  if (isPanoramaMultipleImmunizationGridPage()) return;  // ← added
  ...
}
```

---

## Root Cause 2 — `isPanoramaAgentControl` misses grid agent fields (secondary)

### What `isPanoramaAgentControl` does

Controls returning `true` use **strict** matching in `fillSelectField`: bracket-code extraction (`[AgentCode] TradeName`) is tried before any substring fallback.  
Controls returning `false` skip the bracket path and go straight to loose `isLooseSelectTextMatch`.

### Why it misses the grid fields

Grid field IDs look like:

```
historicalfactoryTable:dataTable:0:immsAgentMenu:selectOneMenu_input
```

The check:

```js
return hint.includes('agentiterm')       // → false (no agentiterm in ID)
  || hint.includes('recordimms_agent')   // → false
  || /\bagent\b/.test(hint);             // → false: 'immsagentmenu' has no
                                         //   word boundary around 'agent'
```

`immsAgentMenu` lowercases to `immsagentmenu`. The characters surrounding `agent` are `s` (before) and `m` (after) — both word characters — so `\b` does not match. The grid's agent fields are treated as non-strict controls.

### Fix

Add `agentmenu` as a substring check:

```js
function isPanoramaAgentControl(field) {
  const hint = `${field?.id || ''} ${field?.name || ''}`.toLowerCase();
  return hint.includes('agentiterm')
    || hint.includes('recordimms_agent')
    || hint.includes('agentmenu')   // ← added: matches immsAgentMenu grid fields
    || /\bagent\b/.test(hint);
}
```

---

## Key architectural rules to carry forward

| Rule | Detail |
|---|---|
| `maybeAutoFillPanoramaMultipleGrid` reads queue **by index** (non-destructive) | Never mix with `applyNextQueueItem` (destructive shift) on the same page |
| `isImmunizationFormEmpty()` is **not grid-aware** | Uses only single-page agentiterm selectors; always returns `true` on the grid page |
| `isPanoramaImmunizationPage()` **matches the grid page** via generic fallback | Cannot be used alone as a "not on grid page" guard |
| Panorama dropdown option format is `[AgentCode] TradeName` | `extractBracketAgentCode` is the precise match path; only fires when `isPanoramaAgentControl` returns `true` |
| `\bagent\b` does NOT match camelCase `immsAgentMenu` | Explicit substring checks are needed for field IDs with embedded camelCase substrings |
