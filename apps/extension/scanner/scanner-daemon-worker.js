import {
  SCANNER_STATUS_STATES,
  SCANNER_WORKER_MESSAGES,
  classifyScannerConnectionFailure,
  createScannerStatusSnapshot,
  getScannerReconnectDelayMs,
  normalizeScannerPortInfo,
  normalizeScannerStatusSnapshot,
  selectGrantedPort
} from './scanner-daemon-shared.js';
import {
  getSerialScannerProfile,
  portMatchesProfile
} from './serial-profiles.js';
import {
  getGrantedSerialScannerPorts,
  openSerialScanner
} from './serial-provider.js';

let desiredProfileId = '';
let preferredPortInfo = null;
let desiredConnected = false;
let activeConnection = null;
let activePort = null;
let reconnectTimer = null;
let openingPromise = null;
let openingController = null;
let closingPromise = null;
let stopping = false;
let recoverAttemptCount = 0;
let currentStatus = createScannerStatusSnapshot();

function postToHost(message) {
  self.postMessage(message);
}

function updateStatus(overrides = {}) {
  currentStatus = normalizeScannerStatusSnapshot({
    ...currentStatus,
    ...overrides
  });
  postToHost({ type: SCANNER_WORKER_MESSAGES.STATUS, status: currentStatus });
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function closeActiveConnection() {
  closingPromise ??= (async () => {
    if (activeConnection) {
      await activeConnection.close();
    } else if (activePort?.readable || activePort?.writable) {
      await activePort.close();
    }
    activeConnection = null;
    activePort = null;
  })().finally(() => {
    closingPromise = null;
  });
  return closingPromise;
}

async function recoverFromReadFailure(error) {
  try {
    await closeActiveConnection();
    handleConnectionFailure(error);
  } catch {
    // Keep the port so Disconnect can retry. A new reader cannot start yet.
    desiredConnected = false;
    updateStatus({
      state: SCANNER_STATUS_STATES.UNAVAILABLE,
      lastError: 'Could not confirm that the scanner stopped.'
    });
  }
}

function scheduleReconnect() {
  if (!desiredConnected) return;
  clearReconnectTimer();
  const delayMs = getScannerReconnectDelayMs(recoverAttemptCount);
  recoverAttemptCount += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectGrantedPort();
  }, delayMs);
}

function handleConnectionFailure(
  error,
  fallbackState = SCANNER_STATUS_STATES.ERROR
) {
  if (!desiredConnected) {
    return;
  }

  const classification = classifyScannerConnectionFailure(error, fallbackState);
  const disconnectedAt = new Date().toISOString();
  const portInfo = normalizeScannerPortInfo(
    activePort && typeof activePort.getInfo === 'function'
      ? activePort.getInfo()
      : preferredPortInfo
  );

  activeConnection = null;
  activePort = null;

  updateStatus({
    state: classification.state,
    portInfo,
    lastDisconnectedAt: disconnectedAt,
    lastError: classification.message,
    recoverAttemptCount
  });

  if (
    classification.recoverable ||
    classification.state === SCANNER_STATUS_STATES.WAITING_FOR_DEVICE ||
    classification.state === SCANNER_STATUS_STATES.BUSY
  ) {
    scheduleReconnect();
  }
}

