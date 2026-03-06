#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_FILE="${1:-$ROOT_DIR/apps/web/nvc-bundle.json}"
URL="https://nvc-cnv.canada.ca/fhir/v2/Bundle/NVC"

mkdir -p "$(dirname "$OUT_FILE")"

echo "Downloading NVC bundle..."
curl --request GET \
  --header "Accept: application/json+fhir" \
  --header "x-app-desc: PHAC NVC Client" \
  "$URL" \
  --output "$OUT_FILE"

echo "Saved bundle to: $OUT_FILE"

