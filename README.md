# VaxLink

[![CI](https://github.com/WDGPH/VaxLink/actions/workflows/extension-ci.yml/badge.svg)](https://github.com/WDGPH/VaxLink/actions/workflows/extension-ci.yml)
[![Docs](https://img.shields.io/badge/docs-PHIZ-blue)](https://docs.phiz.ca/vaxlink/)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/WDGPH/VaxLink)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

VaxLink is a Chrome extension that reads vaccine barcodes and helps staff
enter vaccine details in Panorama. Staff can also use Inventory to track
vaccine lots and expiry dates.

- 📚 **Documentation:** <https://docs.phiz.ca/vaxlink/>
- [Privacy assessment guide for adopting clinics](docs/privacy-assessment.md)
- 🧩 **Extension:** `apps/extension`

## Repository Layout

- `apps/extension` - Chrome extension (Manifest V3) — the main project
- `apps/extension-tests` - extension test suite (kept out of the Web Store zip)
- `scripts` - shell utilities (e.g. `fetch-nvc.sh`, `package-extension.sh`)
- `skills` - Agent guides for common extension tasks
- `docs` - source for the MkDocs documentation site

## Extension (`apps/extension`)

### What it does

- Reads the product code, lot, expiry date and optional serial number from vaccine barcodes
- Looks up vaccine information in the National Vaccine Catalogue
- Selects Panorama agent and lot, lets Panorama derive vaccine details, and fills enabled date/time, reason, and consent fields for staff review
- Shows expiry state (`Expired`, `Expiring soon`, `Valid`)
- Captures scans through Web Serial, including while the workstation is locked
- Follows the active Panorama form in Immunization and exports Inventory scans to CSV

### Installation

Use the approved Chrome Web Store listing for production installation. Chrome
manages updates for this path.

Manual GitHub deployment is an IT-managed fallback, subject to organizational
Chrome policies. Partner IT downloads an approved production ZIP from its GitHub
Release, verifies it, extracts it, and loads the folder through Chrome's **Load
unpacked** option. Manual deployments do not receive Chrome Web Store updates;
partner IT must deliberately install subsequent approved versions. See the
[release instructions](docs/RELEASING.md) for verification and historical
checksum availability.

For local development, load the unpacked extension:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `apps/extension`

First test VaxLink in the Panorama training environment with synthetic training
records. Reload supported Panorama tabs after installing or updating the extension.
Check Immunization on single provider-recorded and non-provider-recorded forms and on the multiple
immunizations grid and detail steps. Check Inventory and verify that a scan
held during lock stays available for review after unlock. Follow the
[workstation setup guide](docs/workstation-setup.md).

### Data update model

- Source: `https://nvc-cnv.canada.ca/fhir/v2/Bundle/NVC`
- VaxLink checks for updates every 24 hours.
- Choose **Recheck** in Settings to check sooner.
- If a check fails, VaxLink keeps using the catalogue it last downloaded successfully.

### Inventory

- Popup and hands-free inventory capture write to the `chrome.storage.local` queue key `inventory_scan_batch_v1`
- Detailed extension notes live in `apps/extension/README.md`

### Extension Checks

```bash
cd apps/extension-tests
npm test
```

The tests cover barcode reading, form entry in Panorama, tray order, repeated scans and Inventory exports.

### Release channels

`./scripts/package-extension.sh alpha|prod` builds the same channel ZIPs used
for Web Store upload and GitHub Releases, stamping the channel name at build
time. Production releases run from `main`; prereleases run from `alpha` for the
separate VaxLink Alpha listing. Store uploads remain manual. See the
[release process](docs/RELEASING.md).

## Notes

- Public access to NVC API does not automatically grant blanket redistribution rights for bundled terminology data. Keep raw bundle files out of public commits unless you have explicit permission.
- If Panorama changes its form markup, update the selectors in `apps/extension/content.js`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

## Documentation site

Architecture, the release process, and engineering
notes are published in the [PHIZ documentation hub](https://docs.phiz.ca/vaxlink/).
This repository owns the Markdown, navigation, Markdown extensions, and locked
build dependencies. `WDGPH/docs` owns the shared presentation and publication.

To check the documentation locally:

```bash
uv sync --locked --group docs
uv run --locked --group docs python -m mkdocs build --strict
uv run --locked --group docs python -m mkdocs serve
```

Open <http://127.0.0.1:8000/docs/vaxlink/latest/>. The local Material theme is
for source checks; the hub applies its shared theme when publishing.
The `docs.yml` workflow runs the strict check on pushes to `main` and `alpha`,
and on pull requests. It does not publish a separate site or write to `gh-pages`.

### Hub notifications and versions

The dedicated `docs-hub-notify.yml` workflow has no checkout or package build.
When `DOCS_HUB_NOTIFY_ENABLED` is true, it uses `DOCS_HUB_TRIGGER_TOKEN` only in
its notification step. Packaging jobs never receive the hub credential. Stable
releases created by release-please request reconciliation in a separate job.

Main pushes request `publish.yml` on hub `main` with
`source_repo=WDGPH/VaxLink` and `deploy=true`; the hub's deployment gate still
controls publication. Stable `vX.Y.Z` tag pushes and deletions request
`refresh-releases.yml` with the same source repository. Manual notification
requests both. Use **Notify documentation hub** on `main` if an automatic
request was missed.

The hub's `latest` manual follows `main`. Current and historical manuals use
release commits approved in the hub's `versions.lock.json`; a tag notification
proposes a reviewable update rather than publishing a new release immediately.
Documentation is available from `v1.1.2`; earlier tags have no MkDocs manual.
If an older tag is corrected or deleted, run **Notify documentation hub** on
`main`, review the resulting hub release-lock PR and its complete build, then
merge it. Do not replace historical Markdown with current pages.

## License

[MIT](LICENSE). The licence permits use, copying, modification and
redistribution when the copyright and licence notice is retained. It provides
the software "as is," without warranty, and limits the liability of its authors
and copyright holders. Separate pilot, MOU and support obligations are distinct
from the open-source licence.