function connectGrantedPort() {
  if (!desiredConnected || closingPromise) return;
  if (activeConnection && activePort) {
    updateStatus({
      state: SCANNER_STATUS_STATES.CONNECTED,
      portInfo: normalizeScannerPortInfo(activePort.getInfo()),
      lastError: '',
      recoverAttemptCount: 0
    });
    return;
  }
  if (openingPromise) {
    return openingPromise;
  }

  openingController = new AbortController();
  const { signal } = openingController;
  openingPromise = (async () => {
    clearReconnectTimer();
    if (!(globalThis.navigator && 'serial' in globalThis.navigator)) {
      handleConnectionFailure(
        new Error('Web Serial is not available in the scanner worker.')
      );
      return;
    }

    updateStatus({
      state:
        recoverAttemptCount > 0
          ? SCANNER_STATUS_STATES.RECOVERING
          : SCANNER_STATUS_STATES.STARTING,
      profileId: desiredProfileId,
      portInfo: preferredPortInfo,
      lastError: '',
      recoverAttemptCount
    });

    const profile = getSerialScannerProfile(desiredProfileId);
    const ports = await getGrantedSerialScannerPorts();
    if (signal.aborted) return;
    const selection = selectGrantedPort(
      ports,
      profile,
      preferredPortInfo,
      portMatchesProfile
    );
    const port = selection.port;

    if (!port) {
      if (
        selection.reason === 'ambiguous' ||
        selection.reason === 'unidentified'
      )
        desiredConnected = false;
      const noPortState = desiredProfileId
        ? SCANNER_STATUS_STATES.WAITING_FOR_DEVICE
        : SCANNER_STATUS_STATES.NEVER_CONFIGURED;
      const message =
        selection.reason === 'ambiguous'
          ? 'Multiple granted scanners have the same identity. Disconnect or revoke access to the others, then select the scanner again.'
          : selection.reason === 'unidentified'
            ? 'The scanner could not be identified. Select a scanner with identifiable port information.'
            : selection.reason === 'preferred_missing'
              ? 'The selected scanner was not found. Reconnect it or select a scanner again.'
              : 'Scanner not found. Reconnect the cradle or power it on, then select the scanner if needed.';
      if (!desiredConnected) {
        updateStatus({
          state: SCANNER_STATUS_STATES.ERROR,
          selectionRequired: true,
          lastError: message
        });
        return;
      }
      handleConnectionFailure(new Error(message), noPortState);
      return;
    }

    activePort = port;
    preferredPortInfo = normalizeScannerPortInfo(port.getInfo());

    activeConnection = await openSerialScanner(port, profile, {
      signal,
      onScan: (scan) => {
        if (!desiredConnected || signal.aborted || activePort !== port) return;
        updateStatus({
          lastCaptureAt: scan.capturedAt || new Date().toISOString(),
          captureCount: currentStatus.captureCount + 1
        });
        postToHost({ type: SCANNER_WORKER_MESSAGES.SCAN, scan });
      },
      onStatus: (status) => {
        if (!desiredConnected || signal.aborted || activePort !== port) return;
        if (status.state === 'open') {
          recoverAttemptCount = 0;
          updateStatus({
            state: SCANNER_STATUS_STATES.CONNECTED,
            profileId: profile.id,
            portInfo: normalizeScannerPortInfo(
              status.portInfo || port.getInfo()
            ),
            lastConnectedAt: new Date().toISOString(),
            lastError: '',
            recoverAttemptCount: 0
          });
          return;
        }

        if (status.state === 'disconnected') {
          void recoverFromReadFailure(
            new DOMException('Serial device disconnected.', 'NetworkError')
          );
        }
      },
      onError: (error) => {
        if (desiredConnected && !signal.aborted && activePort === port) {
          void recoverFromReadFailure(error);
        }
      }
    });
  })()
    .catch((error) => {
      // Disconnect must see a failed close even if opening was cancelled.
      if (signal.aborted) {
        if (activePort) throw error;
        return;
      }
      return recoverFromReadFailure(error);
    })
    .finally(() => {
      openingPromise = null;
      openingController = null;
    });

  return openingPromise;
}

function reply(requestId, fields) {
  postToHost({ type: SCANNER_WORKER_MESSAGES.REPLY, requestId, ...fields });
}

async function disconnectScanner(requestId) {
  desiredConnected = false;
  stopping = true;
  recoverAttemptCount = 0;
  clearReconnectTimer();
  openingController?.abort();
  updateStatus({ state: SCANNER_STATUS_STATES.STOPPING });
  try {
    await openingPromise;
    await closeActiveConnection();
    updateStatus({
      state: SCANNER_STATUS_STATES.DISABLED,
      portInfo: preferredPortInfo,
      lastDisconnectedAt: new Date().toISOString(),
      lastError: '',
      recoverAttemptCount: 0
    });
    reply(requestId, { status: currentStatus });
  } catch {
    updateStatus({
      state: SCANNER_STATUS_STATES.UNAVAILABLE,
      lastError: 'Could not confirm that the scanner stopped.'
    });
    reply(requestId, { error: currentStatus.lastError });
  } finally {
    stopping = false;
  }
}

async function refreshPorts() {
  const port = activePort;
  if (desiredConnected && activeConnection && port) {
    const available = await getGrantedSerialScannerPorts();
    if (desiredConnected && activePort === port && !available.includes(port)) {
      await recoverFromReadFailure(
        new DOMException('Serial device disconnected.', 'NetworkError')
      );
      return;
    }
  }
  if (desiredConnected && !activeConnection && !openingPromise) {
    void connectGrantedPort();
  }
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  switch (data.type) {
    case SCANNER_WORKER_MESSAGES.CONNECT_GRANTED:
      if (stopping || (!desiredConnected && activePort)) break;
      desiredConnected = true;
      updateStatus({ selectionRequired: false });
      desiredProfileId = String(
        data.profileId || desiredProfileId || ''
      ).trim();
      preferredPortInfo = normalizeScannerPortInfo(data.preferredPortInfo);
      void connectGrantedPort();
      break;
    case SCANNER_WORKER_MESSAGES.DISCONNECT:
      if (stopping) {
        reply(data.requestId, { error: 'The scanner is already stopping.' });
      } else {
        void disconnectScanner(data.requestId);
      }
      break;
    case SCANNER_WORKER_MESSAGES.REFRESH_PORTS:
      void refreshPorts().catch(() => undefined);
      break;
    case SCANNER_WORKER_MESSAGES.GET_STATUS:
      reply(data.requestId, { status: currentStatus });
      break;
    default:
      break;
  }
});
