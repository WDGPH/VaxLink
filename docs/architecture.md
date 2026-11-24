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

The scanner worker opens and reads the device. The host stops routing scans
as soon as Disconnect is requested and waits for the reader to confirm the
port closed. Chrome can finish opening a port after cancellation. The reader
closes that port without reading from it and retains a failed close for retry.

### Scanner reader: `scanner/scanner-daemon-worker.js`

A dedicated worker runs the scanner-reading code separately from the page. It
selects an unambiguous granted port, opens it through Chrome's Web Serial API,
and owns the live connection and reconnect attempts. `scanner/serial-provider.js`
reads incoming bytes and assembles complete scans. The worker sends those scans
and connection status back to the hidden host.

This stage reads scanner messages; parsing their vaccine fields happens later.

### Panorama integration: `content.js`

Chrome loads this content script on the immunization entry paths declared for
the three Panorama hosts in `manifest.json`. If a chart opened before VaxLink
was installed or updated, refresh the chart to load the integration.
The script can read and change the page's HTML fields. Its JavaScript variables
are separate from Panorama's own variables. This separation is why a
page-library variable may be unavailable even when the page is still updating.

The integration records the extension's public ID on the chart document. When
two copies are present, both stop filling. Disable the extra copy and refresh
the chart after checking unsaved work. Development and Alpha can fill training
charts. The packaged production build can also fill production charts. Scanner
capture and local trays remain available while chart entry is blocked.

The chart integration reports the visible form and its readiness to callers.
It distinguishes provider and non-provider single forms, the Multiple grid and
the Multiple detail step. Conflicting headings or controls and unavailable
fields explain why a form is unready. Reading the same form repeatedly keeps
its delivery token. A new form, workflow or step retires the old token.

