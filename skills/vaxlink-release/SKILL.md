---
name: vaxlink-release
description: Ship a new VaxLink extension release. Use when bumping the extension version, preparing a release, fixing the CI release workflow, or troubleshooting Chrome Web Store upload failures in `.github/workflows/release-extension.yml`.
---

# VaxLink Release

## How a release works

1. Bump `"version"` and `"version_name"` in `apps/extension/manifest.json`.
2. Push to `main` with `apps/extension/` changes included.
3. GitHub Actions (`.github/workflows/release-extension.yml`) runs automatically:
   - Reads the version from `manifest.json`
   - Skips silently if a GitHub Release for that tag already exists
   - Runs `npm test` in `apps/extension/` — blocks release on failure
   - Builds a lean zip (runtime files only)
   - Uploads zip to Chrome Web Store as a **draft** (not submitted)
   - Creates a GitHub Release tagged `vX.Y.Z` with zip attached
4. Log into the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole) and click **Publish** to go live.

## Version bump

Both fields must match and follow Chrome's `MAJOR.MINOR.PATCH` format:

```json
"version": "1.0.1",
"version_name": "1.0.1"
```

Chrome requires `version` to be numeric only. `version_name` can be a display string but keep them in sync.

## Zip contents

The release zip includes only runtime files:

```
manifest.json, background.js, content.js, popup.html, popup.js,
popup-inventory.js, popup-parser.js, popup-ui.js, queue-record.js,
panorama-agent-rules.js, assets/
```

Excluded: `tests/`, `README.md`, `.gitignore`, `session-batch-preview.html`, `package.json`.

## Required GitHub secrets

All four must be set under **Settings → Secrets and variables → Actions**:

| Secret | How to get it |
|---|---|
| `CHROME_EXTENSION_ID` | Last path segment of the Web Store URL |
| `CHROME_CLIENT_ID` | Google Cloud Console → APIs & Services → OAuth 2.0 client |
| `CHROME_CLIENT_SECRET` | Same OAuth client |
| `CHROME_REFRESH_TOKEN` | Run `npx chrome-webstore-upload-cli@latest init` once locally |

## Troubleshooting

- **Workflow skipped entirely** — `apps/extension/` files were not in the push. Only commits touching `apps/extension/**` trigger this workflow.
- **Workflow exits early with "release already exists"** — the version in `manifest.json` was not bumped. Bump the version and push again.
- **Tests fail** — fix the failing test before releasing. Run `cd apps/extension && npm test` locally.
- **Chrome Web Store upload fails** — check that all four secrets are set and the refresh token has not expired. Re-run `npx chrome-webstore-upload-cli@latest init` to get a new refresh token.
- **Upload succeeds but store shows old version** — the upload is a draft. Go to the developer dashboard and click **Publish**.
