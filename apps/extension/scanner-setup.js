import {
  SCANNER_DAEMON_ACTIONS,
  SCANNER_STATUS_STATES,
  normalizeScannerPortInfo,
  normalizeScannerStatusSnapshot,
  selectGrantedPort,
  getScannerConnectionLabel
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
let statusChangeVersion = 0;

const els = {};
const embedded = window.parent !== window;
if (embedded) document.documentElement.classList.add('embedded');

document.addEventListener('DOMContentLoaded', () => {
  [
    'profileSelect',
    'profileNote',
    'requestPortBtn',
    'connectGrantedBtn',
    'disconnectBtn',
    'connectionStatus',
    'scannerIdentity',
    'connectionDetails',
    'scannerUsbIdentity',
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
}

chrome.runtime.onMessage.addListener((request) => {
  if (
    request?.action === SCANNER_DAEMON_ACTIONS.STATUS_CHANGED &&
    request.status
  ) {
    statusChangeVersion++;
    applyDaemonStatus(request.status);
  }
  if (request?.action === SCANNER_DAEMON_ACTIONS.SCAN_ECHO && request.scan) {
    renderDaemonRouteResult(request.response || {});
    if (!embedded && els.routeStatus.classList.contains('error'))
      document.getElementById('scannerDiagnostics').open = true;
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

function applyDaemonStatus(status, source = 'live', captureSource = source) {
  scannerStatusSnapshot = normalizeScannerStatusSnapshot(status);
  const profile = getSerialScannerProfile(
    scannerStatusSnapshot.profileId || getSelectedProfile()?.id
  );
  const state = scannerStatusSnapshot.state;
  const connected =
    state === SCANNER_STATUS_STATES.CONNECTED && source === 'live';
  const tone = connected
    ? 'success'
    : source === 'live' &&
        (state === SCANNER_STATUS_STATES.ERROR ||
          state === SCANNER_STATUS_STATES.BUSY)
      ? 'error'
      : 'info';
  setStatus(
    els.connectionStatus,
    getScannerConnectionLabel(status, source),
    tone
  );
  const identityKnown = !!scannerStatusSnapshot.profileId;
  els.scannerIdentity.hidden = !identityKnown;
  els.scannerIdentity.textContent = identityKnown
    ? `${connected ? 'Scanner' : 'Saved scanner'}: ${profile.label} (Web Serial)`
    : '';
  let detail = '';
  if (
    source === 'live' &&
    (scannerStatusSnapshot.captureCount > 0 ||
      scannerStatusSnapshot.lastCaptureAt)
  )
    detail = `Hardware captures in this session: ${scannerStatusSnapshot.captureCount}; latest ${scannerStatusSnapshot.lastCaptureAt || 'time unavailable'}.`;
  else if (connected)
    detail = 'No hardware scan has reached VaxLink in this session.';
  if (scannerStatusSnapshot.lastError)
    detail += ` ${scannerStatusSnapshot.lastError}`;
  if (scannerStatusSnapshot.lastKnownCaptureAt && captureSource === 'cached')
    detail += ` Last known capture (cached): ${scannerStatusSnapshot.lastKnownCaptureAt}.`;
  setStatus(els.connectionDetails, detail.trim(), tone);
  els.connectionDetails.hidden = !detail.trim();
  const info = scannerStatusSnapshot.portInfo;
  els.scannerUsbIdentity.hidden = !info;
  els.scannerUsbIdentity.textContent = info
    ? `${connected ? 'USB device' : 'Saved USB device'}: vendor ${formatUsbId(info.usbVendorId)}, product ${formatUsbId(info.usbProductId)}`
    : '';
  setButtons({ canConnect: !connected, canDisconnect: connected });
  els.requestPortBtn.hidden = connected;
  els.connectGrantedBtn.hidden =
    connected ||
    (state === SCANNER_STATUS_STATES.NEVER_CONFIGURED && !identityKnown);
  els.disconnectBtn.hidden = !connected;
}

function renderDaemonRouteResult(response) {
  if (response?.duplicate_ignored) {
    setStatus(els.routeStatus, 'Duplicate scan ignored.', 'info');
    return;
  }
  if (response?.locked && response.queuedToWorkflow === false) {
    setStatus(
      els.routeStatus,
      `Scan saved to pending scans (${response.pendingCount || 0}).`,
      'success'
    );
    return;
  }
  if (response?.locked) {
    setStatus(
      els.routeStatus,
      `Scan saved while locked to the Multiple Inject queue (${response.queueSizeAfter || 0}).`,
      'success'
    );
    return;
  }
  if (response?.routed) {
    renderChartRouteResult(response);
    return;
  }
  if (response?.queuedToWorkflow) {
    setStatus(
      els.routeStatus,
      `Scan saved to the ${response.workflow || 'multiple'} queue (${response.queueSizeAfter || 0}).`,
      'success'
    );
    return;
  }
  setStatus(
    els.routeStatus,
    response?.error || 'Scan captured by daemon.',
    response?.success === false ? 'error' : 'info'
  );
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
      if (portInfo) {
        els.scannerIdentity.hidden = false;
        els.scannerIdentity.textContent = `Saved scanner: ${profile.label} (Web Serial)`;
      }
      void sendScannerDaemonCommand(SCANNER_DAEMON_ACTIONS.GET_STATUS)
        .then((response) => {
          applyDaemonStatus(
            response.status,
            response.source,
            response.captureSource
          );
          if (response.captureError && !embedded) {
            document.getElementById('scannerDiagnostics').open = true;
            setStatus(
              els.routeStatus,
              'A scan could not be saved or delivered. Check pending scans and rescan if needed.',
              'error'
            );
          }
        })
        .catch((error) =>
          setStatus(els.connectionStatus, error.message, 'error')
        );
    }
  );

  navigator.serial.addEventListener('connect', () => {
    setStatus(
      els.connectionStatus,
      'Scanner detected. Choose Reconnect or Pair scanner.',
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
    els.scannerIdentity.hidden = false;
    els.scannerIdentity.textContent = `Saved scanner: ${profile.label} (Web Serial)`;
    const versionAtRequest = statusChangeVersion;
    await sendScannerDaemonCommand(SCANNER_DAEMON_ACTIONS.CONNECT_GRANTED, {
      profileId: profile.id,
      preferredPortInfo: portInfo,
      enableAutostart: true,
      trigger: 'setup_permission_granted'
    });
    // The command acknowledges the request using a saved snapshot. A live
    // update must confirm connection, and a late acknowledgement must not
    // replace an update received while the request was pending.
    if (statusChangeVersion === versionAtRequest)
      setStatus(els.connectionStatus, 'Scanner selected. Connecting…', 'info');
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
    const selection = selectGrantedPort(
      ports,
      profile,
      scannerStatusSnapshot.portInfo,
      portMatchesProfile
    );
    const port = selection.port;
    if (!port) {
      throw new Error(
        selection.reason === 'ambiguous'
          ? 'Multiple granted scanners have the same identity. Disconnect or revoke access to the others, then select the scanner again.'
          : 'The selected scanner could not be identified. Reconnect it or use Pair scanner.'
      );
    }
    const versionAtRequest = statusChangeVersion;
    await sendScannerDaemonCommand(SCANNER_DAEMON_ACTIONS.CONNECT_GRANTED, {
      profileId: profile.id,
      preferredPortInfo: normalizeScannerPortInfo(port.getInfo()),
      enableAutostart: true,
      trigger: 'setup_reconnect'
    });
    if (statusChangeVersion === versionAtRequest)
      setStatus(
        els.connectionStatus,
        'Reconnect requested. Checking connection…',
        'info'
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

function renderChartRouteResult(response) {
  const chartResult = response?.response || {};
  if (chartResult.success) {
    if (chartResult.duplicate_ignored) {
      setStatus(
        els.routeStatus,
        `Duplicate scan ignored by chart tab ${response.tabId}.`,
        'warning'
      );
      return;
    }
    setStatus(
      els.routeStatus,
      `Scan routed to chart tab ${response.tabId}.`,
      'success'
    );
    return;
  }
  if (chartResult.pending) {
    setStatus(
      els.routeStatus,
      `Scan reached chart tab ${response.tabId}. Chart action is required before autofill can finish.`,
      'warning'
    );
    return;
  }
  if (chartResult.command_handled) {
    setStatus(
      els.routeStatus,
      `VaxLink scanner command handled by tab ${response.tabId}.`,
      'success'
    );
    return;
  }
  const message =
    chartResult.error ||
    chartResult.status ||
    'Chart received the scan, but autofill did not complete.';
  setStatus(
    els.routeStatus,
    `Scan reached chart tab ${response.tabId}, but ${message}`,
    'error'
  );
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
