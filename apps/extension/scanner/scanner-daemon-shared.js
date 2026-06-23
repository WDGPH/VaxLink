export const SCANNER_DAEMON_ENABLED_KEY = 'vaxlink_scanner_daemon_enabled_v1';
export const SCANNER_STATUS_SNAPSHOT_KEY = 'vaxlink_scanner_status_snapshot_v1';
export const SCANNER_DAEMON_OFFSCREEN_PATH = 'scanner-daemon.html';
export const SCANNER_DAEMON_TARGET = 'scannerDaemon';
export const SCANNER_DAEMON_BACKGROUND_TARGET = 'scannerDaemonBackground';

export const SCANNER_DAEMON_ACTIONS = Object.freeze({
  ENSURE: 'scannerDaemon.ensure',
  GET_STATUS: 'scannerDaemon.getStatus',
  CONNECT_GRANTED: 'scannerDaemon.connectGranted',
  DISCONNECT: 'scannerDaemon.disconnect',
  ENABLE_AUTOSTART: 'scannerDaemon.enableAutostart',
  STATUS_CHANGED: 'scannerDaemon.statusChanged',
  SCAN_ECHO: 'scannerDaemon.scanEcho',
  STATUS_UPDATE: 'scannerDaemon.statusUpdate'
});

export const SCANNER_STATUS_STATES = Object.freeze({
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
const RECONNECT_DELAYS_MS = [0, 1000, 3000, 10000, 30000, 60000];

function normalizeIsoTimestamp(value) {
  if (!value) return '';
  const parsed = new Date(String(value).trim());
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

export function normalizeScannerPortInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const normalized = {};
  if (info.usbVendorId !== undefined && info.usbVendorId !== null && info.usbVendorId !== '') {
    const vendorId = Number(info.usbVendorId);
    if (Number.isFinite(vendorId)) normalized.usbVendorId = vendorId;
  }
  if (info.usbProductId !== undefined && info.usbProductId !== null && info.usbProductId !== '') {
    const productId = Number(info.usbProductId);
    if (Number.isFinite(productId)) normalized.usbProductId = productId;
  }
  if (info.bluetoothServiceClassId) {
    normalized.bluetoothServiceClassId = String(info.bluetoothServiceClassId);
  }
  return Object.keys(normalized).length ? normalized : null;
}

export function createScannerStatusSnapshot(overrides = {}) {
  return normalizeScannerStatusSnapshot({
    state: SCANNER_STATUS_STATES.NEVER_CONFIGURED,
    profileId: '',
    portInfo: null,
    lastConnectedAt: '',
    lastDisconnectedAt: '',
    lastError: '',
    recoverAttemptCount: 0,
    ...overrides
  });
}

export function normalizeScannerStatusSnapshot(snapshot) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return {
    state: VALID_SCANNER_STATES.has(source.state)
      ? source.state
      : SCANNER_STATUS_STATES.NEVER_CONFIGURED,
    profileId: String(source.profileId || '').trim(),
    portInfo: normalizeScannerPortInfo(source.portInfo),
    lastConnectedAt: normalizeIsoTimestamp(source.lastConnectedAt),
    lastDisconnectedAt: normalizeIsoTimestamp(source.lastDisconnectedAt),
    lastError: String(source.lastError || '').trim(),
    recoverAttemptCount: Math.max(0, Number.parseInt(source.recoverAttemptCount, 10) || 0)
  };
}

export function buildDefaultScannerStatus({ enabled = false, profileId = '', portInfo = null } = {}) {
  const normalizedProfileId = String(profileId || '').trim();
  if (!normalizedProfileId) {
    return createScannerStatusSnapshot();
  }
  return createScannerStatusSnapshot({
    state: enabled ? SCANNER_STATUS_STATES.WAITING_FOR_DEVICE : SCANNER_STATUS_STATES.DISABLED,
    profileId: normalizedProfileId,
    portInfo: normalizeScannerPortInfo(portInfo)
  });
}

export function isScannerConnected(status) {
  return normalizeScannerStatusSnapshot(status).state === SCANNER_STATUS_STATES.CONNECTED;
}

export function shouldShowScannerWorkflowBanner(mode, status) {
  const normalizedMode = mode === 'multiple' || mode === 'inventory' ? mode : 'single';
  return normalizedMode !== 'single' && !isScannerConnected(status);
}

export function getScannerReconnectDelayMs(attemptCount) {
  const attempt = Math.max(0, Number.parseInt(attemptCount, 10) || 0);
  return RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
}

export function portInfoMatches(preferredInfo, candidateInfo) {
  const preferred = normalizeScannerPortInfo(preferredInfo);
  const candidate = normalizeScannerPortInfo(candidateInfo);
  if (!preferred || !candidate) return false;
  const keys = ['usbVendorId', 'usbProductId', 'bluetoothServiceClassId'];
  let compared = 0;
  for (const key of keys) {
    if (preferred[key] === undefined) continue;
    compared += 1;
    if (candidate[key] !== preferred[key]) return false;
  }
  return compared > 0;
}

export function selectGrantedPort(ports, profile, preferredPortInfo, profileMatcher) {
  const candidates = Array.isArray(ports) ? ports.filter(Boolean) : [];
  if (!candidates.length) {
    return { port: null, reason: 'none' };
  }

  const preferred = candidates.find((candidate) => {
    const info = typeof candidate.getInfo === 'function' ? candidate.getInfo() : null;
    return portInfoMatches(preferredPortInfo, info);
  });
  if (preferred) {
    return { port: preferred, reason: 'preferred' };
  }

  const matchesProfile = typeof profileMatcher === 'function'
    ? candidates.find((candidate) => profileMatcher(candidate, profile))
    : null;
  if (matchesProfile) {
    return { port: matchesProfile, reason: 'profile' };
  }

  return { port: candidates[0], reason: 'first' };
}

export function normalizeScannerErrorMessage(error) {
  if (!error) return '';
  if (typeof error === 'string') return error.trim();
  return String(error.message || error.name || error).trim();
}

export function classifyScannerConnectionFailure(error, fallbackState = SCANNER_STATUS_STATES.ERROR) {
  const rawMessage = normalizeScannerErrorMessage(error);
  const message = rawMessage.toLowerCase();
  const name = String(error?.name || '').toLowerCase();

  if (!rawMessage) {
    return {
      state: fallbackState,
      recoverable: false,
      message: 'Scanner connection failed.'
    };
  }

  if (
    name === 'networkerror' ||
    message.includes('networkerror') ||
    message.includes('device disconnected') ||
    message.includes('disconnected') ||
    message.includes('the port is closed') ||
    message.includes('reader has been released')
  ) {
    return {
      state: SCANNER_STATUS_STATES.RECOVERING,
      recoverable: true,
      message: rawMessage
    };
  }

  if (
    message.includes('access denied') ||
    message.includes('resource busy') ||
    message.includes('already open') ||
    message.includes('the port is already open') ||
    message.includes('failed to open serial port') ||
    message.includes('busy')
  ) {
    return {
      state: SCANNER_STATUS_STATES.BUSY,
      recoverable: false,
      message: rawMessage
    };
  }

  if (
    name === 'securityerror' ||
    name === 'notallowederror' ||
    message.includes('permission') ||
    message.includes('not allowed') ||
    message.includes('denied') ||
    message.includes('security')
  ) {
    return {
      state: SCANNER_STATUS_STATES.PERMISSION_LOST,
      recoverable: false,
      message: rawMessage
    };
  }

  if (
    message.includes('no previously granted serial port') ||
    message.includes('no granted port') ||
    message.includes('select scanner first')
  ) {
    return {
      state: SCANNER_STATUS_STATES.NEVER_CONFIGURED,
      recoverable: false,
      message: rawMessage
    };
  }

  if (
    name === 'notfounderror' ||
    message.includes('not found') ||
    message.includes('device unavailable') ||
    message.includes('no port matching')
  ) {
    return {
      state: SCANNER_STATUS_STATES.WAITING_FOR_DEVICE,
      recoverable: false,
      message: rawMessage
    };
  }

  return {
    state: fallbackState,
    recoverable: false,
    message: rawMessage
  };
}

export function buildScannerStatusDescriptor(status, mode = 'single') {
  const snapshot = normalizeScannerStatusSnapshot(status);
  const canBanner = shouldShowScannerWorkflowBanner(mode, snapshot);
  const descriptor = {
    label: 'Disconnected',
    detail: 'Scanner connection is unavailable.',
    tone: 'info',
    showReconnect: false,
    showSetup: true,
    bannerText: '',
    bannerTone: 'warning'
  };

  switch (snapshot.state) {
    case SCANNER_STATUS_STATES.CONNECTED:
      descriptor.label = 'Connected';
      descriptor.detail = 'Scanner online. Hands-free capture is active.';
      descriptor.tone = 'success';
      descriptor.showSetup = true;
      break;
    case SCANNER_STATUS_STATES.STARTING:
      descriptor.label = 'Connecting';
      descriptor.detail = 'VaxLink is starting the station scanner.';
      descriptor.tone = 'info';
      break;
    case SCANNER_STATUS_STATES.RECOVERING:
      descriptor.label = 'Recovering';
      descriptor.detail = 'Scanner link dropped. Retrying automatically.';
      descriptor.tone = 'warning';
      descriptor.showReconnect = true;
      descriptor.bannerText = 'Scanner link dropped. VaxLink is retrying automatically.';
      break;
    case SCANNER_STATUS_STATES.NEVER_CONFIGURED:
      descriptor.label = 'Needs Setup';
      descriptor.detail = 'No granted scanner found. Open setup once to pair.';
      descriptor.tone = 'warning';
      descriptor.bannerText = 'Scanner setup is required before unattended scan capture will work.';
      break;
    case SCANNER_STATUS_STATES.WAITING_FOR_DEVICE:
      descriptor.label = 'Disconnected';
      descriptor.detail = 'Scanner not detected. Reconnect the cradle or power it on.';
      descriptor.tone = 'warning';
      descriptor.showReconnect = true;
      descriptor.bannerText = 'Scanner is offline. New scans will not be captured until it reconnects.';
      break;
    case SCANNER_STATUS_STATES.PERMISSION_LOST:
      descriptor.label = 'Needs Setup';
      descriptor.detail = 'Scanner permission was lost. Open setup to grant the port again.';
      descriptor.tone = 'error';
      descriptor.bannerText = 'Scanner permission was lost. Open setup to re-grant access.';
      descriptor.bannerTone = 'error';
      break;
    case SCANNER_STATUS_STATES.BUSY:
      descriptor.label = 'Busy in Another App';
      descriptor.detail = 'Scanner is unavailable because another app or browser context is using the COM port.';
      descriptor.tone = 'error';
      descriptor.showReconnect = true;
      descriptor.bannerText = 'Scanner COM port is busy in another app. Release it, then reconnect.';
      descriptor.bannerTone = 'error';
      break;
    case SCANNER_STATUS_STATES.DISABLED:
      descriptor.label = 'Disconnected';
      descriptor.detail = 'Scanner is disconnected for this session.';
      descriptor.tone = 'info';
      descriptor.showReconnect = true;
      descriptor.bannerText = 'Scanner capture is paused for this session.';
      break;
    case SCANNER_STATUS_STATES.ERROR:
      descriptor.label = 'Disconnected';
      descriptor.detail = snapshot.lastError || 'Scanner connection failed.';
      descriptor.tone = 'error';
      descriptor.showReconnect = true;
      descriptor.bannerText = 'Scanner connection failed. Reconnect to resume unattended scan capture.';
      descriptor.bannerTone = 'error';
      break;
    default:
      break;
  }

  if (!canBanner) {
    descriptor.bannerText = '';
  }

  return descriptor;
}
