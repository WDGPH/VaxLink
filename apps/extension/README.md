# VaxLink Extension

Chrome extension for GS1 vaccine barcode parsing, NVC enrichment, and CHR autofill.

## Main Pieces

- `popup.js` drives popup workflow state, scan parsing, queue management, and workflow mode switching (single / multiple / inventory).
- `popup-inventory.js` manages the popup-side multiple-inject queue and inventory tray, stored in `chrome.storage.local`, plus CSV export.
- `popup-parser.js` parses GS1 AI barcode strings.
- `popup-ui.js` renders the popup UI.
- `queue-record.js` normalizes inventory rows so the exported CSV column shape stays stable for downstream tools.
- `content.js` handles hands-free page scanning and autofill on supported chart pages (Panorama, InputHealth).
- `panorama-agent-rules.js` — heuristics for matching a scanned lot/GTIN to a Panorama agent dropdown option. Loaded before `content.js`.
- `background.js` owns NVC bundle refresh, lot lookup, analytics logging, and queue append helpers.

## Storage Model

Everything lives in `chrome.storage.local`:

- `multiple_inject_queue_v1` — active multiple-inject queue (popup + content script)
- `inventory_scan_batch_v1` — inventory tray queue (popup + content script)
- `nvc_bundle_override` — cached NVC FHIR bundle (background)
- `vaxlink_workflow_mode_v1` — current workflow mode (popup)
- `vaxlink_analytics_v1` — fill event log (background)

## Testing

Static checks:

```bash
cd apps/extension
node --check content.js
node --check popup.js
node --check popup-inventory.js
```

Full suite (lives in `apps/extension-tests/`, outside this directory, so it never ships in the Chrome Web Store zip):

```bash
cd apps/extension-tests
npm test
```

Current automated coverage checks: GS1 barcode parsing, Panorama/InputHealth autofill flows, multiple-inject queue ordering and dedup, and inventory export contracts.
