import {
  SCANNER_DAEMON_ACTIONS,
  SCANNER_DAEMON_BACKGROUND_TARGET,
  SCANNER_DAEMON_TARGET,
  SCANNER_STATUS_STATES,
  createScannerStatusSnapshot,
  normalizeScannerPortInfo,
  normalizeScannerStatusSnapshot
} from './scanner/scanner-daemon-shared.js';

let daemonWorker = null;
let restartTimer = null;
let desiredConnection = null;
let currentStatus = createScannerStatusSnapshot();

function postStatusToBackground(status) {
  chrome.runtime.sendMessage({
    target: SCANNER_DAEMON_BACKGROUND_TARGET,
    action: SCANNER_DAEMON_ACTIONS.STATUS_UPDATE,
    status
  }, () => {
    void chrome.runtime.lastError;
  });
}

function broadcastScanEcho(scan, response) {
  chrome.runtime.sendMessage({
    action: SCANNER_DAEMON_ACTIONS.SCAN_ECHO,
    scan,
    response
  }, () => {
    void chrome.runtime.lastError;
  });
}

function applyStatus(status) {
  const nextStatus = normalizeScannerStatusSnapshot(status);
  const hasChanged = JSON.stringify(nextStatus) !== JSON.stringify(currentStatus);
  currentStatus = nextStatus;
  if (hasChanged) {
    postStatusToBackground(currentStatus);
  }
}

function clearRestartTimer() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function ensureWorker() {
  if (daemonWorker) return daemonWorker;

  clearRestartTimer();
  daemonWorker = new Worker(chrome.runtime.getURL('scanner/scanner-daemon-worker.js'), { type: 'module' });
  daemonWorker.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'status') {
      applyStatus(data.status);
      return;
    }
    if (data.type === 'scan') {
      void routeScannerScan(data.scan);
    }
  });
  daemonWorker.addEventListener('error', (event) => {
    const message = String(event?.message || 'Scanner worker crashed.').trim();
    daemonWorker = null;
    applyStatus({
      ...currentStatus,
      state: SCANNER_STATUS_STATES.ERROR,
      lastError: message,
      lastDisconnectedAt: new Date().toISOString()
    });
    if (desiredConnection) {
      restartTimer = setTimeout(() => {
        restartTimer = null;
        const worker = ensureWorker();
        worker.postMessage({ type: 'connectGranted', ...desiredConnection });
      }, 1000);
    }
  });
  daemonWorker.postMessage({ type: 'getStatus' });
  if (desiredConnection) {
    daemonWorker.postMessage({ type: 'connectGranted', ...desiredConnection });
  }
  return daemonWorker;
}

async function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function routeScannerScan(scan) {
  let response = null;
  try {
    response = await sendRuntimeMessage({ action: 'scannerScanCaptured', scan });
  } catch (error) {
    response = { success: false, error: error.message || 'Scan route failed.' };
  }
  broadcastScanEcho(scan, response);
}

function requestConnect(message = {}) {
  desiredConnection = {
    profileId: String(message.profileId || currentStatus.profileId || '').trim(),
    preferredPortInfo: normalizeScannerPortInfo(message.preferredPortInfo || currentStatus.portInfo),
    trigger: message.trigger || 'manual'
  };
  ensureWorker().postMessage({ type: 'connectGranted', ...desiredConnection });
}

function requestDisconnect() {
  desiredConnection = desiredConnection || {
    profileId: String(currentStatus.profileId || '').trim(),
    preferredPortInfo: normalizeScannerPortInfo(currentStatus.portInfo),
    trigger: 'disconnect'
  };
  ensureWorker().postMessage({ type: 'disconnect' });
}

function refreshGrantedPorts(trigger = 'device-event') {
  if (!desiredConnection) return;
  ensureWorker().postMessage({ type: 'refreshPorts', trigger });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.target !== SCANNER_DAEMON_TARGET) {
    return false;
  }

  if (request.action === SCANNER_DAEMON_ACTIONS.CONNECT_GRANTED) {
    requestConnect(request);
    sendResponse({ success: true, accepted: true, status: currentStatus });
    return false;
  }

  if (request.action === SCANNER_DAEMON_ACTIONS.DISCONNECT) {
    requestDisconnect();
    sendResponse({ success: true, accepted: true, status: currentStatus });
    return false;
  }

  if (request.action === SCANNER_DAEMON_ACTIONS.GET_STATUS) {
    ensureWorker().postMessage({ type: 'getStatus' });
    sendResponse({ success: true, status: currentStatus });
    return false;
  }

  return false;
});

if (globalThis.navigator && globalThis.navigator.serial && typeof globalThis.navigator.serial.addEventListener === 'function') {
  globalThis.navigator.serial.addEventListener('connect', () => {
    refreshGrantedPorts('serial-connect');
  });
  globalThis.navigator.serial.addEventListener('disconnect', () => {
    refreshGrantedPorts('serial-disconnect');
  });
}

ensureWorker();
