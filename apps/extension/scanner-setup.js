import { normalizeScanEvent } from './scanner/scanner-events.js';
import {
  SCANNER_DAEMON_ACTIONS,
  SCANNER_DAEMON_BACKGROUND_TARGET,
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
  openSerialScanner,
  requestSerialScannerPort
} from './scanner/serial-provider.js';

let activeConnection = null;
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

  window.addEventListener('pagehide', () => {
    if (!activeConnection) return;
    publishScannerStatus({
      state: SCANNER_STATUS_STATES.DISABLED,
      lastDisconnectedAt: new Date().toISOString(),
      lastError: 'Scanner setup page closed.'
    });
  });
}

function publishScannerStatus(overrides = {}) {
  scannerStatusSnapshot = normalizeScannerStatusSnapshot({
    ...scannerStatusSnapshot,
    ...overrides
  });
  chrome.runtime.sendMessage({
    target: SCANNER_DAEMON_BACKGROUND_TARGET,
    action: SCANNER_DAEMON_ACTIONS.STATUS_UPDATE,
    status: scannerStatusSnapshot
  }, () => {
    void chrome.runtime.lastError;
  });
}

function publishDisconnectedStatus(profile, portInfo, message = '') {
  publishScannerStatus({
    state: SCANNER_STATUS_STATES.DISABLED,
    profileId: profile?.id || scannerStatusSnapshot.profileId || '',
    portInfo: normalizeScannerPortInfo(portInfo || scannerStatusSnapshot.portInfo),
    lastDisconnectedAt: new Date().toISOString(),
    lastError: message
  });
}

function initializePage() {
  if (!isWebSerialSupported()) {
    setStatus(els.connectionStatus, 'Web Serial is not available in this browser context.', 'error');
    publishScannerStatus({
      state: SCANNER_STATUS_STATES.ERROR,
      lastError: 'Web Serial is not available in this browser context.'
    });
    setButtons({ canConnect: false, canDisconnect: false });
    return;
  }

  chrome.storage.local.get([SCANNER_PROFILE_STORAGE_KEY, SCANNER_PORT_INFO_STORAGE_KEY], (stored) => {
    const profile = getSerialScannerProfile(stored && stored[SCANNER_PROFILE_STORAGE_KEY]);
    const portInfo = normalizeScannerPortInfo(stored && stored[SCANNER_PORT_INFO_STORAGE_KEY]);
    els.profileSelect.value = profile.id;
    renderProfileNote(profile);
    publishDisconnectedStatus(profile, portInfo);
  });

  navigator.serial.addEventListener('connect', () => {
    setStatus(els.connectionStatus, 'Serial device connected. Use Reconnect Granted Port or Select Scanner.', 'info');
  });

  navigator.serial.addEventListener('disconnect', () => {
    setStatus(els.connectionStatus, 'Serial device disconnected.', 'warning');
    updateDeviceState('Disconnected');
    publishScannerStatus({
      state: SCANNER_STATUS_STATES.WAITING_FOR_DEVICE,
      lastDisconnectedAt: new Date().toISOString(),
      lastError: 'Serial device disconnected.'
    });
  });

  setStatus(els.connectionStatus, 'Ready. Select the scanner once, or reconnect a previously granted port.', 'info');
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
    await startPort(port, profile);
  } catch (error) {
    const message = error.message || 'Scanner selection failed.';
    setStatus(els.connectionStatus, message, 'error');
    publishScannerStatus({
      state: SCANNER_STATUS_STATES.ERROR,
      profileId: profile.id,
      lastError: message,
      lastDisconnectedAt: new Date().toISOString()
    });
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
    await startPort(port, profile);
  } catch (error) {
    const message = error.message || 'Reconnect failed.';
    setStatus(els.connectionStatus, message, 'error');
    publishScannerStatus({
      state: SCANNER_STATUS_STATES.ERROR,
      profileId: profile.id,
      lastError: message,
      lastDisconnectedAt: new Date().toISOString()
    });
    setButtons({ canConnect: true, canDisconnect: false });
  }
}

