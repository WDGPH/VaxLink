---
name: vaxlink-panorama-selector-maintenance
description: Maintain and update Panorama DOM selectors, PrimeFaces rerender timing, and agent/lot/date autofill behavior in VaxLink. Use when Panorama HTML changes, `pano1.html` or `pano2.html` are updated, lot selection stops working, fields fill then disappear, or selector drift breaks `apps/extension/content.js`.
---

# VaxLink Panorama Selector Maintenance

## Focus

Use this skill for Panorama-specific DOM work only.
Keep the source of truth in the captured Panorama HTML fixtures and the current `content.js` selector flow.

## Operating Rules

- Treat Panorama as PrimeFaces JSF, not generic HTML.
- Prefer `id*=` selectors because generated prefixes change.
- Keep the sequence `agent -> wait for rerender -> lot -> deferred date/time`.
- Do not manually fill dependent fields that Panorama is supposed to derive.
- Use mutation/retry logic when a field is populated and then cleared by rerender.
- When a selector fails, inspect `pano1.html` and `pano2.html` first.

## What To Update

- `apps/extension/content.js` selector maps for Panorama fields.
- Retry timing around PrimeFaces queue and `MutationObserver`.
- Lot matching logic for text like `LOT123 - Exp. 2027 Jun 30`.
- Date Administered selectors using Panorama's `dateAdministedDate` IDs.
- Any fallback logic that starts filling dependent vaccine details too early.

## Reference Files

- Read `references/panorama-selector-map.md` before changing selectors or rerender timing.
