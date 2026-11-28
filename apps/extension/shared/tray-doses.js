(() => {
  // Both the background writer and the popup need the same dose rules.
  function positiveDoseCount(value) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function getTrayRemainingDoses(row) {
    if (row?.dose_tracking === 'retained') return null;
    if (row?.dose_tracking === 'single_use') return 1;
    // Old rows without a count stay in the tray after use.
    return (
      positiveDoseCount(row?.remaining_doses) ??
      positiveDoseCount(row?.total_doses)
    );
  }

  function trayDoseNeedsReview(row) {
    const remaining = getTrayRemainingDoses(row);
    const reservations = row.dose_reservations || [];
    return (
      remaining !== null &&
      reservations.length >= remaining &&
      reservations.some((dose) => dose.review)
    );
  }

  function getTrayDoseFields(row) {
    return JSON.stringify([
      row?.dose_tracking,
      row?.total_doses,
      row?.remaining_doses
    ]);
  }

  function canPinTrayDose(row) {
    return (
      row.dose_tracking === 'single_use' || getTrayRemainingDoses(row) === null
    );
  }

  function defaultChartDose(row) {
    return row.dose_tracking !== 'retained' &&
      getTrayRemainingDoses(row) === null
      ? { ...row, dose_tracking: 'single_use' }
      : row;
  }

  globalThis.VaxLinkTrayDoses = Object.freeze({
    getTrayRemainingDoses,
    trayDoseNeedsReview,
    getTrayDoseFields,
    canPinTrayDose,
    defaultChartDose
  });
})();
