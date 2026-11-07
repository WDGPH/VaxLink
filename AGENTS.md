# Agent guidance

This is the shared repository guidance for Codex, Claude, and other coding agents.
Keep project rules here rather than in separate files for each harness. Configure
any harness that does not discover `AGENTS.md` to read this file.

## Working with the user

- Work deliberately. Do the agreed work without rushing into the next task,
  broadening the scope, or treating passing checks as permission to publish.
- **Never merge your own PRs or enable auto-merge for them.** Leave merging to
  the user or another maintainer. Do not bypass review by pushing the changes
  directly to `alpha` or `main`.
- Implementation, checks, commits, pushes, releases, and Store submissions are
  separate steps. Complete authorized work without repeatedly asking about
  routine actions. Follow the user's release instructions separately.
- Commit small, coherent changes as you go. Keep each PR easy to understand and
  review. Prefer a direct fix and existing helpers over new frameworks or layers.
- Keep unrelated findings separate. Explain the issue and its impact before
  expanding a cleanup into a larger change.
- Keep updates brief: what changed, what matters, and what needs user input.

## Writing and PR descriptions

- Use the user's direct writing style: familiar words, short sentences, and
  concrete instructions. Apply this to comments, documentation, commit messages,
  and PR descriptions. Keep technical names where they help the reader.
- Start a PR description with the problem and resulting behavior. One or two
  short paragraphs are usually enough.
- **Do not automatically add validation reports, test counts, temporary test
  stories, agent names, review sign-offs, or process footers to PR descriptions.**
  This includes phrases about leaving a PR open for maintainer review or not
  adding a test framework. Keep check results and agent-review details in chat
  or CI unless the user asks for them in the PR description.
- Use Conventional Commit titles. Describe the change in plain language.

## Tests and reviews

- Keep tests proportionate to the change. Use existing tests, fixtures, and
  production functions. Add a focused test when it covers a meaningful failure
  or behavior that the existing checks miss.
- Do not add tests just for documentation edits, unused-function removal, or
  other low-impact cleanup. Avoid a new test framework or broad harness for a
  small change.
- Use controlled promises for asynchronous tests rather than arbitrary sleeps.
- Run the checks required for the change. Repeat or broaden them when a new
  change, failure, or unresolved concern warrants it.
- Separate code, package, and CI evidence from browser, scanner, Store, and live
  clinic validation. Do not claim the latter from automated checks alone.
- Get a critical review from Astra for each PR's changes before pushing. Address
  meaningful findings and recheck the affected work. If Astra is unavailable,
  report that rather than silently substituting another reviewer.

## Delegation

- Use subagents when requested or when applicable project instructions call for
  them. Give each agent a bounded task and avoid overlapping edits.
- For requested parallel cleanup passes, use Terra agents to inspect distinct
  areas and report concrete findings first. Review those findings before making
  broader changes. Keep proven issues separate from guesses and style preferences.
- Keep agent coordination and review reports out of PR descriptions.

## Development checks

Install the locked tools and enable the hooks once per clone:

```bash
npm ci
npm run setup:hooks
```

Format the files you changed, review them, and stage them before committing:

```bash
npm run format -- path/to/file
git add path/to/file
npm run format:check
```

The pre-commit check reads staged contents. Stage or restore changes to formatter
settings first. Hook setup preserves an existing custom hooks path; see
`CONTRIBUTING.md` for adding the hooks to that setup.

For documentation changes, run the strict documentation build:

```bash
uv run --locked --group docs python -m mkdocs build --strict
```

## Repository Layout

| Path                    | What it is                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `apps/extension/`       | Chrome extension (Manifest V3) — no build step, plain JS                                      |
| `apps/extension-tests/` | Extension test suite (kept outside `apps/extension/` so the Chrome Web Store zip stays clean) |
| `scripts/`              | Shell utilities (e.g. `fetch-nvc.sh` to download NVC bundle locally)                          |
| `skills/`               | Task guides for common extension workflows                                                    |

## Commands

### Chrome Extension (`apps/extension`)

```bash
# Syntax check individual files (no test runner needed)
node --check apps/extension/content.js
node --check apps/extension/popup.js
node --check apps/extension/popup-inventory.js

# Run automated tests (suite lives in apps/extension-tests/, outside the packaged extension)
cd apps/extension-tests && npm test     # or `npm test` from the repo root
```

Install for manual testing: load `apps/extension/` as an unpacked extension in `chrome://extensions` with Developer mode on.

```bash
# Package for the Chrome Web Store (stamps channel identity at build time)
./scripts/package-extension.sh alpha   # dist/vaxlink-alpha-<v>.zip, name "VaxLink Alpha"
./scripts/package-extension.sh prod    # dist/vaxlink-prod-<v>.zip,  name "VaxLink"
```

