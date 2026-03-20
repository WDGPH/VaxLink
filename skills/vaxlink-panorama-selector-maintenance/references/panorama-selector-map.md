# Panorama Selector Map

## Current Panorama targets

- Agent select: `select[id*="immsDetailssection_recordImms_agentiterm:selectOneMenu_input"]`
- Agent combobox focus: `input[id*="immsDetailssection_recordImms_agentiterm:selectOneMenu_focus"]`
- Lot select: `select[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_input"]`
- Lot select alt: `select[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_input"]`
- Lot filter: `input[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_filter"]`
- Lot filter alt: `input[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_filter"]`
- Date administered date: `input[id*="immsDetailssection_dateAdministedDate:dateInput_input"]`
- Date administered time: `input[id*="immsDetailssection_dateAdministedDate:timeInput:timeInput"]`

## Expected sequence

1. Select agent.
2. Wait for the PrimeFaces rerender to settle.
3. Select lot.
4. Let Panorama populate trade, dosage, route, site, and manufacturer.
5. Fill Date Administered and Time only after the page is stable.

## Failure modes

- Field fills and disappears: the write happened before a rerender completed.
- Lot select does nothing: agent selection or queue timing is incomplete.
- Dependent fields remain blank: Panorama likely did not receive the lot change event.
- Date/Time fail: selector drift or a stale masked input wrapper.
