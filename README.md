# VaxLink

VaxLink contains:
- A Chrome extension for GS1 vaccine barcode parsing + CHR autofill
- A web app for NVC FHIR bundle exploration and barcode/lot lookup

## Repository Layout

- `apps/extension` - Chrome extension (Manifest V3)
- `apps/web` - Landing page + NVC explorer UI

## Extension (`apps/extension`)

### What it does

- Parses GS1 AIs from scanned strings (`01`, `10`, `17`, `21`)
- Looks up vaccine metadata from the NVC bundle
- Auto-fills CHR fields (trade name, manufacturer, route, dose, strength, DIN/drug code, lot, expiry)
- Shows expiry state (`Expired`, `Expiring soon`, `Valid`)

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

## Web App (`apps/web`)

Fetch a local bundle snapshot (kept out of Git):

```bash
./scripts/fetch-nvc.sh
```

Run locally:

```bash
cd apps/web
python3 -m http.server 8080
```

Pages:
- `http://localhost:8080/` -> landing page
- `http://localhost:8080/explorer.html` -> explorer + barcode parser
- `http://localhost:8080/extension.html` -> extension learn-more page

## Notes

- `apps/web/nvc-bundle.json` is a local snapshot for exploration and is ignored by Git.
- Public access to NVC API does not automatically grant blanket redistribution rights for bundled terminology data. Keep raw bundle files out of public commits unless you have explicit permission.
- If CHR DOM changes, update selectors in `apps/extension/content.js`.

## License

Internal use / private project.
