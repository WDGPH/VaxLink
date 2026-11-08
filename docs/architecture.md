# Architecture

The extension has no build step: Chrome loads its JavaScript files directly,
without a bundler or a language conversion step. Its parts run in separate
places, described below. Each has its own variables. They exchange messages
through Chrome's extension APIs and use `chrome.storage.local` for saved data.

## Execution contexts

An execution context is a separate place where JavaScript runs. Keeping these
roles clear helps prevent two parts from opening the scanner or changing the
same queue independently.

### Background coordination: `background.js`

Chrome starts this background program, called a service worker, to handle
extension events and can stop it when idle. It coordinates:

- Loading, indexing, and refreshing the vaccine catalogue (NVC).
- Looking up a vaccine by lot and barcode product identifier (GTIN).
- Choosing the intended chart destination and checking its current form.
- Saving held scans, recovering them for review, and handling queue appends and
  verified consumption in order.
- Saving review notices and analytics, and updating the extension's icon and badge.
- Creating the hidden scanner host and passing scanner control requests to it.

It coordinates capture but does not own the open scanner connection.

### Hidden scanner host: `scanner-daemon.html` and `scanner-daemon.js`

An offscreen page is a hidden extension page. It hosts the scanner worker so
closing the popup or Scanner Setup does not end that worker. It passes control
requests to the worker and forwards scans and status to the background program.
It remembers the requested connection so it can restart a failed worker.

The host passes messages; the scanner worker opens and reads the device.

### Scanner reader: `scanner/scanner-daemon-worker.js`

A dedicated worker runs the scanner-reading code separately from the page. It
selects an unambiguous granted port, opens it through Chrome's Web Serial API,
and owns the live connection and reconnect attempts. `scanner/serial-provider.js`
reads incoming bytes and assembles complete scans. The worker sends those scans
and connection status back to the hidden host.

This stage reads scanner messages; parsing their vaccine fields happens later.

### Panorama integration: `content.js`

Chrome loads this content script into supported Panorama tabs. It can read and
change the page's HTML fields, but its JavaScript variables are separate from
Panorama's own variables. This separation is why a page-library variable may be
unavailable even when the page is still updating.

The script receives routed scans, shows the floating VaxLink controls, and fills
the intended immunization form. It owns form identity, cancellation on user
takeover, field writes, follow-up attempts, and observed field verification.
It reads workflow settings from local storage.

### User controls: popup and Scanner Setup

`popup.js`, `popup.html`, `popup-inventory.js`, and `popup-ui.js` provide manual
scan input and preview, workflow selection, queue and inventory controls, CSV
export, held-scan recovery, and review notices. The popup sends fill requests to
the selected Panorama integration.

`scanner-setup.html` and `scanner-setup.js` let staff choose a scanner, grant
browser permission, and request a connection or disconnection. They do not run
the ongoing scanner reader.

A hardware scan travels from the scanner worker through the hidden host to the
background program. The background then routes it to the intended chart or
retains it in the appropriate queue.

## Shared helpers

- **`shared/gs1-parser.js`** reads the tagged fields in GS1 barcodes, such as
  product identifier, lot, expiry, and serial number. Background, content, and
  popup code use this parser. **`popup-parser.js`** adapts popup input, including
  manual input formats, and supplies date and expiry-status helpers.
- **`panorama-agent-rules.js`** contains the matching rules for vaccine choices.
  Chrome loads it before `content.js` on supported pages.
- **`queue-record.js`** normalizes popup queue records;
  **`popup-inventory.js`** manages the popup's stored rows, display, and CSV columns.
- **`scanner/scanner-daemon-shared.js`** supplies common scanner status and port
  selection helpers. **`scanner/serial-profiles.js`** holds device settings, and
  **`scanner/scanner-lock-session.js`** holds lock-session metadata helpers.

## Key storage keys

| Key                                  | Writers                      | Purpose                                          |
| ------------------------------------ | ---------------------------- | ------------------------------------------------ |
| `multiple_inject_queue_v1`           | background + popup + content | Multiple Inject queue rows                       |
| `inventory_scan_batch_v1`            | background + popup           | Inventory tray rows                              |
| `vaxlink_pending_scan_inbox_v1`      | background                   | Saved Single scans awaiting completion or review |
| `vaxlink_scanner_capture_error_v1`   | background                   | Capture warning awaiting acknowledgement         |
| `vaxlink_queue_review_notice_v1`     | background                   | Opaque label for an unconfirmed queue use        |
| `vaxlink_scanner_status_snapshot_v1` | background                   | Last saved scanner status and capture history    |
| `nvc_bundle_override`                | background                   | Cached NVC catalogue                             |
| `vaxlink_workflow_mode_v1`           | popup + content              | Current workflow mode                            |
| `vaxlink_analytics_v1`               | background + popup           | Local event log and summaries                    |

Queue appends and verified consumption handled by the background run in order.
Popup and in-page queue edits still write directly to storage; re-reading the
rows does not make all writers one coordinated operation.

## NVC catalogue readiness and refresh

