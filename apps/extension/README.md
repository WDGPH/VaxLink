# VaxLink Extension

Chrome extension for GS1 vaccine barcode parsing, NVC enrichment, and CHR autofill.

## Panorama Training Site

First test VaxLink in the Panorama training environment using synthetic training
records.

The training hostname is allowed explicitly, alongside
the two existing production Panorama hosts. No wildcard permission
for other eHealth Ontario sites or new extension API permissions is added.

Scanner routing, hands-free workflows, and the Panorama HUD still require an
immunization page with `/recordImms/` in its path. Runtime page detection requires
HTTPS, matching the manifest. Reload an already-open training page after
installing or updating the extension.

Check Single Inject, Multiple Inject, Inventory, and lock-screen capture/replay
in the training environment before moving to production.
Automated URL and routing tests do not verify the live training site's DOM,
scanner hardware, or organization-specific access.

## Main Pieces

- `popup.js` drives popup workflow state, scan parsing, queue management, and inventory page launch.
- `popup-inventory.js` manages the popup-side multiple-inject and inventory trays stored in `chrome.storage.local`.
- `content.js` handles scan routing, autofill, and workflow automation on supported chart pages.
- `background.js` owns NVC bundle refresh, lot lookup, analytics logging, and queue append helpers.
- `scanner-setup.html` + `scanner/` provide the Web Serial scanner channel and diagnostics.
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

Extension data is kept locally in two browser stores:

- `chrome.storage.local`
  Used by the popup and scanner flows for the legacy queue keys, scanner settings, workflow settings, analytics, and small extension preferences.
- IndexedDB
  Used by the inventory manager page for normalized inventory items, transactions, incidents, reconciliation sign-offs, and lot quarantine flags.

The page keeps `inventory_scan_batch_v1` mirrored for compatibility, so popup inventory mode and content-script inventory capture continue to work without a coordinated rewrite.

## Inventory Keys

- Legacy queue key: `inventory_scan_batch_v1`
- Scanner settings: `inventory_ultrafast_scanner_v1`, `inventory_scanner_beeps_v1`
- Serial scanner profile: `vaxlink_serial_scanner_profile_v1`
- Pending dedicated-channel scans: `vaxlink_pending_scan_inbox_v1`
- IndexedDB database: `vaxlink_inventory_ops_v2`

## Dedicated Scanner Channel

Scanner capture uses a Chrome offscreen document and dedicated worker instead of page-level keyboard, paste, or input interception. Use `scanner-setup.html` from the popup settings to grant Web Serial permission once, test the raw framed scan, and confirm the scanner is not also typing into a focused input. The setup tab can then be closed.

This channel requires Chrome 114 or newer because it uses the offscreen `WORKERS` lifecycle reason.

While Windows is locked, Single Inject scans are held for replay after unlock. Scans in other modes are saved to the Multiple Inject queue. VaxLink does not fill the chart while locked. The computer must stay awake; scans cannot be captured while it is sleeping or hibernating.

The first hardware profile is `Zebra DS8178 / USB CDC` with Zebra vendor ID `0x05e0`, CR/LF framing, and ASCII scan payloads. The scanner/cradle must be configured for USB CDC / virtual COM mode and must not emit HID keyboard wedge output while the dedicated channel is in use.

## Isolated scanner test in Alpha

Scanner Setup offers an optional isolated scanner test in Alpha builds. Start
it and wait for the active-test message before scanning the displayed synthetic
barcode. The test reports port, byte, complete-frame and synthetic GS1 parse
checkpoints. It discards the input without adding it to a chart, queue, inventory
or usage counter. The barcode is hidden while the test is inactive.

The test stops after one minute. Normal capture stays paused until you deliberately
reconnect in Scanner Setup. If reader release cannot be confirmed, close the test
page before reconnecting. An in-flight stop may require another reconnect attempt.
A failed reader close can require reloading the extension before capture resumes.
Production packages exclude the scanner-test executable assets. Workstation health
is available in both channels.

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

Current automated coverage checks: GS1 barcode parsing, Panorama autofill flows, multiple-inject queue ordering and dedup, and inventory export contracts.
