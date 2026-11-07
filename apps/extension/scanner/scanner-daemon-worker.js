import '../capability.js';
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

let scannerRecorder = null;
let testController = null;
if (globalThis.VaxLinkDiagnostics?.enabled) {
  const { createScannerRecorder } =
    await import('../diagnostics/scanner-recorder.js');
  scannerRecorder = createScannerRecorder({ post: postToHost });
  const { createScannerTestController } =
    await import('../diagnostics/scanner-test.js');
  testController = createScannerTestController({
    getConnection: () => activeConnection,
    post: postToHost
  });
}

let desiredProfileId = '';
let preferredPortInfo = null;
let desiredConnected = false;
let activeConnection = null;
let activePort = null;
let reconnectTimer = null;
let openingPromise = null;
let recoverAttemptCount = 0;
let currentStatus = createScannerStatusSnapshot();

function postToHost(message) {
  self.postMessage(message);
}

function updateStatus(overrides = {}) {
  currentStatus = normalizeScannerStatusSnapshot({
    ...currentStatus,
    ...overrides,
    observedAt: new Date().toISOString()
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
  await connection.close().catch(() => undefined);
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

  const testInterrupted = testController?.connectionLost() || false;
  if (testInterrupted) desiredConnected = false;
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
    !testInterrupted &&
    (classification.recoverable ||
      classification.state === SCANNER_STATUS_STATES.WAITING_FOR_DEVICE ||
      classification.state === SCANNER_STATUS_STATES.BUSY)
  ) {
    scheduleReconnect();
  }
}

async function connectGrantedPort(trigger = 'manual') {
  if (!desiredConnected) {
    return;
  }
  if (activeConnection && activePort && activeConnection.readable) {
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
    if (activeConnection && !activeConnection.readable) {
      await closeActiveConnection();
      if (!desiredConnected) return;
    }
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
        selection.reason === 'preferred_missing' ||
        selection.reason === 'no_match'
      ) {
        desiredConnected = false;
        updateStatus({
          state: SCANNER_STATUS_STATES.ERROR,
          lastError:
            'Scanner selection is not unique or the selected scanner is unavailable. Open Setup to select the scanner. If identical devices are granted, remove unneeded browser permissions first.',
          recoverAttemptCount
        });
        return;
      }
      const noPortState = desiredProfileId
        ? SCANNER_STATUS_STATES.WAITING_FOR_DEVICE
        : SCANNER_STATUS_STATES.NEVER_CONFIGURED;
      handleConnectionFailure(
        new Error(
          noPortState === SCANNER_STATUS_STATES.NEVER_CONFIGURED
            ? 'No previously granted serial port found. Use Select Scanner first.'
            : 'Scanner not found. Reconnect the cradle or power it on.'
        ),
        noPortState
      );
      return;
    }

    activePort = port;
    preferredPortInfo = normalizeScannerPortInfo(port.getInfo());

    try {
      const connection = await openSerialScanner(port, profile, {
        onRead: (observation) => {
          if (observation.owner !== 'clinical')
            testController?.onRead(observation);
          else scannerRecorder?.onRead(observation);
        },
        onBoundary: () => scannerRecorder?.boundary('user'),
        onScan: (scan, capture) => {
          if (capture.owner !== 'clinical') {
            testController?.onScan(scan, capture);
            return;
          }
          const link = scannerRecorder?.onFrame(capture);
          if (link) scan.diagnosticLink = link;
          updateStatus({
            lastCaptureAt: scan.capturedAt || new Date().toISOString(),
            captureCount: currentStatus.captureCount + 1
          });
          postToHost({ type: 'scan', scan });
        },
        onStatus: (status) => {
          if (status.state === 'open') {
            if (!desiredConnected) return;
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
            scannerRecorder?.onDisconnect();
            handleConnectionFailure(
              new DOMException('Serial device disconnected.', 'NetworkError')
            );
          }
        },
        onError: (error) => {
          scannerRecorder?.onDisconnect();
          handleConnectionFailure(error);
        }
      });
      if (!desiredConnected) {
        await connection.close();
        activePort = null;
        return;
      }
      activeConnection = connection;
    } catch (error) {
      handleConnectionFailure(error);
    }
  })().finally(() => {
    openingPromise = null;
  });

  return openingPromise;
}

async function disconnectScanner() {
  scannerRecorder?.onDisconnect();
  testController?.connectionLost();
  desiredConnected = false;
  recoverAttemptCount = 0;
  clearReconnectTimer();
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
  if (testController?.handleMessage(data)) return;
  switch (data.type) {
    case 'diagnosticSession':
      scannerRecorder?.setSession(data.session);
      break;
    case 'connectGranted':
      desiredConnected = true;
      desiredProfileId = String(
        data.profileId || desiredProfileId || ''
      ).trim();
      preferredPortInfo = normalizeScannerPortInfo(
        data.preferredPortInfo || preferredPortInfo
      );
      void connectGrantedPort(data.trigger || 'manual');
      break;
    case 'disconnect':
      void disconnectScanner();
      break;
    case 'refreshPorts':
      if (desiredConnected && !activeConnection && !openingPromise) {
        void connectGrantedPort(data.trigger || 'refresh');
      }
      break;
    case 'getStatus':
      currentStatus = normalizeScannerStatusSnapshot({
        ...currentStatus,
        observedAt: new Date().toISOString()
      });
      postToHost({
        type: 'status',
        status: currentStatus,
        requestId: data.requestId
      });
      break;
    default:
      break;
  }
});

if (scannerRecorder)
  postToHost({
    type: 'diagnosticContext',
    contextId: scannerRecorder.contextId
  });