The background worker loads a valid saved catalogue before checking the network.
Startup, alarm, and manual refreshes share one download. A new catalogue must
pass the checks, build usable lot and vaccine-name indexes with at least one reachable vaccine
identity, and save successfully
before it replaces the working catalogue. Downloads use only the official HTTPS
endpoint and reject redirects. SHA-256 identifies local content; it does not
prove who published it.

Without a usable catalogue, a lookup waits up to five seconds for the existing
initialization attempt. Downloads stop after fifteen seconds. Lookup errors use
`errorCategory`: `initializing`, `unavailable`, `invalid`, `not_found`, or `incomplete`. A matched
lot without a vaccine name or DIN reports incomplete details. Barcode
fields and queued scans remain available when vaccine details cannot be added.

`getNVCUpdateStatus` returns `state` (`ready`, `refreshing`, `unavailable`, or
`invalid`), `usable`, `usingCache`, and `freshnessDegraded`. `updatedAt` is the
last accepted download date; `lastCheckAt` is the last successful remote check;
`lastAttemptAt` includes failed attempts. These are local activity dates, not
catalogue publication dates. `lastError` contains only a controlled category:
`source`, `network`, `timeout`, `http`, `invalid`, or `storage`. A failed refresh
keeps the accepted dates, fingerprint, and indexes. The small health record is
saved alongside the existing cache so the popup can report a failed check after
the worker restarts. If storage itself fails, the current worker still reports
the failure, but saving that failure for the next restart may also fail.

The accepted indexes also hold the distinct normalized lot-code count and the
lot CodeSystem's version and publication date. These are calculated once when
loading or refreshing the catalogue; opening the popup reads only the compact
status. The saved catalogue supplies those fields again after a worker restart.
A matching content fingerprint or accepted HTTP 304 means unchanged data. Zero
added lot codes alone does not: existing vaccine information may have changed.
Popup lookups always use the background indexes so automatic and manual updates
are reflected in subsequent scans.

## Chart boundary

Chart delivery supports only HTTPS immunization paths containing `/recordImms/`
on `www.panorama.prod.ehealthontario.ca`, `panorama.prod.ehealthontario.ca`,
and `trpanoramadhir.prod.ehealthontario.ca`. Manifest path matches stay broad
so navigation within Panorama can initialize the integration; runtime checks
restrict chart writes. Missing tab metadata requires a read-only response from
an existing supported integration. It does not permit script injection.
GS1 parsing, NVC lookup, scanner capture, queues, and inventory remain useful
without an open chart. Staff review vaccine details before saving in Panorama.

## Pending scanner scans

The pending inbox holds up to 250 scans and 1 MiB of JSON data. When either
limit is reached, VaxLink keeps the existing scans and reports that the new scan
was not saved. Storage errors also leave a capture warning. Check pending scans
and the intended chart before rescanning; a warning does not identify which
scan failed. Scanner delivery and persistence are not crash-proof exactly-once
operations.

## Panorama autofill sequence

Fill order must be: `agent → lot → (deferred) date/time`. Panorama
auto-populates dependent fields (trade name, route, dose, manufacturer) after
lot selection. Lot writes and deferred date/time use the existing bounded retries and
`!isPrimeFacesAjaxBusy()` guard. This isolated-world check alone does not prove
that all page activity has finished. Lot matching uses `normalizePanoramaLotToken` to
handle formats like `LOT123 - Exp. ...`. Panorama uses misspelled IDs (e.g.
`dateAdministedDate`) — keep those as-is.

## CI

- `.github/workflows/extension-ci.yml` — checks syntax and runs tests for
  extension changes in PRs and pushes to `alpha`/`main`. Tests that need the live
  catalogue skip if it cannot be downloaded. Uploads Alpha ZIPs for prereleases
  and both channel ZIPs for stable versions. Web Store uploads are manual.
- `.github/workflows/docs.yml` — runs the locked, strict MkDocs check on
  pushes to `alpha`/`main` and pull requests.
- `.github/workflows/docs-hub-notify.yml` — opt-in notifications for `main` and
  stable-tag changes. The PHIZ documentation hub owns publication and styling;
  see the [repository README](https://github.com/WDGPH/VaxLink#documentation-site)
  for setup and historical release reconciliation.

## Constraints

- `apps/extension/nvc_bundle.json` is in `.gitignore` — never commit raw NVC
  bundle files.
- If Panorama DOM changes, update selectors in `apps/extension/content.js`.
  Capture a fresh DOM snapshot locally to diff against (do not commit
  live-session captures — they can contain real patient data; sanitize to
  structural fragments only, as done in
  `apps/extension-tests/panorama-reason-consent.test.js`).
- `apps/extension-tests/` uses Node.js's built-in `node:test` runner (no
  Jest/Vitest). Tests must stay outside `apps/extension/` so they are never
  packaged into the Chrome Web Store upload.
- The repo-root `package.json` exists to mark the tree `"type": "module"` so
  Node parses the extension's ESM sources correctly in tests — don't delete
  it.
