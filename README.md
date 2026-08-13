# VaxLink

[![CI](https://github.com/WDGPH/VaxLink/actions/workflows/extension-ci.yml/badge.svg)](https://github.com/WDGPH/VaxLink/actions/workflows/extension-ci.yml)
[![docs](https://github.com/WDGPH/VaxLink/actions/workflows/docs.yml/badge.svg)](https://github.com/WDGPH/VaxLink/actions/workflows/docs.yml)
[![Docs site](https://img.shields.io/badge/docs-wdgph.github.io%2FVaxLink-blue)](https://wdgph.github.io/VaxLink/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

VaxLink is a Chrome extension that parses GS1 vaccine barcodes and auto-fills
them into Ontario immunization EMRs (Panorama, InputHealth), with an
inventory management workflow for lot/expiry tracking. The repo also has a
small Next.js marketing site and a MkDocs documentation site, but the
extension (`apps/extension`) is the main deliverable.

- 📚 **Documentation:** <https://wdgph.github.io/VaxLink/>
- 🧩 **Extension:** `apps/extension`

## Repository Layout

- `apps/extension` - Chrome extension (Manifest V3) — the main project
- `apps/extension-tests` - extension test suite (kept out of the Web Store zip)
- `apps/web-next` - Next.js marketing site (Pages deploy currently superseded by the docs site, see below)
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
- The full inventory operations page (`inventory-manager.html`) persists normalized items, transactions, and reconciliation snapshots in IndexedDB
- Detailed extension notes live in `apps/extension/README.md`

### Extension Checks

```bash
cd apps/extension-tests
npm test
```

This covers GS1 barcode parsing, Panorama/InputHealth autofill flows, multiple-inject queue ordering and dedup, and inventory export contracts.

### Release channels

`./scripts/package-extension.sh alpha|prod` packages the extension for the
Chrome Web Store, stamping the channel name at build time (`dev` → VaxLink
Alpha, `main` → VaxLink). See `CLAUDE.md` for the full build/release
reference.

## Marketing site (`apps/web-next`)

A small Next.js landing page for VaxLink. `.github/workflows/deploy-web-next-pages.yml`
builds and deploys it to GitHub Pages on every push to `main`, but see the
[Documentation site](#documentation-site) section below — it currently loses
the shared Pages slot to the docs site. See `content/site.ts` for the site
copy.

```bash
cd apps/web-next
npm ci
npm run dev
```

## Notes

- Public access to NVC API does not automatically grant blanket redistribution rights for bundled terminology data. Keep raw bundle files out of public commits unless you have explicit permission.
- If CHR DOM changes, update selectors in `apps/extension/content.js`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

## Documentation site

Architecture, the EMR adapter contract, release process, and engineering
notes are published as a [MkDocs](https://www.mkdocs.org/) site
([Material theme](https://squidfunk.github.io/mkdocs-material/)) at
**<https://wdgph.github.io/VaxLink/>**.

To build it locally:

```bash
uv sync --group docs
uv run mkdocs serve
```

Open <http://127.0.0.1:8000>.

The `docs` workflow (`.github/workflows/docs.yml`) builds the site on every
push to `main` and publishes it to the `gh-pages` branch. **This is
currently the live Pages source for the repo** (confirmed via
`gh api repos/WDGPH/VaxLink/pages`: `build_type: legacy`, `source.branch:
gh-pages`) — a GitHub repo can only serve one Pages source at a time, and a
`docs.yml` run after a `deploy-web-next-pages.yml` run flips it back to the
branch-based docs deployment. In practice this means `apps/web-next`'s own
Pages workflow succeeds as an Actions run but its output isn't what's
actually served at the Pages URL; the docs site "wins."

## License

[MIT](LICENSE)
