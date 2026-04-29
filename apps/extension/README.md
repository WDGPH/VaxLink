# VaxLink Extension

Chrome extension for GS1 vaccine barcode parsing, NVC enrichment, CHR autofill, and local inventory operations.

## Main Pieces

- `popup.js` drives popup workflow state, scan parsing, queue management, and analytics export.
- `popup-inventory.js` manages the popup-side multiple-inject and inventory trays stored in `chrome.storage.local`.
- `queue-record.js` normalizes saved tray rows and preserves the popup inventory CSV shape.
- `content.js` handles hands-free page scanning and autofill on supported chart pages.
- `background.js` owns NVC bundle refresh, lot lookup, analytics logging, and queue append helpers.

## Inventory Tray Architecture

- Inventory capture now stays inside the popup and hands-free workflow only.
- `popup-inventory.js` owns the tray UI, local persistence, and CSV download.
- `queue-record.js` keeps the saved row shape stable for popup queue consumers and downstream CSV tooling.

## Storage Model

- `chrome.storage.local`
  Used by the popup and hands-free flows for the queue keys, scanner settings, workflow settings, analytics, and small extension preferences.

## Inventory Keys

- Multiple queue key: `multiple_inject_queue_v1`
- Legacy queue key: `inventory_scan_batch_v1`
- Scanner settings: `inventory_ultrafast_scanner_v1`, `inventory_scanner_beeps_v1`

## Testing

Static checks:

```bash
cd apps/extension
node --check popup.js
node --check popup-inventory.js
node --check queue-record.js
```

Focused extension tests:

```bash
cd apps/extension
npm test
```

Current automated coverage checks:

- popup queue record normalization
- popup multiple-inject summary output
- popup inventory summary output

## Compatibility Notes

- Popup inventory rows still use the legacy queue row shape.
- `queue-record.js` keeps popup rows stable for CSV export and queue reuse.
- If you change export columns or row field names, update both the popup queue consumers and the popup inventory tests.
