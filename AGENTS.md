# Agent guidance

This is the shared repository guidance for all coding agents.
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

## Change size and clinical safety

- Prefer PRs under 500 changed lines. Count additions plus deletions, including
  tests, against the PR's intended base. At 750 lines, explicitly reconsider
  scope. Treat 1,000 lines as a soft ceiling, not a target.
- Optimize for conceptual simplicity. Split work by understandable behavior,
  not just line count. Do not weaken an essential clinical safety guarantee
  solely to meet a numeric target.
- State the concrete failure and the smallest safety rule that prevents it
  before adding machinery. Prefer direct JavaScript and a few clear invariants
  over speculative abstractions, generalized transaction protocols, or broad
  diagnostic systems.
- Add persistent warnings, recovery states, or completion-verification machinery
  only for a demonstrated failure with a clear benefit. Acknowledge unavoidable
  uncertainty without implying that the browser can prove a saved clinical state.
- Check cancellation after waiting and before meaningful changes to page fields.
  Additional checks within synchronous code need a reason, such as a field event
  running page code that can replace the form. Avoid repeated checks between
  ordinary calculations.
- When a clean rewrite is requested, use the earlier implementation to discover
  requirements and failure modes, not as a structure to preserve. Keep superseded
  work available until the replacement is reviewed and its requirements accounted for.

## Writing and PR descriptions

- Use the user's direct writing style: familiar words, short sentences, and
  concrete instructions. Apply this to comments, documentation, commit messages,
  and PR descriptions. Keep technical names where they help the reader.
- Explain non-obvious safety and ordering decisions for a reader unfamiliar
  with JavaScript or the framework. State why the safeguard exists and what
  could go wrong without it. Introduce unfamiliar terms when needed; avoid
  comments that merely repeat the code.
- Keep private planning and unvalidated future designs out of implementation
  PRs and their public comments, commit messages, and documentation. Describe
  implemented behavior and verified limitations.
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
- Prefer one representative test per failure class, with table-driven variations
  where useful. Test externally meaningful behavior or a safety invariant rather
  than every internal state transition. Justify larger test suites by the distinct
  risks they protect, and avoid another generalized mock browser or DOM framework.
- Do not add tests just for documentation edits, unused-function removal, or
  other low-impact cleanup. Avoid a new test framework or broad harness for a
  small change.
- Use controlled promises for asynchronous tests rather than arbitrary sleeps.
- Run the checks required for the change. Repeat or broaden them when a new
  change, failure, or unresolved concern warrants it.
- Separate code, package, and CI evidence from browser, scanner, Store, and live
  clinic validation. Do not claim the latter from automated checks alone.
- In scan workflows, distinguish capture, local persistence, page acceptance,
  observed field verification, and a saved clinical record. Explain which step
  an acknowledgement proves. Make uncertain outcomes visible for staff review;
  do not automatically replay or restore uncertain clinical work.
- For substantial clinical changes, review a short design before implementation:
  essential guarantees, minimum state, PR boundaries, and unavoidable limitations.
  Review the combined result afterward for safety and unnecessary complexity.
  Keep these reviews bounded; address material findings and recheck affected work.
- Review each PR's changes critically before pushing. Use a separate reviewer
  when the harness supports it. Address meaningful findings and recheck the
  affected work.

## Delegation

- Use subagents when requested or when applicable project instructions call for
  them. Give each agent a bounded task and avoid overlapping edits.
- For requested parallel cleanup passes, split distinct areas between available
  agents and have them report concrete findings first. If subagents are not
  available, inspect those areas in sequence. Review findings before making
  broader changes. Keep proven issues separate from guesses and style preferences.
- Treat requests for particular models or tools as task-specific unless the user
  asks to make them a project rule.
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

See [Architecture](docs/architecture.md) for the maintained component map,
shared helpers, storage responsibilities, and scan delivery and recovery flow.
Update that document when these responsibilities or contracts change. Keep the
hard constraints below in this guidance rather than duplicating the component
map here.

### Panorama Autofill Sequence

Fill order must be: `agent → lot → (deferred) date/time`. Panorama auto-populates dependent fields (trade name, route, dose, manufacturer) after lot selection. The existing bounded retries guard lot and deferred date/time writes with `!isPrimeFacesAjaxBusy()`. This isolated-world check alone does not prove that page activity has finished. Lot matching uses `normalizePanoramaLotToken` to handle formats like `LOT123 - Exp. ...`. Panorama uses misspelled IDs (e.g. `dateAdministedDate`) — keep those as-is.

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
