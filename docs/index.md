# VaxLink

[![Tests](https://img.shields.io/github/actions/workflow/status/WDGPH/VaxLink/extension-ci.yml?branch=main&label=tests&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOmlua3NjYXBlPSJodHRwOi8vd3d3Lmlua3NjYXBlLm9yZy9uYW1lc3BhY2VzL2lua3NjYXBlIiB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlIGRlc2MiPgo8dGl0bGUgaWQ9InRpdGxlIj5WYXhMaW5rIDE2IHB4IHRvb2xiYXIgdGlsZTwvdGl0bGU%2BCjxkZXNjIGlkPSJkZXNjIj5PcHRpY2FsbHkgc2ltcGxpZmllZCBmb3IgYnJvd3NlciBjaHJvbWUgaW4gbGlnaHQgYW5kIGRhcmsgdGhlbWVzLjwvZGVzYz4KPHJlY3QgaWQ9InRpbGUiIHg9IjAiIHk9IjAiIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgcng9IjMuNjUiIGZpbGw9IiMxMDJENDEiLz4KPHBhdGggaWQ9InNjYW4tY29ybmVycyIgZD0iTTIuNSA1LjRWNC4xNUMyLjUgMy4yNCAzLjI0IDIuNSA0LjE1IDIuNUg1LjRNMTAuNiAyLjVIMTEuODVDMTIuNzYgMi41IDEzLjUgMy4yNCAxMy41IDQuMTVWNS40TTIuNSAxMC42VjExLjg1QzIuNSAxMi43NiAzLjI0IDEzLjUgNC4xNSAxMy41SDUuNE0xMC42IDEzLjVIMTEuODVDMTIuNzYgMTMuNSAxMy41IDEyLjc2IDEzLjUgMTEuODVWMTAuNiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjRjhGQ0ZDIiBzdHJva2Utd2lkdGg9IjEuMjEiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8cmVjdCBpZD0idmlhbC1jYXAiIHg9IjUuMTUiIHk9IjMuNjUiIHdpZHRoPSI1LjciIGhlaWdodD0iMS43NSIgcng9IjAuNjUiIGZpbGw9IiNGOEZDRkMiLz4KPHJlY3QgaWQ9InZpYWwtYm9keSIgeD0iNC43NSIgeT0iNi42IiB3aWR0aD0iNi41IiBoZWlnaHQ9IjYuNCIgcng9IjEuNTUiIGZpbGw9IiNGOEZDRkMiLz4KPHBhdGggaWQ9ImNoZWNrIiBkPSJtNi41OCA5LjggMS4wMyAxLjA2IDEuODYgLTIuMTUiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzAwN0Y2MyIgc3Ryb2tlLXdpZHRoPSIxLjI4IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KPC9zdmc%2BCg%3D%3D)](https://github.com/WDGPH/VaxLink/actions/workflows/extension-ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/WDGPH/VaxLink/blob/main/LICENSE)

VaxLink is a Chrome extension that reads vaccine barcodes and helps staff
enter vaccine details in the open Panorama chart. Wellington-Dufferin-Guelph
Public Health built it.

VaxLink looks up product barcodes on the workstation. Privacy teams can trace what the clinic browser stores, what enters the clinical record and what staff can share in the [privacy assessment guide](privacy-assessment.md).

## What it does

- Reads the product code, lot, expiry date and optional serial number from vaccine barcodes
- Looks up vaccine information in the [National Vaccine Catalogue](https://nvc-cnv.canada.ca)
- Selects Panorama agent and lot, lets Panorama derive vaccine details, and
  fills enabled date/time, reason, and consent fields for staff review
- Flags expiry state (`Expired`, `Expiring soon`, `Valid`)
- Uses one Immunization tray for single forms and the Multiple Immunizations grid
- Saves Inventory scans to a separate tray with CSV export
- Keeps scans for review if automatic chart entry is uncertain
- Connects a scanner directly and offers an optional sample test

## Get started

First test VaxLink in the Panorama training environment using synthetic training
records. After installing or updating the extension, reload the training page
and open an immunization record. Check single forms, the Multiple Immunizations
grid and detail step, Inventory, and how held scans appear after unlock.

[Staff scanner guide](scanner-quick-guide.md) · [Workstation setup](workstation-setup.md)

In Settings, **Troubleshooting** keeps details for the current
browser session. It starts on in packaged Alpha and off in production and
development unless you save a different choice. Turning it off clears the
details. Local Activity counts are separate.

<div class="grid cards" markdown>

- :material-source-branch: **Architecture**

  ***

  How the scanner reader, background program, Panorama integration, and user
  controls work together, plus stored data and the autofill sequence.

  [:octicons-arrow-right-24: Architecture](architecture.md)

- :material-package-up: **Release process**

  ***

  How to prepare, check and submit Alpha and production releases.

  [:octicons-arrow-right-24: Release Process](RELEASING.md)

- :material-account-group: **Contributing**

  ***

  How to set up your development environment and use sample Panorama forms in tests.

  [:octicons-arrow-right-24: Contributing](contributing.md)

</div>

## Repository structure

```text
apps/extension/         Chrome extension (Manifest V3), no build step
apps/extension-tests/   Extension test suite (kept out of the packaged zip)
scripts/                Shell utilities (packaging, NVC bundle fetch)
skills/                 Agent guides for extension tasks
docs/                   This documentation site
```

## License

[MIT](https://github.com/WDGPH/VaxLink/blob/main/LICENSE)
