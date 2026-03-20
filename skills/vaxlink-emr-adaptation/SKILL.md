---
name: vaxlink-emr-adaptation
description: Add support for new EMRs in VaxLink by defining page detection, field mappings, selector profiles, and rerender timing rules. Use when adapting the extension beyond Panorama, adding a new site-specific adapter, or refactoring EMR logic out of `apps/extension/content.js`.
---

# VaxLink EMR Adaptation

## Focus

Treat each EMR as an adapter profile.
Keep core barcode parsing and popup payloads stable; add EMR-specific detection, selectors, and write order in the adapter layer.

## Adapter Model

- Detect the EMR/page first.
- Load the matching profile.
- Map parsed fields to page-specific controls.
- Apply the EMR's timing and retry rules.
- Keep the generic core free of site-specific selectors where possible.

## What A New Profile Needs

- A reliable page detector.
- Stable selectors or fallback heuristics for the target fields.
- A field order that matches the EMR's dependency chain.
- Rerender-safe retry behavior.
- A small fixture or HTML sample for testing selector changes.

## Rules To Keep

- Keep barcode parsing and NVC lookup separate from page adaptation.
- Keep EMR-specific logic behind adapter boundaries.
- Do not copy Panorama selectors into a new EMR unless the DOM actually matches.
- Favor page-specific profiles over if/else chains scattered through `content.js`.
- Treat missing selectors as a profile update, not a parser bug.

## Where To Change Code

- `apps/extension/content.js` for page detection and adapter dispatch.
- `apps/extension/panorama-agent-rules.js` for Panorama-specific agent heuristics only.
- `apps/extension/popup.js` when the new EMR needs different payload shaping.
- `apps/extension/background.js` when the EMR changes queue or storage behavior.

## References

- Read `references/emr-adapter-contract.md` before adding a new site profile.
