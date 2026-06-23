import { normalizeScanEvent } from './scanner/scanner-events.js';
import {
  SCANNER_DAEMON_ACTIONS,
  buildScannerStatusDescriptor,
  normalizeScannerStatusSnapshot
} from './scanner/scanner-daemon-shared.js';
import {
  SERIAL_SCANNER_PROFILES,
  SCANNER_PORT_INFO_STORAGE_KEY,
  SCANNER_PROFILE_STORAGE_KEY,
  formatUsbId,
  getSerialScannerProfile
} from './scanner/serial-profiles.js';
import {
  isWebSerialSupported,
  requestSerialScannerPort
} from './scanner/serial-provider.js';

let lastLeakageInputAt = 0;
let currentStatus = normalizeScannerStatusSnapshot(null);

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
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  void initializePage();
});

function bindEvents() {
  els.profileSelect?.addEventListener('change', () => {
    const profile = getSelectedProfile();
    renderProfileNote(profile);
    chrome.storage.local.set({ [SCANNER_PROFILE_STORAGE_KEY]: profile.id });
  });

  els.requestPortBtn?.addEventListener('click', () => {
    void requestAndGrantPort();
  });

  els.connectGrantedBtn?.addEventListener('click', () => {
    void reconnectGrantedPort();
  });

  els.disconnectBtn?.addEventListener('click', () => {
    void disconnectScanner();
  });

  els.leakageInput?.addEventListener('input', () => {
    lastLeakageInputAt = Date.now();
  });
}

async function initializePage() {
  if (!isWebSerialSupported()) {
    setStatus(els.connectionStatus, 'Web Serial is not available in this browser context.', 'error');
    setButtons({ canConnect: false, canDisconnect: false });
    return;
  }

  const stored = await getLocalStorage([SCANNER_PROFILE_STORAGE_KEY]).catch(() => ({}));
  const profile = getSerialScannerProfile(stored && stored[SCANNER_PROFILE_STORAGE_KEY]);
  if (els.profileSelect) {
    els.profileSelect.value = profile.id;
  }
  renderProfileNote(profile);
  setStatus(
    els.connectionStatus,
    'Pair the scanner once, then VaxLink keeps the connection alive in a hidden station daemon even after you close this page.',
    'info'
  );
  setStatus(
    els.routeStatus,
    'The hidden station daemon will route scans to open Panorama or InputHealth tabs automatically.',
    'info'
  );
  setButtons({ canConnect: true, canDisconnect: false });
  await refreshScannerStatus();
}

