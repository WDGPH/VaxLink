# NVC FHIR Bundle Explorer

Small browser app to inspect the NVC FHIR bundle.

## 1) Download the bundle (recommended)

From repository root:

```bash
./scripts/fetch-nvc.sh
```

This writes `apps/web/nvc-bundle.json`.

## 1b) Direct curl alternative

```bash
curl --request GET \
  --header "Accept: application/json+fhir" \
  --header "x-app-desc: PHAC NVC Client" \
  https://nvc-cnv.canada.ca/fhir/v2/Bundle/NVC \
  -o nvc-bundle.json
```

## 2) Run the app locally

From this folder:

```bash
python3 -m http.server 8080
```

Open: `http://localhost:8080`

Pages:
- `http://localhost:8080/` -> landing page
- `http://localhost:8080/explorer.html` -> full data explorer
- `http://localhost:8080/extension.html` -> browser extension learn-more page

## 3) What the app does

- Loads `nvc-bundle.json` by default
- Supports remote refresh from API using fetch + required headers
- Shows resource list, type counts, search, filter, and full JSON viewer
- Includes barcode/AI parsing for lot lookup (AI `10`, `17`, `01`, `21`, plus `LOT`/`BATCH`/`EXP`/`DIN` labels)

## Data publishing note

- `nvc-bundle.json` is intended as a local runtime file and is ignored by Git.
- For public repositories, publish code and fetch scripts, not raw bundle snapshots.

## JavaScript fetch example

```js
const response = await fetch("https://nvc-cnv.canada.ca/fhir/v2/Bundle/NVC", {
  headers: {
    Accept: "application/json+fhir",
    "x-app-desc": "PHAC NVC Client",
  },
});

const bundle = await response.json();
console.log(bundle);
```
