# Contributing to VaxLink

Coding agents should read [AGENTS.md](https://github.com/WDGPH/VaxLink/blob/alpha/AGENTS.md) for shared project guidance.

## Repository Layout

- `apps/extension/` — Chrome extension (Manifest V3), no build step, plain JS
- `apps/extension-tests/` — extension test suite (kept outside `apps/extension/` so the Chrome Web Store zip stays clean)
- `scripts/` — shell utilities
- `docs/` — source for the staff and maintainer guides
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
- Run `npm test` for extension changes. Run the strict build below for documentation changes.

## Documentation

This repository owns the Markdown, navigation, Markdown extensions and locked
build dependencies. The PHIZ documentation hub in `WDGPH/docs` owns the published
theme and release URLs. [VaxLink documentation](https://docs.phiz.ca/vaxlink/)

Check and preview the docs locally:

```bash
uv sync --locked --group docs
uv run --locked --group docs python -m mkdocs build --strict
uv run --locked --group docs python -m mkdocs serve
```

Open the address printed by MkDocs. The local preview uses Material. The
`docs.yml` workflow runs the strict build on pushes to `main` and `alpha` and on
pull requests. The hub handles publication.

### Hub notifications and versions

Set `DOCS_HUB_NOTIFY_ENABLED` to `true` to enable notifications. Set
`DOCS_HUB_TRIGGER_TOKEN` to a GitHub token with Actions write access to
`WDGPH/docs`. Only notification steps use that token.

- Main pushes request the hub's `publish.yml` workflow for `WDGPH/VaxLink` with
  `deploy=true`. The hub's deployment gate still controls publication.
- Stable version tags added or deleted request the hub's `refresh-releases.yml`
  workflow. Release Please also requests it when it creates a stable release.
- Run **Notify documentation hub** on `main` if the automatic request was missed.
  The manual run requests both workflows.

The hub's latest manual follows `main`. Its `versions.lock.json` pins the
release commits used for versioned manuals. When an older stable tag is
corrected or deleted, run **Notify documentation hub** on `main`, then review the
hub's release-lock PR and build. Keep historical manuals tied to their release
sources. The first release with a MkDocs manual was `v1.1.2`.