The [Panorama autofill sequence](#panorama-autofill-sequence) explains how the
integration verifies the product, stops when chart ownership changes, and
consumes a confirmed tray dose.

### User controls: popup

`popup.js`, `popup.html`, `popup-inventory.js`, and `popup-ui.js` provide manual
scan input and preview, workflow selection, queue and inventory controls, CSV
export, and scanner status. The popup sends fill requests to the Panorama
integration already loaded in the selected tab. Opening the popup grants no
access to the page in the current tab.

The header shows the installed version below VaxLink and provides separate
Settings and Local Activity controls. Each view uses the top bar for its title
and a close button that returns to the workflow.
Settings has three sections, in order: Scanner, Autofill, and National Vaccine Catalogue.
`scanner-settings.js` provides connection controls directly within the Scanner
section. It shows the saved device and gets current connection status from the
reader. When the reader does not reply, Settings shows the last known capture
time if available. The popup sends connection requests to the background. **Reconnect** resumes
capture with the saved device. **Disconnect** stops capture and keeps the
selection. **Forget** clears the selection after a confirmed stop and removes
the browser's grant if it can identify exactly one matching port.

**Scanner setup** opens a temporary standard browser window
(`scanner-pairing.html` and `scanner-pairing.js`). Chromium needs its extensions
toolbar to display the device chooser. Opening setup again brings the same
setup page forward while it is still open. Staff click **Connect scanner** and choose a
device. Cancelling the chooser leaves the current scanner connected. When
replacing a scanner, the background waits for the existing port to close before
saving the new device and starting capture. The setup window closes after the
hidden reader accepts the request. Settings confirms when it is connected.

After connecting a device, reopen Scanner setup and choose **Test saved
scanner**. The reader pauses regular capture and checks for a sample barcode.
It only reports whether a sample arrived. Sample scans stay out of charts and
trays. **Finish test** and closing the window both restore the previous capture
setting, even if no sample arrived. If capture was off, the scanner stays
disconnected.

National Vaccine Catalogue shows its version, publication date, and last checked
date, with a Refresh button. Loading and refresh errors stay visible.

Autofill has four separate switches: administration date, administration time,
Reason for Immunization, and Consent for Service. Each field inherits its old
combined preference until staff set it separately. Date and time use the local
time when form filling starts, for both live scans and tray items. A fill keeps
that timestamp through retries and rerenders. The scan timestamp remains scan
history and is not used as the administration timestamp. The Multiple
Immunizations entry grid fills only its date field; detail forms can fill both
fields. Disabled fields keep their existing values.

The Autofill settings can ask for funding before VaxLink searches for a lot.
With automatic funding enabled, VaxLink checks the current Lot list and uses
a sole match. If both funding categories list the lot, staff choose one.
VaxLink keeps an existing category and waits for the Lot list to change after
a category change. After a miss in one category, staff can try the other.

If the Lot cannot be matched, VaxLink only clears a different selection it can
attribute to the current fill. It leaves a staff selection for review. When the
product matches but another field does not settle, the chart names the fields
staff need to check.

A confirmed catalogue miss can open an email draft from a saved row or the
chart. If the catalogue matched and Panorama could not find the lot, the
chart offers a draft for the Panorama support contact. Staff choose that
recipient, review the vaccine details, and decide whether to send.

Local Activity is available from the header and shows a table with Today and All
time columns. All statistics stay visible,
with JSON export and reset buttons in one row. JSON exports cover
today in local time or all activity since the last reset. The popup reports
activity and starts downloads. The background worker saves the daily totals and
prepares the summaries and JSON export. The totals describe extension activity,
and staff verify and save clinical records in Panorama.

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
Inventory batch save, only the failed lines remain for correction. New
Immunization entries require a lot number. If any recorded expiry date has
passed locally, VaxLink blocks chart entry. Staff can confirm adding an expired
lot by hand for reference in the tray. Inventory keeps expired lots for stock
checks.

A newly saved chart-tray row with no explicit quantity has one use. Older rows
without a count keep their existing reuse behaviour. Staff can pin an
uncounted chart row or type the number of remaining doses. The background
checks the saved dose fields before applying the change, so a quantity edit
does not overwrite a use that already occurred. Inventory retains its CSV
columns.

The background can reserve a counted dose for one chart document. It accepts
another reservation only when the saved quantity still covers it. A chart
can release its own reservation before it touches any fields. If a field may
have changed, staff check the original chart before returning the dose or
recording it as used. A missing response leaves the dose held. The chart tray
offers **Review dose** and asks whether it was used. When the original chart has
yet to confirm that its operation stopped, the background checks that browser
document before accepting review.

A hardware scan travels from the scanner worker through the hidden host to the
background program. The background routes it to a supported chart or retains
it in a queue. Inventory uses the local catalogue when available and saves the
barcode while a download is pending. Saved rows keep the lookup result and the
catalogue version when known. Scanner acknowledgement follows the saved row
without waiting for Local Activity counts.

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
- **`scanner/scanner-daemon-protocol.js`** defines scanner commands and saved status.
  **`scanner/scanner-daemon-shared.js`** supplies port selection and status display helpers. **`scanner/serial-profiles.js`** holds device settings, and
  **`scanner/scanner-lock-session.js`** holds lock-session metadata helpers.

## Key storage keys

| Key                                         | Writers         | Purpose                                       |
| ------------------------------------------- | --------------- | --------------------------------------------- |
| `multiple_inject_queue_v1`                  | background      | Multiple Immunizations queue rows             |
| `inventory_scan_batch_v1`                   | background      | Inventory tray rows                           |
| `vaxlink_pending_scan_inbox_v1`             | background      | Scans held for staff review                   |
| `vaxlink_scanner_capture_error_v1`          | background      | Capture warning awaiting acknowledgement      |
| `vaxlink_scanner_status_snapshot_v1`        | background      | Last saved scanner status and capture history |
| `nvc_bundle_override`                       | background      | Cached NVC catalogue                          |
| `vaxlink_administered_date_autofill_v1`     | popup           | Date Administered autofill preference         |
| `vaxlink_administered_time_autofill_v1`     | popup           | Time Administered autofill preference         |
| `vaxlink_administered_datetime_autofill_v1` | legacy popup    | Default for unset date and time switches      |
| `vaxlink_reason_autofill_v1`                | popup           | Reason for Immunization autofill preference   |
| `vaxlink_consent_autofill_v1`               | popup           | Consent for Service autofill preference       |
| `vaxlink_reason_consent_autofill_v1`        | legacy popup    | Default for unset reason and consent switches |
| `vaxlink_workflow_mode_v1`                  | popup + content | Current workflow mode                         |
| `vaxlink_analytics_v1`                      | background      | Local Activity daily totals                   |

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

Single Immunization saves each scan before sending it once to its original
foreground chart. The worker checks the chart build, document context, focus,
and workstation lock again after waits. The current worker instance and the
original chart document identify the same delivery.

A pending acknowledgement means the chart started handling the scan. VaxLink
keeps the saved barcode until the same chart verifies its fields. A timeout,
stale build, lost focus, unavailable lock check, or unverified result leaves a
held scan for staff review. If VaxLink cannot identify the Agent for a scanned
lot, it holds the barcode before any field interaction and shows a warning.

Staff can check the original chart and copy or discard a held barcode in the
popup. Held scans never replay automatically, including after unlock. Field
verification reflects what the browser observed. Staff still verify and save
the record in Panorama.

The pending inbox holds up to 250 scans and 1 MiB of JSON data. When either
limit is reached, VaxLink keeps the existing scans and reports that the new scan
was not saved. Storage errors also leave a capture warning. Check pending scans
and the intended chart before rescanning; a warning does not identify which
scan failed. Scanner delivery and persistence are not crash-proof exactly-once
operations.

## Panorama autofill sequence

VaxLink fills Agent and then checks the Lot list for the selected funding
category. It uses an existing choice. Automatic funding can select a sole
match and asks staff when both categories match. When automatic choice is off,
staff choose before the search and can try the other category after a miss.
VaxLink verifies the selected Lot on the current widget. For older saved
rows without a Lot, it verifies the Trade. Panorama supplies dependent product
fields after selection. VaxLink fills the enabled Date, Time, Reason and
Consent details only after the product is confirmed and preserves entered
values. A bounded watcher handles both visible updates and quiet pages.
Browser-isolated checks for page activity are one input to this verification.

The fill stays with the original document, form, workflow and step. A staff
interaction or a changed form stops further writes. A scanner-triggered fill
also stops when its tab loses focus, and a delayed first write must meet the
worker's deadline. An explicit tray choice can continue when the toolbar popup
takes focus while the chart remains visible.

Using a saved dose on the Multiple grid reserves it before assigning one
empty row. VaxLink checks the same row after the Agent event. A verified grid
assignment leaves the dose in the tray for Details. If the row changes
during the attempt, check the original chart before trying the held dose again.

For a counted tray dose, the chart obtains a reservation before it writes to
Panorama. Once the watched product and detail fields stay settled, one
finalization on the current owner asks the background to consume the reservation.
The queue writer matches the token to the chart document in storage, releases
the reservation, and decrements the count or removes the last dose in one
write. If that write fails, the tray reports no verified use. A later repair
can restore a blank detail on the same chart without another tray write.
Staff verify and save the immunization in Panorama.

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
