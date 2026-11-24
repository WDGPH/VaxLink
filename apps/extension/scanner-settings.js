import {
  SCANNER_DAEMON_ACTIONS,
  SCANNER_STATUS_STATES,
  normalizeScannerStatusSnapshot,
  getScannerConnectionLabel
} from './scanner/scanner-daemon-shared.js';
import {
  formatUsbId,
  getSerialScannerProfile
} from './scanner/serial-profiles.js';
import { isWebSerialSupported } from './scanner/serial-provider.js';

let statusChangeVersion = 0;

const els = {};
export function initializeScannerSettings() {
  if (els.connectionStatus || !document.getElementById('connectionStatus'))
    return;
  [
    'requestPortBtn',
    'connectGrantedBtn',
    'disconnectBtn',
    'forgetScannerBtn',
    'scannerActionNotice',
    'connectionStatus',
    'scannerIdentity'
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });
  bindEvents();
  if (!isWebSerialSupported()) {
    setStatus(
      els.connectionStatus,
      'Web Serial is not available in this browser.',
      'error'
    );
    setButtons({ canConnect: false, canDisconnect: false });
    return;
  }
  chrome.runtime.onMessage.addListener((request) => {
    if (
      request?.action === SCANNER_DAEMON_ACTIONS.STATUS_CHANGED &&
      request.status
    ) {
      void refreshStatus();
    }
    return false;
  });
  void refreshStatus();
}

function bindEvents() {
  els.requestPortBtn?.addEventListener('click', () => {
    openPairingWindow();
  });

  els.connectGrantedBtn?.addEventListener('click', () => {
    void reconnectGrantedPort();
  });

  els.disconnectBtn?.addEventListener('click', () =>
    stopScanner(SCANNER_DAEMON_ACTIONS.DISCONNECT)
  );
  els.forgetScannerBtn?.addEventListener('click', () =>
    stopScanner(SCANNER_DAEMON_ACTIONS.FORGET)
  );
}

function sendScannerDaemonCommand(action, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || response.success !== true) {
        reject(new Error(response?.error || 'Scanner daemon command failed.'));
        return;
      }
      resolve(response);
    });
  });
}

function applyDaemonStatus(status, source = 'live') {
  const scannerStatusSnapshot = normalizeScannerStatusSnapshot(status);
  const profile = getSerialScannerProfile(scannerStatusSnapshot.profileId);
  const state = scannerStatusSnapshot.state;
  const connected =
    state === SCANNER_STATUS_STATES.CONNECTED &&
    source === 'live' &&
    !scannerStatusSnapshot.testing;
  const tone = connected
    ? 'success'
    : source === 'live' &&
        (state === SCANNER_STATUS_STATES.ERROR ||
          state === SCANNER_STATUS_STATES.BUSY ||
          state === SCANNER_STATUS_STATES.UNAVAILABLE)
      ? 'error'
      : 'info';
  setStatus(
    els.connectionStatus,
    [
      getScannerConnectionLabel(status, source),
      source === 'live' ? scannerStatusSnapshot.lastError : '',
      source !== 'live' && scannerStatusSnapshot.lastKnownCaptureAt
        ? `Last known capture ${new Date(scannerStatusSnapshot.lastKnownCaptureAt).toLocaleString()}.`
        : ''
    ]
      .filter(Boolean)
      .join(': '),
    tone
  );
  const identityKnown = !!scannerStatusSnapshot.profileId;
  const { usbVendorId, usbProductId } = scannerStatusSnapshot.portInfo || {};
  const usb =
    usbVendorId != null && usbProductId != null
      ? ` [USB ${formatUsbId(usbVendorId)}:${formatUsbId(usbProductId)}]`
      : '';
  els.scannerIdentity.hidden = !identityKnown;
  els.scannerIdentity.textContent = identityKnown
    ? `${connected ? 'Scanner' : 'Saved scanner'}: ${profile.label}${usb}`
    : '';
  const stopping = state === SCANNER_STATUS_STATES.STOPPING;
  const starting = state === SCANNER_STATUS_STATES.STARTING;
  const retryStop = state === SCANNER_STATUS_STATES.UNAVAILABLE;
  const needsSetup =
    state === SCANNER_STATUS_STATES.PERMISSION_LOST ||
    scannerStatusSnapshot.selectionRequired;
  const testing = scannerStatusSnapshot.testing;
  const canStop =
    retryStop ||
    (identityKnown &&
      !testing &&
      !needsSetup &&
      state !== SCANNER_STATUS_STATES.DISABLED);
  setButtons({
    canConnect: !stopping && !starting && !retryStop && !testing,
    canDisconnect: canStop && !stopping
  });
  els.connectGrantedBtn.hidden =
    connected ||
    !identityKnown ||
    needsSetup ||
    starting ||
    stopping ||
    retryStop ||
    testing;
  els.disconnectBtn.hidden = !(canStop || stopping);
  if (els.forgetScannerBtn) {
    els.forgetScannerBtn.hidden = !identityKnown;
    els.forgetScannerBtn.disabled = stopping || testing;
  }
}

