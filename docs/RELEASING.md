# VaxLink Release Process

## Current release process

Production releases run from `main`. v1.1.5 was released directly from `main`
using release-please; the former `dev`-based Alpha process is not active.

1. Merge changes with conventional commit subjects into `main`.
2. Release-please creates or updates a release PR containing the version changes
   and generated changelog.
3. Merge the release PR. Release-please creates the version tag and GitHub Release.
4. GitHub Actions packages the production extension and uploads
   `vaxlink-prod-<v>.zip` and, for releases produced after this improvement,
   `SHA256SUMS` calculated from that final ZIP.
5. An authorized publisher verifies the ZIP, uploads it to the existing VaxLink
   Chrome Web Store listing, and submits it for review. GitHub release creation
   does not publish to the store automatically.

The workflow is `.github/workflows/release-please.yml`, with stable configuration
in `release-please-config.json`. Do not create release tags or increment versions
manually: the release PR updates root `package.json`, the extension manifest's
`version` and `version_name`, and `CHANGELOG.md`. Each store upload needs a version
higher than the one already uploaded to that listing.

## Channels

| Channel | Status | Web Store listing | Packaged manifest name | Popup badge |
|---|---|---|---|---|
| Production | Active, releases from `main` | VaxLink | `VaxLink` | hidden |
| Alpha | Separate listing; branch-based automation dormant | VaxLink Alpha | `VaxLink Alpha` | shown |

`scripts/package-extension.sh prod` and `alpha` stamp the channel name and
`version_name` into the packaged manifest. Keep channel identity out of source
branch differences; runtime channel behaviour derives from the manifest name.

The Alpha jobs and `release-please-dev-config.json` are retained for possible
future use. They require `dev`, which is no longer active. If reinstated, they
would create an Alpha release PR, tag and prerelease, then attach the Alpha ZIP
and its checksum. Uploading to the separate Alpha listing would still be manual.
The current production process does not require Alpha-to-production promotion.

## Installation and updates

- **Chrome Web Store:** Chrome validates the extension package through its normal distribution process and updates the installed listing automatically. Use the approved VaxLink listing for production.
- **Manual GitHub deployment:** Partner IT downloads an approved `vaxlink-prod-<v>.zip` from the GitHub Release, verifies it, extracts it, and uses Chrome's **Load unpacked** option to deploy the folder. This is an IT-managed fallback, subject to organizational Chrome policies. It does not automatically receive Chrome Web Store updates. Partner IT must deliberately install each subsequent approved version. Reload supported Panorama tabs after an extension update.

Releases produced after this improvement attach `SHA256SUMS` for their final
ZIP assets. Historical releases, including v1.1.5, may not have a separate checksum
file. Do not assume it is available or replace historical assets to add one.
GitHub also provides native SHA-256 release-asset digests, which partner IT can
use to verify older downloads when available.

Download the ZIP and `SHA256SUMS` from the same release. In their directory, run
`sha256sum -c SHA256SUMS`. On Windows, compare
`Get-FileHash .\vaxlink-prod-<v>.zip -Algorithm SHA256` with the matching line in
`SHA256SUMS`. A matching checksum confirms agreement with the GitHub release
record and detects corruption or substitution relative to that record. It is
not an independent publisher signature.

### Exceptional release-asset repair

Prefer a new version for changed release content. Normal release uploads do not
replace existing assets. The workflow's manual `existing_tag` repair path is an
exceptional administrative operation: it uses `--clobber` to replace assets and
regenerates `SHA256SUMS` from the newly packaged ZIP. Replaced bytes may differ
from the ZIP previously submitted to the Chrome Web Store or downloaded by
partners. Confirm the need and coordinate with affected partners before using
this path. Do not use it to retrofit checksums onto v1.1.5.

The external pilot FAQ should distinguish these paths: automatic updates apply to Web Store installs; partner IT deploys updates for manual GitHub installs. Keep supplied partner PDFs in their established source-document process rather than copying them into this repository.

## Changelog workflow

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) with two VaxLink-specific additions:

1. **"Clinic feedback addressed" table** — for any release containing fixes driven by pilot feedback, add a table row per feedback item: the nurse's words (short paraphrase or quote), what changed, and the issue refs. This is the artifact to send back to the nursing team — it closes the loop and shows their feedback lands.
2. **Contributors line** per release. Generate code contributors with:
   ```bash
   git shortlog -sn <prev-version-commit>..<this-version-commit>
   ```
   Credit non-code contributions explicitly (e.g. `clinic feedback: WDGPH immunization nursing team`).

Review the generated changelog in the release PR on `main`. Keep useful hand-curated feedback tables and a `### Known issues (tracked)` subsection with issue numbers so testers know what not to re-report. Do not manually rename sections or bump versions as a separate release step.

## Feedback traceability (feedback → issue → fix → changelog)

1. Clinic feedback arrives (email/clinic notes). File or update a GitHub issue per distinct item, quoting the feedback and the build it was observed on (e.g. "VaxLink Alpha 1.0.5").
2. Fix commits reference the issue (`(#25)` in the subject or body).
3. The changelog's feedback table links the quote to the issue and the release that shipped the fix.
4. After release, comment on each addressed issue with the version that shipped the fix; close it once the clinic confirms.

This gives both directions: from a nurse's complaint to the exact commit, and from any commit back to why it exists.

## Commit conventions

Use conventional commit subjects on `main`:

- `fix: stop eating Tab keystrokes (#30)` → patch bump, "Fixed" section
- `feat: preset dose for prefilled syringes (#24)` → minor bump, "Added" section
- `feat!:` or a `BREAKING CHANGE:` footer → major bump
- `chore:`/`docs:`/`test:`/`refactor:` → hidden from the generated changelog

### Conventions the automation relies on
- Label feedback-driven issues **`clinic-feedback`** so they can be found when preparing release notes.
- Reference issues in commit subjects (`(#25)`) so changelog entries link back.
- Don't hand-edit `version` anywhere; the Release PR owns version bumps. (Hand-written changelog content *above* the generated sections is preserved — the historical 1.0.0–1.0.7 entries stay.)
- Write "Clinic feedback addressed" tables by hand for major pilot rounds; release-please generates commit-based changelog entries, not these feedback tables.

### Sanity checks before any store upload
- Open the zip and confirm `manifest.json` has the right `name`/`version_name` for the listing.
- Load the extracted zip unpacked and open the popup: badge present on alpha, absent on prod.
- No downloaded `nvc_bundle.json`, tests, fixtures, `node_modules`, or development-only files inside the ZIP (the package script excludes them). Verify the checksum against the final ZIP before uploading.

## Repository security settings

Repository administrators should verify Dependabot vulnerability alerts and security updates, CodeQL default setup, and secret scanning with push protection where available. Their enabled status has not been verified as part of this PR. `.github/dependabot.yml` groups weekly GitHub Actions and documentation tooling version updates. This configuration does not enable repository security controls. These GitHub settings are separate from this repository's files and must be checked in the repository settings page.
