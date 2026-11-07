// Shared by the classic background worker and the module-based scanner contexts.
(() => {
  const SCANNER_STATUS_STATES = Object.freeze({
    NEVER_CONFIGURED: 'never_configured',
    STARTING: 'starting',
    CONNECTED: 'connected',
    RECOVERING: 'recovering',
    WAITING_FOR_DEVICE: 'waiting_for_device',
    PERMISSION_LOST: 'permission_lost',
    BUSY: 'busy',
    ERROR: 'error',
    DISABLED: 'disabled'
  });

  const VALID_SCANNER_STATES = new Set(Object.values(SCANNER_STATUS_STATES));

  function normalizeIsoTimestamp(value) {
    if (!value) return '';
    const parsed = new Date(String(value).trim());
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
  }

  function normalizeScannerPortInfo(info) {
    if (!info || typeof info !== 'object') return null;
    const normalized = {};
    if (
      info.usbVendorId !== undefined &&
      info.usbVendorId !== null &&
      info.usbVendorId !== ''
    ) {
      const vendorId = Number(info.usbVendorId);
      if (Number.isFinite(vendorId)) normalized.usbVendorId = vendorId;
    }
    if (
      info.usbProductId !== undefined &&
      info.usbProductId !== null &&
      info.usbProductId !== ''
    ) {
      const productId = Number(info.usbProductId);
      if (Number.isFinite(productId)) normalized.usbProductId = productId;
    }
    if (info.bluetoothServiceClassId) {
      normalized.bluetoothServiceClassId = String(info.bluetoothServiceClassId);
    }
    return Object.keys(normalized).length ? normalized : null;
  }

  function createScannerStatusSnapshot(overrides = {}) {
    return normalizeScannerStatusSnapshot({
      state: SCANNER_STATUS_STATES.NEVER_CONFIGURED,
      profileId: '',
      portInfo: null,
      lastConnectedAt: '',
      lastDisconnectedAt: '',
      lastCaptureAt: '',
      captureCount: 0,
      lastError: '',
      recoverAttemptCount: 0,
      ...overrides
    });
  }

  function normalizeScannerStatusSnapshot(snapshot) {
    const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
    return {
      state: VALID_SCANNER_STATES.has(source.state)
        ? source.state
        : SCANNER_STATUS_STATES.NEVER_CONFIGURED,
      profileId: String(source.profileId || '').trim(),
      portInfo: normalizeScannerPortInfo(source.portInfo),
      lastConnectedAt: normalizeIsoTimestamp(source.lastConnectedAt),
      lastDisconnectedAt: normalizeIsoTimestamp(source.lastDisconnectedAt),
      lastCaptureAt: normalizeIsoTimestamp(source.lastCaptureAt),
      observedAt: normalizeIsoTimestamp(source.observedAt),
      captureCount: Math.max(0, Number.parseInt(source.captureCount, 10) || 0),
      lastError: String(source.lastError || '').trim(),
      recoverAttemptCount: Math.max(
        0,
        Number.parseInt(source.recoverAttemptCount, 10) || 0
      )
    };
  }

  function buildDefaultScannerStatus({
    enabled = false,
    profileId = '',
    portInfo = null
  } = {}) {
    const normalizedProfileId = String(profileId || '').trim();
    if (!normalizedProfileId) {
      return createScannerStatusSnapshot();
    }
    return createScannerStatusSnapshot({
      state: enabled
        ? SCANNER_STATUS_STATES.WAITING_FOR_DEVICE
        : SCANNER_STATUS_STATES.DISABLED,
      profileId: normalizedProfileId,
      portInfo: normalizeScannerPortInfo(portInfo)
    });
  }

  globalThis.VaxLinkScannerStatus = Object.freeze({
    SCANNER_STATUS_STATES,
    normalizeScannerPortInfo,
    createScannerStatusSnapshot,
    normalizeScannerStatusSnapshot,
    buildDefaultScannerStatus
  });
})();
