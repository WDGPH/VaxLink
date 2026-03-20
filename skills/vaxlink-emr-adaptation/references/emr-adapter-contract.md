# EMR Adapter Contract

## Adapter responsibilities

- Detect the target EMR and page variant.
- Declare the fields it owns.
- Define the fill order and dependency timing.
- Expose selectors and fallback heuristics for that EMR only.

## Core contract

- Core parser produces normalized vaccine data.
- Adapter maps normalized data to page controls.
- Adapter may retry writes, but only within its own page profile.
- Adapter should not mutate shared parsing rules unless the EMR requires a new normalization case.

## Recommended profile shape

- `name`
- `matches`
- `detect()`
- `fillOrder`
- `selectors`
- `retryPolicy`
- `dependentFields`
- `postFillChecks`

## Good practice

- Keep one fixture per EMR/page variant.
- Add the smallest selector needed that still survives rerenders.
- Prefer explicit field ownership over broad generic matching.
- When an EMR changes, update the adapter profile before widening core logic.

## Panorama as example

- Panorama uses explicit agent and lot selection.
- Dependent fields are filled by Panorama after lot selection.
- Date Administered is deferred and guarded against rerender overwrite.
