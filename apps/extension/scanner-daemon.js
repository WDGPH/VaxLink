import './capability.js';
import {
  SCANNER_DAEMON_ACTIONS,
  SCANNER_DAEMON_BACKGROUND_TARGET,
  SCANNER_DAEMON_TARGET,
  SCANNER_STATUS_STATES,
  createScannerStatusSnapshot,
  normalizeScannerPortInfo,
  normalizeScannerStatusSnapshot
} from './scanner/scanner-daemon-shared.js';

let testBridge = null;
if (globalThis.VaxLinkDiagnostics?.enabled) {
  const { createScannerTestHost } =
    await import('./diagnostics/scanner-test-host.js');
  testBridge = createScannerTestHost({
    getWorker: () => daemonWorker,
    isConnected: () => currentStatus.state === SCANNER_STATUS_STATES.CONNECTED,
    stopReconnect: () => {
      desiredConnection = null;
      clearRestartTimer();
    },
    broadcast: (payload) =>
      chrome.runtime.sendMessage(payload, () => {
        void chrome.runtime.lastError;
      })
  });
}

let daemonWorker = null;
let restartTimer = null;
let desiredConnection = null;
let currentStatus = createScannerStatusSnapshot();
let statusRequestSequence = 0;
const pendingStatusRequests = new Map();

function observeStatus() {
  if (!daemonWorker)
    return Promise.resolve({ source: 'cached', status: currentStatus });
  return new Promise((resolve) => {
    const requestId = ++statusRequestSequence;
    const timer = setTimeout(() => {
      pendingStatusRequests.delete(requestId);
      resolve({ source: 'cached', status: currentStatus });
    }, 1000);
    pendingStatusRequests.set(requestId, (status) => {
      clearTimeout(timer);
      pendingStatusRequests.delete(requestId);
      resolve({ source: 'fresh', status });
    });
    daemonWorker.postMessage({ type: 'getStatus', requestId });
  });
}

function postStatusToBackground(status) {
  chrome.runtime.sendMessage(
    {
      target: SCANNER_DAEMON_BACKGROUND_TARGET,
      action: SCANNER_DAEMON_ACTIONS.STATUS_UPDATE,
      status
    },
    () => {
      void chrome.runtime.lastError;
    }
  );
}

function applyStatus(status) {
  const nextStatus = normalizeScannerStatusSnapshot(status);
  const hasChanged =
    JSON.stringify(nextStatus) !== JSON.stringify(currentStatus);
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
  daemonWorker = new Worker(
    chrome.runtime.getURL('scanner/scanner-daemon-worker.js'),
    { type: 'module' }
  );
  daemonWorker.addEventListener('message', (event) => {
    const data = event.data || {};
    if (testBridge?.onWorkerMessage(data)) return;
    if (data.type === 'status') {
      if (data.requestId === undefined) testBridge?.onStatus(data.status);
      const pending = pendingStatusRequests.get(data.requestId);
      if (pending) pending(normalizeScannerStatusSnapshot(data.status));
      else if (data.requestId === undefined) applyStatus(data.status);
      return;
    }
    if (data.type === 'scan') {
      void routeScannerScan(data.scan);
    }
  });
  daemonWorker.addEventListener('error', (event) => {
    testBridge?.onWorkerError();
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
  try {
    await sendRuntimeMessage({ action: 'scannerScanCaptured', scan });
  } catch (_) {
    // The scan could not be delivered to the background worker.
  }
}

function requestConnect(message = {}) {
  desiredConnection = {
    profileId: String(
      message.profileId || currentStatus.profileId || ''
    ).trim(),
    preferredPortInfo: normalizeScannerPortInfo(
      message.preferredPortInfo || currentStatus.portInfo
    ),
    trigger: message.trigger || 'manual'
  };
  ensureWorker().postMessage({ type: 'connectGranted', ...desiredConnection });
}

function requestDisconnect() {
  desiredConnection = null;
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

  if (testBridge?.handleMessage(request, sender, sendResponse)) return true;

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
    void observeStatus().then(({ source, status }) => {
      sendResponse({ success: true, status, observation: { source } });
    });
    return true;
  }

  return false;
});

if (
  globalThis.navigator &&
  globalThis.navigator.serial &&
  typeof globalThis.navigator.serial.addEventListener === 'function'
) {
  globalThis.navigator.serial.addEventListener('connect', () => {
    refreshGrantedPorts('serial-connect');
  });
  globalThis.navigator.serial.addEventListener('disconnect', () => {
    refreshGrantedPorts('serial-disconnect');
  });
}

ensureWorker();
