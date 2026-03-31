# VaxLink — Multi-Platform Support Roadmap

## Current Architecture (the problem)

Two places in `content.js` are hardcoded per-platform:

| Location | What it does | Line |
|---|---|---|
| `isHandsFreeSupportedPage()` | Whitelist of allowed hostnames | 522 |
| `autoFillTelus()` | Routes to Panorama fill OR generic fill | 1299 |
| `isPanoramaImmunizationPage()` | Detects Panorama-specific DOM | 1127 |
| `fillPanoramaImmunizationFields()` | Panorama-specific fill logic | 1150 |

Adding OSCAR/Wolf/PS Suite today = copy-pasting more `if (isOSCAR)` branches into those same functions. It will get messy fast.

---

## Proposed Architecture: Platform Registry

**No build tool needed** — uses multiple content scripts loaded in order via manifest.

```
apps/extension/
├── manifest.json               ← add new platform files to content_scripts
├── background.js
├── content.js                  ← refactored: reads from VAXLINK_PLATFORMS registry
├── popup.js / popup.html       ← add platform indicator badge
├── platforms/
│   ├── registry.js             ← defines VAXLINK_PLATFORMS = [] and helpers
│   ├── panorama.js             ← extracted from content.js (no change in behavior)
│   ├── inputhealth.js          ← extracted from content.js
│   ├── oscar.js                ← new
│   ├── wolf.js                 ← new
│   └── psuite.js               ← new
└── settings/
    ├── settings.html           ← community config UI (add custom hostnames)
    └── settings.js
```

**Each platform file registers itself:**
```js
// platforms/oscar.js
VAXLINK_PLATFORMS.push({
  id: 'oscar',
  name: 'OSCAR EMR',
  hostPatterns: ['oscar.', '.oscarhost.com', 'oscar-emr.'],
  detect(host, doc) { /* optional DOM check */ return true; },
  fill(data) { /* platform-specific fill */ }
});
```

**`content.js` becomes platform-agnostic:**
```js
// isHandsFreeSupportedPage() becomes:
function isHandsFreeSupportedPage() {
  const host = window.location.hostname.toLowerCase();
  return VAXLINK_PLATFORMS.some(p => matchesHost(p, host));
}

// autoFillTelus() becomes:
function autoFillTelus(data) {
  const host = window.location.hostname.toLowerCase();
  const platform = VAXLINK_PLATFORMS.find(
    p => matchesHost(p, host) && p.detect?.(host, document) !== false
  );
  return platform ? platform.fill(data) : genericFill(data);
}
```

---

## Phase Breakdown

### Phase 1 — Refactor (no behavior change)
- Create `platforms/registry.js` with `VAXLINK_PLATFORMS = []`
- Create `platforms/panorama.js` — extract existing Panorama logic
- Create `platforms/inputhealth.js` — extract existing InputHealth logic
- Update `manifest.json` to load platform files before `content.js`
- Refactor `isHandsFreeSupportedPage()` and `autoFillTelus()` to use registry
- **Zero behavior change** — Panorama + InputHealth work identically

### Phase 2 — New Platforms
- `platforms/oscar.js` — OSCAR EMR (widely used in Ontario/BC/AB)
- `platforms/wolf.js` — Wolf EMR
- `platforms/psuite.js` — PS Suite (Telus Health)
- Requires inspecting each platform's immunization form field selectors

### Phase 3 — Community Config System
- `settings.html` / `settings.js` — settings page linked from popup
- UI to add **custom hostname patterns** (stored in `chrome.storage`)
- UI to **enable/disable** built-in platforms
- Shows current active platform detection status
- Add a gear icon to popup linking to settings

### Phase 4 — Popup Enhancement
- Show detected platform name in popup (e.g., "OSCAR EMR detected")
- Show "No supported platform on this page" when on an unsupported site
- Make "Auto-fill CHR" button label dynamic per platform

---

## Platform Research Notes

| Platform | Common Hostnames | Notes |
|---|---|---|
| OSCAR EMR | `oscar.*`, `*.oscarhost.com`, `*.oscar-emr.com` | Open-source Java; immunizations under `/oscarRx/` or `/appointment/` |
| Wolf EMR | `*.wolfemr.com`, `wolfmedical.com` | Field names tend to be `vaccine_`, `lot_`, `expiry_` patterns |
| PS Suite | `*.ps-suite.com`, `pssuite.ca` | Telus Health product; likely similar to InputHealth |

> **TODO:** Inspect actual running instances of OSCAR/Wolf/PS Suite to get accurate field selectors before implementing Phase 2.

---

## Other Future Updates (backlog)

1. **Configurable platform hostnames** — settings UI to add custom hostnames without code changes
2. **Audit log / fill history** — log every auto-fill event to `chrome.storage`, show in popup
3. **Field selector warnings** — surface warning in popup when expected fields aren't found
4. **Export (CSV/JSON)** — export parsed barcode data or fill history for clinic reporting
5. **Unit tests** — Vitest or `node:test` for GS1 parser and lot lookup logic
6. **Batch barcode lookup (web app)** — upload list of barcodes, get back resolved metadata CSV
7. **IndexedDB for bundle** — replace `chrome.storage.local` for the large NVC bundle
8. **Firefox support** — MV3 now supported in Firefox, mostly compatible already
9. **Chrome Web Store publishing** — polish for public distribution (clinics install without dev mode)