Production releases run from `main` and prereleases from `alpha` through release-please, with separate VaxLink and VaxLink Alpha listings. Store uploads remain manual. The extension name is stamped by the package script; release-please owns version changes. See `docs/RELEASING.md`.

## Extension Architecture

The extension has three execution contexts that communicate via `chrome.runtime.sendMessage` and `chrome.storage.local`:

**`background.js`** — service worker. Owns:

- NVC FHIR bundle fetch, indexing, and 24-hour auto-refresh (`nvc-auto-sync` alarm)
- Lot lookup with GTIN-based product selection (`lookupVaccineInfo`)
- Analytics event log (`vaxlink_analytics_v1`)
- Multiple-inject queue append helpers
- Action icon and badge management

**`content.js`** — injected into Panorama and InputHealth pages. Owns:

- Receives Web Serial scans on supported pages
- HUD overlay on supported pages
- EMR-specific autofill dispatch (`autoFillTelus` → Panorama or generic fill)
- Workflow mode reading from `chrome.storage.local`

**`popup.js` + `popup-inventory.js` + `popup-ui.js`** — popup window. Owns:

- Manual scan input and parse (`popup-parser.js` for GS1 AI parsing)
- Workflow mode switching (single / multiple / inventory)
- Inventory tray UI, CSV export, and storage via `popup-inventory.js`
- Sending fill payloads to content script via `chrome.tabs.sendMessage`

**`panorama-agent-rules.js`** — loaded before `content.js` as a content script. Contains heuristics for matching scanned lot/GTIN to a Panorama agent dropdown option.

**`queue-record.js`** — shared row normalization for inventory CSV export. Keeps the exported column shape stable for downstream tools.

### Key Storage Keys

| Key                        | Owner           | Purpose                      |
| -------------------------- | --------------- | ---------------------------- |
| `multiple_inject_queue_v1` | popup + content | Active multiple-inject queue |
| `inventory_scan_batch_v1`  | popup + content | Legacy inventory batch queue |
| `nvc_bundle_override`      | background      | Cached NVC FHIR bundle       |
| `vaxlink_workflow_mode_v1` | popup           | Current workflow mode        |
| `vaxlink_analytics_v1`     | background      | Fill event log               |

### Panorama Autofill Sequence

Fill order must be: `agent → lot → (deferred) date/time`. Panorama auto-populates dependent fields (trade name, route, dose, manufacturer) after lot selection. Write the lot and deferred date/time only when `!isPrimeFacesAjaxBusy()`. Lot matching uses `normalizePanoramaLotToken` to handle formats like `LOT123 - Exp. ...`. Panorama uses misspelled IDs (e.g. `dateAdministedDate`) — keep those as-is.

### Adding a New EMR

The ROADMAP describes a planned platform registry refactor. Until that lands, new platforms are added to `content.js` by extending `isHandsFreeSupportedPage()` and `autoFillTelus()`. See `skills/vaxlink-emr-adaptation/SKILL.md` for the adapter contract.

## CI

GitHub Actions:

- `.github/workflows/formatting.yml` — checks changed files with the same Prettier rules used by the pre-commit hook.
- `.github/workflows/extension-ci.yml` — checks syntax and runs tests for
  extension changes in PRs and pushes to `alpha`/`main`. Tests that need the live
  catalogue skip if it cannot be downloaded. Uploads Alpha ZIPs for prereleases
  and both channel ZIPs for stable versions. Web Store uploads are manual.
- `.github/workflows/docs.yml` — runs the locked, strict MkDocs documentation check on pushes to `main`/`alpha` and on PRs; it does not publish.
- `.github/workflows/docs-hub-notify.yml` — opt-in notifications to `WDGPH/docs` for main and stable-tag changes. See `README.md` for token setup and historical release reconciliation.

## Important Constraints

- `apps/extension/nvc_bundle.json` is in `.gitignore` — never commit raw NVC bundle files.
- If Panorama DOM changes, update selectors in `apps/extension/content.js`. Capture a fresh DOM snapshot locally to diff against (do not commit live-session captures — they can contain real patient data; sanitize to structural fragments only, as done in `apps/extension-tests/panorama-reason-consent.test.js`).
- The extension has no build step — files are loaded directly by Chrome. No bundler, no transpilation.
- `apps/extension-tests/` uses Node.js built-in `node:test` runner (no Jest/Vitest). Tests must stay outside `apps/extension/` so they are never packaged into the Chrome Web Store upload.
- The repo-root `package.json` exists to mark the tree `"type": "module"` so Node parses the extension's ESM sources correctly in tests — don't delete it.
