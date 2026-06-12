# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Layout

| Path | What it is |
|---|---|
| `apps/extension/` | Chrome extension (Manifest V3) — no build step, plain JS |
| `apps/extension-tests/` | Extension test suite (kept outside `apps/extension/` so the Chrome Web Store zip stays clean) |
| `apps/web/` | Static landing page + NVC bundle explorer (no build step) |
| `apps/web-next/` | Next.js 14 marketing site, deployed to GitHub Pages |
| `scripts/` | Shell utilities (e.g. `fetch-nvc.sh` to download NVC bundle locally) |
| `skills/` | Claude Code skill definitions for common extension workflows |
| `pano1.html`, `pano2.html` | Panorama DOM fixtures used as selector test references |

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

Release channels: `dev` = VaxLink Alpha, `main` = VaxLink (two separate Web Store listings). The extension *name* is stamped by the package script, never edited in `manifest.json` — the manifest must stay identical across branches so `dev → main` merges don't conflict. Only `version` is bumped in git, and it flows through merges.

### Next.js Site (`apps/web-next`)

```bash
cd apps/web-next
npm ci                     # install deps
npm run dev                # local dev server on port 3000
npm run build              # production build
npm run lint               # ESLint
```

When running behind JupyterHub or a reverse proxy, pass the base path:

```bash
BASE_PATH=/notebook/analytics/vaxlink/proxy/3000 npm run dev
```

For GitHub Pages static export (also done automatically in CI):

```bash
BUILD_STATIC_EXPORT=true PAGES_BASE_PATH=/<repo> npm run build
```

### Static Web App (`apps/web`)

```bash
cd apps/web && python3 -m http.server 8080
./scripts/fetch-nvc.sh     # download local NVC bundle snapshot (not committed)
```

## Extension Architecture

The extension has three execution contexts that communicate via `chrome.runtime.sendMessage` and `chrome.storage.local`:

**`background.js`** — service worker. Owns:
- NVC FHIR bundle fetch, indexing, and 24-hour auto-refresh (`nvc-auto-sync` alarm)
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

## Next.js Site Architecture

`apps/web-next/` uses the Next.js App Router (no `src/` directory):

- `app/` — routes: `/` (landing), `/extension/` (learn-more), `/privacy/`
- `components/` — React components for landing page sections
- `content/site.ts` — site-wide copy and configuration
- `lib/` — utilities: `gs1.ts` (GS1 barcode parsing), `base-path.ts` (proxy-aware asset URLs), `analytics.ts`

The `next.config.js` auto-detects `VSCODE_PROXY_URI` and `NB_PREFIX` to set `basePath`/`assetPrefix` for JupyterHub proxy environments. Always set both together. GitHub Pages CI sets `PAGES_BASE_PATH` and `BUILD_STATIC_EXPORT=true`.

## CI

GitHub Actions:
- `.github/workflows/extension-ci.yml` — on extension-related pushes/PRs to `dev`/`main`: syntax checks, full test suite (NVC suites skip if the best-effort bundle fetch fails), and both channel zips uploaded as workflow artifacts. Web Store uploads are manual: download the tested zip from the run.
- `.github/workflows/deploy-web-next-pages.yml` — builds `apps/web-next` as a static export and deploys to GitHub Pages on every push to `main`.

## Important Constraints

- `apps/web/nvc-bundle.json` is in `.gitignore` — never commit raw NVC bundle files.
- If Panorama DOM changes, update selectors in `apps/extension/content.js`. Use `pano1.html` / `pano2.html` as fixtures.
- The extension has no build step — files are loaded directly by Chrome. No bundler, no transpilation.
- `apps/extension-tests/` uses Node.js built-in `node:test` runner (no Jest/Vitest). Tests must stay outside `apps/extension/` so they are never packaged into the Chrome Web Store upload.
- The repo-root `package.json` exists to mark the tree `"type": "module"` so Node parses the extension's ESM sources correctly in tests — don't delete it.
