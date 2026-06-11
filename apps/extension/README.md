# VaxLink Extension

Chrome extension for GS1 vaccine barcode parsing, NVC enrichment, CHR autofill, and local inventory operations.

## Main Pieces

- `popup.js` drives popup workflow state, scan parsing, queue management, and inventory page launch.
- `popup-inventory.js` manages the popup-side multiple-inject and inventory trays stored in `chrome.storage.local`.
- `content.js` handles explicit scanner events and autofill on supported chart pages.
- `background.js` owns NVC bundle refresh, lot lookup, analytics logging, native scanner routing, and queue append helpers.
- `inventory-manager.html` + `inventory-manager.js` open the full inventory operations page in its own extension tab.

## Inventory Architecture

The inventory page was split out of the old monolithic `inventory-manager.js` into domain modules under `apps/extension/inventory/`.

- `page-controller.js` wires the page, events, exports, and status updates.
- `repository.js` is the inventory source of truth for the page and persists operational data in IndexedDB.
- `model.js` defines normalized inventory items, transactions, reconciliation snapshots, FEFO ordering, and legacy row conversion.
- `receive.js` parses receive input and enriches scans through `lookupVaccineInfo`.
- `render.js` renders the summary table, FEFO board, reconciliation grid, lot quarantine banner, and ledger.
- `exports.js` builds CSV/JSON handoff files and preserves stable inventory export columns.
- `audio.js`, `runtime.js`, `constants.js`, and `utils.js` hold the shared support code.

## Storage Model

There are now two storage layers by design:

- `chrome.storage.local`
  Used by the popup, native scanner routing, legacy queue keys, scanner settings, workflow settings, analytics, and small extension preferences.
- IndexedDB
  Used by the inventory manager page for normalized inventory items, transactions, incidents, reconciliation sign-offs, and lot quarantine flags.

The page keeps `inventory_scan_batch_v1` mirrored for compatibility, so popup inventory mode and content-script inventory capture continue to work without a coordinated rewrite.

## Inventory Keys

- Legacy queue key: `inventory_scan_batch_v1`
- Scanner settings: `inventory_ultrafast_scanner_v1`, `inventory_scanner_beeps_v1`
- IndexedDB database: `vaxlink_inventory_ops_v2`

## Testing

Static checks:

```bash
cd apps/extension
node --check inventory-manager.js
node --check popup-inventory.js
node --check inventory/page-controller.js
```

Focused inventory tests (the suite lives in `apps/extension-tests/`, outside this
directory, so it never ships in the Chrome Web Store zip):

```bash
cd apps/extension-tests
npm test
```

Current automated coverage checks:

- FEFO ordering
- dose consumption by lot
- reconciliation math
- inventory export contracts

## Compatibility Notes

- Popup inventory rows still use the legacy queue row shape.
- The shared builder in `inventory/model.js` keeps popup rows and inventory-page rows aligned.
- If you change export columns or row field names, update both the popup queue consumers and the inventory tests.
