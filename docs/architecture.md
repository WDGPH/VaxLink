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

**`content.js`** — injected into Panorama and InputHealth pages. Owns:

- Hardware barcode scanner detection (keystroke timing heuristics)
- HUD overlay on supported pages
- EMR-specific autofill dispatch (`autoFillTelus` → Panorama or generic fill)
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

| Key | Owner | Purpose |
|---|---|---|
| `multiple_inject_queue_v1` | popup + content | Active multiple-inject queue |
| `inventory_scan_batch_v1` | popup + content | Legacy inventory batch queue |
| `nvc_bundle_override` | background | Cached NVC FHIR bundle |
| `vaxlink_workflow_mode_v1` | popup | Current workflow mode |
| `vaxlink_analytics_v1` | background | Fill event log |

## Panorama autofill sequence

Fill order must be: `agent → lot → (deferred) date/time`. Panorama
auto-populates dependent fields (trade name, route, dose, manufacturer) after
lot selection. Always gate lot writes and deferred date/time behind
`!isPrimeFacesAjaxBusy()`. Lot matching uses `normalizePanoramaLotToken` to
handle formats like `LOT123 - Exp. ...`. Panorama uses misspelled IDs (e.g.
`dateAdministedDate`) — keep those as-is.

## Next.js site

`apps/web-next/` uses the Next.js App Router (no `src/` directory):

- `app/` — routes: `/` (landing), `/extension/` (learn-more), `/privacy/`
- `components/` — React components for landing page sections
- `content/site.ts` — site-wide copy and configuration
- `lib/` — utilities: `gs1.ts` (GS1 barcode parsing), `base-path.ts`
  (proxy-aware asset URLs), `analytics.ts`

`next.config.js` auto-detects `VSCODE_PROXY_URI` and `NB_PREFIX` to set
`basePath`/`assetPrefix` for JupyterHub proxy environments. Always set both
together. GitHub Pages CI sets `PAGES_BASE_PATH` and
`BUILD_STATIC_EXPORT=true`.

## CI

- `.github/workflows/extension-ci.yml` — on extension-related pushes/PRs to
  `dev`/`main`: syntax checks, full test suite (NVC suites skip if the
  best-effort bundle fetch fails), and both channel zips uploaded as workflow
  artifacts. Web Store uploads are manual: download the tested zip from the
  run.
- `.github/workflows/deploy-web-next-pages.yml` — builds `apps/web-next` as a
  static export and deploys it to GitHub Pages on every push to `main`.

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
