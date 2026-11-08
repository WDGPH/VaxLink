# Architecture

The extension has no build step — files are loaded directly by Chrome. No
bundler, no transpilation. It has three execution contexts that communicate
via `chrome.runtime.sendMessage` and `chrome.storage.local`.

## Execution contexts

**`background.js`** — service worker. Owns:

- NVC FHIR bundle fetch, indexing, and 24-hour auto-refresh (`nvc-auto-sync`
  alarm)
- Lot/GTIN lookup (`lookupVaccineInfo`)
- Analytics event log (`vaxlink_analytics_v1`)
- Multiple-inject queue append helpers
- Action icon and badge management

**`content.js`** — injected into Panorama pages. Owns:

- Receives scans routed from the background scanner channel on supported pages
- HUD overlay on supported pages
- Panorama autofill on supported immunization pages
- Workflow mode reading from `chrome.storage.local`

**`popup.js` + `popup-inventory.js` + `popup-ui.js`** — popup window. Owns:

- Manual scan input and parse (`popup-parser.js` for GS1 AI parsing)
- Workflow mode switching (single / multiple / inventory)
- Inventory tray UI, CSV export, and storage via `popup-inventory.js`
- Sending fill payloads to content script via `chrome.tabs.sendMessage`

**`panorama-agent-rules.js`** — loaded before `content.js` as a content
script. Contains heuristics for matching scanned lot/GTIN to a Panorama agent
dropdown option.

**`queue-record.js`** — shared row normalization for inventory CSV export.
Keeps the exported column shape stable for downstream tools.

## Key storage keys

| Key                        | Owner           | Purpose                      |
| -------------------------- | --------------- | ---------------------------- |
| `multiple_inject_queue_v1` | popup + content | Active multiple-inject queue |
| `inventory_scan_batch_v1`  | popup + content | Legacy inventory batch queue |
| `nvc_bundle_override`      | background      | Cached NVC FHIR bundle       |
| `vaxlink_workflow_mode_v1` | popup           | Current workflow mode        |
| `vaxlink_analytics_v1`     | background      | Fill event log               |

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

## Single-scan delivery and recovery

Single scanner scans are saved before chart delivery. A scan is tied to the
selected tab and the document/form context observed there. An unready chart
keeps the scan held; VaxLink does not search other chart tabs for a destination.
Held Single scans are never automatically replayed after unlock or page reload.
A changed or unknown context requires deliberate recovery. Context tokens are
random and contain no patient identifiers or chart URLs.

Delivery is recorded before sending, so an uncertain acknowledgement or worker
restart does not automatically replay a scan that may already have populated
fields. A content-script acceptance is separate from observed application.
Application is reported only after the scheduled corrective passes finish and a
fresh observation confirms the expected agent, exact lot token and requested
fields in the intended form. Unresolved work remains pending at the retry deadline.
That observation does not prove that a clinical record was saved. Trusted edits
of controls in the owning form or its linked PrimeFaces panels cancel later
writes. Unrelated page interactions do not cancel the operation. A newer fill,
navigation, or a replacement owning form also cancels later writes.
Replacing controls within the same owning form can continue that operation.
Before consuming a queue row, the background writer rechecks the current operation
and its observed fields. Native agent selection takes priority over widget labels.

Popup Settings shows held scans and offers **Move held scans to Multiple Inject**.
Review the intended chart first: some held scans may already have populated
fields. Recovery moves scans into the review queue without filling a chart. Recovered rows
require explicit use and are skipped by automatic queue and grid fills. Unparseable
input is retained with a warning so staff can review or remove that queue row.
Capture warnings have a separate acknowledgement; acknowledging a warning does
not recover a scan. Delivery, storage and clinical saving remain separate steps.

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
