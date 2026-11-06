# VaxLink

[![CI](https://github.com/WDGPH/VaxLink/actions/workflows/extension-ci.yml/badge.svg)](https://github.com/WDGPH/VaxLink/actions/workflows/extension-ci.yml)
[![Docs](https://img.shields.io/badge/docs-PHIZ-blue)](https://docs.phiz.ca/vaxlink/)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/WDGPH/VaxLink)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

VaxLink is a Chrome extension that parses GS1 vaccine barcodes and auto-fills
them into Ontario immunization EMRs (Panorama, InputHealth), with an
inventory management workflow for lot/expiry tracking. The extension
(`apps/extension`) is the main deliverable, supported by a MkDocs
documentation site.

- 📚 **Documentation:** <https://docs.phiz.ca/vaxlink/>
- 🧩 **Extension:** `apps/extension`

## Repository Layout

- `apps/extension` - Chrome extension (Manifest V3) — the main project
- `apps/extension-tests` - extension test suite (kept out of the Web Store zip)
- `scripts` - shell utilities (e.g. `fetch-nvc.sh`, `package-extension.sh`)
- `skills` - Claude Code skill definitions for common extension workflows
- `docs` - source for the MkDocs documentation site

## Extension (`apps/extension`)

### What it does

- Parses GS1 AIs from scanned strings (`01`, `10`, `17`, `21`)
- Looks up vaccine metadata from the NVC bundle
- Auto-fills CHR fields (trade name, manufacturer, route, dose, strength, DIN/drug code, lot, expiry) into Panorama and InputHealth
- Shows expiry state (`Expired`, `Expiring soon`, `Valid`)
- Detects hardware barcode scanners (keystroke-timing heuristics), plus a dedicated Web Serial scanner channel for capture while the workstation is locked
- Supports single-fill, multiple-inject queue, and full inventory (receive, FEFO board, reconciliation, lot quarantine) workflows, with CSV/JSON export

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
Check Single Inject, Multiple Inject, Inventory, and lock-screen capture/replay
before moving to production.

### Data update model

- Default source: `https://nvc-cnv.canada.ca/fhir/v2/Bundle/NVC`
- Auto-check every 24h (alarms)
- Manual refresh from popup
- Keeps the last-known-good catalogue if refresh fails

### Inventory

- Popup and hands-free inventory capture write to the `chrome.storage.local` queue key `inventory_scan_batch_v1`
- The full inventory operations page (`inventory-manager.html`) persists normalized items, transactions, and reconciliation snapshots in IndexedDB
- Detailed extension notes live in `apps/extension/README.md`

### Extension Checks

```bash
cd apps/extension-tests
npm test
```

This covers GS1 barcode parsing, Panorama/InputHealth autofill flows, multiple-inject queue ordering and dedup, and inventory export contracts.

### Release channels

`./scripts/package-extension.sh alpha|prod` builds the same channel ZIPs used
for Web Store upload and GitHub Releases, stamping the channel name at build
time. Production releases run from `main`; the separate Alpha listing and
packaging option remain available, but the `dev`-based automation is dormant. See the
[release process](docs/RELEASING.md).

## Notes

- Public access to NVC API does not automatically grant blanket redistribution rights for bundled terminology data. Keep raw bundle files out of public commits unless you have explicit permission.
- If CHR DOM changes, update selectors in `apps/extension/content.js`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

## Documentation site

Architecture, the EMR adapter contract, release process, and engineering
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
The `docs.yml` workflow runs the strict check on pushes and pull requests to
`main`. It does not publish a separate site or write to `gh-pages`.

### Hub notifications and versions

The dedicated `docs-hub-notify.yml` workflow has no checkout or package build.
When `DOCS_HUB_NOTIFY_ENABLED` is true, it uses `DOCS_HUB_TRIGGER_TOKEN` only in
its notification step. Packaging jobs never receive the hub credential. Stable
releases created by release-please request reconciliation in a separate job.

Main pushes request `publish.yml` on hub `main` with
`source_repo=WDGPH/VaxLink` and `deploy=true`; the hub's deployment gate still
controls publication. Stable `vX.Y.Z` tag pushes and deletions request
`refresh-releases.yml` with the same source repository. Manual notification
requests both. There is no polling schedule. Tags created by a workflow using
`GITHUB_TOKEN` may not trigger another workflow: after such a release, run
**Notify documentation hub** manually on `main`.

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
