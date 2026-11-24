# Changelog

All notable changes to VaxLink are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Release process, channels, and feedback traceability: see [docs/RELEASING.md](docs/RELEASING.md).

Channels: **Alpha** (`dev` branch, "VaxLink Alpha" Web Store listing) and **Prod** (`main` branch, "VaxLink" listing). Prod versions may skip numbers — gaps were alpha-only iterations.

---

## [2.0.0-rc2](https://github.com/WDGPH/VaxLink/compare/v2.0.0-rc1...v2.0.0-rc2) (2026-11-24)


### Fixed

* clarify tray counts and catalogue messages ([c3d2452](https://github.com/WDGPH/VaxLink/commit/c3d245240f5cf5c149cc442e7cbe3ce2b287b215))
* keep scanner permission instructions visible ([ca4175f](https://github.com/WDGPH/VaxLink/commit/ca4175fe7edcab5c63c3903c034635d57786cbb0))
* simplify the popup and keep scanner permission guidance visible ([3697761](https://github.com/WDGPH/VaxLink/commit/3697761d97844d8088b5003740595ad008bc1c4e))

## [2.0.0-rc1](https://github.com/WDGPH/VaxLink/compare/v1.2.0-alpha...v2.0.0-rc1) (2026-11-24)


### ⚠ BREAKING CHANGES

* InputHealth chart integration is removed. Barcode parsing, NVC lookup, scanner capture, queues and inventory remain available without a chart.

### Added

* add read-only workstation health ([#92](https://github.com/WDGPH/VaxLink/issues/92)) ([dff18c0](https://github.com/WDGPH/VaxLink/commit/dff18c0b054ae0d95e0bd1d29c2350a18e6af510))
* **debug:** collect and clear troubleshooting details for a session ([c501996](https://github.com/WDGPH/VaxLink/commit/c501996797d1a0ad9ce4d86edddf31d59d511f85))
* **debug:** record routing decisions and settings at export ([2f9773c](https://github.com/WDGPH/VaxLink/commit/2f9773c5a900abbaefa34dc3135dd1b8e9eb3ebb))
* **debug:** trace chart checks through the owned fill ([6534a24](https://github.com/WDGPH/VaxLink/commit/6534a24f65d3e02b072318de1a32aa01a6171449))
* **funding:** choose a category using the current Lot list ([60bc0d8](https://github.com/WDGPH/VaxLink/commit/60bc0d823407c169203ecdc556fce4f12813dfd4))
* **immunization:** use one tray for single forms and the Multiple grid ([2d20c8d](https://github.com/WDGPH/VaxLink/commit/2d20c8d37599516e29a969d249416959c762ecb7))
* limit chart autofill to Panorama ([#88](https://github.com/WDGPH/VaxLink/issues/88)) ([6792e2d](https://github.com/WDGPH/VaxLink/commit/6792e2d456fcef85950ce1e7071143335342f5a1))
* package numbered release candidates for VaxLink Alpha ([235f8ec](https://github.com/WDGPH/VaxLink/commit/235f8ece68908eb3042abc5b74710573d47df39f))
* **panorama:** carry an exact grid dose into Enter Details ([75909ee](https://github.com/WDGPH/VaxLink/commit/75909ee23e44edd8454a57c89a70e7c0bba872d2))
* **panorama:** identify the open immunization form ([5fa2a57](https://github.com/WDGPH/VaxLink/commit/5fa2a57ae9b17c7fd99e49355c5bcff596831b5b))
* **popup:** compact held scans into individual review rows ([1106f04](https://github.com/WDGPH/VaxLink/commit/1106f040f9445a2c496c2f8e5c8a754712069c69))
* **reports:** prepare a draft for the appropriate lot support team ([1c8eb8b](https://github.com/WDGPH/VaxLink/commit/1c8eb8b7d09053eddd131e4200dfc3da42814ea4))
* **scanner:** connect the selected scanner from Settings ([2c247fa](https://github.com/WDGPH/VaxLink/commit/2c247fa97dc438838cf7367db86304a76ed3d729))
* **scanner:** forget a saved scanner after it stops ([8ec669c](https://github.com/WDGPH/VaxLink/commit/8ec669ce40068545d37ca5ee6864f8a5961a0a9c))
* **scanner:** offer an optional test for the saved scanner ([c8bbec1](https://github.com/WDGPH/VaxLink/commit/c8bbec1caf5efcf88b4e19a4842b23f202455fcb))
* trace funding refreshes and visible detail fields ([b504f89](https://github.com/WDGPH/VaxLink/commit/b504f89c669a58ed0f96117a94c25cc06a08ebd7))
* **tray:** add a recently verified lot for another dose ([78a93a2](https://github.com/WDGPH/VaxLink/commit/78a93a2fdd2447451dbbcd7a3c2606eba8ce2e79))
* **tray:** give saved vaccines a deliberate number of uses ([b8ded5d](https://github.com/WDGPH/VaxLink/commit/b8ded5d94ae1eadb81108310bb8808e7c2999937))
* **tray:** move and reorder selected scans ([14a87f6](https://github.com/WDGPH/VaxLink/commit/14a87f64b5b54a4562c5488f9677ed73e8df3f1a))
* **tray:** reserve a counted dose for one chart ([26166df](https://github.com/WDGPH/VaxLink/commit/26166df7a8c13e2c8a7b3f8672da4bce02f172a6))
* **tray:** review a held dose on the chart ([1dc449f](https://github.com/WDGPH/VaxLink/commit/1dc449fcb5d7ad802a62cf35ef1a3299e6884bc8))
* **tray:** use a reserved dose on the chosen chart ([d04744f](https://github.com/WDGPH/VaxLink/commit/d04744f7d05e2816670c15849934a6443bbaf2bf))
* **tray:** use the chosen dose on the Multiple grid ([70499a9](https://github.com/WDGPH/VaxLink/commit/70499a9b845d477d3606cb09ec8dada38091a6ac))
* unify immunization scanning and improve scanner and tray workflows ([4cee807](https://github.com/WDGPH/VaxLink/commit/4cee80768c25b9c9cb7ac647fc67c12d82f05380))


### Fixed

* **activity:** count each Inventory export once ([35e3a04](https://github.com/WDGPH/VaxLink/commit/35e3a044687011832e00bdf01c4927e1e7fa4133))
* distinguish active tray fills from doses needing review ([108176c](https://github.com/WDGPH/VaxLink/commit/108176c2cbcadf892d960fd8e50cfc0ccb2cb726))
* finish popup adds without overwriting new input ([#100](https://github.com/WDGPH/VaxLink/issues/100)) ([dd8eb57](https://github.com/WDGPH/VaxLink/commit/dd8eb57a9d29d3c945ec4c115744e0f4e08ed5d3))
* **immunization:** block expired doses from chart entry ([4a3992c](https://github.com/WDGPH/VaxLink/commit/4a3992cb4d476c5792f81899e6ca531a66314150))
* **immunization:** require a lot on new barcode entry ([6f25ecc](https://github.com/WDGPH/VaxLink/commit/6f25ecc3f5a1f9cce1f9135b92aadf29c066b65e))
* **inventory:** save a scan while the catalogue is unavailable ([96c7efa](https://github.com/WDGPH/VaxLink/commit/96c7efaad486b92869678fdf376ff9778fb6ff60))
* match grid doses to the visible immunization detail ([9dab103](https://github.com/WDGPH/VaxLink/commit/9dab1033290d288fc50a6794eef9ededcf1eedd5))
* open scanner pairing in a standard browser window ([#104](https://github.com/WDGPH/VaxLink/issues/104)) ([06a84e8](https://github.com/WDGPH/VaxLink/commit/06a84e8226746d1503a2a9f27e70f5a972dd4498))
* **panorama:** carry later doses after a skipped detail step ([202542a](https://github.com/WDGPH/VaxLink/commit/202542a05563b9a6c6e4fb44d9a965eaff9dc718))
* **panorama:** claim each deferred fill outcome once ([dde4e82](https://github.com/WDGPH/VaxLink/commit/dde4e8203e41535ae5c14be39294b630510b4b36))
* **panorama:** clear unmatched lots and retire stale feedback ([ad8f2c4](https://github.com/WDGPH/VaxLink/commit/ad8f2c48b9cd7f66ddbbdd75f2b9823eab3a045c))
* **panorama:** distinguish funding entries for the same lot ([6396670](https://github.com/WDGPH/VaxLink/commit/6396670d51086e35dae8801456db109f45e4f65e))
* **panorama:** explain which fields need review after a Lot miss ([abe6e25](https://github.com/WDGPH/VaxLink/commit/abe6e25ff671ee7c93c846312a2802895a001b37))
* **panorama:** handle funding choices and guide staff after a lot miss ([1502fdb](https://github.com/WDGPH/VaxLink/commit/1502fdb343a002a5e8478d35ca6f295ac664b9e8))
* **panorama:** keep a delayed fill with the chart that started it ([3bc5084](https://github.com/WDGPH/VaxLink/commit/3bc5084689a60c393a16d62dc3760416f3fa09c3))
* **panorama:** keep chart access on supported immunization pages ([d947a2b](https://github.com/WDGPH/VaxLink/commit/d947a2bf4f6b09c5b0050528c1b471ef765f46ed))
* **panorama:** keep Enter Details under staff control ([d54a5a8](https://github.com/WDGPH/VaxLink/commit/d54a5a8fb19e900b0766ac51eae27175437abc06))
* **panorama:** keep the deliberate chart choice through popup focus ([2823722](https://github.com/WDGPH/VaxLink/commit/2823722919cb74e06cc216f72de73d9d74bd64f1))
* **panorama:** match the vaccine formulation to the Agent ([ffcd9ee](https://github.com/WDGPH/VaxLink/commit/ffcd9ee24d5fff40e751218f7be90e9bbd704c72))
* **panorama:** preserve a confirmed Lot miss at the deadline ([4587e0b](https://github.com/WDGPH/VaxLink/commit/4587e0b1ee2348336babe40948be8ce0b8d53c53))
* **panorama:** preserve entered details and use the visible Consent menu ([d63a654](https://github.com/WDGPH/VaxLink/commit/d63a6545238e281f1fb18fb1f2fdcf3b4ab17e53))
* **panorama:** preserve safe funding cleanup and Consent timing ([08fb5f5](https://github.com/WDGPH/VaxLink/commit/08fb5f5794c90754062445c62a422adf7cabff43))
* **panorama:** prevent two installations from filling the same chart ([147c154](https://github.com/WDGPH/VaxLink/commit/147c154483479a42937baeccf5cf483e147f4554))
* **panorama:** recheck deferred entry with one bounded watcher ([b2c897a](https://github.com/WDGPH/VaxLink/commit/b2c897a0b9e6ac19755825f72143a8214bad42b7))
* **panorama:** show Lot search and field-check progress ([b3129f3](https://github.com/WDGPH/VaxLink/commit/b3129f3463e36ab22b5e0da29471a0a7b2b77ebe))
* **panorama:** stop detail fills when the Agent changes ([fe4b85b](https://github.com/WDGPH/VaxLink/commit/fe4b85b8f389c73560db0e94275488825baf21c8))
* **panorama:** verify the Lot on the current chart widget ([e3ad9c9](https://github.com/WDGPH/VaxLink/commit/e3ad9c9e51ed4b83977edfdc534d03e92ee653e9))
* **panorama:** verify Trade on saved rows without a Lot ([a947a4b](https://github.com/WDGPH/VaxLink/commit/a947a4ba76bf80611a276c58865441f8c0bdee24))
* **panorama:** wait for product verification before filling details ([9ff972b](https://github.com/WDGPH/VaxLink/commit/9ff972b5f206fd023566a003de82eb55996c9e0c))
* preserve pending scans and inspect scanner status safely ([#89](https://github.com/WDGPH/VaxLink/issues/89)) ([d186b36](https://github.com/WDGPH/VaxLink/commit/d186b36b9523c68fbf557fbe3c1c39159cd40a37))
* reject invalid expiry dates and count calendar days ([#98](https://github.com/WDGPH/VaxLink/issues/98)) ([21f59ce](https://github.com/WDGPH/VaxLink/commit/21f59ce835910ea3cefe36fcb01f261e4fa38324))
* retain uncertain scanner delivery for deliberate recovery ([#97](https://github.com/WDGPH/VaxLink/issues/97)) ([28520b0](https://github.com/WDGPH/VaxLink/commit/28520b0a4ee97eef8547652b6ddd221aa3743284))
* **scanner:** cancel a pending serial reader ([211c82e](https://github.com/WDGPH/VaxLink/commit/211c82e696a3241abcc5f67e9ed1372e94a7f222))
* **scanner:** confirm disconnect after a late serial open ([54c0723](https://github.com/WDGPH/VaxLink/commit/54c0723e87ab0eb788d39e0df068a75b4576acc8))
* **scanner:** hold an uncertain scan against its original chart ([83b9783](https://github.com/WDGPH/VaxLink/commit/83b97834970f8daf02ef1f5dea2185e95a536c91))
* **scanner:** keep locked captures in the selected workflow ([21b6de9](https://github.com/WDGPH/VaxLink/commit/21b6de93f22c525c742d3b045f03eb1d02542671))
* **scanner:** reuse setup and show the reported device ([065c6e3](https://github.com/WDGPH/VaxLink/commit/065c6e364a16db37333a3722461384b2f703a9cf))
* serialize shared queue edits with scanner captures ([#99](https://github.com/WDGPH/VaxLink/issues/99)) ([005f123](https://github.com/WDGPH/VaxLink/commit/005f123b2d51529d429f2ad13fefeea71d0e8d8a))
* **settings:** load Debug mode when Settings opens ([32592ea](https://github.com/WDGPH/VaxLink/commit/32592ea8bb17bfc9fcc8f5b9de4dca713688fa3a))
* stop autofill after form changes or manual takeover ([#96](https://github.com/WDGPH/VaxLink/issues/96)) ([0e4e0fb](https://github.com/WDGPH/VaxLink/commit/0e4e0fb6300edc8cc49144b45c3a46e3d2a7d2c0))
* **tray:** keep chart Use available for unreserved doses ([7910434](https://github.com/WDGPH/VaxLink/commit/79104343313dcd5cb4a12c9df440d5451c4a7c0c))
* **tray:** keep legacy expiry when reusing a recent lot ([e13c26c](https://github.com/WDGPH/VaxLink/commit/e13c26c01b886c781157d0ccb920efc640ff8379))

## [1.2.0-alpha](https://github.com/WDGPH/VaxLink/compare/v1.1.5...v1.2.0-alpha) (2026-11-07)


### Added

* clarify NVC catalogue details and refresh results ([#70](https://github.com/WDGPH/VaxLink/issues/70)) ([2322130](https://github.com/WDGPH/VaxLink/commit/23221301213492e0aafa1acc0f8a437d67e9b54e))


### Fixed

* keep NVC lookups reliable during startup and refresh ([#61](https://github.com/WDGPH/VaxLink/issues/61)) ([6c685a5](https://github.com/WDGPH/VaxLink/commit/6c685a5be99fb451618cebac0578c4a73816bace))

## [1.1.5](https://github.com/WDGPH/VaxLink/compare/v1.1.4...v1.1.5) (2026-11-06)


### Fixed

* support the Panorama training site ([dd3ac80](https://github.com/WDGPH/VaxLink/commit/dd3ac80a3387774aeb859a8c71f0313ed1a4b647))
* support the Panorama training site ([adddd5e](https://github.com/WDGPH/VaxLink/commit/adddd5e60c3e883e842ebd4241816da3e57ca203))

## [1.1.4](https://github.com/WDGPH/VaxLink/compare/v1.1.3...v1.1.4) (2026-10-07)


### Fixed

* allow repairing existing stable release assets ([5f291d5](https://github.com/WDGPH/VaxLink/commit/5f291d5639a68339db606c44022aeb5efd914c01))
* preserve GS1 lot numbers containing AI-like digits ([5d4efdc](https://github.com/WDGPH/VaxLink/commit/5d4efdc16f8d95ebea47f6bf3e245ecb614b0239))
* preserve vaccine lot numbers containing GS1 AI digits ([8b3a06b](https://github.com/WDGPH/VaxLink/commit/8b3a06b11e36201d1e5a61321153321c775f49d7))

## [1.1.3](https://github.com/WDGPH/VaxLink/compare/v1.1.2...v1.1.3) (2026-08-12)


### Added

* add single lock-screen scanner support ([f665994](https://github.com/WDGPH/VaxLink/commit/f6659944aec0f73ff882e893b8ac98e2f637a4c8))


### Fixed

* use prerelease versioning for alpha lane ([a6cd9a6](https://github.com/WDGPH/VaxLink/commit/a6cd9a627765a69995f1a4558bd6292263be774e))

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
- **Paste interception false positive** — `onHandsFreePaste` was calling `event.preventDefault()` for any clipboard content containing the substring `"01"`, silently swallowing patient notes, dates, health card numbers, and other clinical text pasted into Panorama fields. The fix gates paste interception on `parseGS1BarcodeFromScanner` succeeding and the extracted GTIN being 14 numeric digits (#14).

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
