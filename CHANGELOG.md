# Changelog

All notable changes to VaxLink are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

---

## [1.0.2] – 2026-06-03

### Fixed
- **Paste interception false positive** — `onHandsFreePaste` was calling `event.preventDefault()` for any clipboard content containing the substring `"01"`, silently swallowing patient notes, dates, health card numbers, and other clinical text pasted into Panorama fields. The fix gates paste interception on `parseGS1BarcodeFromScanner` succeeding and the extracted GTIN being 14 numeric digits (#14). See `docs/paste-interception-false-positive.md`.

---

## [1.0.1] – 2026-05-26

### Fixed
- **Multi-inject race condition** — fixed a timing issue where `chrome.storage.local.get` could resolve after `initClickReductionFeatures()` ran, causing multi-mode autofill to miss the first Panorama SPA load (#7).
- Ensure `activeWorkflowMode='multiple'` is applied before early `checkGrid()` guards execute.
- Re-trigger multi-mode autofill and auto-drain from within the storage callback to avoid missed fills.
- Defer `initClickReductionFeatures()` on already-loaded pages to prevent sync init timing issues.
- Prevent missed `MutationObserver` processing during PrimeFaces page-load bursts.

### Added
- HUD can now be **moved and hidden** by the user — drag to reposition, or dismiss entirely (#6).
- Added popup UI improvements (`popup.html` / `popup.js`) supporting multi-inject workflow.
- New debug docs: `docs/multiple-workflow-grid-not-filling-until-hover.md` and `docs/multiple-workflow-wrong-agent-first-page.md`.

---

## [1.0.0] – 2026-05-14

### Added
- Initial stable release of the VaxLink Chrome extension (Manifest V3).
- GS1 barcode parsing for vaccine lot, GTIN, expiry, and serial number (`popup-parser.js`).
- Panorama autofill: agent → lot → deferred date/time sequence with PrimeFaces AJAX guard.
- InputHealth / web-based EMR autofill support.
- NVC FHIR bundle fetch, indexing, and 24-hour auto-refresh via service worker alarm.
- Single, multiple, and inventory workflow modes.
- Candidate matching heuristics for Panorama agent dropdown (`panorama-agent-rules.js`).
- HUD overlay with scan feedback on supported pages.
- Analytics event log (`vaxlink_analytics_v1`).
- Next.js 14 marketing site (`apps/web-next`) deployed to GitHub Pages.
- Privacy policy page.

---

[1.0.2]: https://github.com/WDGPublicHealth/VaxLink/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/WDGPublicHealth/VaxLink/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/WDGPublicHealth/VaxLink/releases/tag/v1.0.0
