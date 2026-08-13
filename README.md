# VaxLink

[![CI](https://github.com/WDGPH/VaxLink/actions/workflows/extension-ci.yml/badge.svg)](https://github.com/WDGPH/VaxLink/actions/workflows/extension-ci.yml)
[![docs](https://github.com/WDGPH/VaxLink/actions/workflows/docs.yml/badge.svg)](https://github.com/WDGPH/VaxLink/actions/workflows/docs.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

VaxLink contains:
- A Chrome extension for GS1 vaccine barcode parsing + CHR autofill
- A Next.js marketing site (`apps/web-next`)

## Repository Layout

- `apps/extension` - Chrome extension (Manifest V3)
- `apps/web-next` - Next.js marketing site, deployed to GitHub Pages

## Extension (`apps/extension`)

### What it does

- Parses GS1 AIs from scanned strings (`01`, `10`, `17`, `21`)
- Looks up vaccine metadata from the NVC bundle
- Auto-fills CHR fields (trade name, manufacturer, route, dose, strength, DIN/drug code, lot, expiry)
- Shows expiry state (`Expired`, `Expiring soon`, `Valid`)
- Supports popup inventory trays with CSV export

### Install (Developer Mode)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `apps/extension`

### Data update model

- Default source: `https://nvc-cnv.canada.ca/fhir/v2/Bundle/NVC`
- Auto-check every 24h (alarms)
- Manual refresh from popup
- Keeps last-known-good bundle if refresh fails

### Inventory

- Popup and hands-free inventory capture write to the `chrome.storage.local` queue key `inventory_scan_batch_v1`
- Detailed extension notes live in `apps/extension/README.md`

### Extension Checks

```bash
cd apps/extension-tests
npm test
```

This covers GS1 barcode parsing, Panorama/InputHealth autofill flows, multiple-inject queue ordering and dedup, and inventory export contracts.

## Notes

- Public access to NVC API does not automatically grant blanket redistribution rights for bundled terminology data. Keep raw bundle files out of public commits unless you have explicit permission.
- If CHR DOM changes, update selectors in `apps/extension/content.js`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

## Documentation site

Architecture, the EMR adapter contract, release process, and engineering
notes are published as a [MkDocs](https://www.mkdocs.org/) site
([Material theme](https://squidfunk.github.io/mkdocs-material/)), built from
this README and the other project markdown files.

```bash
uv sync --group docs
uv run mkdocs serve
```

Open <http://127.0.0.1:8000>.

The `docs` workflow (`.github/workflows/docs.yml`) builds the site on every
push to `main` and publishes it to the `gh-pages` branch. GitHub Pages can
only serve one source per repo, and this repo's Pages site is currently
configured to deploy `apps/web-next` via GitHub Actions
(`deploy-web-next-pages.yml`) — enabling the docs site as-is means picking
one of the two as the live Pages deployment, or merging the mkdocs build
into the `apps/web-next` static export before it's uploaded.

## License

[MIT](LICENSE)
