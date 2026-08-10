#!/usr/bin/env bash
# Package the Chrome extension for a release channel.
#
#   ./scripts/package-extension.sh alpha   -> dist/vaxlink-alpha-<version>.zip  (name: "VaxLink Alpha")
#   ./scripts/package-extension.sh prod    -> dist/vaxlink-prod-<version>.zip   (name: "VaxLink")
#
# The channel identity (extension name) is stamped HERE, not stored as a
# branch difference — manifest.json must stay identical on dev and main so
# merges never conflict on it. Version flows through git normally.

set -euo pipefail

CHANNEL="${1:-alpha}"
if [[ "$CHANNEL" != "alpha" && "$CHANNEL" != "prod" ]]; then
  echo "Usage: $0 [alpha|prod]" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHANNEL="$CHANNEL" ROOT="$ROOT" python3 - <<'PY'
import json, os, shutil, tempfile, zipfile

channel = os.environ["CHANNEL"]
root = os.environ["ROOT"]
src = os.path.join(root, "apps", "extension")
dist = os.path.join(root, "dist")

# Files that must never ship in a Web Store upload.
EXCLUDE = {".claude", ".gitignore", "README.md"}

staging = tempfile.mkdtemp(prefix="vaxlink-pkg-")
try:
    ext = os.path.join(staging, "ext")
    shutil.copytree(src, ext, ignore=lambda d, names: [n for n in names if n in EXCLUDE])

    manifest_path = os.path.join(ext, "manifest.json")
    with open(manifest_path) as f:
        manifest = json.load(f)
    with open(os.path.join(root, "package.json")) as f:
        package_version = str(json.load(f).get("version") or manifest["version"])

    manifest["name"] = "VaxLink" if channel == "prod" else "VaxLink Alpha"
    # Chrome's manifest `version` cannot contain a prerelease suffix. Release
    # Please may set package.json to e.g. 1.2.0-alpha.1 on dev, so package the
    # numeric base in manifest.version while retaining the full prerelease in
    # version_name for the alpha channel.
    version = package_version.split("-", 1)[0]
    manifest["version"] = version
    manifest["version_name"] = version if channel == "prod" else package_version
    if channel == "alpha" and "-" not in package_version:
        manifest["version_name"] = f"{version}-alpha"

    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    os.makedirs(dist, exist_ok=True)
    out = os.path.join(dist, f"vaxlink-{channel}-{version}.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for dirpath, dirnames, filenames in os.walk(ext):
            for name in sorted(filenames):
                full = os.path.join(dirpath, name)
                zf.write(full, os.path.relpath(full, ext))

    print(f"channel : {channel}")
    print(f"name    : {manifest['name']}")
    print(f"version : {manifest['version_name']}")
    print(f"zip     : {os.path.relpath(out, root)}")
finally:
    shutil.rmtree(staging, ignore_errors=True)
PY
