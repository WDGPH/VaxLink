# Bug: Extension Intercepts Legitimate Copy/Paste in Panorama

**Branch:** `fix/paste-interception`  
**Affected workflow:** All hands-free modes — any Panorama or InputHealth page where the content script is active

---

## Symptom

A clinician attempts to paste text from the clipboard into a Panorama form field — a patient note, a date typed as `"01/01/2024"`, a health card number beginning with `"01"`, or any freeform text containing the digit sequence `"01"` — and the paste silently fails. The field remains empty. No error is shown. The clipboard content is not placed into the target element.

The problem is not reproducible in other applications (the clipboard works normally outside Panorama), and disappears if the VaxLink extension is disabled, confirming the extension is the source.

---

## Root Cause — overly broad paste gate

### The paste handler

`onHandsFreePaste` in `content.js` intercepts all paste events on the page (captured at the `window` level) and decides whether to redirect the clipboard content to the barcode scanner pipeline instead of allowing it to land in the target element:

```js
window.addEventListener('paste', onHandsFreePaste, true);   // capture phase
```

The decision logic before the fix:

```js
function onHandsFreePaste(event) {
  if (!isHandsFreeSupportedPage()) return;

  const text = String((event.clipboardData && event.clipboardData.getData('text')) || '').trim();
  if (!text || text.length < SCAN_MIN_LENGTH) return;
  if (!isCandidateGS1Text(text)) return;   // ← the only gate

  event.preventDefault();                  // ← blocks the paste
  handleHandsFreeScan(text, 'paste');
}
```

If `isCandidateGS1Text` returns `true`, the paste is consumed by VaxLink unconditionally. The clinician never sees the text appear in the field.

---

### Why `isCandidateGS1Text` is too broad for paste

`isCandidateGS1Text` was designed for **incremental keystroke screening** — deciding whether a keystroke sequence that is still accumulating in `scannerBuffer` could eventually become a GS1 barcode. Being wrong in the loose direction is cheap: the scanner idle timer will reset the buffer. Being wrong in the strict direction means missing real scans.

For that purpose the function is correct. For paste interception it is not — because for paste the full text is already available and the decision is **irreversible** (`event.preventDefault()` cannot be undone).

The function delegates to `normalizeScannerCandidate` before testing:

```js
function normalizeScannerCandidate(value) {
  let s = String(value || '').trim()
    /* ... strip control chars, brackets ... */;
  if (!s.startsWith('01')) {
    const first01 = s.indexOf('01');
    if (first01 > 0) {
      s = s.substring(first01);   // ← extract everything from the first "01"
    }
  }
  return s;
}
```

After normalization, `isCandidateGS1Text` checks:

```js
if (normalized.startsWith('01') || normalized.includes('01')) return true;
```

**Because `normalizeScannerCandidate` already seeks forward to the first `"01"` in the string, the `startsWith('01')` check after normalization passes for any input that contains the substring `"01"` anywhere.** The `includes('01')` condition is effectively redundant — it returns the same result.

---

### Affected clipboard content — concrete examples

| Pasted text | What normalization extracts | Candidate check |
|---|---|---|
| `"01/01/2024"` | `"01/01/2024"` (starts with "01") | ✓ — **intercepted** |
| `"Administered 01 dose today"` | `"01 dose today"` (offset 13) | ✓ — **intercepted** |
| `"DOB: 01-15-1985, health card 01234"` | `"01-15-1985, health card 01234"` | ✓ — **intercepted** |
| `"Chart note: visit #0156, dose #01"` | `"0156, dose #01"` | ✓ — **intercepted** |
| `"Phone: 01 800 555 0199"` | `"01 800 555 0199"` | ✓ — **intercepted** |

All of the above triggered `event.preventDefault()` before the fix.

---

### Why copy is unaffected

`onHandsFreeKeydown` returns early for any event where `ctrlKey` or `metaKey` is held:

```js
if (event.ctrlKey || event.metaKey || event.altKey) return;
```

Ctrl+C never accumulates characters into `scannerBuffer`. Copy works correctly.

---

### The secondary failure mode — non-numeric GTIN

`parseGS1BarcodeFromScanner` requires that a string starting with `"01"` have at least 16 characters (2-char AI + 14-char GTIN). For shorter strings it throws:

```js
if (s.length < 16) {
  throw new Error('AI(01) GTIN incomplete');
}
```

However, it does **not** require the 14 GTIN characters to be digits. For a string like `"Administered 01 dose of vaccine today"`:

1. Normalization extracts from offset 13 → `"01 dose of vaccine today"` (24 chars, ≥ 16 ✓)
2. Parser extracts `data.gtin = s.substring(2, 16)` = `" dose of vaccin"` — garbage, but no exception
3. Parser returns `{ gtin: " dose of vaccin", ... }` — truthy, no exception

If the fix only checked for a successful parse without inspecting the GTIN, strings with embedded `"01"` that happen to be ≥ 16 characters long would still be intercepted.

---

## Timeline comparison

