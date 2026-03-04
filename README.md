# VaxLink (Chrome Extension)

VaxLink is a Chrome extension for scanning/parsing GS1 vaccine barcodes and auto-filling CHR injection fields.

## What It Does

- Parses GS1 AIs from scanned strings:
  - `01` GTIN
  - `17` Expiry
  - `10` Lot
  - `21` Serial
- Looks up vaccine metadata from the National Vaccine Catalogue (NVC).
- Auto-fills CHR form fields such as trade name, manufacturer, route, dose, strength, DIN/drug code, and lot/expiry.
- Shows expiry warnings:
  - `Expired`
  - `Expiring soon`
  - `Valid`

## Project Structure

This repository is intentionally extension-only:

- `VaccineScannerExtension/manifest.json`
- `VaccineScannerExtension/popup.html`
- `VaccineScannerExtension/popup.js`
- `VaccineScannerExtension/background.js`
- `VaccineScannerExtension/content.js`
- `VaccineScannerExtension/.gitignore`

## Install (Developer Mode)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `VaccineScannerExtension`

## Usage

1. Open your CHR page.
2. Click the VaxLink extension icon.
3. Paste or scan a GS1 barcode.
4. Click **Parse Barcode**.
5. Click **Auto-fill CHR**.
6. Optional: click **Refresh NVC Data** to pull latest NVC bundle.

## NVC Data Updates

- Default source: `https://nvc-cnv.canada.ca/fhir/v2/Bundle/NVC`
- Auto-check: every 24 hours (background alarm)
- Manual check: **Refresh NVC Data** button
- Safety: last known good bundle is kept if refresh fails
- Change detection: SHA-256 hash of downloaded bundle payload

## Local Bundle File (`nvc_bundle.json`)

`VaccineScannerExtension/nvc_bundle.json` is used as local/offline fallback.

This file is intentionally **ignored from Git** (local only), so each developer can keep a local copy without pushing it.

If missing, the extension can still work after a successful online NVC refresh.

## Notes

- Chrome popup outer frame is controlled by Chrome and remains rectangular; only inner UI is styleable.
- If auto-fill misses a field due to DOM changes in CHR, update selectors in `content.js`.

## License

Internal use / private project.
