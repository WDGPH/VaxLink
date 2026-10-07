# Contributing to VaxLink

## Repository Layout

- `apps/extension/` — Chrome extension (Manifest V3), no build step, plain JS
- `apps/extension-tests/` — extension test suite (kept outside `apps/extension/` so the Chrome Web Store zip stays clean)
- `scripts/` — shell utilities
- `skills/` — Claude Code skill definitions for common extension workflows

## Chrome Extension

Load `apps/extension/` as an unpacked extension in `chrome://extensions` with Developer mode on to test manually.

```bash
# Syntax check individual files
node --check apps/extension/content.js
node --check apps/extension/popup.js
node --check apps/extension/popup-inventory.js

# Run the automated test suite
cd apps/extension-tests && npm test
```

See `apps/extension/README.md` for the module breakdown and storage model.

## Panorama DOM Fixtures

**Never commit a live-session DOM capture.** Panorama and similar EMR pages can contain real patient data (name, client ID, address). If you need a fixture to test or debug a selector:

- Capture from a training/UAT environment only, never production.
- Sanitize to the minimal structural fragment you actually need (e.g. the specific `<select>`/`<input>` elements and their field IDs), not the full page.
- See `apps/extension-tests/panorama-reason-consent.test.js` for the pattern: inline HTML fragments embedded directly in the test, no fixture files on disk.

## Pull Requests

- Keep `manifest.json` identical across branches — the extension *name* is stamped by `scripts/package-extension.sh` at package time, never edited directly, so `dev` → `main` merges don't conflict. Only `version` is bumped in git.
- Run `npm test` for extension changes and `uv run mkdocs build --strict` for documentation changes before opening a PR.
