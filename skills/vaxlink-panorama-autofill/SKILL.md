---
name: vaxlink-panorama-autofill
description: Improve and troubleshoot VaxLink Chrome extension autofill behavior on Panorama immunization pages. Use when modifying apps/extension/content.js or related popup payload files for agent and lot selection, deferred Date Administered fill, PrimeFaces timing/re-render issues, selector drift, and autofill performance tuning.
---

# VaxLink Panorama Autofill

## Overview

Apply a stable Panorama autofill pattern that is fast and resistant to PrimeFaces rerenders.
Preserve the core behavior: VaxLink sets Agent and Lot, Panorama derives dependent fields, VaxLink defers Date Administered/Time.

## Core Workflow

1. Confirm Panorama structure before editing selectors.
2. Keep the fill sequence as `agent -> lot -> date/time`.
3. Let Panorama auto-populate dependent details after lot selection.
4. Use deferred retries with PrimeFaces-idle guards for rerender safety.
5. Validate syntax and run a manual smoke test.

## Rules to Preserve

- Keep agent selection and lot selection explicit.
- Keep dependent details (trade, dosage, route, site, manufacturer) Panorama-driven unless explicitly requested otherwise.
- Gate lot and deferred date/time writes behind `!isPrimeFacesAjaxBusy()`.
- Keep watcher retries active across async rerenders using `MutationObserver` plus timed retries.
- Keep lot matching normalized (`normalizePanoramaLotToken`) so formats like `LOT123 - Exp. ...` still match.
- Keep Date Administered selectors aligned to Panorama's misspelled IDs (`dateAdministedDate`).
- Keep `id*=` selector fallbacks for dynamic JSF/PrimeFaces prefixes.

## Primary Edit Surface

- Main logic: `apps/extension/content.js`
- Payload and settings: `apps/extension/popup.js`, `apps/extension/popup-inventory.js`, `apps/extension/popup.html`
- Agent heuristics: `apps/extension/panorama-agent-rules.js`
- DOM fixtures: `pano1.html`, `pano2.html`

## Validation Checklist

- Run:
  - `node --check apps/extension/content.js`
  - `node --check apps/extension/popup.js`
  - `node --check apps/extension/popup-inventory.js`
- Manually verify on Panorama:
  - Agent is selected.
  - Lot is selected after agent refresh completes.
  - Panorama fills dependent fields after lot.
  - Date Administered/Time remains set after rerenders.

## References

- Read `references/panorama-selector-map.md` when selectors drift or specific controls stop responding.
