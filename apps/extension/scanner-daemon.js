import {
  SCANNER_DAEMON_ACTIONS,
  SCANNER_DAEMON_BACKGROUND_TARGET,
  SCANNER_DAEMON_TARGET,
  SCANNER_STATUS_STATES,
  createScannerStatusSnapshot,
  normalizeScannerPortInfo,
  normalizeScannerStatusSnapshot
} from './scanner/scanner-daemon-shared.js';

const testGuard =
  chrome.runtime.getManifest().name === 'VaxLink Alpha'
    ? (await import('./diagnostics/scanner-test-host.js')).canConnect
    : null;

let daemonWorker = null;
let disconnectSequence = 0;
const pendingDisconnects = new Map();
let restartTimer = null;
let desiredConnection = null;
let currentStatus = createScannerStatusSnapshot();

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

function broadcastScanEcho(scan, response) {
  chrome.runtime.sendMessage(
    {
      action: SCANNER_DAEMON_ACTIONS.SCAN_ECHO,
      scan,
      response
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
  if (nextStatus.selectionRequired) {
    desiredConnection = null;
    clearRestartTimer();
  }
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
    if (data.type === 'disconnected') {
      pendingDisconnects.get(data.requestId)?.(data.success === true);
      return;
    }
    if (data.type === 'status') {
      applyStatus(data.status);
      return;
    }
    if (data.type === 'scan') {
      void routeScannerScan(data.scan);
    }
  });
  daemonWorker.addEventListener('error', (event) => {
    for (const finish of pendingDisconnects.values()) finish(false);
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
    response = await sendRuntimeMessage({
      action: 'scannerScanCaptured',
      scan
    });
  } catch (error) {
    response = { success: false, error: error.message || 'Scan route failed.' };
  }
  broadcastScanEcho(scan, response);
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
  clearRestartTimer();
  if (!daemonWorker) return Promise.resolve(false);
  return new Promise((resolve) => {
    const requestId = ++disconnectSequence;
    const finish = (success) => {
      clearTimeout(timer);
      pendingDisconnects.delete(requestId);
      resolve(success);
    };
    const timer = setTimeout(() => finish(false), 5000);
    pendingDisconnects.set(requestId, finish);
    try {
      daemonWorker.postMessage({ type: 'disconnect', requestId });
    } catch {
      finish(false);
    }
  });
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
    if (!testGuard) {
      requestConnect(request);
      sendResponse({ success: true, accepted: true, status: currentStatus });
      return false;
    }
    testGuard(sender)
      .then((allowed) => {
        if (!allowed) return sendResponse({ success: false, accepted: false });
        requestConnect(request);
        sendResponse({ success: true, accepted: true, status: currentStatus });
      })
      .catch(() => sendResponse({ success: false, accepted: false }));
    return true;
  }

  if (request.action === SCANNER_DAEMON_ACTIONS.DISCONNECT) {
    requestDisconnect().then((released) =>
      sendResponse({ success: released, released, status: currentStatus })
    );
    return true;
  }

  if (request.action === SCANNER_DAEMON_ACTIONS.GET_STATUS) {
    sendResponse({ success: true, status: currentStatus });
    return false;
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
