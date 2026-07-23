# VaxLink

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
- Supports popup inventory trays plus a full inventory operations page for receiving, FEFO review, reconciliation, incident logging, wastage, and export handoff

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

### Inventory Architecture

- Popup and hands-free inventory capture still write to the legacy `chrome.storage.local` queue key `inventory_scan_batch_v1`
- The inventory manager page now uses a normalized IndexedDB-backed data layer for items, transactions, incidents, reconciliation sign-offs, and lot quarantine flags
- The page mirrors the legacy queue key for compatibility with popup inventory mode and content-script inventory capture
- Detailed extension notes live in `apps/extension/README.md`

### Extension Checks

```bash
cd apps/extension
npm test
```

This covers FEFO ordering, dose consumption, reconciliation math, and inventory export contracts.

## Notes

- Public access to NVC API does not automatically grant blanket redistribution rights for bundled terminology data. Keep raw bundle files out of public commits unless you have explicit permission.
- If CHR DOM changes, update selectors in `apps/extension/content.js`.
- Inventory manager operational data now lives in IndexedDB; popup trays and lightweight settings still live in `chrome.storage.local`.

## License

Internal use / private project.
