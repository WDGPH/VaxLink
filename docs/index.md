# VaxLink

A Chrome extension that parses GS1 vaccine barcodes and auto-fills them into
Ontario immunization EMRs (Panorama, InputHealth), plus the Next.js marketing
site at [vaxlink.ca](https://vaxlink.ca). Built by Wellington-Dufferin-Guelph
Public Health.

!!! info "Client-side by design"
    Scanned barcode data is parsed locally in the browser and never sent to a
    server VaxLink controls. The only outbound call is fetching the public NVC
    vaccine metadata bundle. See the [Security Policy](security.md) for the
    full data-handling model.

## What it does

- Parses GS1 Application Identifiers (`01`, `10`, `17`, `21`) from scanned
  barcode strings
- Looks up vaccine metadata from the [NVC](https://nvc-cnv.canada.ca) FHIR
  bundle
- Auto-fills CHR fields — trade name, manufacturer, route, dose, strength,
  DIN/drug code, lot, expiry
- Flags expiry state (`Expired`, `Expiring soon`, `Valid`)
- Supports single, multiple, and inventory scan workflows with CSV export

## Get started

<div class="grid cards" markdown>

- :material-source-branch: **Architecture**

    ---

    The three extension execution contexts, key storage schema, and the
    Panorama autofill sequence.

    [:octicons-arrow-right-24: Architecture](architecture.md)

- :material-puzzle-plus: **Adding a new EMR**

    ---

    How the platform registry works and what a new adapter profile needs
    before it can ship.

    [:octicons-arrow-right-24: Adding a New EMR](adding-an-emr.md)

- :material-package-up: **Release process**

    ---

    Alpha vs. prod channels, versioning, and how `package-extension.sh`
    stamps channel identity at build time.

    [:octicons-arrow-right-24: Release Process](RELEASING.md)

- :material-map: **Roadmap**

    ---

    The planned platform-registry refactor and the backlog beyond it.

    [:octicons-arrow-right-24: Roadmap](roadmap.md)

- :material-account-group: **Contributing**

    ---

    Repository layout, local dev setup, and the rules around Panorama DOM
    fixtures.

    [:octicons-arrow-right-24: Contributing](contributing.md)

</div>

## Repository structure

```text
apps/extension/         Chrome extension (Manifest V3), no build step
apps/extension-tests/   Extension test suite (kept out of the packaged zip)
apps/web-next/          Next.js marketing site, deployed to GitHub Pages
scripts/                Shell utilities (packaging, NVC bundle fetch)
skills/                 Claude Code skill definitions for extension workflows
docs/                   This documentation site
```

## License

[MIT](https://github.com/WDGPH/VaxLink/blob/main/LICENSE)
