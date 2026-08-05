# Changelog

All notable changes to VaxLink are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Release process, channels, and feedback traceability: see [docs/RELEASING.md](docs/RELEASING.md).

Channels: **Alpha** (`dev` branch, "VaxLink Alpha" Web Store listing) and **Prod** (`main` branch, "VaxLink" listing). Prod versions may skip numbers — gaps were alpha-only iterations.

---

## [1.1.2](https://github.com/WDGPH/VaxLink/compare/v1.1.1...v1.1.2) (2026-08-05)


### Added

* add admin date time autofill setting and UI toggle in popup ([b978539](https://github.com/WDGPH/VaxLink/commit/b978539032b11945af3f10e7dc04545894a7cccb))
* add admin date time autofill setting and UI toggle in popup ([5606bfb](https://github.com/WDGPH/VaxLink/commit/5606bfbcef66b743a1e975454bea427d13579fbd))
* add analytics features to popup.js ([85eb390](https://github.com/WDGPH/VaxLink/commit/85eb39021c65dc216fb821ba076aca472216cb77))
* add inventory management and barcode parsing functionality ([bb2e155](https://github.com/WDGPH/VaxLink/commit/bb2e15541a0e407b277217ec72fa0bbfa3296d86))
* enhance logging functionality in background and content scripts ([192271f](https://github.com/WDGPH/VaxLink/commit/192271fd81e6e44b3394cfa39540ae3d66352425))
* enhance logging functionality in background and content scripts ([a9c6cf8](https://github.com/WDGPH/VaxLink/commit/a9c6cf8dc6be66b62bc8d7b33af899095039c1f7))
* enhance NVC indexing and add lot-agent mapping functionality ([9a01079](https://github.com/WDGPH/VaxLink/commit/9a01079c02b76d3319f36f0f0e6611eedcba2609))
* enhance NVC indexing and add lot-agent mapping functionality ([4a4b3a8](https://github.com/WDGPH/VaxLink/commit/4a4b3a800e7a0d68ca3012509233e8fc254e8608))
* implement local storage management and queue record handling in background and content scripts ([957e672](https://github.com/WDGPH/VaxLink/commit/957e67214c544c356f876bddda0bdf303be5fd64))
* implement mode switching for barcode scanning and inventory management ([dcc17ec](https://github.com/WDGPH/VaxLink/commit/dcc17ec363dabe533c484ca9f998e7a3b72a8a5d))
* implement queue badge functionality and VaxLink command handling ([fe9675e](https://github.com/WDGPH/VaxLink/commit/fe9675ee79a80a1aa3af9b84ba203bc3175ac58a))
* implement queue badge functionality and VaxLink command handling ([94132e3](https://github.com/WDGPH/VaxLink/commit/94132e3c90bcc0d5d2356425bdd5e986de405c33))
* improve GS1 barcode parsing with enhanced error handling and support for AI sequences ([b398fb0](https://github.com/WDGPH/VaxLink/commit/b398fb0ddc763d0380f8a77d2378f6c96b7f3bd3))
* improve GS1 barcode parsing with enhanced error handling and support for AI sequences ([abe7851](https://github.com/WDGPH/VaxLink/commit/abe78518bcbfeb8c69a32929f1492a7b66392524))
* Refactor popup.js for improved vaccine scanning workflow and add panorama agent rules ([e92d20f](https://github.com/WDGPH/VaxLink/commit/e92d20f60a0cfefc358b26cbe877b220e7e385ef))
* update version to 1.0.2 in manifest.json and enhance field handling in content.js - Pentacel ([ec1c833](https://github.com/WDGPH/VaxLink/commit/ec1c833fbb7b8d29548aeb70dd07cc91d0e9963c))
* update version to 1.0.2 in manifest.json and enhance field handling in content.js - Pentacel ([6220273](https://github.com/WDGPH/VaxLink/commit/62202739c04289d676b49f712badaa1f848e288b))


### Fixed

* reliable HB pediatric/adult classification for lot-only barcodes ([652c3c2](https://github.com/WDGPH/VaxLink/commit/652c3c206a4165407a753426fcee3fe96aa56a1b))
* restore 1.1.1 release baseline ([e5f8872](https://github.com/WDGPH/VaxLink/commit/e5f88721c7becfc614ba63a93c741de943a5be52))
* strength-based HB rules use bare number tokens matching NVC data ([6501160](https://github.com/WDGPH/VaxLink/commit/6501160ce24d1b9449a29ff4769b0fcc1496fefe))


### Chores

* release VaxLink 1.1.2 ([c05e55c](https://github.com/WDGPH/VaxLink/commit/c05e55cb1a5bfdf31310e6a6460afcd10ac5d50d))

## [1.1.1](https://github.com/WDGPH/VaxLink/compare/v1.1.0...v1.1.1) (2026-07-15)


### Fixed

* stabilize expired-lot PF/NPF autofill flow in Panorama ([f6358c5](https://github.com/WDGPH/VaxLink/commit/f6358c523976d1b2ee54dd18c34e3df2973046f4))

## [1.1.0](https://github.com/WDGPH/VaxLink/compare/v1.0.7...v1.1.0) (2026-07-07)


### Added

* reason for immunization and consent autofill in Panorama ([e1d0b11](https://github.com/WDGPH/VaxLink/commit/e1d0b11f36c8dab4885c741871d78ebd1d014469))

## [1.0.7] – 2026-06-12

### Fixed
- **Alpha badge showed on the prod build.** The popup badge is now hidden unless the manifest name says Alpha — the channel is stamped at package time, so prod uploads show no badge. Includes the CSS fix where the badge class's `display` rule overrode the `hidden` attribute.

### Added
- `scripts/package-extension.sh [alpha|prod]` — builds channel-stamped Web Store zips (name, `version_name` suffix) and keeps `manifest.json` identical across branches, ending the recurring merge conflicts.
- Extension CI (`.github/workflows/extension-ci.yml`): syntax checks, full test suite, and both channel zips as downloadable artifacts on every extension push/PR.

### Changed
- GitHub Actions bumped to Node 24 majors (checkout/setup-node v6, upload-artifact v6, cache v5).

**Contributors:** Eswar Attuluri

---

## [1.0.6] – 2026-06-12

The clinic-feedback release: two rounds of nurse pilot feedback (May–June 2026) plus a systematic bug audit. Test suite grew from 0 to 130 automated tests (`apps/extension-tests/`).

### Clinic feedback addressed

| What the clinic told us | What changed | Refs |
|---|---|---|
| "One item scanned twice... on trying to delete the extra scan it was impossible" | Duplicate-scan guard: an identical barcode within 3 s is rejected with a distinct tone and a "Duplicate scan ignored" toast. Window kept short so back-to-back same-lot patients still scan (vaccine barcodes carry no per-unit serial). | #25 |
| "Could not see which item scanned until hovering... same scanned items appeared again" | The on-page HUD now lists every queued item (tradename · lot) with per-row remove and a confirm-to-clear button. Every queue save gets a success tone and an "Added to queue (N queued)" toast. | #27 |
| "Changed an item... it reverted back and I had to change again" | Manual agent/lot changes stick: user interaction cancels pending autofill retries, and the queue never overwrites a form whose agent differs from the next queued scan ("Kept your selection" toast). | #26 |
| "If an expired vaccine is scanned — does an ALERT pop up?" | Expired scans show a red warning that stays on screen until dismissed, plus a distinct warning tone. Routine toasts render beneath it instead of replacing it. | #28 |
| "Covid vaccine did not scan" / "Unable to scan multidose vial" | Two parser fixes for real scanner output: AIM symbology prefixes beyond `]C1` (`]d2` DataMatrix, `]Q3` QR) are stripped, and lot-only scans containing "01" in the lot (e.g. lot Y016312) no longer get truncated. May not cover all COVID products — see Known issues. | #16, #9 |

### Fixed
- Nurse Tab/Enter keystrokes typed shortly before navigation were swallowed by the scanner buffer; interception is now gated on machine-speed input.
- Restored the audio feedback system (`playAudioCue` had been deleted while its call sites remained — a live error on every failed parse/lookup).
- Popup lot lookups no longer cache transient errors for the whole session.
- Popup queue mutations re-read storage first, so hands-free scans appended while the popup is open are never clobbered; multidose dose counts decrement from the freshest value.
- CSV exports neutralize spreadsheet formula injection (`=`, `+`, `-`, `@` prefixes) in both export paths.
- Analytics bucket by local calendar day — evening clinics no longer split across two days, and "today" exports cover the local day.
- GS1 day "00" expiry dates resolve to the last day of the month.

### Known issues (tracked)
- PF/NPF same-lot disambiguation: the scanned lot always matches the publicly-funded entry; "N <lot>" cannot be auto-selected (#29).
- Prefilled-syringe dose/UOM are not preset (#24).
- Some COVID vial QR codes may not be GS1 at all — diagnosis needs a raw decoded scan string from a clinic scanner (#16).

**Contributors:** Eswar Attuluri · clinic feedback: WDGPH immunization nursing team

---

## [1.0.5] – 2026-06-09

### Changed
- Hands-free scanner capture restricted to the Panorama `recordImms` page only, reducing interference on other Panorama screens.

**Contributors:** Eswar Attuluri

---

## [1.0.4] – 2026-06-08

### Clinic feedback addressed

| What the clinic told us | What changed | Refs |
|---|---|---|
| "Unable to select non-publicly funded for a rabies vaccine — no work around" | The funding filter radio is reset to "Show All" before lot fill, so NPF lots hidden by Panorama's filter become selectable. | #12, #19, #21 |
| "Recombivax HB (1 mL) was scanning as a ped dose" | Reliable HB pediatric/adult classification for lot-only barcodes, including strength-token rules and NVC override tables. | #8, #18 |
| Client IDs and field navigation broken while the extension was active | Client IDs starting with "10" are no longer intercepted as barcodes; Tab/Enter field navigation fixed (paste/keydown guards require a full numeric-GTIN GS1 parse). | #11, #13, #14 |

### Changed
- Extension renamed to **VaxLink Alpha** for the pilot listing.

**Contributors:** Eswar Attuluri · clinic feedback: WDGPH immunization nursing team

---

## [1.0.2 – 1.0.3] – 2026-03-20 → 2026-05-08

Alpha-only iterations between the 1.0.1 prod release and the June pilot rounds.

### Added
- Queue badge on the extension icon; VaxLink scanner command handling.
- Administered date/time autofill setting with popup toggle.
- Audio feedback for scan success/error/expiry (later restored in 1.0.6 after a refactor regression).
- Inventory manager design and features (page later removed in favor of the popup tray).
- EMR adaptation and debugging skills, selector maintenance docs.

### Changed
- GS1 parsing hardened (error handling, GTIN context, tradename strength resolution).
- NVC indexing enhanced with lot→agent mapping.

**Contributors:** Eswar Attuluri

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

**Contributors:** Eswar Attuluri

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

**Contributors:** Eswar Attuluri, Justin Angevaare

---

[1.0.7]: https://github.com/WDGPH/VaxLink/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/WDGPH/VaxLink/compare/v1.0.4...v1.0.6
[1.0.5]: https://github.com/WDGPH/VaxLink/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/WDGPH/VaxLink/compare/v1.0.1...v1.0.4
[1.0.1]: https://github.com/WDGPH/VaxLink/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/WDGPH/VaxLink/releases/tag/v1.0.0
