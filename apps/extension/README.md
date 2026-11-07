# VaxLink Extension

Chrome extension for GS1 vaccine barcode parsing, NVC enrichment, and Panorama immunization form assistance.

## Panorama Training Site

First test VaxLink in the Panorama training environment using synthetic training
records.

The training hostname is allowed explicitly, alongside
the existing production Panorama hosts. No wildcard permission
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

- `popup.js` drives popup workflow state, manual scan parsing, and queue management.
- `popup-inventory.js` manages the popup-side multiple-inject and inventory trays stored in `chrome.storage.local`.
- `content.js` handles scan routing, autofill, and workflow automation on supported chart pages.
- `background.js` owns NVC bundle refresh, lot lookup, analytics logging, and queue append helpers.
- `scanner-setup.html` + `scanner/` provide the Web Serial scanner channel and diagnostics.
- `diagnostics.html` and `diagnostics/` provide opted-in Alpha workflow recordings; production packaging excludes them.

## Storage Model

Operational queues, catalogue cache, workflow settings, scanner settings/status,
and usage counters use `chrome.storage.local`. The active Multiple Inject queue
is `multiple_inject_queue_v1`; the inventory tray uses
`inventory_scan_batch_v1`; pending Single scans use
`vaxlink_pending_scan_inbox_v1`.

The Alpha diagnostic collector and queue-correlation map use
`chrome.storage.session`. They do not copy operational queue records or usage
counter labels. Source still loads directly without transpilation; packaging
selects channel capabilities and stamps the loaded build identity.

## Dedicated Scanner Channel

Scanner capture uses a Chrome offscreen document and dedicated worker instead of page-level keyboard, paste, or input interception. Use `scanner-setup.html` from the popup settings to grant Web Serial permission once. Alpha provides a separate scanner-only test that reports bytes, frames, and parsing without routing test input into clinical workflows. Its optional keyboard check is confined to an extension-owned field. The setup tab can then be closed.

This channel requires Chrome 114 or newer because it uses the offscreen `WORKERS` lifecycle reason.

While Windows is locked, Single Inject scans are held for replay after unlock. Scans in other modes are saved to the Multiple Inject queue. VaxLink does not fill the chart while locked. The computer must stay awake; scans cannot be captured while it is sleeping or hibernating.

The first hardware profile is `Zebra DS8178 / USB CDC` with Zebra vendor ID `0x05e0`, CR/LF framing, and ASCII scan payloads. The scanner/cradle must be configured for USB CDC / virtual COM mode and must not emit HID keyboard wedge output while the dedicated channel is in use.

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

See the [diagnostics guide](../../docs/diagnostics.md) for capture levels,
retention, filtered export, and interpretation limits.