async function refreshStatus() {
  const version = ++statusChangeVersion;
  try {
    const result = await sendScannerDaemonCommand(
      SCANNER_DAEMON_ACTIONS.GET_STATUS
    );
    if (version === statusChangeVersion)
      applyDaemonStatus(result.status, result.source);
  } catch (error) {
    if (version === statusChangeVersion)
      setStatus(els.connectionStatus, error.message, 'error');
  }
}

function openPairingWindow() {
  // Chrome anchors extension device choosers to its extensions toolbar.
  // A popup window lacks that toolbar, so use a standard browser window.
  chrome.windows.create(
    {
      url: chrome.runtime.getURL('scanner-pairing.html'),
      type: 'normal',
      width: 500,
      height: 440,
      focused: true
    },
    () => {
      if (chrome.runtime.lastError)
        setStatus(
          els.connectionStatus,
          chrome.runtime.lastError.message,
          'error'
        );
    }
  );
}

async function reconnectGrantedPort() {
  setStatus(els.scannerActionNotice, '');
  setButtons({ canConnect: false, canDisconnect: true });
  setStatus(els.connectionStatus, 'Connecting…', 'info');
  try {
    await sendScannerDaemonCommand(SCANNER_DAEMON_ACTIONS.CONNECT_GRANTED, {
      enableAutostart: true
    });
    await refreshStatus();
  } catch (error) {
    setStatus(els.connectionStatus, error.message, 'error');
    setButtons({ canConnect: true, canDisconnect: false });
  }
}

async function stopScanner(action) {
  setStatus(els.scannerActionNotice, '');
  setButtons({ canConnect: false, canDisconnect: false });
  if (els.forgetScannerBtn) els.forgetScannerBtn.disabled = true;
  try {
    const result = await sendScannerDaemonCommand(action);
    if (action === SCANNER_DAEMON_ACTIONS.FORGET) {
      setStatus(
        els.scannerActionNotice,
        result.permissionRemoved
          ? 'Saved scanner and browser permission cleared.'
          : 'Saved scanner cleared. You can remove any remaining serial port permission in your browser’s site settings.'
      );
    }
  } catch (error) {
    setStatus(els.scannerActionNotice, error.message, 'error');
  }
  await refreshStatus();
}

function setButtons({ canConnect, canDisconnect }) {
  if (els.requestPortBtn) els.requestPortBtn.disabled = !canConnect;
  if (els.connectGrantedBtn) els.connectGrantedBtn.disabled = !canConnect;
  if (els.disconnectBtn) els.disconnectBtn.disabled = !canDisconnect;
}

function setStatus(el, message, type = 'info') {
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
  el.className = `status ${type}`;
}
