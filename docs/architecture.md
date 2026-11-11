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
- Routing scans to supported chart tabs or retaining them when delivery fails.
- Saving Single scans before one delivery attempt, retaining uncertain scans,
  and handling queue appends in order.
- Saving scanner capture warnings and analytics, and updating the icon and badge.
- Creating the hidden scanner host and passing scanner control requests to it.

It coordinates capture but does not own the open scanner connection.

### Hidden scanner host: `scanner-daemon.html` and `scanner-daemon.js`

An offscreen page is a hidden extension page. It hosts the scanner worker so
closing the popup does not end that worker. It passes control
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
the immunization form. Each fill keeps the document, form, URL, workflow, and
visible immunization step that started it. A newer fill, navigation, form
replacement, workflow change, or meaningful manual interaction with that form
stops its delayed writes. Clearly linked PrimeFaces dropdowns count as part of
the form; unrelated controls do not. Automatic attempts keep a cancelled owner
until an explicit fill or a new context starts work again. This does not detect
a patient change that preserves the same document, URL, and form without a
visible step change.
It reads workflow settings from local storage.

### User controls: popup

`popup.js`, `popup.html`, `popup-inventory.js`, and `popup-ui.js` provide manual
scan input and preview, workflow selection, queue and inventory controls, CSV
export, and scanner status. The popup sends fill requests to
the selected Panorama integration.

The header shows the installed version below VaxLink and provides separate
Settings and Local Activity controls. Each view uses the top bar for its title
and a close button that returns to the workflow.
Settings has three sections, in order: Scanner, Autofill, and National Vaccine Catalogue.
`scanner-settings.js` provides connection controls directly within the Scanner
section. It shows connection status and the saved scanner name, with pairing,
reconnect, and disconnect controls. Cached status cannot confirm a live
connection. Actual connection errors remain visible. The popup sends connection
requests to the background; it does not run the ongoing scanner reader.

National Vaccine Catalogue shows its version, publication date, and last checked
date, with a Refresh button. Loading and refresh errors stay visible.

Autofill has separate switches for scan date/time, Reason for Immunization,
and Consent for Service. Reason and consent each fall back to the old combined
preference until staff set them separately.

Local Activity is available from the header and shows a table with Today and All
time columns. All statistics stay visible,
with JSON export and reset buttons in one row. JSON exports cover
today in local time or all activity since the last reset. Its counts describe
extension activity, not confirmation that Panorama saved a clinical record.

Immunization and Inventory show a Setup Scanner button when no scanner
is configured or permission needs to be granted again. It opens Settings with
the Scanner section expanded and focused. The small close button allows manual
input and saved queues without scanner setup. This choice lasts for the current
popup and does not change scanner capture or routing.

The Multiple Immunizations and Inventory trays use **+** to open barcode text
entry in packaged and unpacked installs. They use the existing parser, catalogue
lookup, and background queue writer. Inventory accepts one barcode per line and
keeps CSV export. Entry closes after a confirmed save when the input has not
changed; failed saves and newly typed text keep the entry open. After a partial
Inventory batch save, only the failed lines remain for correction.

A hardware scan travels from the scanner worker through the hidden host to the
background program. The background routes it to a supported chart or retains
it in a queue.

## Shared helpers

- **`shared/gs1-parser.js`** reads the tagged fields in GS1 barcodes, such as
  product identifier, lot, expiry, and serial number. Background, content, and
  popup code use this parser. **`popup-parser.js`** adapts popup input, including
  manual input formats, and supplies expiry-status helpers.
- **`shared/expiry-date.js`** validates calendar dates and counts days without
  daylight-saving shifts. Background, content, and popup code share it.
- **`panorama-agent-rules.js`** contains the matching rules for vaccine choices.
  Chrome loads it before `content.js` on supported pages.
- **`queue-record.js`** normalizes popup queue records;
  **`popup-inventory.js`** manages the popup display and CSV columns, requesting
  saved row changes through the background writer.
- **`scanner/scanner-daemon-shared.js`** supplies common scanner status and port
  selection helpers. **`scanner/serial-profiles.js`** holds device settings, and
  **`scanner/scanner-lock-session.js`** holds lock-session metadata helpers.

## Key storage keys

| Key                                  | Writers            | Purpose                                       |
| ------------------------------------ | ------------------ | --------------------------------------------- |
| `multiple_inject_queue_v1`           | background         | Multiple Immunizations queue rows             |
| `inventory_scan_batch_v1`            | background         | Inventory tray rows                           |
| `vaxlink_pending_scan_inbox_v1`      | background         | Single scans held for later chart delivery    |
| `vaxlink_scanner_capture_error_v1`   | background         | Capture warning awaiting acknowledgement      |
| `vaxlink_scanner_status_snapshot_v1` | background         | Last saved scanner status and capture history |
| `nvc_bundle_override`                | background         | Cached NVC catalogue                          |
| `vaxlink_reason_autofill_v1`         | popup              | Reason for Immunization autofill preference   |
| `vaxlink_consent_autofill_v1`        | popup              | Consent for Service autofill preference       |
| `vaxlink_reason_consent_autofill_v1` | legacy popup       | Default for unset reason and consent switches |
| `vaxlink_workflow_mode_v1`           | popup + content    | Current workflow mode                         |
| `vaxlink_analytics_v1`               | background + popup | Local event log and summaries                 |

Queue appends, popup edits, HUD removals, and dose consumption share the
background writer. Each change reads the latest rows after earlier writes finish,
so it cannot overwrite a scan appended while another context was editing.
Only the extension popup and supported Panorama main frames can request these
edits. Mutation messages require record arrays for adds and IDs for targeted
changes.

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

Single Immunization saves each scan before attempting delivery once to the captured
active tab and observed form context. Navigation, form replacement, a newer
fill, or manual takeover invalidates that context. This detects observable
changes; it cannot identify a patient change that preserves the same URL and
form without a visible context change.

A successful acknowledgement means the scan was handled or autofill started.
It does not prove that later field updates completed or that Panorama saved a
clinical record. Failed or uncertain deliveries remain held and never replay
automatically, including after unlock. The popup lists held barcodes and capture
times for deliberate copying into manual input or discard. Staff must check the
chart first because an uncertain scan may already have populated fields.

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
