import './scanner-status.js';

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
  STATUS_UPDATE: 'scannerDaemon.statusUpdate'
});

export const {
  SCANNER_STATUS_STATES,
  normalizeScannerPortInfo,
  createScannerStatusSnapshot,
  normalizeScannerStatusSnapshot,
  buildDefaultScannerStatus
} = globalThis.VaxLinkScannerStatus;

const RECONNECT_DELAYS_MS = [0, 1000, 3000, 10000, 30000, 60000];

export function isScannerConnected(status) {
  return (
    normalizeScannerStatusSnapshot(status).state ===
    SCANNER_STATUS_STATES.CONNECTED
  );
}

export function shouldShowScannerWorkflowBanner(mode, status) {
  return !isScannerConnected(status);
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

export function selectGrantedPort(
  ports,
  profile,
  preferredPortInfo,
  profileMatcher
) {
  const candidates = Array.isArray(ports) ? ports.filter(Boolean) : [];
  if (!candidates.length) {
    return { port: null, reason: 'none' };
  }

  const preferred = normalizeScannerPortInfo(preferredPortInfo);
  if (preferred) {
    const matches = candidates.filter((candidate) => {
      const info =
        typeof candidate.getInfo === 'function' ? candidate.getInfo() : null;
      return portInfoMatches(preferred, info);
    });
    if (matches.length === 1) return { port: matches[0], reason: 'preferred' };
    return {
      port: null,
      reason: matches.length ? 'ambiguous' : 'preferred_missing'
    };
  }

  const matches =
    typeof profileMatcher === 'function'
      ? candidates.filter((candidate) => profileMatcher(candidate, profile))
      : [];
  if (matches.length === 1) return { port: matches[0], reason: 'profile' };
  return { port: null, reason: matches.length ? 'ambiguous' : 'no_match' };
}

export function normalizeScannerErrorMessage(error) {
  if (!error) return '';
  if (typeof error === 'string') return error.trim();
  return String(error.message || error.name || error).trim();
}

export function classifyScannerConnectionFailure(
  error,
  fallbackState = SCANNER_STATUS_STATES.ERROR
) {
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

export function buildScannerStatusDescriptor(
  status,
  mode = 'single',
  observation = null
) {
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
      descriptor.detail =
        snapshot.captureCount > 0
          ? `Scanner online. ${snapshot.captureCount} hardware scan(s) captured; latest ${snapshot.lastCaptureAt || 'time unavailable'}.`
          : 'Scanner online. No hardware scan has reached Web Serial since this daemon started.';
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
      descriptor.bannerText =
        'Scanner link dropped. VaxLink is retrying automatically.';
      break;
    case SCANNER_STATUS_STATES.NEVER_CONFIGURED:
      descriptor.label = 'Needs Setup';
      descriptor.detail = 'No granted scanner found. Open setup once to pair.';
      descriptor.tone = 'warning';
      descriptor.bannerText =
        'Scanner setup is required before unattended scan capture will work.';
      break;
    case SCANNER_STATUS_STATES.WAITING_FOR_DEVICE:
      descriptor.label = 'Disconnected';
      descriptor.detail =
        'Scanner not detected. Reconnect the cradle or power it on.';
      descriptor.tone = 'warning';
      descriptor.showReconnect = true;
      descriptor.bannerText =
        'Scanner is offline. New scans will not be captured until it reconnects.';
      break;
    case SCANNER_STATUS_STATES.PERMISSION_LOST:
      descriptor.label = 'Needs Setup';
      descriptor.detail =
        'Scanner permission was lost. Open setup to grant the port again.';
      descriptor.tone = 'error';
      descriptor.bannerText =
        'Scanner permission was lost. Open setup to re-grant access.';
      descriptor.bannerTone = 'error';
      break;
    case SCANNER_STATUS_STATES.BUSY:
      descriptor.label = 'Busy in Another App';
      descriptor.detail =
        'Scanner is unavailable because another app or browser context is using the COM port.';
      descriptor.tone = 'error';
      descriptor.showReconnect = true;
      descriptor.bannerText =
        'Scanner COM port is busy in another app. Release it, then reconnect.';
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
      descriptor.bannerText =
        'Scanner connection failed. Reconnect to resume unattended scan capture.';
      descriptor.bannerTone = 'error';
      break;
    default:
      break;
  }

  if (!canBanner) {
    descriptor.bannerText = '';
  }

  if (observation?.source === 'cached') {
    const age = Number.isFinite(observation.ageMs)
      ? `${Math.floor(observation.ageMs / 1000)} seconds old`
      : 'age unknown';
    descriptor.label = `Last known: ${descriptor.label}`;
    descriptor.detail = `Cached scanner status (${age}). ${descriptor.detail}`;
    if (snapshot.state === SCANNER_STATUS_STATES.CONNECTED)
      descriptor.tone = 'warning';
  }

  return descriptor;
}
