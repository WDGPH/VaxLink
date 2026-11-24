(() => {
  // The service worker loads this with importScripts. Extension pages and
  // the dedicated scanner worker can load the same file as a module.
  const SCANNER_DAEMON_ENABLED_KEY = 'vaxlink_scanner_daemon_enabled_v1';
  const SCANNER_STATUS_SNAPSHOT_KEY = 'vaxlink_scanner_status_snapshot_v1';
  const SCANNER_DAEMON_OFFSCREEN_PATH = 'scanner-daemon.html';
  const SCANNER_DAEMON_TARGET = 'scannerDaemon';
  const SCANNER_DAEMON_BACKGROUND_TARGET = 'scannerDaemonBackground';

  const SCANNER_DAEMON_ACTIONS = Object.freeze({
    ENSURE: 'scannerDaemon.ensure',
    GET_STATUS: 'scannerDaemon.getStatus',
    CONNECT_GRANTED: 'scannerDaemon.connectGranted',
    SELECT: 'scannerDaemon.select',
    DISCONNECT: 'scannerDaemon.disconnect',
    ENABLE_AUTOSTART: 'scannerDaemon.enableAutostart',
    STATUS_CHANGED: 'scannerDaemon.statusChanged',
    SCAN_ECHO: 'scannerDaemon.scanEcho',
    STATUS_UPDATE: 'scannerDaemon.statusUpdate'
  });

  const SCANNER_WORKER_MESSAGES = Object.freeze({
    CONNECT_GRANTED: 'connectGranted',
    DISCONNECT: 'disconnect',
    GET_STATUS: 'getStatus',
    REFRESH_PORTS: 'refreshPorts',
    STATUS: 'status',
    REPLY: 'reply',
    SCAN: 'scan'
  });

  const SCANNER_STATUS_STATES = Object.freeze({
    STOPPING: 'stopping',
    UNAVAILABLE: 'unavailable',
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
      lastKnownCaptureAt: '',
      captureCount: 0,
      selectionRequired: false,
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
      lastKnownCaptureAt: normalizeIsoTimestamp(source.lastKnownCaptureAt),
      captureCount: Math.max(0, Number.parseInt(source.captureCount, 10) || 0),
      selectionRequired: source.selectionRequired === true,
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

  globalThis.VaxLinkScannerDaemon = Object.freeze({
    SCANNER_DAEMON_ENABLED_KEY,
    SCANNER_STATUS_SNAPSHOT_KEY,
    SCANNER_DAEMON_OFFSCREEN_PATH,
    SCANNER_DAEMON_TARGET,
    SCANNER_DAEMON_BACKGROUND_TARGET,
    SCANNER_DAEMON_ACTIONS,
    SCANNER_WORKER_MESSAGES,
    SCANNER_STATUS_STATES,
    normalizeScannerPortInfo,
    createScannerStatusSnapshot,
    normalizeScannerStatusSnapshot,
    buildDefaultScannerStatus
  });
})();
