# Adding a New EMR

Today, platform support is hardcoded in two places in `content.js`:

| Location | What it does |
|---|---|
| `isHandsFreeSupportedPage()` | Whitelist of allowed hostnames |
| `autoFillTelus()` | Routes to Panorama fill OR generic fill |
| `isPanoramaImmunizationPage()` | Detects Panorama-specific DOM |
| `fillPanoramaImmunizationFields()` | Panorama-specific fill logic |

Adding OSCAR/Wolf/PS Suite today means copy-pasting more `if (isOSCAR)`
branches into those same functions. The [roadmap](roadmap.md) describes a
planned platform-registry refactor to replace this. Until that lands, treat
each EMR as an **adapter profile** rather than inline branches.

## Adapter model

- Detect the EMR/page first.
- Load the matching profile.
- Map parsed fields to page-specific controls.
- Apply the EMR's timing and retry rules.
- Keep the generic core free of site-specific selectors where possible.

## What a new profile needs

- A reliable page detector.
- Stable selectors or fallback heuristics for the target fields.
- A field order that matches the EMR's dependency chain.
- Rerender-safe retry behavior.
- A small fixture or HTML sample for testing selector changes.

## Rules to keep

- Keep barcode parsing and NVC lookup separate from page adaptation.
- Keep EMR-specific logic behind adapter boundaries.
- Do not copy Panorama selectors into a new EMR unless the DOM actually
  matches.
- Favor page-specific profiles over `if`/`else` chains scattered through
  `content.js`.
- Treat missing selectors as a profile update, not a parser bug.

## Where to change code

- `apps/extension/content.js` for page detection and adapter dispatch.
- `apps/extension/panorama-agent-rules.js` for Panorama-specific agent
  heuristics only.
- `apps/extension/popup.js` when the new EMR needs different payload
  shaping.
- `apps/extension/background.js` when the EMR changes queue or storage
  behavior.

!!! tip "Claude Code skill"
    `skills/vaxlink-emr-adaptation/SKILL.md` packages this same adapter
    contract for use with Claude Code, including a pointer to
    `references/emr-adapter-contract.md` — read that before adding a new site
    profile.

## Platform research notes

From the [roadmap](roadmap.md)'s survey of likely next platforms:

| Platform | Common hostnames | Notes |
|---|---|---|
| OSCAR EMR | `oscar.*`, `*.oscarhost.com`, `*.oscar-emr.com` | Open-source Java; immunizations under `/oscarRx/` or `/appointment/` |
| Wolf EMR | `*.wolfemr.com`, `wolfmedical.com` | Field names tend to follow `vaccine_`, `lot_`, `expiry_` patterns |
| PS Suite | `*.ps-suite.com`, `pssuite.ca` | Telus Health product; likely similar to InputHealth |

Inspect actual running instances before implementing a new adapter — no
selectors are confirmed for these yet.
