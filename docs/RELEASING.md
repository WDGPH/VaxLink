# VaxLink Release Process

## Channels

| Channel | Branch | Web Store listing | Manifest name (stamped) | Badge in popup |
|---|---|---|---|---|
| Alpha | `dev` | VaxLink Alpha | `VaxLink Alpha`, `version_name` `X.Y.Z-alpha` | shown |
| Prod | `main` | VaxLink | `VaxLink`, `version_name` `X.Y.Z` | hidden |

The two store listings have separate releases. Prod may jump versions (1.0.2 → 1.0.6) when intermediate versions were alpha-only.

Channel identity is **never** edited in `manifest.json` (it stays "VaxLink Alpha" in git on both branches — that's what unpacked development shows). `scripts/package-extension.sh` stamps the name and `version_name` at package time. Anything else channel-specific must derive from `chrome.runtime.getManifest().name` at runtime, like the popup badge does.

## Versioning

- Bump `version` (and `version_name`) in `manifest.json` on `dev` only, in a dedicated `update version to X.Y.Z` commit.
- Bump whenever a build will be uploaded to a store listing — the store requires strictly increasing versions per listing, including re-uploads after a botched build.
- Three-part versions (`1.0.7`). If alpha ever needs multiple uploads per version, use a fourth part (`1.0.8.1`, `1.0.8.2`) and ship `1.0.8.x`'s final state to prod as `1.0.8`.

## Installation and updates

- **Chrome Web Store:** Chrome validates the extension package through its normal distribution process and updates the installed listing automatically. Use the approved VaxLink listing for production.
- **Manual GitHub deployment:** Partner IT downloads an approved `vaxlink-prod-<v>.zip` from the GitHub Release, verifies it, extracts it, and uses Chrome's **Load unpacked** option to deploy the folder. This path does not require Web Store access. Partner IT must deliberately deploy a newer approved ZIP; GitHub downloads do not update an installed extension automatically.

Each alpha and stable release includes `SHA256SUMS` for its exact ZIP assets. Download the ZIP and `SHA256SUMS` from the same release, then check the production ZIP with `sha256sum -c SHA256SUMS` on a system with that utility. On Windows, compare `Get-FileHash .\vaxlink-prod-<v>.zip -Algorithm SHA256` with the corresponding line in `SHA256SUMS`. A matching checksum detects corruption or substitution relative to the release record; it is not an independent publisher signature. If a release asset is repaired or replaced, the release workflow must regenerate and upload its checksum as well.

The external pilot FAQ should distinguish these paths: automatic updates apply to Web Store installs; partner IT deploys updates for manual GitHub installs. Keep supplied partner PDFs in their established source-document process rather than copying them into this repository.

## Changelog workflow

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) with two VaxLink-specific additions:

1. **"Clinic feedback addressed" table** — for any release containing fixes driven by pilot feedback, add a table row per feedback item: the nurse's words (short paraphrase or quote), what changed, and the issue refs. This is the artifact to send back to the nursing team — it closes the loop and shows their feedback lands.
2. **Contributors line** per release. Generate code contributors with:
   ```bash
   git shortlog -sn <prev-version-commit>..<this-version-commit>
   ```
   Credit non-code contributions explicitly (e.g. `clinic feedback: WDGPH immunization nursing team`).

Maintain an `## [Unreleased]` section at the top of the changelog on `dev`; when bumping the version, rename it to `## [X.Y.Z] – YYYY-MM-DD` in the same commit. Keep a `### Known issues (tracked)` subsection so testers know what NOT to re-report, with issue numbers.

## Feedback traceability (feedback → issue → fix → changelog)

1. Clinic feedback arrives (email/clinic notes). File or update a GitHub issue per distinct item, quoting the feedback and the build it was observed on (e.g. "VaxLink Alpha 1.0.5").
2. Fix commits reference the issue (`(#25)` in the subject or body).
3. The changelog's feedback table links the quote to the issue and the release that shipped the fix.
4. After release, comment on each addressed issue with the version that shipped the fix; close it once the clinic confirms.

This gives both directions: from a nurse's complaint to the exact commit, and from any commit back to why it exists.

## Release steps (automated via release-please)

Releases are driven by [release-please](https://github.com/googleapis/release-please) (`.github/workflows/release-please.yml`, config in `release-please-config.json`).

**The one habit it requires: [Conventional Commit](https://www.conventionalcommits.org/) subjects** on `dev` going forward:

- `fix: stop eating Tab keystrokes (#30)` → patch bump, "Fixed" section
- `feat: preset dose for prefilled syringes (#24)` → minor bump, "Added" section
- `feat!:` or a `BREAKING CHANGE:` footer → major bump
- `chore:`/`docs:`/`test:`/`refactor:` → recorded but hidden from the changelog

### Alpha (automated)
1. Push conventional commits to `dev`. The bot opens/updates a single **Release PR** ("chore: release VaxLink X.Y.Z") that contains the version bump (root `package.json` + `manifest.json` version and version_name via jsonpath) and the generated `CHANGELOG.md` section. It accumulates until you're ready.
2. **Merging the Release PR is the release.** The bot creates an alpha tag and prerelease. A follow-up job builds the alpha ZIP and attaches it with `SHA256SUMS` as release assets.
3. Upload the attached `vaxlink-alpha-<v>.zip` to the VaxLink Alpha listing. Send the release link to the pilot team.

### Prod (when an alpha is confirmed good)
1. Merge the confirmed alpha changes from `dev` to `main`. The stable release workflow creates its own tag and GitHub Release, with the production ZIP and `SHA256SUMS`.
2. Download `vaxlink-prod-<v>.zip` from the stable GitHub Release and upload it to the VaxLink listing.
3. Confirm the stable GitHub Release is marked as a full release.
4. Comment the shipped version on each addressed issue; close after clinic confirmation.

### Conventions the automation relies on
- Label feedback-driven issues **`clinic-feedback`** — that's how the release notes table is generated.
- Reference issues in commit subjects (`(#25)`) so changelog entries link back.
- Don't hand-edit `version` anywhere; the Release PR owns version bumps. (Hand-written changelog content *above* the generated sections is preserved — the historical 1.0.0–1.0.7 entries stay.)
- Hand-curated "Clinic feedback addressed" tables in CHANGELOG.md remain worth writing for big pilot rounds: the automation lists the issues; the table tells the story with the nurses' words.

### Sanity checks before any store upload
- Open the zip and confirm `manifest.json` has the right `name`/`version_name` for the listing.
- Load the extracted zip unpacked and open the popup: badge present on alpha, absent on prod.
- No `.claude/`, `README.md`, `.gitignore`, or test files inside the zip (the package script excludes them).

## Repository security settings

Repository administrators should enable Dependabot vulnerability alerts and security updates, CodeQL default setup for JavaScript/TypeScript, and secret scanning with push protection in GitHub settings. `.github/dependabot.yml` groups weekly GitHub Actions and documentation tooling version updates; security updates remain prompt. These GitHub settings are separate from this repository's files and must be checked in the repository settings page.
