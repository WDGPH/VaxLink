# Architecture

Chrome loads the source directly without transpilation. Packaging selects channel capabilities. The service worker, popup, content script, and offscreen scanner document with its dedicated worker communicate through extension messages and storage.

## Execution contexts

**`background.js`** — service worker. Owns:

- NVC FHIR bundle fetch, indexing, and 24-hour auto-refresh (`nvc-auto-sync`
  alarm)
- Lot/GTIN lookup (`lookupVaccineInfo`)
- Analytics event log (`vaxlink_analytics_v1`)
- Multiple-inject queue append helpers
- Action icon and badge management

**`content.js`** — injected into supported Panorama pages. Owns:

- Receives scans routed to supported pages
- HUD overlay on supported pages
- Panorama autofill and workflow automation
- Workflow mode reading from `chrome.storage.local`

**`scanner/`** — the offscreen document and dedicated worker own Web Serial capture and decoding. Capture, parsing, queues, and inventory can operate without an open chart.

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

## Chart integration boundary

`autoFillPanorama` requires a supported HTTPS Panorama origin and immunization
workflow context. The manifest keeps broad paths for the three approved hosts;
runtime checks establish the narrower page context. A matching DOM on another
origin is not sufficient. When the tab URL is unavailable, the popup uses a
read-only content-script handshake before sending a fill payload; it does not
inject code on an unverified tab. Unsupported or not-ready pages do not receive
field writes. Capture, queues, and inventory do not require an open chart.

## Key storage keys

| Key                        | Owner                        | Purpose                      |
| -------------------------- | ---------------------------- | ---------------------------- |
| `multiple_inject_queue_v1` | background + popup + content | Active multiple-inject queue |
| `inventory_scan_batch_v1`  | background + popup + content | Active inventory tray        |
| `nvc_bundle_override`      | background                   | Cached NVC FHIR bundle       |
| `vaxlink_workflow_mode_v1` | popup                        | Current workflow mode        |
| `vaxlink_analytics_v1`     | background                   | Fill event log               |

Existing upgraded profiles may also retain data written by earlier versions.

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

## Panorama autofill sequence

Fill order must be: `agent → lot → (deferred) date/time`. Panorama
auto-populates dependent fields (trade name, route, dose, manufacturer) after
lot selection. Always gate lot writes and deferred date/time behind
`!isPrimeFacesAjaxBusy()`. Lot matching uses `normalizePanoramaLotToken` to
handle formats like `LOT123 - Exp. ...`. Panorama uses misspelled IDs (e.g.
`dateAdministedDate`) — keep those as-is.

Field helpers use native selects first. The visible PrimeFaces fallback searches
only the control's own menu panel and checks the resulting selection. Typed
focus-input text alone does not establish a completed selection.

Late date/time, reason, and consent follow-ups keep the same cancellation owner
as the initial fill. A trusted edit to a managed field, a newer operation, URL
navigation, or a different owning form cancels the old operation. Controls
replaced within the same form can still receive a deferred fill. Late writes
also respect an observable busy PrimeFaces queue. An inaccessible page-world
queue remains unknown; the isolated content script cannot prove that it is idle.

A Single scan accepted before its form controls are ready stays in the pending
inbox for that tab. Acceptance stops routing to another chart; it does not remove
an unprocessed scan. The existing bounded replay attempts use the same
destination, and an unfinished scan remains pending. An inbox storage failure is
reported rather than treated as a successful save.

## Diagnostic channel boundary

The packager stamps a frozen capability facade and build identity. Production
keeps the ordinary health handshake and inert recorder calls while excluding the
Alpha recorder, viewer, snapshot, and timing implementations. Alpha producers
validate a small event allowlist before batching; the background validates
sender, session, context, and fields again before its serialized session-storage
collector writes. Offscreen workers relay through runtime messages.

Random attempt IDs travel through the existing scan normalizer and message
paths. Durable clinical queues keep their existing schemas. Session-local maps
link known queue records to later operations; ambiguous pending timestamps stay
unlinked. Field snapshots reuse the real Panorama selectors and decisions in the
same isolated world. Recording adds no DOM observer or clinical-page bridge.
See [diagnostics](diagnostics.md) for retention and evidence limits.

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
