import './capability.js';
import {
  SCANNER_DAEMON_ACTIONS,
  SCANNER_STATUS_STATES,
  normalizeScannerPortInfo,
  normalizeScannerStatusSnapshot,
  selectGrantedPort
} from './scanner/scanner-daemon-shared.js';
import {
  SERIAL_SCANNER_PROFILES,
  SCANNER_PORT_INFO_STORAGE_KEY,
  SCANNER_PROFILE_STORAGE_KEY,
  formatUsbId,
  getSerialScannerProfile,
  portMatchesProfile
} from './scanner/serial-profiles.js';
import {
  getGrantedSerialScannerPorts,
  isWebSerialSupported,
  requestSerialScannerPort
} from './scanner/serial-provider.js';

let scannerStatusSnapshot = normalizeScannerStatusSnapshot(null);

const els = {};

document.addEventListener('DOMContentLoaded', () => {
  [
    'profileSelect',
    'profileNote',
    'requestPortBtn',
    'connectGrantedBtn',
    'disconnectBtn',
    'connectionStatus',
    'deviceProfile',
    'deviceVendor',
    'deviceProduct',
    'deviceState'
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });

  renderProfiles();
  bindEvents();
  initializePage();
  if (globalThis.VaxLinkDiagnostics?.enabled) {
    void import('./diagnostics/scanner-test-ui.js').then(
      ({ mountScannerTest }) =>
        mountScannerTest(document.querySelector('.grid'))
    );
  }
});

function bindEvents() {
  els.profileSelect?.addEventListener('change', () => {
    const profile = getSelectedProfile();
    renderProfileNote(profile);
    chrome.storage.local.set({ [SCANNER_PROFILE_STORAGE_KEY]: profile.id });
  });

  els.requestPortBtn?.addEventListener('click', () => {
    void requestAndOpenPort();
  });

  els.connectGrantedBtn?.addEventListener('click', () => {
    void reconnectGrantedPort();
  });

  els.disconnectBtn?.addEventListener('click', () => {
    void disconnectActivePort();
  });
}

chrome.runtime.onMessage.addListener((request) => {
  if (
    request?.action === SCANNER_DAEMON_ACTIONS.STATUS_CHANGED &&
    request.status
  ) {
    applyDaemonStatus(request.status);
  }
  return false;
});

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

function applyDaemonStatus(status) {
  scannerStatusSnapshot = normalizeScannerStatusSnapshot(status);
  const profile = getSerialScannerProfile(
    scannerStatusSnapshot.profileId || getSelectedProfile()?.id
  );
  if (scannerStatusSnapshot.portInfo) {
    updateDevicePanel(profile, scannerStatusSnapshot.portInfo);
  }
  const state = scannerStatusSnapshot.state;
  const connected = state === SCANNER_STATUS_STATES.CONNECTED;
  const tone = connected
    ? 'success'
    : state === SCANNER_STATUS_STATES.ERROR ||
        state === SCANNER_STATUS_STATES.BUSY
      ? 'error'
      : 'info';
  const message = connected
    ? scannerStatusSnapshot.captureCount > 0
      ? `${profile.label} is connected through Web Serial. Hardware captures since daemon start: ${scannerStatusSnapshot.captureCount}; latest ${scannerStatusSnapshot.lastCaptureAt || 'time unavailable'}.`
      : `${profile.label} is connected through Web Serial, but no hardware scan has reached the daemon yet.`
    : scannerStatusSnapshot.lastError ||
      `Scanner daemon state: ${state.replaceAll('_', ' ')}.`;
  setStatus(els.connectionStatus, message, tone);
  updateDeviceState(connected ? 'Connected in background' : state);
  setButtons({ canConnect: !connected, canDisconnect: connected });
}

function initializePage() {
  if (!isWebSerialSupported()) {
    setStatus(
      els.connectionStatus,
      'Web Serial is not available in this browser context.',
      'error'
    );
    setButtons({ canConnect: false, canDisconnect: false });
    return;
  }

  chrome.storage.local.get(
    [SCANNER_PROFILE_STORAGE_KEY, SCANNER_PORT_INFO_STORAGE_KEY],
    (stored) => {
      const profile = getSerialScannerProfile(
        stored && stored[SCANNER_PROFILE_STORAGE_KEY]
      );
      const portInfo = normalizeScannerPortInfo(
        stored && stored[SCANNER_PORT_INFO_STORAGE_KEY]
      );
      els.profileSelect.value = profile.id;
      renderProfileNote(profile);
      if (portInfo) updateDevicePanel(profile, portInfo);
      void sendScannerDaemonCommand(SCANNER_DAEMON_ACTIONS.GET_STATUS)
        .then((response) => applyDaemonStatus(response.status))
        .catch((error) =>
          setStatus(els.connectionStatus, error.message, 'error')
        );
    }
  );

  navigator.serial.addEventListener('connect', () => {
    setStatus(
      els.connectionStatus,
      'Serial device connected. Use Reconnect Granted Port or Select Scanner.',
      'info'
    );
  });

  navigator.serial.addEventListener('disconnect', () => {
    setStatus(
      els.connectionStatus,
      'Serial device disconnected. The background daemon will retry automatically.',
      'warning'
    );
  });

  setStatus(
    els.connectionStatus,
    'Ready. Select the scanner once; the background daemon will keep it connected after this tab closes.',
    'info'
  );
  setButtons({ canConnect: true, canDisconnect: false });
}