function renderProfiles() {
  if (!els.profileSelect) return;
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

async function requestAndGrantPort() {
  const profile = getSelectedProfile();
  try {
    setButtons({ canConnect: false, canDisconnect: false });
    setStatus(els.connectionStatus, 'Waiting for browser scanner selection...', 'info');
    const port = await requestSerialScannerPort(profile);
    await setLocalStorage({
      [SCANNER_PROFILE_STORAGE_KEY]: profile.id,
      [SCANNER_PORT_INFO_STORAGE_KEY]: port.getInfo()
    });
    await sendDaemonCommand(SCANNER_DAEMON_ACTIONS.ENABLE_AUTOSTART);
    await sendDaemonCommand(SCANNER_DAEMON_ACTIONS.CONNECT_GRANTED, {
      profileId: profile.id,
      preferredPortInfo: port.getInfo(),
      trigger: 'setup_pair',
      enableAutostart: true
    });
    setStatus(
      els.connectionStatus,
      'Scanner granted. VaxLink is starting the hidden station daemon connection. You can close this page once it shows Connected.',
      'info'
    );
    await refreshScannerStatus();
  } catch (error) {
    setStatus(els.connectionStatus, error.message || 'Scanner selection failed.', 'error');
    setButtons({ canConnect: true, canDisconnect: false });
  }
}

async function reconnectGrantedPort() {
  const profile = getSelectedProfile();
  try {
    setButtons({ canConnect: false, canDisconnect: false });
    setStatus(els.connectionStatus, 'Reconnecting the hidden station daemon...', 'info');
    await sendDaemonCommand(SCANNER_DAEMON_ACTIONS.CONNECT_GRANTED, {
      profileId: profile.id,
      trigger: 'setup_reconnect'
    });
    await refreshScannerStatus();
  } catch (error) {
    setStatus(els.connectionStatus, error.message || 'Reconnect failed.', 'error');
    setButtons({ canConnect: true, canDisconnect: false });
  }
}

async function disconnectScanner() {
  try {
    setButtons({ canConnect: false, canDisconnect: false });
    await sendDaemonCommand(SCANNER_DAEMON_ACTIONS.DISCONNECT, { trigger: 'setup_disconnect' });
    setStatus(els.connectionStatus, 'Scanner disconnected for this browser session.', 'warning');
    await refreshScannerStatus();
  } catch (error) {
    setStatus(els.connectionStatus, error.message || 'Disconnect failed.', 'error');
    setButtons({ canConnect: true, canDisconnect: false });
  }
}

async function refreshScannerStatus() {
  try {
    const response = await sendDaemonCommand(SCANNER_DAEMON_ACTIONS.GET_STATUS);
    if (response && response.success && response.status) {
      applyScannerStatus(response.status);
      return;
    }
    applyScannerStatus(currentStatus);
  } catch (_) {
    applyScannerStatus(currentStatus);
  }
}

function handleRuntimeMessage(request) {
  if (request?.action === SCANNER_DAEMON_ACTIONS.STATUS_CHANGED) {
    applyScannerStatus(request.status);
    return false;
  }

  if (request?.action === SCANNER_DAEMON_ACTIONS.SCAN_ECHO) {
    handleScanEcho(request);
    return false;
  }

  return false;
}

function handleScanEcho(payload) {
  let scan;
  try {
    scan = normalizeScanEvent(payload.scan);
  } catch (error) {
    setStatus(els.routeStatus, error.message || 'Invalid serial scan event.', 'error');
    return;
  }

  if (els.decodedOutput) {
    els.decodedOutput.textContent = scan.rawText;
  }
  if (els.rawBytesOutput) {
    els.rawBytesOutput.textContent = scan.rawBytesHex || 'No raw bytes captured.';
  }
  checkKeyboardLeakage(scan.rawText);
  applyRouteResponse(payload.response);
}

function applyRouteResponse(response) {
  if (!response || response.success !== true) {
    setStatus(els.routeStatus, response?.error || 'Scan route failed.', 'error');
    return;
  }
  if (response.routed) {
    setStatus(els.routeStatus, `Scan routed to tab ${response.tabId}.`, 'success');
    return;
  }
  if (response.queuedToWorkflow) {
    const label = response.workflow === 'inventory' ? 'inventory queue' : 'multi-vaccine queue';
    setStatus(els.routeStatus, `Scan saved to ${label} (${response.queueSizeAfter || 0}).`, 'success');
    return;
  }
  setStatus(els.routeStatus, `No chart tab accepted the scan. Saved to pending inbox (${response.pendingCount || 0}).`, 'warning');
}

function applyScannerStatus(status) {
  currentStatus = normalizeScannerStatusSnapshot(status);
  const descriptor = buildScannerStatusDescriptor(currentStatus);
  const selectedProfile = getSelectedProfile();
  const statusProfile = currentStatus.profileId
    ? getSerialScannerProfile(currentStatus.profileId)
    : selectedProfile;

  if (currentStatus.profileId || currentStatus.portInfo) {
    updateDevicePanel(statusProfile, currentStatus.portInfo || {});
  } else {
    updateDeviceState('Not paired');
  }

  let connectionMessage = descriptor.detail;
  if (currentStatus.state === 'connected') {
    connectionMessage = `${statusProfile.label} is connected in the hidden station daemon. You can close this page.`;
  } else if (currentStatus.state === 'recovering') {
    connectionMessage = `${descriptor.detail} You can leave this page closed; VaxLink will keep retrying.`;
  } else if (currentStatus.state === 'disabled') {
    connectionMessage = 'Scanner is disconnected for this session. Reconnect when you are ready to resume hands-free capture.';
  }
  setStatus(els.connectionStatus, connectionMessage, descriptor.tone);

  if (!els.deviceState) return;
  els.deviceState.textContent = formatStateLabel(currentStatus.state);
  setButtons({
    canConnect: true,
    canDisconnect: ![
      'never_configured',
      'permission_lost',
      'disabled'
    ].includes(currentStatus.state)
  });
}

function formatStateLabel(state) {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'starting':
      return 'Connecting';
    case 'recovering':
      return 'Recovering';
    case 'waiting_for_device':
      return 'Waiting for device';
    case 'permission_lost':
      return 'Permission lost';
    case 'busy':
      return 'Busy';
    case 'disabled':
      return 'Disconnected';
    case 'error':
      return 'Error';
    default:
      return 'Not paired';
  }
}

function checkKeyboardLeakage(rawText) {
  const before = String(els.leakageInput?.value || '');
  const startedAt = Date.now();
  setTimeout(() => {
    const after = String(els.leakageInput?.value || '');
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
    setStatus(els.leakageStatus, 'No keyboard leakage detected for the latest daemon-routed scan.', 'success');
  }, 350);
}

function normalizeForLeakage(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

function updateDevicePanel(profile, info = {}) {
  if (els.deviceProfile) {
    els.deviceProfile.textContent = profile.label;
  }
  if (els.deviceVendor) {
    els.deviceVendor.textContent = formatUsbId(info.usbVendorId);
  }
  if (els.deviceProduct) {
    els.deviceProduct.textContent = formatUsbId(info.usbProductId);
  }
}

function updateDeviceState(state) {
  if (els.deviceState) {
    els.deviceState.textContent = state;
  }
  if (state === 'Not paired') {
    if (els.deviceProfile) els.deviceProfile.textContent = 'Not connected';
    if (els.deviceVendor) els.deviceVendor.textContent = 'Unknown';
    if (els.deviceProduct) els.deviceProduct.textContent = 'Unknown';
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

function sendDaemonCommand(action, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || response.success !== true) {
        reject(new Error(response?.error || 'Scanner daemon request failed.'));
        return;
      }
      resolve(response);
    });
  });
}

function getLocalStorage(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function setLocalStorage(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
