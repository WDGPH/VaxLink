// Shared by the three places that report Local Activity.
globalThis.vaxlinkVaccineLabel = function vaxlinkVaccineLabel(record) {
  if (!record) return '';
  if (record.tradename || record.generic_name)
    return record.tradename || record.generic_name;
  // Older rows may use an identifier as the display name.
  const name = String(record.name || '')
    .trim()
    .toLowerCase();
  const isIdentifier = [
    record.lot,
    record.gtin,
    record.din,
    record.drug_code
  ].some(
    (value) =>
      String(value || '')
        .trim()
        .toLowerCase() === name
  );
  return name && !isIdentifier ? record.name : '';
};