function renderProfiles() {
  els.profileSelect.innerHTML = SERIAL_SCANNER_PROFILES.map(
    (profile) =>
      `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.label)}</option>`
  ).join('');
  renderProfileNote(getSelectedProfile());
}

function renderProfileNote(profile) {
  if (els.profileNote) {
    els.profileNote.textContent = profile.setupNote || '';
  }
}

function getSelectedProfile() {
  return getSerialScannerProfile(els.profileSelect?.value);
}

async function requestAndOpenPort() {
  const profile = getSelectedProfile();
  try {
    setButtons({ canConnect: false, canDisconnect: false });
    setStatus(
      els.connectionStatus,
      'Waiting for browser scanner selection...',
      'info'
    );
    const port = await requestSerialScannerPort(profile);
    const portInfo = normalizeScannerPortInfo(port.getInfo());
    updateDevicePanel(profile, portInfo);
    const response = await sendScannerDaemonCommand(
      SCANNER_DAEMON_ACTIONS.CONNECT_GRANTED,
      {
        profileId: profile.id,
        preferredPortInfo: portInfo,
        enableAutostart: true,
        trigger: 'setup_permission_granted'
      }
    );
    applyDaemonStatus(response.status);
    setStatus(
      els.connectionStatus,
      'Permission granted. The background scanner daemon is connecting; this tab may be closed.',
      'success'
    );
  } catch (error) {
    const message = error.message || 'Scanner selection failed.';
    setStatus(els.connectionStatus, message, 'error');
    setButtons({ canConnect: true, canDisconnect: false });
  }
}

async function reconnectGrantedPort() {
  const profile = getSelectedProfile();
  try {
    setButtons({ canConnect: false, canDisconnect: false });
    const ports = await getGrantedSerialScannerPorts();
    const stored = await new Promise((resolve, reject) => {
      chrome.storage.local.get([SCANNER_PORT_INFO_STORAGE_KEY], (values) => {
        if (chrome.runtime.lastError)
          reject(new Error(chrome.runtime.lastError.message));
        else resolve(values);
      });
    });
    const preferredPortInfo = normalizeScannerPortInfo(
      stored?.[SCANNER_PORT_INFO_STORAGE_KEY]
    );
    const selection = selectGrantedPort(
      ports,
      profile,
      preferredPortInfo,
      portMatchesProfile
    );
    if (!selection.port) {
      throw new Error(
        'Cannot identify the selected scanner. Use Select Scanner; if identical devices are granted, remove unneeded browser permissions first.'
      );
    }
    const response = await sendScannerDaemonCommand(
      SCANNER_DAEMON_ACTIONS.CONNECT_GRANTED,
      {
        profileId: profile.id,
        preferredPortInfo:
          preferredPortInfo ||
          normalizeScannerPortInfo(selection.port.getInfo()),
        enableAutostart: true,
        trigger: 'setup_reconnect'
      }
    );
    applyDaemonStatus(response.status);
    setStatus(
      els.connectionStatus,
      'Reconnect requested. The background daemon will keep retrying if the scanner is temporarily unavailable.',
      'success'
    );
  } catch (error) {
    const message = error.message || 'Reconnect failed.';
    setStatus(els.connectionStatus, message, 'error');
    setButtons({ canConnect: true, canDisconnect: false });
  }
}

async function disconnectActivePort(options = {}) {
  await sendScannerDaemonCommand(SCANNER_DAEMON_ACTIONS.DISCONNECT, {
    trigger: 'setup_disconnect'
  });
  setButtons({ canConnect: true, canDisconnect: false });
  if (!options.quiet)
    setStatus(
      els.connectionStatus,
      'Background scanner disconnected.',
      'warning'
    );
}

function updateDevicePanel(profile, info = {}) {
  els.deviceProfile.textContent = profile.label;
  els.deviceVendor.textContent = formatUsbId(info.usbVendorId);
  els.deviceProduct.textContent = formatUsbId(info.usbProductId);
  updateDeviceState('Connected');
}

function updateDeviceState(state) {
  if (els.deviceState) {
    els.deviceState.textContent = state;
  }
  if (state === 'Disconnected') {
    els.deviceProfile.textContent = 'Not connected';
    els.deviceVendor.textContent = 'Unknown';
    els.deviceProduct.textContent = 'Unknown';
  }
}

function setButtons({ canConnect, canDisconnect }) {
  if (els.requestPortBtn) els.requestPortBtn.disabled = !canConnect;
  if (els.connectGrantedBtn) els.connectGrantedBtn.disabled = !canConnect;
  if (els.disconnectBtn) els.disconnectBtn.disabled = !canDisconnect;
}

function setStatus(el, message, type = 'info') {
  if (!el) return;
  el.textContent = message;
  el.className = `status ${type}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
