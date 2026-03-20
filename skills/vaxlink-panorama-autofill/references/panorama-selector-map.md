# Panorama Selector Map

## Agent controls

- `select[id*="immsDetailssection_recordImms_agentiterm:selectOneMenu_input"]`
- `input[id*="immsDetailssection_recordImms_agentiterm:selectOneMenu_focus"]`

## Lot controls

- `select[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_input"]`
- `select[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_input"]`
- `input[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_filter"]`
- `input[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_filter"]`
- `li[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_"]`
- `li[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_"]`
- `label[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_label"]`
- `label[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_label"]`

## Date Administered controls

- Date: `input[id*="immsDetailssection_dateAdministedDate:dateInput_input"]`
- Time: `input[id*="immsDetailssection_dateAdministedDate:timeInput:timeInput"]`

Note: Panorama uses `dateAdministedDate` (misspelled). Keep selectors aligned to that ID.

## PrimeFaces behavior notes

- Agent `change` causes async updates of lot options and vaccine details sections.
- Lot `change` triggers defaults for trade/dose/site/route/manufacturer.
- Prefer waiting for PrimeFaces queue idle before writing lot/date fields.
- Keep retry watcher active long enough to survive rerenders.

## Troubleshooting order

1. Confirm Agent gets selected and remains selected after update.
2. Confirm Lot control is enabled and options loaded before selecting lot.
3. Confirm lot option text contains scanned lot token after normalization.
4. Confirm Date Administered/Time fills after lot-triggered rerender completes.
5. Add selectors only as fallbacks; do not remove existing working selectors.
