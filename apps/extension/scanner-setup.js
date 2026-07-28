import {
  SCANNER_DAEMON_ACTIONS,
  SCANNER_STATUS_STATES,
  normalizeScannerPortInfo,
  normalizeScannerStatusSnapshot
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
let lastLeakageInputAt = 0;

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
    'deviceState',
    'decodedOutput',
    'rawBytesOutput',
    'leakageInput',
    'leakageStatus',
    'routeStatus'
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });

  renderProfiles();
  bindEvents();
  initializePage();
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

  els.leakageInput?.addEventListener('input', () => {
    lastLeakageInputAt = Date.now();
  });

}

chrome.runtime.onMessage.addListener((request) => {
  if (request?.action === SCANNER_DAEMON_ACTIONS.STATUS_CHANGED && request.status) {
    applyDaemonStatus(request.status);
  }
  if (request?.action === SCANNER_DAEMON_ACTIONS.SCAN_ECHO && request.scan) {
    els.decodedOutput.textContent = request.scan.rawText || '';
    els.rawBytesOutput.textContent = request.scan.rawBytesHex || 'No raw bytes captured.';
    checkKeyboardLeakage(request.scan.rawText || '');
    renderDaemonRouteResult(request.response || {});
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
  const profile = getSerialScannerProfile(scannerStatusSnapshot.profileId || getSelectedProfile()?.id);
  if (scannerStatusSnapshot.portInfo) {
    updateDevicePanel(profile, scannerStatusSnapshot.portInfo);
  }
  const state = scannerStatusSnapshot.state;
  const connected = state === SCANNER_STATUS_STATES.CONNECTED;
  const tone = connected ? 'success' : (state === SCANNER_STATUS_STATES.ERROR || state === SCANNER_STATUS_STATES.BUSY ? 'error' : 'info');
  const message = connected
    ? (scannerStatusSnapshot.captureCount > 0
      ? `${profile.label} is connected through Web Serial. Hardware captures since daemon start: ${scannerStatusSnapshot.captureCount}; latest ${scannerStatusSnapshot.lastCaptureAt || 'time unavailable'}.`
      : `${profile.label} is connected through Web Serial, but no hardware scan has reached the daemon yet.`)
    : (scannerStatusSnapshot.lastError || `Scanner daemon state: ${state.replaceAll('_', ' ')}.`);
  setStatus(els.connectionStatus, message, tone);
  updateDeviceState(connected ? 'Connected in background' : state);
  setButtons({ canConnect: !connected, canDisconnect: connected });
}

function renderDaemonRouteResult(response) {
  if (response?.locked) {
    setStatus(els.routeStatus, `Scan saved while locked to the Multiple Inject queue (${response.queueSizeAfter || 0}).`, 'success');
    return;
  }
  if (response?.routed) {
    renderChartRouteResult(response);
    return;
  }
  if (response?.queuedToWorkflow) {
    setStatus(els.routeStatus, `Scan saved to the ${response.workflow || 'multiple'} queue (${response.queueSizeAfter || 0}).`, 'success');
    return;
  }
  setStatus(els.routeStatus, response?.error || 'Scan captured by daemon.', response?.success === false ? 'error' : 'info');
}

function initializePage() {
  if (!isWebSerialSupported()) {
    setStatus(els.connectionStatus, 'Web Serial is not available in this browser context.', 'error');
    setButtons({ canConnect: false, canDisconnect: false });
    return;
  }

  chrome.storage.local.get([SCANNER_PROFILE_STORAGE_KEY, SCANNER_PORT_INFO_STORAGE_KEY], (stored) => {
    const profile = getSerialScannerProfile(stored && stored[SCANNER_PROFILE_STORAGE_KEY]);
    const portInfo = normalizeScannerPortInfo(stored && stored[SCANNER_PORT_INFO_STORAGE_KEY]);
    els.profileSelect.value = profile.id;
    renderProfileNote(profile);
    if (portInfo) updateDevicePanel(profile, portInfo);
    void sendScannerDaemonCommand(SCANNER_DAEMON_ACTIONS.GET_STATUS)
      .then((response) => applyDaemonStatus(response.status))
      .catch((error) => setStatus(els.connectionStatus, error.message, 'error'));
  });

  navigator.serial.addEventListener('connect', () => {
    setStatus(els.connectionStatus, 'Serial device connected. Use Reconnect Granted Port or Select Scanner.', 'info');
  });

  navigator.serial.addEventListener('disconnect', () => {
    setStatus(els.connectionStatus, 'Serial device disconnected. The background daemon will retry automatically.', 'warning');
  });

  setStatus(els.connectionStatus, 'Ready. Select the scanner once; the background daemon will keep it connected after this tab closes.', 'info');
  setButtons({ canConnect: true, canDisconnect: false });
}

function renderProfiles() {
  els.profileSelect.innerHTML = SERIAL_SCANNER_PROFILES.map((profile) => (
    `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.label)}</option>`
  )).join('');
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
    setStatus(els.connectionStatus, 'Waiting for browser scanner selection...', 'info');
    const port = await requestSerialScannerPort(profile);
    const portInfo = normalizeScannerPortInfo(port.getInfo());
    updateDevicePanel(profile, portInfo);
    const response = await sendScannerDaemonCommand(SCANNER_DAEMON_ACTIONS.CONNECT_GRANTED, {
      profileId: profile.id,
      preferredPortInfo: portInfo,
      enableAutostart: true,
      trigger: 'setup_permission_granted'
    });
    applyDaemonStatus(response.status);
    setStatus(els.connectionStatus, 'Permission granted. The background scanner daemon is connecting; this tab may be closed.', 'success');
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
    const port = ports.find((candidate) => portMatchesProfile(candidate, profile)) || ports[0];
    if (!port) {
      throw new Error('No previously granted serial port found. Use Select Scanner first.');
    }
    const response = await sendScannerDaemonCommand(SCANNER_DAEMON_ACTIONS.CONNECT_GRANTED, {
      profileId: profile.id,
      preferredPortInfo: normalizeScannerPortInfo(port.getInfo()),
      enableAutostart: true,
      trigger: 'setup_reconnect'
    });
    applyDaemonStatus(response.status);
    setStatus(els.connectionStatus, 'Reconnect requested. The background daemon will keep retrying if the scanner is temporarily unavailable.', 'success');
  } catch (error) {
    const message = error.message || 'Reconnect failed.';
    setStatus(els.connectionStatus, message, 'error');
    setButtons({ canConnect: true, canDisconnect: false });
  }
}

async function disconnectActivePort(options = {}) {
  await sendScannerDaemonCommand(SCANNER_DAEMON_ACTIONS.DISCONNECT, { trigger: 'setup_disconnect' });
  setButtons({ canConnect: true, canDisconnect: false });
  if (!options.quiet) setStatus(els.connectionStatus, 'Background scanner disconnected.', 'warning');
}

function renderChartRouteResult(response) {
  const chartResult = response?.response || {};
  if (chartResult.success) {
    if (chartResult.duplicate_ignored) {
      setStatus(els.routeStatus, `Duplicate scan ignored by chart tab ${response.tabId}.`, 'warning');
      return;
    }
    setStatus(els.routeStatus, `Scan routed to chart tab ${response.tabId}.`, 'success');
    return;
  }
  if (chartResult.pending) {
    setStatus(els.routeStatus, `Scan reached chart tab ${response.tabId}. Chart action is required before autofill can finish.`, 'warning');
    return;
  }
  if (chartResult.command_handled) {
    setStatus(els.routeStatus, `VaxLink scanner command handled by tab ${response.tabId}.`, 'success');
    return;
  }
  const message = chartResult.error || chartResult.status || 'Chart received the scan, but autofill did not complete.';
  setStatus(els.routeStatus, `Scan reached chart tab ${response.tabId}, but ${message}`, 'error');
}

function checkKeyboardLeakage(rawText) {
  const before = String(els.leakageInput.value || '');
  const startedAt = Date.now();
  setTimeout(() => {
    const after = String(els.leakageInput.value || '');
    const recentInput = lastLeakageInputAt >= startedAt - 250;
    const leakedText = normalizeForLeakage(after).includes(normalizeForLeakage(rawText));
    if (recentInput || (after !== before && leakedText)) {
      setStatus(
        els.leakageStatus,
        'Scanner is still emitting keyboard input. Reconfigure the scanner/cradle to USB CDC only and disable HID keyboard output.',
        'error'
      );
      return;
    }
    setStatus(els.leakageStatus, 'No keyboard leakage detected for the latest serial scan.', 'success');
  }, 350);
}

function normalizeForLeakage(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
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
