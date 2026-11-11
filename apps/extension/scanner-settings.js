import {
  SCANNER_DAEMON_ACTIONS,
  SCANNER_STATUS_STATES,
  normalizeScannerPortInfo,
  normalizeScannerStatusSnapshot,
  selectGrantedPort,
  getScannerConnectionLabel
} from './scanner/scanner-daemon-shared.js';
import {
  SCANNER_PORT_INFO_STORAGE_KEY,
  SCANNER_PROFILE_STORAGE_KEY,
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
let configuredProfileId;

const els = {};
export function initializeScannerSettings() {
  if (els.connectionStatus || !document.getElementById('connectionStatus'))
    return;
  [
    'requestPortBtn',
    'connectGrantedBtn',
    'disconnectBtn',
    'connectionStatus',
    'scannerIdentity'
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });
  bindEvents();
  chrome.runtime.onMessage.addListener((request) => {
    if (
      request?.action === SCANNER_DAEMON_ACTIONS.STATUS_CHANGED &&
      request.status
    ) {
      statusChangeVersion++;
      applyDaemonStatus(request.status);
    }
    return false;
  });
  loadScannerConnection();
}

function bindEvents() {
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
    [
      getScannerConnectionLabel(status, source),
      source === 'live' ? scannerStatusSnapshot.lastError : ''
    ]
      .filter(Boolean)
      .join(': '),
    tone
  );
  const identityKnown = !!scannerStatusSnapshot.profileId;
  els.scannerIdentity.hidden = !identityKnown;
  els.scannerIdentity.textContent = identityKnown
    ? `${connected ? 'Scanner' : 'Saved scanner'}: ${profile.label} (Web Serial)`
    : '';
  setButtons({ canConnect: !connected, canDisconnect: connected });
  els.requestPortBtn.hidden = connected;
  els.connectGrantedBtn.hidden =
    connected ||
    (state === SCANNER_STATUS_STATES.NEVER_CONFIGURED && !identityKnown);
  els.disconnectBtn.hidden = !connected;
}

function loadScannerConnection() {
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
      configuredProfileId = profile.id;
      if (portInfo) {
        els.scannerIdentity.hidden = false;
        els.scannerIdentity.textContent = `Saved scanner: ${profile.label} (Web Serial)`;
      }
      void sendScannerDaemonCommand(SCANNER_DAEMON_ACTIONS.GET_STATUS)
        .then((response) => {
          applyDaemonStatus(response.status, response.source);
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

  setStatus(els.connectionStatus, 'Checking scanner connection…', 'info');
  setButtons({ canConnect: true, canDisconnect: false });
}

function getSelectedProfile() {
  return getSerialScannerProfile(
    scannerStatusSnapshot.profileId || configuredProfileId
  );
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
