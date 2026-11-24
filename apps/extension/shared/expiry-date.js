(function attachExpiryDate(root) {
  function parseDateToLocal(value) {
    if (!value) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    // Expiry is a calendar date. Keep the written date of an NVC timestamp,
    // rather than shifting it to the previous day in another time zone.
    // Timestamps require seconds and a UTC marker or numeric time-zone offset.
    const iso = raw.match(
      /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/
    );
    const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!iso && !mdy) return null;
    if (iso && raw.includes('T') && Number.isNaN(Date.parse(raw))) return null;
    const year = Number(iso ? iso[1] : mdy[3]);
    const month = Number(iso ? iso[2] : mdy[1]);
    const day = Number(iso ? iso[3] : mdy[2]);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day
      ? date
      : null;
  }

  function daysUntil(expiry, today = new Date()) {
    // Local days can be 23 or 25 hours long. Compare calendar dates in UTC
    // so tomorrow always counts as one day, including clock changes.
    const calendarDay = (date) =>
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    return (calendarDay(expiry) - calendarDay(today)) / 86400000;
  }

  function expiredVaccineDate(vaccine, today = new Date()) {
    let earliestDate = '';
    let earliestDays = 0;
    for (const value of [
      vaccine?.barcode_expiry,
      vaccine?.expiry,
      vaccine?.inventory_expiry,
      vaccine?.nvc_lot_expiry
    ]) {
      const date = parseDateToLocal(value);
      if (!date) continue;
      const days = daysUntil(date, today);
      if (days < earliestDays) {
        earliestDate = value;
        earliestDays = days;
      }
    }
    return earliestDate;
  }

  function isExpiredVaccine(vaccine) {
    // Recheck calendar dates even if a saved row was still valid when scanned.
    return vaccine?.expiry_flag === 'expired' || !!expiredVaccineDate(vaccine);
  }

  function blocksChartUse(vaccine) {
    return vaccine?.reference_only === true || isExpiredVaccine(vaccine);
  }

  root.VaxLinkExpiryDate = Object.freeze({
    parseDateToLocal,
    daysUntil,
    expiredVaccineDate,
    isExpiredVaccine,
    blocksChartUse
  });
})(globalThis);
