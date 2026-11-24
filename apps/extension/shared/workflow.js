(() => {
  const WORKFLOW_MODE_KEY = 'vaxlink_workflow_mode_v1';
  const LEGACY_POPUP_MODE_KEY = 'vaxlink_popup_mode_v1';
  const SINGLE_SCAN_AUTOFILL_KEY = 'vaxlink_single_scan_autofill_v1';
  const GRID_SCAN_AUTOFILL_KEY = 'vaxlink_grid_scan_autofill_v1';

  function normalizeWorkflowMode(stored) {
    const mode = stored?.[WORKFLOW_MODE_KEY];
    if (mode === 'inventory') return 'inventory';
    if (['immunization', 'single', 'multiple'].includes(mode))
      return 'immunization';
    return stored?.[LEGACY_POPUP_MODE_KEY] === 'inventory'
      ? 'inventory'
      : 'immunization';
  }

  globalThis.VaxLinkWorkflow = Object.freeze({
    WORKFLOW_MODE_KEY,
    LEGACY_POPUP_MODE_KEY,
    SINGLE_SCAN_AUTOFILL_KEY,
    GRID_SCAN_AUTOFILL_KEY,
    normalizeWorkflowMode
  });
})();
