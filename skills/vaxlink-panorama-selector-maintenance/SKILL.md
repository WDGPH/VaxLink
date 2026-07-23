---
name: vaxlink-panorama-selector-maintenance
description: Maintain and update Panorama DOM selectors, PrimeFaces rerender timing, and agent/lot/date autofill behavior in VaxLink. Use when Panorama HTML changes, lot selection stops working, fields fill then disappear, or selector drift breaks `apps/extension/content.js`.
---

# VaxLink Panorama Selector Maintenance

## Focus

Use this skill for Panorama-specific DOM work only.
Keep the source of truth in `references/panorama-selector-map.md` and the current `content.js` selector flow. Do not commit live-session DOM captures as fixtures — they can contain real patient data; sanitize to structural fragments only (field IDs, option lists) as done in `apps/extension-tests/panorama-reason-consent.test.js`.

## Operating Rules

- Treat Panorama as PrimeFaces JSF, not generic HTML.
- Prefer `id*=` selectors because generated prefixes change.
- Keep the sequence `agent -> wait for rerender -> lot -> deferred date/time`.
- Do not manually fill dependent fields that Panorama is supposed to derive.
- Use mutation/retry logic when a field is populated and then cleared by rerender.
- When a selector fails, capture a fresh sanitized DOM snapshot from a test/training Panorama session and diff it against `references/panorama-selector-map.md`.

## What To Update

- `apps/extension/content.js` selector maps for Panorama fields.
- Retry timing around PrimeFaces queue and `MutationObserver`.
- Lot matching logic for text like `LOT123 - Exp. 2027 Jun 30`.
- Date Administered selectors using Panorama's `dateAdministedDate` IDs.
- Any fallback logic that starts filling dependent vaccine details too early.

## Reference Files

- Read `references/panorama-selector-map.md` before changing selectors or rerender timing.