async function startPort(port, profile) {
  await disconnectActivePort({ quiet: true });
  setStatus(els.connectionStatus, `Opening ${profile.label}...`, 'info');
  publishScannerStatus({
    state: SCANNER_STATUS_STATES.STARTING,
    profileId: profile.id,
    portInfo: normalizeScannerPortInfo(port.getInfo()),
    lastError: ''
  });
  activeConnection = await openSerialScanner(port, profile, {
    onScan: handleSerialScan,
    onStatus: (status) => {
      if (status.state === 'open') {
        const portInfo = normalizeScannerPortInfo(status.portInfo || port.getInfo());
        updateDevicePanel(profile, portInfo);
        publishScannerStatus({
          state: SCANNER_STATUS_STATES.CONNECTED,
          profileId: profile.id,
          portInfo,
          lastConnectedAt: new Date().toISOString(),
          lastError: ''
        });
        setStatus(els.connectionStatus, `${profile.label} is connected. Scan a test barcode.`, 'success');
      }
      if (status.state === 'closed') {
        updateDeviceState('Disconnected');
        publishDisconnectedStatus(profile, port.getInfo());
      }
      if (status.state === 'disconnected') {
        updateDeviceState('Disconnected');
        publishScannerStatus({
          state: SCANNER_STATUS_STATES.WAITING_FOR_DEVICE,
          profileId: profile.id,
          portInfo: normalizeScannerPortInfo(status.portInfo || port.getInfo()),
          lastDisconnectedAt: new Date().toISOString(),
          lastError: 'Serial device disconnected.'
        });
      }
    },
    onError: (error) => {
      const message = error.message || 'Serial read error.';
      setStatus(els.connectionStatus, message, 'error');
      publishScannerStatus({
        state: SCANNER_STATUS_STATES.ERROR,
        profileId: profile.id,
        portInfo: normalizeScannerPortInfo(port.getInfo()),
        lastError: message,
        lastDisconnectedAt: new Date().toISOString()
      });
    }
  });

  chrome.storage.local.set({
    [SCANNER_PROFILE_STORAGE_KEY]: profile.id,
    [SCANNER_PORT_INFO_STORAGE_KEY]: port.getInfo()
  });
  setButtons({ canConnect: true, canDisconnect: true });
}

async function disconnectActivePort(options = {}) {
  if (!activeConnection) return;
  const connection = activeConnection;
  activeConnection = null;
  await connection.close();
  setButtons({ canConnect: true, canDisconnect: false });
  publishDisconnectedStatus(connection.profile, connection.port?.getInfo?.());
  if (!options.quiet) {
    setStatus(els.connectionStatus, 'Scanner disconnected.', 'warning');
  }
}

function handleSerialScan(rawScan) {
  let scan;
  try {
    scan = normalizeScanEvent(rawScan);
  } catch (error) {
    setStatus(els.routeStatus, error.message || 'Invalid serial scan event.', 'error');
    return;
  }

  els.decodedOutput.textContent = scan.rawText;
  els.rawBytesOutput.textContent = scan.rawBytesHex || 'No raw bytes captured.';
  checkKeyboardLeakage(scan.rawText);
  routeScan(scan);
}

function routeScan(scan) {
  setStatus(els.routeStatus, 'Routing scan to open chart tab...', 'info');
  chrome.runtime.sendMessage({ action: 'scannerScanCaptured', scan }, (response) => {
    if (chrome.runtime.lastError) {
      setStatus(els.routeStatus, chrome.runtime.lastError.message, 'error');
      return;
    }
    if (!response || response.success !== true) {
      setStatus(els.routeStatus, response?.error || 'Scan route failed.', 'error');
      return;
    }
    if (response.routed) {
      renderChartRouteResult(response);
      return;
    }
    if (response.queuedToWorkflow) {
      const label = response.workflow === 'inventory' ? 'inventory queue' : 'multi-vaccine queue';
      setStatus(els.routeStatus, `Scan saved to ${label} (${response.queueSizeAfter || 0}).`, 'success');
      return;
    }
    setStatus(els.routeStatus, `No chart tab accepted the scan. Saved to pending inbox (${response.pendingCount || 0}).`, 'warning');
  });
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
