# Contributing to VaxLink

Coding agents should read [AGENTS.md](https://github.com/WDGPH/VaxLink/blob/alpha/AGENTS.md) for shared project guidance.

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

## Formatting

Install the formatter and enable the hooks once per clone:

```bash
npm ci
npm run setup:hooks
```

Format the files you changed, review them, then stage and commit:

```bash
npm run format -- apps/extension/popup.js
git add apps/extension/popup.js
git commit -m "fix: describe the change"
```

The pre-commit hook checks what you staged, including partially staged files.
Stage or restore changes to formatter settings before committing. Actions uses
the same rules to check files changed by a PR or push. Generated changelogs and
local catalogue snapshots are excluded.

If you already use a custom hooks path, setup leaves it alone. Add
`.githooks/pre-commit` and `.githooks/commit-msg` to your existing setup.

## Commit and pull request titles

Use Conventional Commit titles for local commits and pull requests. With squash
merging, the PR title becomes the commit subject that release-please reads.
For example, use `fix: preserve vaccine lot numbers`, `feat: add a workflow`, or
`ci: check release packaging`. An optional scope and `!` for breaking changes are
supported, such as `fix(scanner)!: change scan framing`.

Enable the local `commit-msg` hook once per clone (Node.js is required):

```bash
npm run setup:hooks
```

The hook rejects invalid commit subjects before Git creates the commit. Normal
merge commits keep Git's generated message. If you already use a custom hooks
path, integrate `.githooks/commit-msg` into your existing setup instead of
replacing it.

The **PR title / conventional-title** check applies the same rule to PR titles
and reruns when a title changes. Keep the conventional subject when confirming a
squash merge; local hooks do not run on GitHub. The CI check reports failures;
blocking a merge also depends on the repository's required-check settings.

`fix:` and `feat:` are release-worthy changes; maintenance titles such as `ci:`
and `docs:` remain valid without forcing a release. See the
[release process](https://github.com/WDGPH/VaxLink/blob/alpha/docs/RELEASING.md#commit-conventions).

## Pull Requests

- Let `scripts/package-extension.sh` set the extension name for each channel. Release-please manages versions separately on `alpha` and `main`; do not change them by hand.
- Run `npm test` for extension changes and `uv sync --locked --group docs` followed by `uv run --locked --group docs mkdocs build --strict` for documentation changes before opening a PR.

Documentation ownership and notification setup are described in the
[README](https://github.com/WDGPH/VaxLink#documentation-site). Keep source navigation and Markdown
extensions here; the documentation hub owns published styling and release URLs.
