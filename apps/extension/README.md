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
installing or updating the extension. Reload previously open InputHealth tabs
too; removing a manifest match does not rewrite an already-running page.

Check Panorama chart fills using synthetic training records. Also check capture,
queueing, and inventory export without an open chart, plus lock-screen replay,
before moving to production.
Automated URL and routing tests do not verify the live training site's DOM,
scanner hardware, or organization-specific access.

## Runtime and storage

See [architecture](../../docs/architecture.md) for the execution contexts, current
storage keys, and Panorama fill order. Operational queues, catalogue data,
settings, scanner status, and usage counters use `chrome.storage.local`. Alpha
recordings and their correlation links use `chrome.storage.session`.

Older profiles may retain data from earlier versions. This cleanup does not
migrate or delete it. Source loads directly without transpilation; packaging
selects channel capabilities and stamps the build identity.

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
