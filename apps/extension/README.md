# VaxLink Extension

VaxLink reads vaccine barcodes, looks up lots in the National Vaccine Catalogue,
and fills supported Panorama forms.

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

Check **Immunization** on single provider-recorded and non-provider-recorded forms and on the multiple
immunizations grid and detail steps. Check **Inventory**, then capture a scan
while the workstation is locked and review it after unlock.
Automated URL and routing tests do not verify the live training site's DOM,
scanner hardware, or organization-specific access.

## Main Pieces

- `popup.js` shows the Immunization and Inventory tabs, Settings, and Local Activity.
- `popup-inventory.js` renders the trays, requests changes, and exports Inventory to CSV.
- `content.js` identifies supported Panorama forms and fills chart fields.
- `background.js` routes and saves scans, refreshes the catalogue, looks up lots, and records usage counts.
- `scanner-settings.js` provides scanner connection controls within the popup Settings view.

## Storage Model

The trays, scanner settings, catalogue, and usage counts are stored on the
current browser profile. Troubleshooting details are kept in browser
session storage. See the [architecture guide](../../docs/architecture.md)
for storage keys and which part of VaxLink writes each one.

## Dedicated Scanner Channel

Scanner capture uses a Chrome offscreen document and dedicated worker instead of page-level keyboard, paste, or input interception. Use Scanner in Settings to pair the scanner and check its connection. The popup can then be closed.

This channel requires Chrome 114 or newer because it uses the offscreen `WORKERS` lifecycle reason.

While Windows is locked, Immunization scans are held for review. Inventory
scans stay in the Inventory Tray. After unlocking, check the chart before
using any held barcode. Scans cannot be captured while the computer sleeps
or hibernates.

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

Automated checks cover barcode parsing, Panorama form detection and autofill,
scan delivery and recovery, repeated scans, tray updates, and Inventory exports.
