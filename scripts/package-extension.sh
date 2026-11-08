#!/usr/bin/env bash
# Package the Chrome extension for a release channel.
#
#   ./scripts/package-extension.sh alpha   -> dist/vaxlink-alpha-<version>.zip  (name: "VaxLink Alpha")
#   ./scripts/package-extension.sh prod    -> dist/vaxlink-prod-<version>.zip   (name: "VaxLink")
#
# The channel identity (extension name) is stamped HERE, not stored as a
# branch difference. Release Please owns version changes on main and alpha.

set -euo pipefail

CHANNEL="${1:-alpha}"
if [[ "$CHANNEL" != "alpha" && "$CHANNEL" != "prod" ]]; then
  echo "Usage: $0 [alpha|prod]" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHANNEL="$CHANNEL" ROOT="$ROOT" python3 - <<'PY'
import hashlib, json, os, re, shutil, tempfile, zipfile
from pathlib import Path

channel = os.environ["CHANNEL"]
root = os.environ["ROOT"]
src = os.path.join(root, "apps", "extension")
dist = os.path.join(root, "dist")

# Files that must never ship in a Web Store upload.
EXCLUDE = {".claude", ".gitignore", "README.md", "nvc_bundle.json",
           "node_modules", "__pycache__", "tests", "test", "__tests__",
           "fixtures", ".DS_Store"}

staging = tempfile.mkdtemp(prefix="vaxlink-pkg-")
try:
    ext = os.path.join(staging, "ext")
    shutil.copytree(src, ext, ignore=lambda d, names: [n for n in names
        if n in EXCLUDE or n.endswith((".test.js", ".spec.js"))])

    manifest_path = os.path.join(ext, "manifest.json")
    with open(manifest_path) as f:
        manifest = json.load(f)
    with open(os.path.join(root, "package.json")) as f:
        package_version = str(json.load(f).get("version") or manifest["version"])

    manifest["name"] = "VaxLink" if channel == "prod" else "VaxLink Alpha"
    # Keep the prerelease sequence in Chrome's numeric version so successive
    # Alpha uploads can update the same listing. The initial -alpha is sequence 0.
    match = re.fullmatch(r"(\d+\.\d+\.\d+)(?:-alpha(?:\.(\d+))?)?", package_version)
    if not match:
        raise ValueError(f"Unsupported package version: {package_version}")
    version = match.group(1)
    prerelease = "-" in package_version
    if channel == "prod" and prerelease:
        raise ValueError("Production packages require a stable package version")
    manifest["version"] = f"{version}.{int(match.group(2) or 0)}" if prerelease else version
    manifest["version_name"] = package_version if prerelease or channel == "prod" else f"{version}-alpha"
    if any(int(part) > 65535 for part in manifest["version"].split(".")):
        raise ValueError("Chrome version components must not exceed 65535")

    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    # Identify the actual staged runtime once, after channel identity is stamped.
    fingerprint = hashlib.sha256()
    for path in sorted(Path(ext).rglob("*"), key=lambda p: p.relative_to(ext).as_posix()):
        if not path.is_file() or path.name == "build-info.js":
            continue
        fingerprint.update(path.relative_to(ext).as_posix().encode("utf-8") + b"\0")
        fingerprint.update(path.read_bytes() + b"\0")
    Path(ext, "build-info.js").write_text(
        "globalThis.VAXLINK_BUILD_ID = " + json.dumps(fingerprint.hexdigest()) + ";\n"
    )

    os.makedirs(dist, exist_ok=True)
    out = os.path.join(dist, f"vaxlink-{channel}-{package_version}.zip")
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
