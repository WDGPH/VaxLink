# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Layout

| Path | What it is |
|---|---|
| `apps/extension/` | Chrome extension (Manifest V3) — no build step, plain JS |
| `apps/extension-tests/` | Extension test suite (kept outside `apps/extension/` so the Chrome Web Store zip stays clean) |
| `scripts/` | Shell utilities (e.g. `fetch-nvc.sh` to download NVC bundle locally) |
| `skills/` | Claude Code skill definitions for common extension workflows |

## Commands

### Chrome Extension (`apps/extension`)

```bash
# Syntax check individual files (no test runner needed)
node --check apps/extension/content.js
node --check apps/extension/popup.js
node --check apps/extension/popup-inventory.js

# Run automated tests (suite lives in apps/extension-tests/, outside the packaged extension)
cd apps/extension-tests && npm test     # or `npm test` from the repo root
```

Install for manual testing: load `apps/extension/` as an unpacked extension in `chrome://extensions` with Developer mode on.

```bash
# Package for the Chrome Web Store (stamps channel identity at build time)
./scripts/package-extension.sh alpha   # dist/vaxlink-alpha-<v>.zip, name "VaxLink Alpha"
./scripts/package-extension.sh prod    # dist/vaxlink-prod-<v>.zip,  name "VaxLink"
```

Production releases run from `main` and prereleases from `alpha` through release-please, with separate VaxLink and VaxLink Alpha listings. Store uploads remain manual. The extension name is stamped by the package script; release-please owns version changes. See `docs/RELEASING.md`.

## Extension Architecture

The extension has three execution contexts that communicate via `chrome.runtime.sendMessage` and `chrome.storage.local`:

**`background.js`** — service worker. Owns:
- NVC FHIR bundle fetch, indexing, and 24-hour auto-refresh (`nvc-auto-sync` alarm)
- Lot/GTIN lookup (`lookupVaccineInfo`)
- Analytics event log (`vaxlink_analytics_v1`)
- Multiple-inject queue append helpers
- Action icon and badge management

**`content.js`** — injected into Panorama and InputHealth pages. Owns:
- Routes scans from the dedicated Web Serial scanner channel on supported pages
- HUD overlay on supported pages
- EMR-specific autofill dispatch (`autoFillTelus` → Panorama or generic fill)
- Workflow mode reading from `chrome.storage.local`

**`popup.js` + `popup-inventory.js` + `popup-ui.js`** — popup window. Owns:
- Manual scan input and parse (`popup-parser.js` for GS1 AI parsing)
- Workflow mode switching (single / multiple / inventory)
- Inventory tray UI, CSV export, and storage via `popup-inventory.js`
- Sending fill payloads to content script via `chrome.tabs.sendMessage`

**`panorama-agent-rules.js`** — loaded before `content.js` as a content script. Contains heuristics for matching scanned lot/GTIN to a Panorama agent dropdown option.

**`queue-record.js`** — shared row normalization for inventory CSV export. Keeps the exported column shape stable for downstream tools.

### Key Storage Keys

| Key | Owner | Purpose |
|---|---|---|
| `multiple_inject_queue_v1` | popup + content | Active multiple-inject queue |
| `inventory_scan_batch_v1` | popup + content | Legacy inventory batch queue |
| `nvc_bundle_override` | background | Cached NVC FHIR bundle |
| `vaxlink_workflow_mode_v1` | popup | Current workflow mode |
| `vaxlink_analytics_v1` | background | Fill event log |

### Panorama Autofill Sequence

Fill order must be: `agent → lot → (deferred) date/time`. Panorama auto-populates dependent fields (trade name, route, dose, manufacturer) after lot selection. Always gate lot writes and deferred date/time behind `!isPrimeFacesAjaxBusy()`. Lot matching uses `normalizePanoramaLotToken` to handle formats like `LOT123 - Exp. ...`. Panorama uses misspelled IDs (e.g. `dateAdministedDate`) — keep those as-is.

### Adding a New EMR

The ROADMAP describes a planned platform registry refactor. Until that lands, new platforms are added to `content.js` by extending `isHandsFreeSupportedPage()` and `autoFillTelus()`. See `skills/vaxlink-emr-adaptation/SKILL.md` for the adapter contract.

## CI

GitHub Actions:
- `.github/workflows/extension-ci.yml` — on extension-related pushes to `alpha`/`main` and pull requests: syntax checks, full test suite (live-catalogue suites skip if the best-effort bundle fetch fails), and channel ZIPs uploaded as workflow artifacts (Alpha only for prereleases; both channels for stable versions). Web Store uploads are manual: download the tested zip from the run.
- `.github/workflows/docs.yml` — runs the locked, strict MkDocs documentation check on pushes to `main`/`alpha` and on PRs; it does not publish.
- `.github/workflows/docs-hub-notify.yml` — opt-in notifications to `WDGPH/docs` for main and stable-tag changes. See `README.md` for token setup and historical release reconciliation.

## Important Constraints

- `apps/extension/nvc_bundle.json` is in `.gitignore` — never commit raw NVC bundle files.
- If Panorama DOM changes, update selectors in `apps/extension/content.js`. Capture a fresh DOM snapshot locally to diff against (do not commit live-session captures — they can contain real patient data; sanitize to structural fragments only, as done in `apps/extension-tests/panorama-reason-consent.test.js`).
- The extension has no build step — files are loaded directly by Chrome. No bundler, no transpilation.
- `apps/extension-tests/` uses Node.js built-in `node:test` runner (no Jest/Vitest). Tests must stay outside `apps/extension/` so they are never packaged into the Chrome Web Store upload.
- The repo-root `package.json` exists to mark the tree `"type": "module"` so Node parses the extension's ESM sources correctly in tests — don't delete it.
