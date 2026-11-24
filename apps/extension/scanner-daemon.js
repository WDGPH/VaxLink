import {
  SCANNER_DAEMON_ACTIONS,
  SCANNER_DAEMON_BACKGROUND_TARGET,
  SCANNER_DAEMON_TARGET,
  SCANNER_STATUS_STATES,
  SCANNER_WORKER_MESSAGES,
  createScannerStatusSnapshot,
  normalizeScannerPortInfo,
  normalizeScannerStatusSnapshot
} from './scanner/scanner-daemon-shared.js';

let daemonWorker = null;
let restartTimer = null;
let desiredConnection = null;
let stopping = false;
let nextRequestId = 0;
const workerRequests = new Map();
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
  const worker = daemonWorker;
  daemonWorker.addEventListener('message', (event) => {
    if (worker !== daemonWorker) return;
    const data = event.data || {};
    if (data.type === SCANNER_WORKER_MESSAGES.STATUS) {
      if (!stopping) applyStatus(data.status);
      return;
    }
    if (data.type === SCANNER_WORKER_MESSAGES.REPLY) {
      workerRequests.get(data.requestId)?.(data);
    }
    if (data.type === SCANNER_WORKER_MESSAGES.SCAN && desiredConnection) {
      void routeScannerScan(data.scan);
    }
  });
  daemonWorker.addEventListener('error', (event) => {
    if (worker !== daemonWorker) return;
    const message = String(event?.message || 'Scanner worker crashed.').trim();
    daemonWorker = null;
    for (const finish of workerRequests.values()) finish({ error: message });
    applyStatus({
      ...currentStatus,
      state: SCANNER_STATUS_STATES.ERROR,
      lastError: message,
      lastDisconnectedAt: new Date().toISOString()
    });
    if (desiredConnection) {
      restartTimer = setTimeout(() => {
        restartTimer = null;
        ensureWorker();
      }, 1000);
    }
  });
  if (desiredConnection) {
    daemonWorker.postMessage({
      type: SCANNER_WORKER_MESSAGES.CONNECT_GRANTED,
      ...desiredConnection
    });
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
  const worker = ensureWorker();
  desiredConnection = {
    profileId: String(message.profileId || '').trim(),
    preferredPortInfo: normalizeScannerPortInfo(message.preferredPortInfo),
    trigger: message.trigger || 'manual'
  };
  worker.postMessage({
    type: SCANNER_WORKER_MESSAGES.CONNECT_GRANTED,
    ...desiredConnection
  });
}

function requestWorker(worker, type, timeoutMs) {
  return new Promise((resolve) => {
    const requestId = ++nextRequestId;
    const finish = ({ status, error }) => {
      clearTimeout(timer);
      workerRequests.delete(requestId);
      resolve(error ? { success: false, error } : { success: true, status });
    };
    const timer = timeoutMs
      ? setTimeout(
          () => finish({ error: 'Scanner status unavailable' }),
          timeoutMs
        )
      : null;
    workerRequests.set(requestId, finish);
    worker.postMessage({ type, requestId });
  });
}

async function requestDisconnect() {
  desiredConnection = null;
  clearRestartTimer();
  stopping = true;
  applyStatus({ ...currentStatus, state: SCANNER_STATUS_STATES.STOPPING });
  try {
    const reply = await requestWorker(
      ensureWorker(),
      SCANNER_WORKER_MESSAGES.DISCONNECT
    );
    applyStatus(
      reply.success
        ? reply.status
        : {
            ...currentStatus,
            state: SCANNER_STATUS_STATES.UNAVAILABLE,
            lastError: reply.error
          }
    );
    return reply;
  } finally {
    stopping = false;
  }
}

function refreshGrantedPorts() {
  if (!desiredConnection || !daemonWorker) return;
  daemonWorker.postMessage({ type: SCANNER_WORKER_MESSAGES.REFRESH_PORTS });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.target !== SCANNER_DAEMON_TARGET) {
    return false;
  }

  if (request.action === SCANNER_DAEMON_ACTIONS.CONNECT_GRANTED) {
    if (stopping || currentStatus.state === SCANNER_STATUS_STATES.UNAVAILABLE) {
      sendResponse({
        success: false,
        error: 'Finish disconnecting the scanner before reconnecting.'
      });
      return false;
    }
    requestConnect(request);
    sendResponse({ success: true, accepted: true, status: currentStatus });
    return false;
  }

  if (request.action === SCANNER_DAEMON_ACTIONS.DISCONNECT) {
    if (stopping) {
      sendResponse({
        success: false,
        error: 'The scanner is already stopping.'
      });
      return false;
    }
    requestDisconnect().then(sendResponse, (error) =>
      sendResponse({ success: false, error: error.message })
    );
    return true;
  }

  if (request.action === SCANNER_DAEMON_ACTIONS.GET_STATUS) {
    if (!daemonWorker) {
      sendResponse({ success: false, error: 'Scanner status unavailable' });
      return false;
    }
    requestWorker(daemonWorker, SCANNER_WORKER_MESSAGES.GET_STATUS, 900).then(
      sendResponse
    );
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