```
BEFORE FIX
──────────────────────────────────────────────────────────────
Clinician copies "DOB: 01-15-1985" from another field
Clinician focuses a Notes field in Panorama
Clinician presses Ctrl+V

  keydown (ctrlKey=true)   → onHandsFreeKeydown → returns early ✓
  paste event fires
  → onHandsFreePaste
       isCandidateGS1Text("DOB: 01-15-1985, health card 01234")
         normalizeScannerCandidate → "01-15-1985, health card 01234"
         startsWith("01") → TRUE
       → event.preventDefault()   ← paste blocked
       → handleHandsFreeScan(...)  ← attempts autofill, finds nothing, fails silently

  Notes field remains empty.
  Clinician is confused. Tries again. Same result.


AFTER FIX
──────────────────────────────────────────────────────────────
Same actions:

  paste event fires
  → onHandsFreePaste
       isCandidateGS1Text("DOB: 01-15-1985, health card 01234") → true (loose)
       parseGS1BarcodeFromScanner("DOB: 01-15-1985, health card 01234")
         normalized: "01-15-1985, health card 01234" (29 chars ≥ 16)
         gtin = "-15-1985, healt"  (non-digit chars)
       parsed.gtin fails /^\d{14}$/ check → return early

  event.preventDefault() is NOT called.
  Text lands in the Notes field normally. ✓
```

---

## Fix

### `content.js` — `onHandsFreePaste`

```js
function onHandsFreePaste(event) {
  if (!isHandsFreeSupportedPage()) return;

  const text = String((event.clipboardData && event.clipboardData.getData('text')) || '').trim();
  if (!text || text.length < SCAN_MIN_LENGTH) return;
  if (!isCandidateGS1Text(text)) return;

  // isCandidateGS1Text is intentionally loose — it flags any text containing
  // "01" as a candidate, which is correct for incremental keystrokes but too
  // broad for paste. Dates ("01/01/2024"), patient IDs, or notes that happen
  // to contain "01" would otherwise have their paste blocked. Require the text
  // to actually parse as a complete, numeric GS1 barcode before intercepting.
  let parsed;
  try {
    parsed = parseGS1BarcodeFromScanner(text);
  } catch (_) {
    return;
  }
  if (!parsed) return;
  // A non-numeric GTIN means the parser found "01" inside normal prose and
  // treated the next 14 characters as a GTIN. Real GTINs are always 14 digits.
  if (parsed.gtin && !/^\d{14}$/.test(parsed.gtin)) return;

  event.preventDefault();
  rememberRecentInputCandidate(text);
  vlog('hands-free paste');
  handleHandsFreeScan(text, 'paste');
}
```

**Two guards are layered intentionally:**

1. **`parseGS1BarcodeFromScanner` try/catch** — rejects text where the GS1 structure is incomplete (GTIN < 16 chars from `"01"`, malformed expiry date, no recognized fields at all). This gate handles the majority of false positives.

2. **`/^\d{14}$/` GTIN digit check** — rejects text where the parser successfully returned a result but the extracted GTIN contains non-digit characters. This handles the minority case where accidental `"01"` alignment in prose produces a 16+ char substring that the parser accepts structurally but not semantically.

`isCandidateGS1Text` is kept as a fast pre-filter so the relatively heavier `parseGS1BarcodeFromScanner` only runs when the text is at least plausibly barcode-shaped.

---

### Decision matrix after the fix

| Pasted content | Candidate? | Parses? | GTIN numeric? | Intercepted? |
|---|---|---|---|---|
| Real GS1 vaccine barcode | ✓ | ✓ | ✓ | **Yes** |
| GTIN-only barcode (`0100012345678905`) | ✓ | ✓ | ✓ | **Yes** |
| `"01/01/2024"` (date) | ✓ | ✗ (< 16 chars) | — | No |
| `"Administered 01 dose today"` | ✓ | ✓ | ✗ (non-digit) | No |
| `"DOB: 01-15-1985, ..."` | ✓ | ✓ | ✗ (non-digit) | No |
| `"0123456789"` (short ID) | ✓ | ✗ (< 16 chars) | — | No |
| Any text without `"01"/"17"/"10"/"21"` | ✗ | — | — | No |

---

## Test coverage

`apps/extension/tests/content-paste.test.js` tests the exact gate logic using pure copies of the parsing functions (no Chrome or DOM dependencies):

| Test | Assertion |
|---|---|
| Real GS1 barcode (GTIN + lot + expiry) | intercepted, correct field values |
| GTIN-only barcode | intercepted |
| GS1 barcode with GS separator | intercepted |
| Date string `"01/01/2024"` | not intercepted |
| Clinical note with embedded `"01"` | not intercepted |
| DOB with `"01"` prefix | not intercepted |
| Short patient ID starting with `"01"` | not intercepted |
| Phone number starting with `"01"` | not intercepted |
| Text below `SCAN_MIN_LENGTH` | not intercepted |
| Empty / null | not intercepted |

Run with:

```bash
cd apps/extension && npm test
```

---

## Key architectural rules to carry forward

| Rule | Detail |
|---|---|
| `isCandidateGS1Text` is a **loose pre-filter only** | It is intentionally broad (catches anything containing `"01"`). Never use it as the sole gate for an irreversible action like `event.preventDefault()`. |
| Paste interception requires **strict, full-parse validation** | Use `parseGS1BarcodeFromScanner` + numeric GTIN check. Loose candidate matching is appropriate only for incremental keystroke accumulation, where the cost of a false positive is a buffer reset. |
| GTINs are always **14 ASCII digits** | `parseGS1BarcodeFromScanner` enforces length but not digit type. Any downstream consumer that relies on the GTIN being numeric must validate `\d{14}` explicitly. |
| `event.preventDefault()` on paste is **irreversible** | Once called, the text will not reach the target element. The bar for calling it must be high. If there is any doubt about whether the text is a barcode, do not call it. |
| Copy (`Ctrl+C`, `Ctrl+X`) is **unaffected** | `onHandsFreeKeydown` returns early for `ctrlKey`/`metaKey`. The copy path has never been at risk; this bug was paste-specific. |
