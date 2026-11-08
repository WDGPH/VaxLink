import {
  SCANNER_STATUS_STATES,
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
let disconnecting = false;
let releaseFailed = false;
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
  postToHost({ type: 'status', status: currentStatus });
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

async function closeActiveConnection() {
  const connection = activeConnection;
  activeConnection = null;
  activePort = null;
  if (!connection) return;
  await connection.close();
}

function scheduleReconnect() {
  if (!desiredConnected) return;
  clearReconnectTimer();
  const delayMs = getScannerReconnectDelayMs(recoverAttemptCount);
  recoverAttemptCount += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectGrantedPort('retry');
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

async function connectGrantedPort(trigger = 'manual') {
  if (!desiredConnected) {
    return;
  }
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
    if (!desiredConnected) return;
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

    try {
      activeConnection = await openSerialScanner(port, profile, {
        onScan: (scan) => {
          if (!desiredConnected || disconnecting) return;
          updateStatus({
            lastCaptureAt: scan.capturedAt || new Date().toISOString(),
            captureCount: currentStatus.captureCount + 1
          });
          postToHost({ type: 'scan', scan });
        },
        onStatus: (status) => {
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
            handleConnectionFailure(
              new DOMException('Serial device disconnected.', 'NetworkError')
            );
          }
        },
        onError: (error) => {
          if (error?.releaseFailed) {
            releaseFailed = true;
            desiredConnected = false;
            clearReconnectTimer();
            updateStatus({
              state: SCANNER_STATUS_STATES.ERROR,
              lastError: 'Scanner port release failed.'
            });
            return;
          }
          handleConnectionFailure(error);
        }
      });
    } catch (error) {
      handleConnectionFailure(error);
    }
  })().finally(() => {
    openingPromise = null;
  });

  return openingPromise;
}

async function disconnectScanner() {
  disconnecting = true;
  desiredConnected = false;
  recoverAttemptCount = 0;
  clearReconnectTimer();
  if (openingPromise) await openingPromise;
  if (releaseFailed) throw new Error('Scanner release failed');
  await closeActiveConnection();
  updateStatus({
    state: SCANNER_STATUS_STATES.DISABLED,
    portInfo: preferredPortInfo,
    lastDisconnectedAt: new Date().toISOString(),
    lastError: '',
    recoverAttemptCount: 0
  });
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  switch (data.type) {
    case 'connectGranted':
      if (disconnecting || releaseFailed) break;
      desiredConnected = true;
      updateStatus({ selectionRequired: false });
      desiredProfileId = String(
        data.profileId || desiredProfileId || ''
      ).trim();
      preferredPortInfo = normalizeScannerPortInfo(
        data.preferredPortInfo || preferredPortInfo
      );
      void connectGrantedPort(data.trigger || 'manual');
      break;
    case 'disconnect':
      if (disconnecting) {
        postToHost({
          type: 'disconnected',
          requestId: data.requestId,
          success: false
        });
        break;
      }
      void disconnectScanner().then(
        () => {
          disconnecting = false;
          postToHost({
            type: 'disconnected',
            requestId: data.requestId,
            success: true
          });
        },
        () => {
          updateStatus({
            state: SCANNER_STATUS_STATES.ERROR,
            lastError:
              'Scanner release was not confirmed. Reload the extension before reconnecting.'
          });
          postToHost({
            type: 'disconnected',
            requestId: data.requestId,
            success: false
          });
        }
      );
      break;
    case 'refreshPorts':
      if (desiredConnected && !activeConnection && !openingPromise) {
        void connectGrantedPort(data.trigger || 'refresh');
      }
      break;
    case 'getStatus':
      postToHost({ type: 'status', status: currentStatus });
      break;
    default:
      break;
  }
});
