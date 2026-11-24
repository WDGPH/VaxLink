const VAXLINK_BG_DEBUG = false;
importScripts('build-info.js');
importScripts('shared/gs1-parser.js');
importScripts('shared/expiry-date.js');
importScripts('shared/vaccine-label.js');
importScripts('scanner/scanner-lock-session.js');
importScripts('scanner/scanner-daemon-protocol.js');
importScripts('shared/tray-doses.js');

const {
  getTrayRemainingDoses,
  getTrayDoseFields,
  canPinTrayDose,
  defaultChartDose
} = globalThis.VaxLinkTrayDoses;

const {
  SCANNER_LOCK_STATE_KEY,
  SCANNER_LOCK_SESSION_KEY,
  normalizeMachineIdleState,
  shouldQueueScannerScan,
  createLockedScannerSession,
  closeLockedScannerSession,
  isLockedScannerSession,
  buildLockedScanQueueContext
} = globalThis.VaxLinkScannerLockSession;

function bgLog(...args) {
  if (VAXLINK_BG_DEBUG) console.log('[VaxLink]', ...args);
}

let nvcBundle = null;
let nvcIndexes = {};
let bundleLoadPromise = null;
let nvcInitializationPromise = null;
let nvcRefreshPromise = null;
let nvcCacheInvalid = false;
let nvcHealth = {};
let nvcUsingCache = false;
const NVC_LOOKUP_WAIT_MS = 5000;
const NVC_DOWNLOAD_TIMEOUT_MS = 15000;
const DEFAULT_NVC_SOURCE_URL = 'https://nvc-cnv.canada.ca/fhir/v2/Bundle/NVC';
const AUTO_SYNC_INTERVAL_MINUTES = 24 * 60;
const AUTO_SYNC_ALARM_NAME = 'nvc-auto-sync';
const ACTION_ICON_SIZES = [16, 32, 48, 128];
const ACTION_ICON_PATH = 'assets/vaxlink-icon.svg';
const NVC_FETCH_HEADERS = {
  Accept: 'application/json+fhir',
  'x-app-desc': 'PHAC NVC Client'
};
const GTIN_TRADENAME_CODE_OVERRIDES = Object.freeze({
  // RECOMBIVAX HB adult lots scanned with this GTIN are ambiguous in NVC.
  // Force adult tradename code (6951000087100) so the GTIN path is always reliable.
  '00067055046339': '6951000087100'
});

// Lot numbers known to be mislinked in the NVC bundle: the NVC associates these
// adult RECOMBIVAX HB lots with the pediatric tradename. The lot override fires
// when no GTIN is present in the barcode (the GTIN_TRADENAME_CODE_OVERRIDES path
// only activates when AI(01) is scanned). Both mechanisms resolve to the same
// adult tradename code; having both ensures the override works regardless of
// barcode format. Add new lots here as they are discovered.
const LOT_TRADENAME_CODE_OVERRIDES = Object.freeze({
  // RECOMBIVAX HB adult — NVC incorrectly links to pediatric tradename
  Y016312: '6951000087100',
  Y020519: '6951000087100',
  // VAQTA (HA) adult — NVC lists this lot's pediatric tradename link before
  // the adult one, so the default first-match resolution picks pediatric.
  Y018089: '6901000087101'
});
const STORAGE_KEYS = {
  bundle: 'nvc_bundle_override',
  updatedAt: 'nvc_bundle_updated_at',
  lastCheckAt: 'nvc_bundle_last_check_at',
  bundleSha256: 'nvc_bundle_sha256',
  lastModified: 'nvc_bundle_last_modified',
  health: 'nvc_bundle_health'
};
const ANALYTICS_STORAGE_KEY = 'vaxlink_analytics_v1';
const ANALYTICS_TOP_LIMIT = 12;
let analyticsWriteQueue = Promise.resolve();
let scannerQueueWriteQueue = Promise.resolve();
let pendingInboxWriteQueue = Promise.resolve();
let scannerStatusWriteQueue = Promise.resolve();
let scannerControlQueue = Promise.resolve();
let scannerLockSessionPromise = null;
let iconInitPromise = null;
const WORKFLOW_MODE_KEY = 'vaxlink_workflow_mode_v1';
const LEGACY_POPUP_MODE_KEY = 'vaxlink_popup_mode_v1';
const LEGACY_HANDS_FREE_KEY = 'hands_free_scan_autofill_enabled';
const LEGACY_REMOTE_MODE_KEY = 'hands_free_scan_mode_v1';
const MULTIPLE_INJECT_QUEUE_KEY = 'multiple_inject_queue_v1';
const INVENTORY_BATCH_KEY = 'inventory_scan_batch_v1';
const PENDING_SCAN_INBOX_KEY = 'vaxlink_pending_scan_inbox_v1';
const SCANNER_CAPTURE_ERROR_KEY = 'vaxlink_scanner_capture_error_v1';
const PENDING_SCAN_INBOX_LIMIT = 250;
const PENDING_SCAN_INBOX_MAX_BYTES = 1024 * 1024;
const BADGE_COLOR = '#0891b2';
const SCANNER_PAIRING_TAB_KEY = 'vaxlink_scanner_pairing_tab';
let scannerPairingRequest;
const SCANNER_TEST_OWNER_KEY = 'vaxlink_scanner_test_owner_v1';
const SCANNER_PROFILE_STORAGE_KEY = 'vaxlink_serial_scanner_profile_v1';
const SCANNER_PORT_INFO_STORAGE_KEY = 'vaxlink_serial_scanner_port_info_v1';
const {
  SCANNER_DAEMON_ENABLED_KEY,
  SCANNER_STATUS_SNAPSHOT_KEY,
  SCANNER_DAEMON_OFFSCREEN_PATH,
  SCANNER_DAEMON_TARGET,
  SCANNER_DAEMON_BACKGROUND_TARGET,
  SCANNER_DAEMON_ACTIONS,
  SCANNER_STATUS_STATES,
  normalizeScannerPortInfo,
  createScannerStatusSnapshot,
  normalizeScannerStatusSnapshot,
  buildDefaultScannerStatus
} = globalThis.VaxLinkScannerDaemon;
let scannerDaemonCreatePromise = null;
let scannerDaemonStatusCache = createScannerStatusSnapshot();

// Load NVC bundle on installation/startup
chrome.runtime.onInstalled.addListener(() => {
  bgLog('Vaccine Scanner extension installed');
  ensureActionIcon();
  initializeNVCSync();
  synchronizeScannerLockState();
  void maybeStartScannerDaemon('install').catch((error) => {
    console.warn('Scanner daemon startup failed on install:', error);
  });
});

// Also load on startup
chrome.runtime.onStartup.addListener(() => {
  ensureActionIcon();
  initializeNVCSync();
  synchronizeScannerLockState();
  void maybeStartScannerDaemon('startup').catch((error) => {
    console.warn('Scanner daemon startup failed on browser start:', error);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === AUTO_SYNC_ALARM_NAME) {
    maybeAutoRefreshNVCBundle('alarm');
  }
});

// Load immediately when service worker starts
bgLog('Service worker started, loading saved NVC bundle');
ensureActionIcon();
void loadNVCBundle();
let queueBadgeCount = 0;
let scannerCaptureWarning = false;
let captureWarningGeneration = 0;
let captureWarningWrites = Promise.resolve();

initQueueBadge();
initializeScannerLockMonitoring();

function ensureActionIcon() {
  if (iconInitPromise) {
    return iconInitPromise;
  }

  iconInitPromise = (async () => {
    try {
      const iconUrl = chrome.runtime.getURL(ACTION_ICON_PATH);
      const response = await fetch(iconUrl, { cache: 'force-cache' });
      if (!response.ok) {
        throw new Error(`Icon fetch failed: HTTP ${response.status}`);
      }

      const svgText = await response.text();
      const svgBlob = new Blob([svgText], { type: 'image/svg+xml' });
      const bitmap = await createImageBitmap(svgBlob);
      const imageData = {};

      for (const size of ACTION_ICON_SIZES) {
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error('OffscreenCanvas 2D context unavailable');
        }
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(bitmap, 0, 0, size, size);
        imageData[size] = ctx.getImageData(0, 0, size, size);
      }

      chrome.action.setIcon({ imageData });
      bgLog('Action icon updated from VaxLink SVG');
    } catch (error) {
      console.warn('Failed to set custom action icon from SVG:', error);
    }
  })();

  return iconInitPromise;
}

function renderQueueBadge() {
  chrome.action.setBadgeText({
    text: scannerCaptureWarning
      ? '!'
      : queueBadgeCount > 0
        ? String(queueBadgeCount)
        : ''
  });
  chrome.action.setBadgeBackgroundColor({
    color: scannerCaptureWarning ? '#b91c1c' : BADGE_COLOR
  });
}

function updateQueueBadge(rows) {
  queueBadgeCount = Array.isArray(rows) ? rows.length : 0;
  renderQueueBadge();
}

function recordCaptureWarning() {
  captureWarningGeneration++;
  scannerCaptureWarning = true;
  renderQueueBadge();
  captureWarningWrites = captureWarningWrites
    .catch(() => undefined)
    .then(() => setStorage({ [SCANNER_CAPTURE_ERROR_KEY]: true }));
  return captureWarningWrites;
}

function acknowledgeCaptureWarning() {
  const generation = ++captureWarningGeneration;
  const result = captureWarningWrites
    .catch(() => undefined)
    .then(async () => {
      await setStorage({ [SCANNER_CAPTURE_ERROR_KEY]: false });
      if (generation !== captureWarningGeneration) return;
      scannerCaptureWarning = false;
      renderQueueBadge();
    });
  captureWarningWrites = result;
  return result;
}

function initQueueBadge() {
  const generation = captureWarningGeneration;
  chrome.storage.local.get(
    [MULTIPLE_INJECT_QUEUE_KEY, SCANNER_CAPTURE_ERROR_KEY],
    (stored) => {
      if (
        generation === captureWarningGeneration &&
        stored?.[SCANNER_CAPTURE_ERROR_KEY] === true
      )
        scannerCaptureWarning = true;
      updateQueueBadge(stored && stored[MULTIPLE_INJECT_QUEUE_KEY]);
    }
  );
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (MULTIPLE_INJECT_QUEUE_KEY in changes)
      updateQueueBadge(changes[MULTIPLE_INJECT_QUEUE_KEY].newValue);
  });
}

function getStorage(keys) {
  return new Promise((resolve, reject) =>
    chrome.storage.local.get(keys, (stored) => {
      if (chrome.runtime.lastError)
        reject(new Error(chrome.runtime.lastError.message));
      else resolve(stored);
    })
  );
}

function setStorage(values) {
  return new Promise((resolve, reject) =>
    chrome.storage.local.set(values, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    })
  );
}

async function getScannerBootstrapState() {
  const stored = await getStorage([
    SCANNER_DAEMON_ENABLED_KEY,
    SCANNER_PROFILE_STORAGE_KEY,
    SCANNER_PORT_INFO_STORAGE_KEY,
    SCANNER_STATUS_SNAPSHOT_KEY
  ]);
  const enabled = stored[SCANNER_DAEMON_ENABLED_KEY] === true;
  const profileId = String(stored[SCANNER_PROFILE_STORAGE_KEY] || '').trim();
  const portInfo = normalizeScannerPortInfo(
    stored[SCANNER_PORT_INFO_STORAGE_KEY]
  );
  const status = stored[SCANNER_STATUS_SNAPSHOT_KEY]
    ? normalizeScannerStatusSnapshot(stored[SCANNER_STATUS_SNAPSHOT_KEY])
    : buildDefaultScannerStatus({ enabled, profileId, portInfo });
  scannerDaemonStatusCache = status;
  return { enabled, profileId, portInfo, status };
}

function persistScannerStatusSnapshot(snapshot) {
  const result = scannerStatusWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const stored = await getStorage([
        SCANNER_STATUS_SNAPSHOT_KEY,
        SCANNER_DAEMON_ENABLED_KEY,
        SCANNER_PORT_INFO_STORAGE_KEY
      ]);
      const previous = normalizeScannerStatusSnapshot(
        stored[SCANNER_STATUS_SNAPSHOT_KEY]
      );
      const normalized = normalizeScannerStatusSnapshot(snapshot);
      normalized.lastKnownCaptureAt =
        [
          previous.lastKnownCaptureAt,
          previous.lastCaptureAt,
          normalized.lastKnownCaptureAt,
          normalized.lastCaptureAt
        ]
          .sort()
          .at(-1) || '';
      scannerDaemonStatusCache = normalized;
      const values = {
        [SCANNER_STATUS_SNAPSHOT_KEY]: normalized
      };
      if (normalized.selectionRequired && !normalized.testing)
        values[SCANNER_DAEMON_ENABLED_KEY] = false;
      // An old install can have a profile without a saved port identity.
      if (
        normalized.state === SCANNER_STATUS_STATES.CONNECTED &&
        !normalized.testing &&
        normalized.portInfo &&
        stored[SCANNER_DAEMON_ENABLED_KEY] === true &&
        !stored[SCANNER_PORT_INFO_STORAGE_KEY]
      ) {
        values[SCANNER_PORT_INFO_STORAGE_KEY] = normalized.portInfo;
      }
      await setStorage(values);
      return normalized;
    });
  scannerStatusWriteQueue = result;
  return result;
}

async function broadcastScannerStatus(snapshot) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        action: SCANNER_DAEMON_ACTIONS.STATUS_CHANGED,
        status: snapshot
      },
      () => {
        void chrome.runtime.lastError;
        resolve();
      }
    );
  });
}

async function hasScannerDaemonDocument() {
  const offscreenUrl = chrome.runtime.getURL(SCANNER_DAEMON_OFFSCREEN_PATH);
  if (typeof chrome.runtime.getContexts === 'function') {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    return contexts.length > 0;
  }

  if (
    typeof clients === 'undefined' ||
    typeof clients.matchAll !== 'function'
  ) {
    return false;
  }
  const matchedClients = await clients.matchAll();
  return matchedClients.some((client) => client.url === offscreenUrl);
}

async function ensureScannerDaemon() {
  if (
    !chrome.offscreen ||
    typeof chrome.offscreen.createDocument !== 'function'
  ) {
    throw new Error(
      'The Offscreen API is not available in this browser context.'
    );
  }

  if (await hasScannerDaemonDocument()) {
    return { created: false };
  }

  if (!scannerDaemonCreatePromise) {
    scannerDaemonCreatePromise = chrome.offscreen
      .createDocument({
        url: SCANNER_DAEMON_OFFSCREEN_PATH,
        reasons: ['WORKERS'],
        justification:
          'Keep a previously granted scanner connection active without a visible tab.'
      })
      .finally(() => {
        scannerDaemonCreatePromise = null;
      });
  }

  await scannerDaemonCreatePromise;
  return { created: true };
}

function sendRuntimeMessage(message) {
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

async function sendScannerDaemonMessage(message) {
  await ensureScannerDaemon();
  return sendRuntimeMessage({ ...message, target: SCANNER_DAEMON_TARGET });
}

function queueScannerControl(task) {
  const pending = scannerControlQueue.then(task);
  scannerControlQueue = pending.catch(() => undefined);
  return pending;
}

function maybeStartScannerDaemon(trigger = 'startup') {
  return queueScannerControl(async () => {
    if ((await getScannerTestOwner()) === undefined)
      return startConfiguredScanner(trigger);
  });
}

async function startConfiguredScanner(trigger) {
  const bootstrap = await getScannerBootstrapState();
  if (
    !bootstrap.enabled ||
    !bootstrap.profileId ||
    (bootstrap.status.selectionRequired && !bootstrap.status.testing)
  ) {
    return { started: false, status: bootstrap.status };
  }
  await ensureScannerDaemon();
  const response = await sendRuntimeMessage({
    target: SCANNER_DAEMON_TARGET,
    action: SCANNER_DAEMON_ACTIONS.CONNECT_GRANTED,
    profileId: bootstrap.profileId,
    preferredPortInfo: bootstrap.portInfo,
    trigger
  });
  return {
    started: response?.success === true,
    status: response?.status || bootstrap.status
  };
}

async function stopConfiguredScanner(
  action = SCANNER_DAEMON_ACTIONS.DISCONNECT,
  portInfo
) {
  const reply = await sendScannerDaemonMessage({ action, portInfo });
  if (!reply?.success) {
    throw new Error(
      reply?.error || 'Could not confirm that the scanner stopped.'
    );
  }
  return reply;
}

function isScannerSetupPage(sender) {
  return (
    sender.id === chrome.runtime.id &&
    sender.url?.split('?')[0] === chrome.runtime.getURL('scanner-pairing.html')
  );
}

async function getScannerTestOwner() {
  const stored = await chrome.storage.session.get(SCANNER_TEST_OWNER_KEY);
  return stored[SCANNER_TEST_OWNER_KEY];
}

async function requireRegularScannerControls() {
  if ((await getScannerTestOwner()) !== undefined) {
    throw new Error('Finish or close the scanner test first.');
  }
}

async function startScannerTest(tabId) {
  await requireRegularScannerControls();
  const { profileId, portInfo } = await getScannerBootstrapState();
  if (!profileId) throw new Error('Connect a scanner before testing it.');
  await chrome.tabs.get(tabId);
  await chrome.storage.session.set({ [SCANNER_TEST_OWNER_KEY]: tabId });
  try {
    await stopConfiguredScanner();
  } catch (error) {
    await chrome.storage.session.remove(SCANNER_TEST_OWNER_KEY);
    throw error;
  }
  try {
    const reply = await sendScannerDaemonMessage({
      action: SCANNER_DAEMON_ACTIONS.CONNECT_GRANTED,
      profileId,
      preferredPortInfo: portInfo,
      testing: true
    });
    if (!reply?.success)
      throw new Error(reply?.error || 'Could not start the scanner test.');
    return reply;
  } catch (error) {
    await endScannerTest(tabId);
    throw error;
  }
}

async function endScannerTest(tabId, tabClosed = false) {
  if ((await getScannerTestOwner()) !== tabId) return { success: true };
  try {
    await stopConfiguredScanner();
  } catch (error) {
    // If setup has closed, let Settings retry the stop. Capture stays paused.
    if (tabClosed) await chrome.storage.session.remove(SCANNER_TEST_OWNER_KEY);
    throw error;
  }
  // Both pagehide and tab removal can report the same exit.
  await chrome.storage.session.remove(SCANNER_TEST_OWNER_KEY);
  await scannerStatusWriteQueue.catch(() => undefined);
  await startConfiguredScanner('test_finished');
  return { success: true };
}

chrome.tabs.onRemoved?.addListener((tabId) => {
  void queueScannerControl(() => endScannerTest(tabId, true)).catch(
    () => undefined
  );
});

async function connectConfiguredScanner(request) {
  await requireRegularScannerControls();
  const bootstrap = await getScannerBootstrapState();
  const selected = request.action === SCANNER_DAEMON_ACTIONS.SELECT;
  const requestedPort = normalizeScannerPortInfo(request.preferredPortInfo);
  const profileId = String(
    request.profileId || bootstrap.profileId || ''
  ).trim();
  const portInfo = requestedPort || bootstrap.portInfo;
  if (!profileId) throw new Error('Connect a scanner before reconnecting.');
  if (selected && !requestedPort)
    throw new Error('The selected scanner could not be identified.');

  if (selected && (await hasScannerDaemonDocument())) {
    // Keep the previous selection if its port cannot be closed.
    await stopConfiguredScanner();
    await scannerStatusWriteQueue.catch(() => undefined);
  }
  const values = {
    [SCANNER_PROFILE_STORAGE_KEY]: profileId,
    [SCANNER_PORT_INFO_STORAGE_KEY]: portInfo,
    [SCANNER_DAEMON_ENABLED_KEY]:
      selected || request.enableAutostart === true || bootstrap.enabled
  };
  if (selected) await setStorage(values);
  const reply = await sendScannerDaemonMessage({
    action: SCANNER_DAEMON_ACTIONS.CONNECT_GRANTED,
    profileId,
    preferredPortInfo: portInfo
  });
  if (!reply?.success)
    throw new Error(reply?.error || 'Scanner reconnect failed.');
  if (!selected) {
    if (!request.profileId) delete values[SCANNER_PROFILE_STORAGE_KEY];
    if (!requestedPort) delete values[SCANNER_PORT_INFO_STORAGE_KEY];
    await setStorage(values);
  }
  return { success: true, accepted: true };
}

// A hardware scanner can fire twice on one vial (issue #25). Inventory mode is
// exempt: repeated identical scans there are legitimate stock counting.
//
// The window must stay short: vaccine barcodes carry no per-unit serial, so two
// patients vaccinated back-to-back from the same lot scan as identical
// barcodes. 3s catches scanner double-fires (content.js additionally suppresses
// identical scans under 1.5s) without swallowing a deliberate next-patient scan.
const DUPLICATE_SCAN_WINDOW_MS = 3000;
function scanIdentityKey(record) {
  if (!record || typeof record !== 'object') return '';
  const raw = String(record.raw_barcode || '').trim();
  if (raw) return `raw:${raw}`;
  const gtin = String(record.gtin || '').trim();
  const lot = String(record.lot || '')
    .trim()
    .toUpperCase();
  const serial = String(record.serial || '').trim();
  if (!gtin && !lot) return '';
  return `ids:${gtin}|${lot}|${serial}`;
}

function findRecentDuplicateQueueRow(rows, record, nowMs) {
  const key = scanIdentityKey(record);
  if (!key) return null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (scanIdentityKey(row) !== key) continue;
    const scannedAt = Date.parse(row && row.scanned_at);
    if (!Number.isFinite(scannedAt)) continue;
    if (Math.abs(nowMs - scannedAt) <= DUPLICATE_SCAN_WINDOW_MS) return row;
  }
  return null;
}

async function appendQueueRecordNow(storageKey, record, options = {}) {
  if (!storageKey) {
    throw new Error('Missing queue storage key');
  }
  if (!record || typeof record !== 'object') {
    throw new Error('Missing queue record');
  }
  const stored = await getStorage([storageKey]);
  const rows =
    stored && Array.isArray(stored[storageKey]) ? stored[storageKey] : [];

  if (storageKey === MULTIPLE_INJECT_QUEUE_KEY) {
    record = defaultChartDose(record);
  }

  if (
    storageKey === MULTIPLE_INJECT_QUEUE_KEY &&
    options.preserveEveryScan !== true
  ) {
    const recordScannedAt = Date.parse(record.scanned_at);
    const nowMs = Number.isFinite(recordScannedAt)
      ? recordScannedAt
      : Date.now();
    const duplicate = findRecentDuplicateQueueRow(rows, record, nowMs);
    if (duplicate) {
      return {
        ...record,
        duplicate_ignored: true,
        duplicate_of: duplicate.id || '',
        queueSizeAfter: rows.length
      };
    }
  }

  rows.push(record);
  await setStorage({ [storageKey]: rows });
  return {
    ...record,
    queueSizeAfter: rows.length
  };
}

function appendQueueRecord(storageKey, record, options = {}) {
  scannerQueueWriteQueue = scannerQueueWriteQueue
    .catch(() => undefined)
    .then(() => appendQueueRecordNow(storageKey, record, options));
  return scannerQueueWriteQueue;
}

const DOSE_RESERVATION_OPERATIONS = [
  'reserve_dose',
  'stop_dose',
  'review_dose'
];
const DOSE_IN_USE = 'This dose is already in use in another chart.';
const DOSE_REVIEW =
  'The chart may already contain this scan. Check the original chart before using it again.';

function doseReservations(row) {
  return Array.isArray(row?.dose_reservations) ? row.dose_reservations : [];
}

function withDoseReservations(row, reservations) {
  const updated = { ...row };
  if (reservations.length) updated.dose_reservations = reservations;
  else delete updated.dose_reservations;
  return updated;
}

async function findInactiveDoseDocument(storageKey, payload) {
  if (
    storageKey !== MULTIPLE_INJECT_QUEUE_KEY ||
    typeof payload?.id !== 'string' ||
    typeof payload.token !== 'string' ||
    typeof payload.used !== 'boolean'
  )
    return null;
  const stored = await getStorage([storageKey]);
  const rows = Array.isArray(stored[storageKey]) ? stored[storageKey] : [];
  const row = rows.find((row) => row?.id === payload.id);
  const reservation = doseReservations(row).find(
    ({ token }) => token === payload.token
  );
  if (!reservation || reservation.review) return null;

  // Ask the original document outside the queue writer. An inactive or frozen
  // tab cannot delay an unrelated capture.
  const inactive = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 900);
    chrome.tabs.sendMessage(
      reservation.tabId,
      { action: 'isDoseReservationActive', token: reservation.token },
      { documentId: reservation.documentId },
      (response) => {
        clearTimeout(timer);
        const error = chrome.runtime.lastError;
        // An absent reply does not tell us whether the original chart is done.
        resolve(
          error
            ? /No (?:tab|document) with id/i.test(error.message)
            : response?.active === false
        );
      }
    );
  });
  return inactive ? reservation : null;
}

// All queue changes share the scanner append writer so a read-modify-write
// cannot overwrite a scan received while another context is editing a row.
function mutateQueue(
  storageKey,
  operation,
  payload = {},
  popup = false,
  chart = null,
  inactiveDose = null
) {
  const result = scannerQueueWriteQueue
    .catch(() => undefined)
    .then(async () => {
      if (
        ![MULTIPLE_INJECT_QUEUE_KEY, INVENTORY_BATCH_KEY].includes(storageKey)
      ) {
        throw new Error('Invalid queue storage key');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Invalid queue payload');
      }
      if (
        operation === 'add' &&
        (!Array.isArray(payload.records) ||
          payload.records.some(
            (row) =>
              !row ||
              typeof row !== 'object' ||
              Array.isArray(row) ||
              typeof row.id !== 'string' ||
              !row.id.trim() ||
              'dose_reservations' in row
          ))
      ) {
        throw new Error('Queue add requires an array of records with IDs');
      }
      if (
        [
          'remove',
          'update',
          'consume',
          'setDoseCount',
          'setDosePinned',
          ...DOSE_RESERVATION_OPERATIONS
        ].includes(operation) &&
        (typeof payload.id !== 'string' || !payload.id.trim())
      ) {
        throw new Error('Queue operation requires a record ID');
      }
      if (
        operation === 'update' &&
        (!payload.patch ||
          typeof payload.patch !== 'object' ||
          Array.isArray(payload.patch) ||
          ('id' in payload.patch && payload.patch.id !== payload.id) ||
          'dose_reservations' in payload.patch)
      ) {
        throw new Error(
          'Queue update requires a patch that preserves the record ID'
        );
      }
      const stored = await getStorage([storageKey]);
      let rows = Array.isArray(stored[storageKey]) ? stored[storageKey] : [];
      const index = rows.findIndex((row) => row?.id === payload.id);
      const current = rows[index];
      const reservations = doseReservations(current);
      const reservation =
        typeof payload.token === 'string'
          ? reservations.find(({ token }) => token === payload.token)
          : null;
      const ownsReservation =
        chart &&
        reservation?.tabId === chart.tab.id &&
        reservation.documentId === chart.documentId;

      let consumeReviewed = false;
      if (DOSE_RESERVATION_OPERATIONS.includes(operation)) {
        if (
          storageKey !== MULTIPLE_INJECT_QUEUE_KEY ||
          typeof chart?.documentId !== 'string' ||
          !chart.documentId ||
          typeof payload.token !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(payload.token)
        )
          throw new Error('Open the chart again before using a tray dose.');

        if (operation === 'reserve_dose') {
          if (
            ![
              current?.lot,
              current?.tradename,
              current?.name,
              current?.generic_name
            ].some((value) => typeof value === 'string' && value.trim()) ||
            rows.findLastIndex((row) => row?.id === payload.id) !== index
          )
            throw new Error(
              'This vaccine is unavailable. Choose a tray item again.'
            );
          if (globalThis.VaxLinkExpiryDate.blocksChartUse(current))
            throw new Error(
              'This lot is expired or saved for reference. Choose another tray item.'
            );
          if (reservation && (!ownsReservation || reservation.review))
            throw new Error(DOSE_REVIEW);
          const remaining = getTrayRemainingDoses(current);
          if (remaining === null) return { record: current, reserved: false };
          if (reservation) return { record: current, reserved: true };
          if (reservations.length >= remaining)
            throw new Error(
              reservations.some((dose) => !dose.review)
                ? DOSE_IN_USE
                : DOSE_REVIEW
            );

          rows = rows.slice();
          rows[index] = withDoseReservations(current, [
            ...reservations,
            {
              token: payload.token,
              tabId: chart.tab.id,
              documentId: chart.documentId
            }
          ]);
          await setStorage({ [storageKey]: rows });
          return { record: current, reserved: true };
        }

        if (operation === 'stop_dose') {
          if (
            typeof payload.written !== 'boolean' ||
            (reservation && !ownsReservation)
          )
            throw new Error(
              'Only the original chart can stop using this dose.'
            );
          if (!reservation || reservation.review) return { rows };
        } else {
          const inactiveOriginal =
            inactiveDose?.token === reservation?.token &&
            inactiveDose?.tabId === reservation?.tabId &&
            inactiveDose?.documentId === reservation?.documentId;
          if (
            typeof payload.used !== 'boolean' ||
            !reservation ||
            (!reservation.review && !inactiveOriginal)
          )
            throw new Error(
              'Check the original chart before resolving this dose.'
            );
          consumeReviewed = payload.used;
        }

        if (!consumeReviewed) {
          // A possible write holds the dose until staff verify the original chart.
          const saved =
            payload.written === true && operation === 'stop_dose'
              ? reservations.map((dose) =>
                  dose === reservation ? { ...dose, review: true } : dose
                )
              : reservations.filter((dose) => dose !== reservation);
          rows = rows.slice();
          rows[index] = withDoseReservations(current, saved);
          await setStorage({ [storageKey]: rows });
          return { rows };
        }
      }

      if (
        (['remove', 'update', 'setDoseCount', 'setDosePinned'].includes(
          operation
        ) &&
          rows.some(
            (row) => row?.id === payload.id && doseReservations(row).length
          )) ||
        (operation === 'clear' &&
          rows.some((row) => doseReservations(row).length))
      )
        throw new Error(
          'Review the reserved dose on the original chart before changing the tray.'
        );

      let record = null;
      let consumed = null;
      if (operation === 'add') {
        const records =
          storageKey === MULTIPLE_INJECT_QUEUE_KEY
            ? payload.records.map((row) => {
                if (
                  popup &&
                  payload.confirmExpired === true &&
                  payload.records.length === 1
                )
                  return {
                    ...defaultChartDose(row),
                    reference_only: true,
                    expiry_flag: 'expired'
                  };
                if (globalThis.VaxLinkExpiryDate.isExpiredVaccine(row))
                  throw new Error(
                    'Confirm saving the expired lot for reference'
                  );
                return defaultChartDose(row);
              })
            : payload.records;
        rows = [...rows, ...records];
      } else if (operation === 'clear') {
        rows = [];
      } else if (operation === 'remove') {
        rows = rows.filter((row) => row?.id !== payload.id);
      } else if (operation === 'update') {
        rows = rows.map((row) => {
          if (row?.id !== payload.id) return row;
          record = { ...row, ...payload.patch };
          if (row.reference_only === true) record.reference_only = true;
          return record;
        });
      } else if (
        operation === 'setDoseCount' ||
        operation === 'setDosePinned'
      ) {
        const matches = rows.filter((row) => row?.id === payload.id);
        const [current] = matches;
        if (
          matches.length !== 1 ||
          payload.expected !== getTrayDoseFields(current)
        ) {
          throw new Error(
            'The saved dose changed. Check the tray and try again.'
          );
        }
        let changes;
        if (operation === 'setDoseCount') {
          if (!Number.isSafeInteger(payload.quantity) || payload.quantity < 1)
            throw new Error('Enter a whole number of doses greater than zero.');
          changes = {
            total_doses: payload.quantity,
            remaining_doses: payload.quantity,
            dose_tracking: 'manual'
          };
        } else {
          if (
            storageKey !== MULTIPLE_INJECT_QUEUE_KEY ||
            typeof payload.pinned !== 'boolean' ||
            !canPinTrayDose(current)
          )
            throw new Error(
              'Only a single or uncounted chart dose can be pinned.'
            );
          changes = {
            total_doses: null,
            remaining_doses: null,
            dose_tracking: payload.pinned ? 'retained' : 'single_use'
          };
        }
        record = { ...current, ...changes };
        rows = rows.map((row) => (row === current ? record : row));
      } else if (operation === 'consume' || consumeReviewed) {
        if (index >= 0) {
          if (
            !consumeReviewed &&
            (reservations.length || payload.token !== undefined) &&
            (!ownsReservation || reservation.review)
          )
            throw new Error(DOSE_IN_USE);
          consumed = current;
          const remaining = getTrayRemainingDoses(current);
          const saved = reservations.filter((dose) => dose !== reservation);
          if (remaining === null) record = current;
          else if (remaining > 1) {
            record = withDoseReservations(
              { ...current, remaining_doses: remaining - 1 },
              saved
            );
          }
          rows = rows.slice();
          if (record) rows[index] = record;
          else rows.splice(index, 1);
        }
      } else {
        throw new Error('Invalid queue operation');
      }
      await setStorage({ [storageKey]: rows });
      return { rows, record, consumed };
    });
  scannerQueueWriteQueue = result;
  return result;
}

function queryTabs(queryInfo) {
  return new Promise((resolve) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      if (chrome.runtime.lastError) {
        resolve([]);
        return;
      }
      resolve(Array.isArray(tabs) ? tabs : []);
    });
  });
}

function waitForScannerPairingTab(tabId) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (error) reject(error);
      else resolve();
    };
    const onUpdated = (id, change) => {
      if (id === tabId && change.status === 'complete') finish();
    };
    const onRemoved = (id) => {
      if (id === tabId) finish();
    };
    const timeout = setTimeout(
      () =>
        finish(
          new Error('Scanner setup is still loading. Try opening it again.')
        ),
      2000
    );
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    // The load or closure may have finished before the listeners were added.
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab.status !== 'loading') finish();
      },
      () => finish()
    );
  });
}

async function getScannerPairingTab(tabId) {
  if (!Number.isInteger(tabId)) return null;
  let tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.status === 'loading') {
    await waitForScannerPairingTab(tabId);
    tab = await chrome.tabs.get(tabId).catch(() => null);
  }
  if (!tab) return null;
  // The page answers directly so we can verify it without access to tab URLs.
  const reply = await chrome.tabs
    .sendMessage(tabId, { action: 'scannerPairing.isOpen' })
    .catch(() => null);
  return reply?.pairing === true ? tab : null;
}

async function showScannerPairingWindow() {
  const session = chrome.storage.session;
  const { [SCANNER_PAIRING_TAB_KEY]: tabId } = await session.get(
    SCANNER_PAIRING_TAB_KEY
  );
  const existing = await getScannerPairingTab(tabId);
  if (existing) {
    let focusError;
    try {
      const tab = existing.active
        ? existing
        : await chrome.tabs.update(tabId, { active: true });
      const window = await chrome.windows.get(tab.windowId);
      await chrome.windows.update(tab.windowId, {
        focused: true,
        ...(window.state === 'minimized' ? { state: 'normal' } : {})
      });
    } catch (error) {
      focusError = error;
    }
    // A window can survive closing the pairing tab if it contains other tabs.
    if (await getScannerPairingTab(tabId)) {
      if (focusError) throw focusError;
      return;
    }
  }

  // Chrome displays the device chooser from the standard window's toolbar.
  const { tabs } = await chrome.windows.create({
    url: chrome.runtime.getURL('scanner-pairing.html'),
    type: 'normal',
    width: 500,
    height: 440,
    focused: true
  });
  await session.set({ [SCANNER_PAIRING_TAB_KEY]: tabs[0].id });
}

function queryMachineIdleState() {
  if (!chrome.idle || typeof chrome.idle.queryState !== 'function') {
    return Promise.resolve('active');
  }
  return new Promise((resolve) => {
    chrome.idle.queryState(15, (state) => {
      if (chrome.runtime.lastError) {
        resolve('active');
        return;
      }
      resolve(normalizeMachineIdleState(state));
    });
  });
}

async function getLockedScannerSession() {
  const stored = await getStorage([SCANNER_LOCK_SESSION_KEY]);
  return stored && stored[SCANNER_LOCK_SESSION_KEY];
}

async function beginLockedScannerSession() {
  if (!scannerLockSessionPromise) {
    scannerLockSessionPromise = (async () => {
      const existing = await getLockedScannerSession();
      if (isLockedScannerSession(existing)) return existing;
      const activeTabs = await queryTabs({ active: true, currentWindow: true });
      const activeChartTab = activeTabs.find(tabMayBeSupportedChart) || null;
      const session = createLockedScannerSession({ activeTab: activeChartTab });
      await setStorage({
        [SCANNER_LOCK_STATE_KEY]: 'locked',
        [SCANNER_LOCK_SESSION_KEY]: session
      });
      return session;
    })().finally(() => {
      scannerLockSessionPromise = null;
    });
  }
  return scannerLockSessionPromise;
}

async function updateScannerLockState(state) {
  const normalized = normalizeMachineIdleState(state);
  if (normalized === 'locked') {
    return beginLockedScannerSession();
  }
  const existing = await getLockedScannerSession();
  const wasLocked = isLockedScannerSession(existing);
  const values = { [SCANNER_LOCK_STATE_KEY]: normalized };
  if (wasLocked) {
    values[SCANNER_LOCK_SESSION_KEY] = closeLockedScannerSession(existing);
  }
  await setStorage(values);
  return values[SCANNER_LOCK_SESSION_KEY] || existing || null;
}

function initializeScannerLockMonitoring() {
  if (chrome.idle?.onStateChanged) {
    chrome.idle.onStateChanged.addListener((state) => {
      void updateScannerLockState(state).catch((error) => {
        console.warn('Could not update scanner lock state:', error);
      });
    });
  }
}

function synchronizeScannerLockState() {
  void queryMachineIdleState()
    .then(updateScannerLockState)
    .catch((error) =>
      console.warn('Could not initialize scanner lock state:', error)
    );
}

function isSupportedChartUrl(urlValue) {
  try {
    const url = new URL(String(urlValue || ''));
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    const isPanorama =
      (host === 'www.panorama.prod.ehealthontario.ca' ||
        host === 'panorama.prod.ehealthontario.ca' ||
        host === 'trpanoramadhir.prod.ehealthontario.ca') &&
      /^\/(?:phsdsm\/)?ImmsWeb\/pages\/recordImms\//.test(url.pathname);
    return isPanorama;
  } catch (_) {
    return false;
  }
}

function tabMayBeSupportedChart(tab) {
  if (!tab || tab.id === undefined) return false;
  if (!tab.url) return true;
  return isSupportedChartUrl(tab.url);
}

function getScannerDestinationContext(tabId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 1000);
    chrome.tabs.sendMessage(
      tabId,
      { action: 'getPanoramaIntegration' },
      { frameId: 0 },
      (response) => {
        clearTimeout(timer);
        resolve(
          !chrome.runtime.lastError &&
            response?.supported === true &&
            typeof response.contextToken === 'string'
            ? response.contextToken
            : null
        );
      }
    );
  });
}

function tabAcceptedScannerScan(response) {
  return (
    response?.accepted === true &&
    (response.success === true ||
      response.pending === true ||
      response.duplicate_ignored === true ||
      response.command_handled === true)
  );
}

function sendScanToTab(tabId, scan, contextToken) {
  return new Promise((resolve, reject) => {
    // The chart and worker share the deadline so a late lookup cannot start
    // writing after the worker has already held the scan for review.
    const waitMs = 10000;
    const startBy = Date.now() + waitMs;
    const timer = setTimeout(
      () => reject(new Error('Chart acknowledgement timed out')),
      waitMs
    );
    chrome.tabs.sendMessage(
      tabId,
      { action: 'vaxlinkScanCaptured', scan, contextToken, startBy },
      { frameId: 0 },
      (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError || !tabAcceptedScannerScan(response)) {
          reject(
            new Error(
              chrome.runtime.lastError?.message ||
                response?.error ||
                'Chart did not accept scan'
            )
          );
        } else resolve(response);
      }
    );
  });
}

function normalizeScanEvent(scan) {
  const rawText = String(scan?.rawText || '').trim();
  if (!rawText) {
    throw new Error('Scan event missing raw text');
  }
  return {
    type: 'vaxlink.scan',
    rawText,
    source: scan?.source || 'unknown',
    device: scan?.device || null,
    rawBytesHex: String(scan?.rawBytesHex || ''),
    capturedAt: scan?.capturedAt || new Date().toISOString()
  };
}

function normalizeWorkflowMode(stored) {
  const direct = stored && stored[WORKFLOW_MODE_KEY];
  if (direct === 'single' || direct === 'multiple' || direct === 'inventory') {
    return direct;
  }

  const legacyPopup = stored && stored[LEGACY_POPUP_MODE_KEY];
  if (legacyPopup === 'inventory') return 'inventory';
  if (legacyPopup === 'inject') return 'single';

  const legacyRemote = stored && stored[LEGACY_REMOTE_MODE_KEY];
  if (legacyRemote === 'tray') return 'multiple';
  if (legacyRemote === 'autofill') return 'single';

  if (stored && stored[LEGACY_HANDS_FREE_KEY]) return 'single';
  return 'single';
}

function getQueueStorageKeyForWorkflow(mode) {
  if (mode === 'multiple') return MULTIPLE_INJECT_QUEUE_KEY;
  if (mode === 'inventory') return INVENTORY_BATCH_KEY;
  return '';
}

function getExpiryStatus(value) {
  const expiry = globalThis.VaxLinkExpiryDate.parseDateToLocal(value);
  if (!expiry) {
    return { flag: 'unknown', daysRemaining: null };
  }

  const daysRemaining = globalThis.VaxLinkExpiryDate.daysUntil(expiry);

  if (daysRemaining < 0) return { flag: 'expired', daysRemaining };
  if (daysRemaining <= 30) return { flag: 'expiring_soon', daysRemaining };
  return { flag: 'valid', daysRemaining };
}

function getPositiveInt(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function mergeVaccineInfoIntoParsed(parsed, vaccineInfo) {
  if (!parsed || !vaccineInfo) return;
  parsed.nvc_lot_matched = true;
  parsed.tradename = vaccineInfo.tradename;
  parsed.generic_name = vaccineInfo.generic_name;
  parsed.disease = vaccineInfo.disease;
  parsed.antigen = vaccineInfo.antigen;
  parsed.manufacturer = vaccineInfo.manufacturer;
  parsed.nvc_lot_expiry = vaccineInfo.lot_expiry;
  parsed.din = vaccineInfo.din;
  parsed.route = vaccineInfo.route;
  parsed.strength = vaccineInfo.strength;
  parsed.dose_value = vaccineInfo.dose_value;
  parsed.dose_unit = vaccineInfo.dose_unit;
  parsed.drug_code = vaccineInfo.din;
  parsed.nvc_override = vaccineInfo.nvc_override || null;
  parsed.name =
    vaccineInfo.generic_name || vaccineInfo.tradename || vaccineInfo.din;

  if (!parsed.lot && vaccineInfo.lot_number) {
    parsed.lot = vaccineInfo.lot_number;
  }
  if (!parsed.expiry && vaccineInfo.lot_expiry) {
    parsed.expiry = vaccineInfo.lot_expiry || parsed.expiry;
  }
}

function buildQueueRecordFromParsed(data, rawBarcode, context = {}) {
  const totalDoses = getPositiveInt(data.total_doses, null);
  const fallbackDose = getPositiveInt(totalDoses, null);
  const inventoryExpiry =
    data.inventory_expiry || data.expiry || data.nvc_lot_expiry || '';
  const expiryStatus = getExpiryStatus(inventoryExpiry);
  const barcodeExpiry = data.barcode_expiry ?? data.expiry ?? '';
  const expirySource = barcodeExpiry
    ? 'barcode'
    : data.nvc_lot_expiry
      ? 'nvc'
      : data.expiry_source || 'none';

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    scanned_at: data.scanned_at || new Date().toISOString(),
    raw_barcode: rawBarcode || '',
    name: data.name || data.generic_name || data.tradename || data.din || '',
    tradename: data.tradename || '',
    generic_name: data.generic_name || '',
    disease: data.disease || '',
    antigen: data.antigen || '',
    manufacturer: data.manufacturer || '',
    gtin: data.gtin || '',
    lot: data.lot || '',
    serial: data.serial || '',
    barcode_expiry: barcodeExpiry,
    inventory_expiry: inventoryExpiry,
    nvc_lot_expiry: data.nvc_lot_expiry || '',
    expiry_flag: expiryStatus.flag || '',
    expiry_days_remaining: expiryStatus.daysRemaining ?? '',
    expiry_source: expirySource,
    route: data.route || '',
    strength: data.strength || '',
    dose_value: data.dose_value || '',
    dose_unit: data.dose_unit || '',
    total_doses: totalDoses,
    remaining_doses: getPositiveInt(data.remaining_doses, fallbackDose),
    dose_tracking: data.dose_tracking || 'manual',
    din: data.din || '',
    drug_code: data.drug_code || data.din || '',
    lookup_error: data.lookup_error || '',
    lookup_error_category: data.lookup_error_category || '',
    nvc_catalogue_version: data.nvc_catalogue_version || '',
    nvc_lot_matched: data.nvc_lot_matched === true,
    ...context
  };
}

async function saveScannerScanToWorkflowQueue(scan, mode, options = {}) {
  const storageKey = getQueueStorageKeyForWorkflow(mode);
  if (!storageKey) return null;

  const parser = globalThis.VaxLinkGS1Parser;
  if (!parser || typeof parser.parseGS1Barcode !== 'function') {
    throw new Error('VaxLink GS1 parser is not loaded');
  }

  const immunization = mode === 'multiple' && options.inventoryCapture !== true;
  let parsed;
  let status;
  try {
    parsed =
      immunization && parser.isRetailBarcode(scan.rawText)
        ? {}
        : parser.parseGS1Barcode(scan.rawText);
    if (immunization && !String(parsed.lot || '').trim())
      status = 'missing_lot';
  } catch (error) {
    if (!immunization) throw error;
    status = 'parse_error';
  }
  if (status) {
    void logAnalyticsEvent(
      status === 'missing_lot' ? 'barcode_missing_lot' : status,
      { workflow: mode, source: scan.source }
    ).catch(() => {});
    return { rejection: { status } };
  }

  parsed.scanned_at = scan.capturedAt || new Date().toISOString();

  parsed.barcode_expiry = parsed.expiry || '';
  if (
    parsed.lot &&
    !(immunization && globalThis.VaxLinkExpiryDate.isExpiredVaccine(parsed))
  ) {
    const vaccineInfo = await lookupVaccineInfo(parsed.lot, {
      gtin: parsed.gtin,
      waitForDownload: immunization
    });
    parsed.nvc_catalogue_version = vaccineInfo.catalogueVersion;
    if (!vaccineInfo.error) {
      mergeVaccineInfoIntoParsed(parsed, vaccineInfo);
    } else {
      parsed.lookup_error = vaccineInfo.error;
      parsed.lookup_error_category = vaccineInfo.errorCategory;
      parsed.nvc_lot_expiry = vaccineInfo.lot_expiry;
    }
  }

  const draft = buildQueueRecordFromParsed(
    parsed,
    scan.rawText,
    options.context || {}
  );
  const expiry = globalThis.VaxLinkExpiryDate.expiredVaccineDate(draft);
  const blocked = immunization && !!expiry;
  if (expiry) draft.expiry_flag = 'expired';
  const record = blocked
    ? draft
    : await appendQueueRecord(storageKey, draft, {
        preserveEveryScan: options.preserveEveryScan === true
      });
  // Usage counts can finish independently of the scanner acknowledgement.
  const expiryFlag = record.expiry_flag;
  const activity = {
    workflow: mode,
    source: scan.source || 'web-serial',
    vaccineLabel: globalThis.vaxlinkVaccineLabel(record),
    manufacturer: record.manufacturer || '',
    expiryFlag
  };
  void logAnalyticsEvent('scan_captured', activity).catch(() => {});
  if (!blocked && !record.duplicate_ignored) {
    void logAnalyticsEvent('queue_saved', {
      ...activity,
      queue: mode === 'inventory' ? 'inventory' : 'multiple',
      queueSizeAfter: record.queueSizeAfter || 0
    }).catch(() => {});
  }

  if (blocked)
    return { rejection: { status: 'expired', lot: record.lot, expiry } };
  return {
    queuedToWorkflow: true,
    workflow: mode,
    storageKey,
    record
  };
}

function mutatePendingInbox(action) {
  const result = pendingInboxWriteQueue.catch(() => undefined).then(action);
  pendingInboxWriteQueue = result;
  return result;
}

function enqueuePendingScan(scan) {
  return mutatePendingInbox(async () => {
    const stored = await getStorage([PENDING_SCAN_INBOX_KEY]);
    const rows = Array.isArray(stored && stored[PENDING_SCAN_INBOX_KEY])
      ? stored[PENDING_SCAN_INBOX_KEY]
      : [];
    const nextRows = [...rows, scan];
    if (
      nextRows.length > PENDING_SCAN_INBOX_LIMIT ||
      new TextEncoder().encode(JSON.stringify(nextRows)).length >
        PENDING_SCAN_INBOX_MAX_BYTES
    ) {
      throw new Error(
        'Held scans are full. Inspect them in the VaxLink popup before scanning again.'
      );
    }
    await setStorage({ [PENDING_SCAN_INBOX_KEY]: nextRows });
    return nextRows.length;
  });
}

async function getHeldScannerScans() {
  const stored = await getStorage([PENDING_SCAN_INBOX_KEY]);
  return Array.isArray(stored?.[PENDING_SCAN_INBOX_KEY])
    ? stored[PENDING_SCAN_INBOX_KEY]
    : [];
}

function discardHeldScannerScan(scan) {
  return mutatePendingInbox(async () => {
    const rows = await getHeldScannerScans();
    // New captures have unique IDs. Legacy rows stay held; discard only one
    // matching snapshot so a concurrent identical capture is preserved.
    const index = rows.findIndex((row) =>
      scan?.captureId
        ? row.captureId === scan.captureId
        : JSON.stringify(row) === JSON.stringify(scan)
    );
    if (index < 0) return;
    await setStorage({
      [PENDING_SCAN_INBOX_KEY]: rows.filter((_, i) => i !== index)
    });
  });
}

async function routeScanToActiveSupportedTab(rawScan) {
  const scan = {
    ...normalizeScanEvent(rawScan),
    captureId: buildAnalyticsId()
  };
  // Pin the destination before storage waits; focus changes never redirect it.
  const activeTabs = await queryTabs({ active: true, currentWindow: true });
  const destination = activeTabs.find(tabMayBeSupportedChart);
  const contextPromise = destination
    ? getScannerDestinationContext(destination.id)
    : Promise.resolve(null);
  const idleState = await queryMachineIdleState();
  const storedWorkflow = await getStorage([
    WORKFLOW_MODE_KEY,
    LEGACY_POPUP_MODE_KEY,
    LEGACY_REMOTE_MODE_KEY,
    LEGACY_HANDS_FREE_KEY
  ]);
  const workflowMode = normalizeWorkflowMode(storedWorkflow);
  const contextToken = await contextPromise;

  if (shouldQueueScannerScan(idleState)) {
    const lockSession = await beginLockedScannerSession();
    if (workflowMode === 'single') {
      const pendingCount = await enqueuePendingScan({
        ...scan,
        pending_workflow: 'single',
        ...buildLockedScanQueueContext(lockSession)
      });
      return {
        routed: false,
        queued: true,
        queuedToWorkflow: false,
        locked: true,
        lockSessionId: lockSession.id,
        pinnedTabId: lockSession.tabId,
        workflow: 'single',
        pendingCount
      };
    }
    const lockedQueueResult = await saveScannerScanToWorkflowQueue(
      scan,
      'multiple',
      {
        context: buildLockedScanQueueContext(lockSession),
        preserveEveryScan: true,
        inventoryCapture: workflowMode === 'inventory'
      }
    );
    if (lockedQueueResult.rejection) {
      // Staff cannot see chart feedback while locked. Keep the rejected barcode for review.
      const pendingCount = await enqueuePendingScan({
        ...scan,
        pending_workflow: workflowMode,
        ...buildLockedScanQueueContext(lockSession)
      });
      return {
        routed: false,
        queued: true,
        queuedToWorkflow: false,
        locked: true,
        lockSessionId: lockSession.id,
        pinnedTabId: lockSession.tabId,
        workflow: workflowMode,
        pendingCount,
        response: lockedQueueResult.rejection
      };
    }
    return {
      routed: false,
      queued: true,
      queuedToWorkflow: true,
      locked: true,
      lockSessionId: lockSession.id,
      pinnedTabId: lockSession.tabId,
      workflow: 'multiple',
      storageKey: lockedQueueResult.storageKey,
      queueSizeAfter: lockedQueueResult.record?.queueSizeAfter || 0
    };
  }
  // Queue workflows are owned by the background daemon. Do not route these
  // scans through a chart first: the chart content script may still have a
  // stale mode during popup/storage synchronization, which previously made a
  // Multiple scan behave like Single or disappear into a failed chart fill.
  if (workflowMode === 'multiple' || workflowMode === 'inventory') {
    const workflowQueueResult = await saveScannerScanToWorkflowQueue(
      scan,
      workflowMode
    );
    if (workflowQueueResult.rejection) {
      if (destination && contextToken) {
        chrome.tabs.sendMessage(
          destination.id,
          {
            action: 'showScannerBarcodeFeedback',
            contextToken,
            feedback: workflowQueueResult.rejection
          },
          { frameId: 0 },
          () => void chrome.runtime.lastError
        );
      }
      return {
        routed: false,
        queued: false,
        queuedToWorkflow: false,
        workflow: workflowMode,
        response: workflowQueueResult.rejection
      };
    }
    return {
      routed: false,
      queued: !workflowQueueResult.record?.duplicate_ignored,
      queuedToWorkflow: !workflowQueueResult.record?.duplicate_ignored,
      duplicate_ignored: workflowQueueResult.record?.duplicate_ignored === true,
      workflow: workflowQueueResult.workflow,
      storageKey: workflowQueueResult.storageKey,
      queueSizeAfter: workflowQueueResult.record?.queueSizeAfter || 0
    };
  }

  const held = {
    ...scan,
    intendedTabId: destination?.id ?? null,
    contextToken
  };
  const pendingCount = await enqueuePendingScan(held);
  // Messaging must not occupy the inbox writer: other captures and deliberate
  // discards can proceed while this one waits for its answer.
  if (destination && contextToken) {
    try {
      const response = await sendScanToTab(destination.id, scan, contextToken);
      await discardHeldScannerScan(held);
      return { routed: true, queued: false, tabId: destination.id, response };
    } catch (_) {
      // The chart may already contain values. Retain the scan without replay.
    }
  }
  return {
    routed: false,
    queued: true,
    queuedToWorkflow: false,
    workflow: 'single',
    pendingCount
  };
}

function buildAnalyticsId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function analyticsDayKey(value = Date.now()) {
  // Bucket by LOCAL calendar day: clinics run evenings, and UTC bucketing
  // splits a single Ontario clinic day at 8pm EDT (and mis-scopes the
  // "today" export filter, which uses this same key).
  let d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    d = new Date();
  }
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function safeAnalyticsCount(value, fallback = 1) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function createAnalyticsWorkflowStats() {
  return {
    liveScans: 0,
    popupParses: 0,
    queueSaved: 0,
    queueUsed: 0,
    autofillSuccess: 0,
    autofillFailure: 0
  };
}

function createAnalyticsDay(dayKey) {
  return {
    day: dayKey,
    eventCount: 0,
    popupOpens: 0,
    modeSwitches: { single: 0, multiple: 0, inventory: 0 },
    workflows: {
      single: createAnalyticsWorkflowStats(),
      multiple: createAnalyticsWorkflowStats(),
      inventory: createAnalyticsWorkflowStats()
    },
    parsing: { success: 0, error: 0, missingLot: 0 },
    lookup: { success: 0, error: 0 },
    autofill: { attempts: 0, success: 0, failure: 0, fromQueueSuccess: 0 },
    funding: { prompts: 0, choices: 0, single: 0, both: 0, unmatched: 0 },
    queues: {
      multipleSaved: 0,
      multipleUsed: 0,
      multipleCleared: 0,
      inventorySaved: 0,
      inventoryCleared: 0,
      maxMultipleDepth: 0,
      maxInventoryDepth: 0
    },
    exports: { inventoryCount: 0, inventoryRows: 0 },
    nvc: { manualSuccess: 0, manualFailure: 0, autoSuccess: 0, autoFailure: 0 },
    expiry: {
      expired: 0,
      expiringSoon: 0,
      valid: 0,
      unknown: 0,
      noticesShown: 0
    },
    sources: {},
    vaccines: {},
    manufacturers: {}
  };
}

function createAnalyticsStore() {
  const now = new Date().toISOString();
  return {
    version: 1,
    deviceId: buildAnalyticsId(),
    deviceLabel: '',
    firstSeenAt: now,
    lastEventAt: null,
    lastExportAt: null,
    days: {}
  };
}

function normalizeAnalyticsStore(existing) {
  if (!existing || typeof existing !== 'object') {
    return createAnalyticsStore();
  }
  return {
    ...existing,
    deviceId: existing.deviceId || buildAnalyticsId(),
    firstSeenAt: existing.firstSeenAt || new Date().toISOString(),
    days:
      existing.days && typeof existing.days === 'object' ? existing.days : {},
    deviceLabel:
      typeof existing.deviceLabel === 'string' ? existing.deviceLabel : ''
  };
}

function ensureAnalyticsDay(store, dayKey) {
  if (!store.days[dayKey]) {
    store.days[dayKey] = createAnalyticsDay(dayKey);
  }
  return store.days[dayKey];
}

function incrementMap(map, key, amount = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + amount;
}

function normalizeWorkflowKey(value) {
  return value === 'multiple' || value === 'inventory' ? value : 'single';
}

function normalizeQueueKey(value) {
  return value === 'inventory' ? 'inventory' : 'multiple';
}

function normalizeExpiryKey(value) {
  if (value === 'expired') return 'expired';
  if (value === 'expiring_soon') return 'expiringSoon';
  if (value === 'valid') return 'valid';
  return 'unknown';
}

function trimAnalyticsLabel(value, maxLength = 80) {
  return String(value || '')
    .trim()
    .slice(0, maxLength);
}

function applyTopCounter(map, rawKey, amount = 1) {
  const key = trimAnalyticsLabel(rawKey, 60);
  if (!key) return;
  map[key] = (map[key] || 0) + amount;
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  if (entries.length <= ANALYTICS_TOP_LIMIT) {
    return;
  }
  const trimmed = Object.fromEntries(entries.slice(0, ANALYTICS_TOP_LIMIT));
  Object.keys(map).forEach((existingKey) => {
    if (!(existingKey in trimmed)) {
      delete map[existingKey];
    }
  });
}

function applyAnalyticsEvent(day, event) {
  const workflow = normalizeWorkflowKey(event.workflow);
  const count = safeAnalyticsCount(event.count, 1);
  day.eventCount += 1;

  if (event.source) {
    incrementMap(day.sources, trimAnalyticsLabel(event.source, 40), count);
  }
  if (event.vaccineLabel) {
    applyTopCounter(day.vaccines, event.vaccineLabel, count);
  }
  if (event.manufacturer) {
    applyTopCounter(day.manufacturers, event.manufacturer, count);
  }
  if (event.expiryFlag) {
    const key = normalizeExpiryKey(event.expiryFlag);
    day.expiry ??= {};
    day.expiry[key] = (day.expiry[key] || 0) + count;
  }

  switch (event.eventType) {
    case 'expiry_notice_shown':
      day.expiry ??= {};
      day.expiry.noticesShown = (day.expiry.noticesShown ?? 0) + 1;
      break;
    case 'popup_open':
      day.popupOpens += 1;
      break;
    case 'workflow_mode_set':
      day.modeSwitches[workflow] += 1;
      break;
    case 'parse_success':
      day.parsing.success += count;
      if (event.source && String(event.source).startsWith('popup')) {
        day.workflows[workflow].popupParses += count;
      }
      break;
    case 'barcode_missing_lot':
      day.parsing.missingLot = (day.parsing.missingLot || 0) + count;
      break;
    case 'parse_error':
      day.parsing.error += count;
      break;
    case 'lookup_success':
      day.lookup.success += count;
      break;
    case 'lookup_error':
      day.lookup.error += count;
      break;
    case 'scan_captured':
      day.workflows[workflow].liveScans += count;
      break;
    case 'queue_saved': {
      const queue = normalizeQueueKey(event.queue);
      if (queue === 'multiple') {
        day.queues.multipleSaved += count;
        day.queues.maxMultipleDepth = Math.max(
          day.queues.maxMultipleDepth,
          Number(event.queueSizeAfter) || 0
        );
      } else {
        day.queues.inventorySaved += count;
        day.queues.maxInventoryDepth = Math.max(
          day.queues.maxInventoryDepth,
          Number(event.queueSizeAfter) || 0
        );
      }
      day.workflows[queue].queueSaved += count;
      break;
    }
    case 'queue_used':
      day.queues.multipleUsed += count;
      day.workflows.multiple.queueUsed += count;
      break;
    case 'queue_cleared': {
      const queue = normalizeQueueKey(event.queue);
      if (queue === 'multiple') {
        day.queues.multipleCleared += count;
      } else {
        day.queues.inventoryCleared += count;
      }
      break;
    }
    case 'autofill_attempt':
      day.autofill.attempts += count;
      break;
    case 'funding_prompt_shown':
    case 'funding_choice_made':
    case 'funding_comparison': {
      const metric =
        event.eventType === 'funding_prompt_shown'
          ? 'prompts'
          : event.eventType === 'funding_choice_made'
            ? 'choices'
            : event.outcome;
      if (metric) {
        day.funding ??= {};
        day.funding[metric] = (day.funding[metric] || 0) + 1;
      }
      break;
    }
    case 'autofill_result':
      if (event.pending) break;
      if (event.success) {
        day.autofill.success += count;
        day.workflows[workflow].autofillSuccess += count;
        if (event.source === 'queue') {
          day.autofill.fromQueueSuccess += count;
        }
      } else {
        day.autofill.failure += count;
        day.workflows[workflow].autofillFailure += count;
      }
      break;
    case 'inventory_export':
      day.exports.inventoryCount += count;
      day.exports.inventoryRows += safeAnalyticsCount(event.rows, 0);
      break;
    case 'nvc_refresh_result': {
      const trigger = event.trigger === 'manual' ? 'manual' : 'auto';
      const key = event.success ? `${trigger}Success` : `${trigger}Failure`;
      day.nvc[key] += count;
      break;
    }
    default:
      break;
  }
}

function makeAnalyticsEvent(eventType, payload = {}) {
  const ts = payload.ts || new Date().toISOString();
  return {
    ts,
    day: analyticsDayKey(ts),
    eventType,
    workflow: normalizeWorkflowKey(payload.workflow),
    queue: payload.queue ? normalizeQueueKey(payload.queue) : '',
    source: trimAnalyticsLabel(payload.source, 40),
    success: !!payload.success,
    pending: payload.pending === true,
    outcome: ['single', 'both', 'unmatched'].includes(payload.outcome)
      ? payload.outcome
      : '',
    count: safeAnalyticsCount(payload.count, 1),
    rows: safeAnalyticsCount(payload.rows, 0),
    queueSizeAfter: safeAnalyticsCount(payload.queueSizeAfter, 0),
    expiryFlag: payload.expiryFlag || '',
    vaccineLabel: trimAnalyticsLabel(payload.vaccineLabel, 60),
    manufacturer: trimAnalyticsLabel(payload.manufacturer, 60),
    trigger: payload.trigger || ''
  };
}

function accessAnalyticsStore(mutator) {
  analyticsWriteQueue = analyticsWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const stored = await getStorage([ANALYTICS_STORAGE_KEY]);
      const existing = stored[ANALYTICS_STORAGE_KEY];
      const normalized = normalizeAnalyticsStore(existing);
      const store = mutator?.(normalized) ?? normalized;
      // First use needs a lasting identity even when Activity opens before a scan.
      if (mutator || !existing?.deviceId || !existing.firstSeenAt) {
        await setStorage({ [ANALYTICS_STORAGE_KEY]: store });
      }
      return store;
    });
  return analyticsWriteQueue;
}

async function logAnalyticsEvent(eventType, payload = {}) {
  const event = makeAnalyticsEvent(eventType, payload);
  return accessAnalyticsStore((store) => {
    const day = ensureAnalyticsDay(store, event.day);
    applyAnalyticsEvent(day, event);
    store.lastEventAt = event.ts;
  });
}

function sumObjectCounters(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    target[key] = (target[key] || 0) + Number(value || 0);
  }
}

function aggregateAnalyticsDays(days) {
  const rollup = createAnalyticsDay('rollup');
  rollup.expiry.noticesShown = null;
  for (const day of days) {
    rollup.eventCount += day.eventCount || 0;
    rollup.popupOpens += day.popupOpens || 0;
    sumObjectCounters(rollup.modeSwitches, day.modeSwitches);
    ['single', 'multiple', 'inventory'].forEach((workflow) => {
      const target = rollup.workflows[workflow];
      const source = (day.workflows && day.workflows[workflow]) || {};
      target.liveScans += source.liveScans || 0;
      target.popupParses += source.popupParses || 0;
      target.queueSaved += source.queueSaved || 0;
      target.queueUsed += source.queueUsed || 0;
      target.autofillSuccess += source.autofillSuccess || 0;
      target.autofillFailure += source.autofillFailure || 0;
    });
    sumObjectCounters(rollup.parsing, day.parsing);
    sumObjectCounters(rollup.lookup, day.lookup);
    sumObjectCounters(rollup.funding, day.funding);
    ['attempts', 'success', 'failure', 'fromQueueSuccess'].forEach((key) => {
      rollup.autofill[key] += day.autofill?.[key] || 0;
    });
    [
      'multipleSaved',
      'multipleUsed',
      'multipleCleared',
      'inventorySaved',
      'inventoryCleared'
    ].forEach((key) => {
      rollup.queues[key] += day.queues?.[key] || 0;
    });
    rollup.queues.maxMultipleDepth = Math.max(
      rollup.queues.maxMultipleDepth,
      day.queues?.maxMultipleDepth || 0
    );
    rollup.queues.maxInventoryDepth = Math.max(
      rollup.queues.maxInventoryDepth,
      day.queues?.maxInventoryDepth || 0
    );
    ['inventoryCount', 'inventoryRows'].forEach((key) => {
      rollup.exports[key] += day.exports?.[key] || 0;
    });
    ['manualSuccess', 'manualFailure', 'autoSuccess', 'autoFailure'].forEach(
      (key) => {
        rollup.nvc[key] += day.nvc?.[key] || 0;
      }
    );
    ['expired', 'expiringSoon', 'valid', 'unknown'].forEach((key) => {
      rollup.expiry[key] += day.expiry?.[key] || 0;
    });
    if (typeof day.expiry?.noticesShown === 'number') {
      rollup.expiry.noticesShown =
        (rollup.expiry.noticesShown ?? 0) + day.expiry.noticesShown;
    }
    sumObjectCounters(rollup.sources, day.sources);
    sumObjectCounters(rollup.vaccines, day.vaccines);
    sumObjectCounters(rollup.manufacturers, day.manufacturers);
  }
  return rollup;
}

async function getAnalyticsSummary() {
  return buildAnalyticsSummary(await accessAnalyticsStore());
}

function buildAnalyticsSummary(store) {
  const dayKeys = Object.keys(store.days).sort();
  const todayKey = analyticsDayKey();
  const today = store.days[todayKey] || {};
  const rollup = aggregateAnalyticsDays(dayKeys.map((key) => store.days[key]));
  return {
    deviceId: store.deviceId,
    deviceLabel: store.deviceLabel || '',
    firstSeenAt: store.firstSeenAt || null,
    lastEventAt: store.lastEventAt || null,
    lastExportAt: store.lastExportAt || null,
    daysTracked: dayKeys.length,
    todayKey,
    today,
    rollup
  };
}

async function getAnalyticsExport(scope = 'pilot') {
  const store = await accessAnalyticsStore((store) => {
    store.lastExportAt = new Date().toISOString();
  });
  const dayKeys = Object.keys(store.days).sort();
  const todayKey = analyticsDayKey(store.lastExportAt);
  const selectedKeys =
    scope === 'today' ? dayKeys.filter((key) => key === todayKey) : dayKeys;
  const selectedDays = Object.fromEntries(
    selectedKeys.map((key) => [key, store.days[key]])
  );
  return {
    exportedAt: store.lastExportAt,
    scope,
    deviceId: store.deviceId,
    deviceLabel: store.deviceLabel || '',
    firstSeenAt: store.firstSeenAt || null,
    lastEventAt: store.lastEventAt || null,
    daysTracked: selectedKeys.length,
    days: selectedDays,
    rollup: aggregateAnalyticsDays(selectedKeys.map((key) => store.days[key]))
  };
}

async function setAnalyticsDeviceLabel(label) {
  return accessAnalyticsStore((store) => {
    store.deviceLabel = trimAnalyticsLabel(label, 80);
  });
}

async function resetAnalyticsStore() {
  return accessAnalyticsStore(() => createAnalyticsStore());
}

async function sha256Hex(text) {
  const encoded = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function setupAutoSyncAlarm() {
  chrome.alarms.create(AUTO_SYNC_ALARM_NAME, {
    periodInMinutes: AUTO_SYNC_INTERVAL_MINUTES
  });
}

function initializeNVCSync() {
  setupAutoSyncAlarm();
  if (!nvcInitializationPromise) {
    nvcInitializationPromise = maybeAutoRefreshNVCBundle('startup');
  }
  return nvcInitializationPromise;
}

function hasUsableNVCCatalogue() {
  return !!nvcBundle;
}

function nvcFailure(category) {
  const messages = {
    source: 'Only the official NVC source is supported',
    network: 'Unable to download the NVC catalogue',
    timeout: 'NVC catalogue download timed out',
    http: 'The NVC server could not provide the catalogue',
    invalid: 'The NVC catalogue could not support vaccine lookups',
    storage: 'Unable to save the NVC catalogue',
    initializing: 'NVC catalogue is still loading. Try the lookup again.',
    unavailable:
      'NVC catalogue is unavailable. Barcode details have been kept.',
    not_found: 'Lot not found in the NVC catalogue',
    incomplete: 'NVC vaccine details are incomplete for this lot'
  };
  return {
    success: false,
    error: messages[category],
    errorCategory: category,
    usable: hasUsableNVCCatalogue()
  };
}

async function lookupVaccineInfo(lot, options = {}) {
  await loadNVCBundle();
  if (!hasUsableNVCCatalogue() && options.waitForDownload !== false) {
    let timer;
    try {
      await Promise.race([
        nvcRefreshPromise || initializeNVCSync(),
        new Promise((resolve) => {
          timer = setTimeout(resolve, NVC_LOOKUP_WAIT_MS);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  if (!hasUsableNVCCatalogue()) {
    return nvcFailure(
      nvcRefreshPromise
        ? 'initializing'
        : nvcCacheInvalid || nvcHealth.lastError === 'invalid'
          ? 'invalid'
          : 'unavailable'
    );
  }
  const info = lookupVaccineLot(lot, options);
  const catalogueVersion = nvcIndexes.catalogueInfo?.releaseVersion ?? null;
  if (!info) return { ...nvcFailure('not_found'), catalogueVersion };
  if (info.error) return { ...info, catalogueVersion };
  return {
    ...info,
    ...(hasNVCVaccineIdentity(info) ? {} : nvcFailure('incomplete')),
    catalogueVersion
  };
}

function validateBundleShape(data) {
  if (
    !data ||
    data.resourceType !== 'Bundle' ||
    data.type !== 'collection' ||
    !Array.isArray(data.entry) ||
    data.entry.length < 2
  )
    return false;
  const isObject = (value) =>
    value && typeof value === 'object' && !Array.isArray(value);
  const validObjectArray = (value) =>
    value === undefined || (Array.isArray(value) && value.every(isObject));
  const validCoding = (value) =>
    value === undefined || (isObject(value) && validObjectArray(value.coding));
  const validConceptField = (item) =>
    validCoding(item.valueCodeableConcept) &&
    (item.valueCoding === undefined || isObject(item.valueCoding));
  if (
    !data.entry.every(
      (entry) =>
        entry &&
        isObject(entry.resource) &&
        typeof entry.resource.resourceType === 'string'
    )
  )
    return false;
  const resources = data.entry.map((entry) => entry.resource);
  const validConcepts = (concepts) =>
    !concepts ||
    (Array.isArray(concepts) &&
      concepts.every(
        (concept) =>
          isObject(concept) &&
          typeof concept.code === 'string' &&
          validObjectArray(concept.extension) &&
          validObjectArray(concept.property) &&
          validObjectArray(concept.designation) &&
          (concept.extension || []).every(validConceptField) &&
          (concept.property || []).every(validConceptField)
      ));
  const usedResources = resources.filter(
    (resource) =>
      resource.id === 'Tradename' ||
      resource.id === 'nvc-vaccine-lot-id' ||
      /tradename|lotagentmapping/i.test(
        [resource.id, resource.name, resource.title, resource.url].join(' ')
      )
  );
  if (
    !usedResources.every(
      (resource) =>
        validConcepts(resource.concept) &&
        (!resource.compose?.include ||
          (Array.isArray(resource.compose.include) &&
            resource.compose.include.every(
              (item) => item && validConcepts(item.concept)
            ))) &&
        validConcepts(resource.expansion?.contains)
    )
  )
    return false;
  return (
    resources.some(
      (resource) =>
        resource.resourceType === 'CodeSystem' &&
        resource.id === 'nvc-vaccine-lot-id' &&
        Array.isArray(resource.concept) &&
        resource.concept.some(
          (concept) => typeof concept?.code === 'string' && concept.code
        )
    ) &&
    resources.some(
      (resource) =>
        resource.resourceType === 'ValueSet' &&
        resource.id === 'Tradename' &&
        (resource.compose?.include?.some(
          (item) => Array.isArray(item.concept) && item.concept.length > 0
        ) ||
          resource.expansion?.contains?.length > 0)
    )
  );
}

function hasNVCVaccineIdentity(info) {
  return [info?.tradename, info?.generic_name, info?.din].some(
    (value) => typeof value === 'string' && value.trim()
  );
}

function prepareNVCCatalogue(data) {
  if (!validateBundleShape(data)) throw new Error('Invalid NVC catalogue');
  const indexes = buildNVCIndexes(data);
  if (
    !Object.keys(indexes.lotByCode).length ||
    !Object.keys(indexes.tradenameByCode).length
  ) {
    throw new Error('NVC catalogue has no usable lots or vaccine names');
  }
  const canEnrichLot = Object.values(indexes.lotByCode).some((concept) =>
    hasNVCVaccineIdentity(
      lookupVaccineLot(extractLotNumber(concept) || concept.code, { indexes })
    )
  );
  if (!canEnrichLot)
    throw new Error('NVC catalogue has no usable vaccine links');
  return indexes;
}

function loadNVCBundle() {
  if (bundleLoadPromise) return bundleLoadPromise;
  bundleLoadPromise = (async () => {
    try {
      const stored = await getStorage(Object.values(STORAGE_KEYS));
      const health = stored[STORAGE_KEYS.health];
      const errors = [
        'source',
        'network',
        'timeout',
        'http',
        'invalid',
        'storage'
      ];
      nvcHealth = {
        updatedAt: stored[STORAGE_KEYS.updatedAt] || null,
        lastCheckAt: stored[STORAGE_KEYS.lastCheckAt] || null,
        sha256: stored[STORAGE_KEYS.bundleSha256] || null,
        lastModified: stored[STORAGE_KEYS.lastModified] || null,
        lastAttemptAt: health?.lastAttemptAt || null,
        lastError: errors.includes(health?.lastError) ? health.lastError : null
      };
      if (!stored[STORAGE_KEYS.bundle]) return false;
      try {
        const indexes = prepareNVCCatalogue(stored[STORAGE_KEYS.bundle]);
        nvcBundle = stored[STORAGE_KEYS.bundle];
        nvcIndexes = indexes;
        nvcUsingCache = true;
        return true;
      } catch {
        nvcCacheInvalid = true;
        nvcHealth.lastError = 'invalid';
        return false;
      }
    } catch {
      nvcHealth.lastError = 'storage';
      return false;
    }
  })();
  return bundleLoadPromise;
}

function refreshNVCBundleFromUrl(sourceUrl, options = {}) {
  if (sourceUrl && sourceUrl !== DEFAULT_NVC_SOURCE_URL) {
    return Promise.resolve(nvcFailure('source'));
  }
  // All callers share this download and its result, including manual refreshes.
  if (nvcRefreshPromise) return nvcRefreshPromise;
  nvcRefreshPromise = performNVCRefresh(options).finally(() => {
    nvcRefreshPromise = null;
  });
  return nvcRefreshPromise;
}

async function downloadNVCCatalogue(headers) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(DEFAULT_NVC_SOURCE_URL, {
          cache: 'no-store',
          redirect: 'error',
          headers,
          signal: controller.signal
        });
        if (response.redirected || response.url !== DEFAULT_NVC_SOURCE_URL) {
          throw Object.assign(new Error(), { category: 'source' });
        }
        if (response.status === 304) return { response };
        if (!response.ok)
          throw Object.assign(new Error(), { category: 'http' });
        try {
          return { response, bundle: await response.json() };
        } catch {
          throw Object.assign(new Error(), { category: 'invalid' });
        }
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error(), { category: 'timeout' }));
          controller.abort();
        }, NVC_DOWNLOAD_TIMEOUT_MS);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function performNVCRefresh(options) {
  await loadNVCBundle();
  const trigger = options.trigger === 'manual' ? 'manual' : 'auto';
  nvcHealth.lastAttemptAt = new Date().toISOString();
  let category = 'storage';
  try {
    await setStorage({
      [STORAGE_KEYS.health]: {
        lastAttemptAt: nvcHealth.lastAttemptAt,
        lastError: nvcHealth.lastError
      }
    });
    const headers = { ...NVC_FETCH_HEADERS };
    if (nvcHealth.lastModified && hasUsableNVCCatalogue()) {
      headers['If-Modified-Since'] = nvcHealth.lastModified;
    }
    category = 'network';
    const { response, bundle } = await downloadNVCCatalogue(headers);
    const checkedAt = new Date().toISOString();
    const health = { lastAttemptAt: nvcHealth.lastAttemptAt, lastError: null };
    const firstRefresh = !hasUsableNVCCatalogue();
    let indexes = nvcIndexes;
    let computedSha256 = nvcHealth.sha256;
    let unchanged = response.status === 304;
    if (unchanged) {
      if (firstRefresh)
        throw Object.assign(new Error(), { category: 'invalid' });
    } else {
      category = 'invalid';
      indexes = prepareNVCCatalogue(bundle);
      computedSha256 = await sha256Hex(JSON.stringify(bundle));
      const previousSha256 =
        nvcHealth.sha256 ||
        (nvcBundle ? await sha256Hex(JSON.stringify(nvcBundle)) : null);
      unchanged = !firstRefresh && computedSha256 === previousSha256;
    }
    const addedLotCount = unchanged
      ? 0
      : Object.keys(indexes.lotByCode).filter(
          (code) => !Object.hasOwn(nvcIndexes.lotByCode || {}, code)
        ).length;
    const outcome = {
      firstRefresh,
      unchanged,
      addedLotCount,
      ...indexes.catalogueInfo
    };
    const lastModified =
      response.headers.get('Last-Modified') ||
      (response.status === 304 ? nvcHealth.lastModified : null);
    if (unchanged) {
      category = 'storage';
      await setStorage({
        [STORAGE_KEYS.lastCheckAt]: checkedAt,
        [STORAGE_KEYS.lastModified]: lastModified,
        [STORAGE_KEYS.bundleSha256]: computedSha256,
        [STORAGE_KEYS.health]: health
      });
      Object.assign(nvcHealth, {
        lastCheckAt: checkedAt,
        lastModified,
        sha256: computedSha256,
        lastError: null
      });
      return {
        success: true,
        ...outcome,
        sourceUrl: DEFAULT_NVC_SOURCE_URL,
        updatedAt: nvcHealth.updatedAt,
        checkedAt,
        usable: true
      };
    }
    category = 'storage';
    await setStorage({
      [STORAGE_KEYS.bundle]: bundle,
      [STORAGE_KEYS.bundleSha256]: computedSha256,
      [STORAGE_KEYS.lastCheckAt]: checkedAt,
      [STORAGE_KEYS.lastModified]: lastModified,
      [STORAGE_KEYS.updatedAt]: checkedAt,
      [STORAGE_KEYS.health]: health
    });
    // Make the replacement visible only after both indexing and saving succeed.
    nvcBundle = bundle;
    nvcIndexes = indexes;
    nvcUsingCache = false;
    nvcCacheInvalid = false;
    Object.assign(nvcHealth, {
      updatedAt: checkedAt,
      lastCheckAt: checkedAt,
      sha256: computedSha256,
      lastModified,
      lastError: null
    });
    await logAnalyticsEvent('nvc_refresh_result', {
      trigger,
      success: true
    }).catch(() => undefined);
    return {
      success: true,
      ...outcome,
      sourceUrl: DEFAULT_NVC_SOURCE_URL,
      updatedAt: checkedAt,
      checkedAt,
      entryCount: bundle.entry.length,
      sha256: computedSha256,
      usable: true
    };
  } catch (error) {
    nvcHealth.lastError = error.category || category;
    if (hasUsableNVCCatalogue()) nvcUsingCache = true;
    await setStorage({
      [STORAGE_KEYS.health]: {
        lastAttemptAt: nvcHealth.lastAttemptAt,
        lastError: nvcHealth.lastError
      }
    }).catch(() => undefined);
    await logAnalyticsEvent('nvc_refresh_result', {
      trigger,
      success: false
    }).catch(() => undefined);
    return nvcFailure(nvcHealth.lastError);
  }
}

async function maybeAutoRefreshNVCBundle(trigger) {
  await loadNVCBundle();
  if (nvcRefreshPromise) return nvcRefreshPromise;
  const last = Date.parse(nvcHealth.lastCheckAt || '');
  if (
    hasUsableNVCCatalogue() &&
    Date.now() - last < AUTO_SYNC_INTERVAL_MINUTES * 60000
  ) {
    return { success: true, skipped: true, reason: 'interval_not_elapsed' };
  }
  return refreshNVCBundleFromUrl(DEFAULT_NVC_SOURCE_URL, { trigger });
}

async function getNVCUpdateStatus() {
  await loadNVCBundle();
  const usable = hasUsableNVCCatalogue();
  return {
    sourceUrl: DEFAULT_NVC_SOURCE_URL,
    state: nvcRefreshPromise
      ? 'refreshing'
      : usable
        ? 'ready'
        : nvcCacheInvalid || nvcHealth.lastError === 'invalid'
          ? 'invalid'
          : 'unavailable',
    usable,
    usingCache: usable && nvcUsingCache,
    freshnessDegraded: usable && !!nvcHealth.lastError,
    updatedAt: nvcHealth.updatedAt || null,
    lastCheckAt: nvcHealth.lastCheckAt || null,
    lastAttemptAt: nvcHealth.lastAttemptAt || null,
    lastError: nvcHealth.lastError || null,
    sha256: nvcHealth.sha256 || null,
    ...(nvcIndexes.catalogueInfo || {
      lotCount: null,
      releaseVersion: null,
      releaseDate: null
    }),
    autoSyncIntervalMinutes: AUTO_SYNC_INTERVAL_MINUTES
  };
}

function buildNVCIndexes(bundle) {
  bgLog('buildNVCIndexes called');
  if (!bundle || !bundle.entry) {
    console.error('bundle not loaded or no entries');
    return;
  }

  bgLog('bundle has', bundle.entry.length, 'entries');

  const tradenames = collectTradenameConceptsFromBundle(bundle);
  const lots = collectLotConceptsFromBundle(bundle);
  const lotAgentRows = collectLotAgentMappingRowsFromBundle(bundle);

  bgLog('Collected', tradenames.length, 'tradename concepts');
  bgLog('Collected', lots.length, 'lot concepts');
  bgLog('Collected', lotAgentRows.length, 'lot-agent mapping rows');

  // Index tradenames by code and by DIN
  const tradenameByCode = Object.create(null);
  const tradenameByDin = Object.create(null);
  const tradenameByName = Object.create(null);

  for (const concept of tradenames) {
    const codeKey = normalizeCodeKey(concept.code);
    if (codeKey) {
      const existingByCode = tradenameByCode[codeKey];
      if (
        !existingByCode ||
        conceptRichness(concept) >= conceptRichness(existingByCode)
      ) {
        tradenameByCode[codeKey] = concept;
      }
    }
    const din = extractTradenameDIN(concept);
    const dinKey = normalizeDinKey(din);
    if (dinKey) {
      const existingByDin = tradenameByDin[dinKey];
      if (
        !existingByDin ||
        conceptRichness(concept) >= conceptRichness(existingByDin)
      ) {
        tradenameByDin[dinKey] = concept;
      }
    }
    indexTradenameNames(tradenameByName, concept);
  }

  bgLog('Indexed', Object.keys(tradenameByCode).length, 'tradenames by code');
  bgLog('Indexed', Object.keys(tradenameByDin).length, 'tradenames by DIN');
  bgLog('Indexed', Object.keys(tradenameByName).length, 'tradenames by name');

  // Index lots by lot number and by code
  const lotByLotNumber = Object.create(null);
  const lotByCode = Object.create(null);
  const lotByCodePrefix = Object.create(null);

  for (const concept of lots) {
    const codeKey = normalizeCodeKey(concept.code);
    if (!codeKey || /[\s\x00-\x1f\x7f]/.test(codeKey)) continue;
    lotByCode[codeKey] = concept;
    const underscoreIdx = codeKey.indexOf('_');
    const prefix =
      underscoreIdx > 0 ? codeKey.substring(0, underscoreIdx) : codeKey;
    if (prefix && !lotByCodePrefix[prefix]) {
      lotByCodePrefix[prefix] = concept;
    }
    const lotNumber = extractLotNumber(concept);
    if (lotNumber) {
      lotByLotNumber[normalizeCodeKey(lotNumber)] = concept;
    }
  }

  bgLog('Indexed', Object.keys(lotByLotNumber).length, 'lots by lot number');
  bgLog('Indexed', Object.keys(lotByCode).length, 'lots by code');
  const lotAgentMappingByLot = buildLotAgentMappingIndex(lotAgentRows);
  bgLog(
    'Indexed',
    Object.keys(lotAgentMappingByLot).length,
    'lot-agent mappings by lot key'
  );

  const lotResource = bundle.entry.find(
    ({ resource }) =>
      resource.resourceType === 'CodeSystem' &&
      resource.id === 'nvc-vaccine-lot-id'
  )?.resource;
  return {
    catalogueInfo: {
      lotCount: Object.keys(lotByCode).length,
      releaseVersion:
        typeof lotResource?.version === 'string'
          ? lotResource.version.trim() || null
          : null,
      releaseDate:
        typeof lotResource?.date === 'string'
          ? lotResource.date.trim() || null
          : null
    },
    tradenameByCode,
    tradenameByDin,
    tradenameByName,
    tradenameConceptsArray: tradenames,
    lotByLotNumber,
    lotByCode,
    lotByCodePrefix,
    lotAgentMappingByLot
  };
}

function collectTradenameConceptsFromBundle(bundle) {
  const concepts = [];
  if (!bundle.entry) return concepts;

  for (const entry of bundle.entry) {
    const resource = entry.resource;
    if (!resource || !resource.resourceType) continue;
    if (resource.resourceType === 'ValueSet' && resource.id === 'Tradename') {
      for (const include of resource.compose?.include || []) {
        concepts.push(...(include.concept || []));
      }
      for (const item of resource.expansion?.contains || []) {
        concepts.push(item);
      }
    } else if (resource.resourceType === 'CodeSystem') {
      const idKey = normalizeCodeKey(resource.id);
      const titleKey = normalizeCodeKey(resource.title);
      const nameKey = normalizeCodeKey(resource.name);
      const urlKey = normalizeCodeKey(resource.url);
      const looksLikeTradename =
        idKey.includes('tradename') ||
        titleKey.includes('tradename') ||
        nameKey.includes('tradename') ||
        urlKey.includes('tradename');
      if (looksLikeTradename) {
        concepts.push(...(resource.concept || []));
      }
    }
  }
  return concepts;
}

function collectLotConceptsFromBundle(bundle) {
  const concepts = [];
  if (!bundle.entry) return concepts;

  for (const entry of bundle.entry) {
    const resource = entry.resource;
    if (
      resource.resourceType === 'CodeSystem' &&
      resource.id === 'nvc-vaccine-lot-id'
    ) {
      concepts.push(...(resource.concept || []));
    }
  }
  return concepts;
}

function collectLotAgentMappingRowsFromBundle(bundle) {
  const rows = [];
  if (!bundle.entry) return rows;

  for (const entry of bundle.entry) {
    const resource = entry.resource;
    if (!resource || !resource.resourceType) continue;
    const identity = normalizeCodeKey(
      [resource.id, resource.name, resource.title, resource.url]
        .filter(Boolean)
        .join(' ')
    );
    if (!identity.includes('lotagentmapping')) {
      continue;
    }

    if (resource.resourceType === 'CodeSystem') {
      for (const concept of resource.concept || []) {
        rows.push({ concept, sourceType: 'codesystem' });
      }
      continue;
    }

    if (resource.resourceType === 'ValueSet') {
      for (const include of resource.compose?.include || []) {
        for (const concept of include.concept || []) {
          rows.push({ concept, sourceType: 'valueset-compose' });
        }
      }
      for (const concept of resource.expansion?.contains || []) {
        rows.push({ concept, sourceType: 'valueset-expansion' });
      }
    }
  }
  return rows;
}

function normalizeLotMapKey(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

function readPropertyScalar(prop) {
  if (!prop || typeof prop !== 'object') return '';
  if (prop.valueString !== undefined) return String(prop.valueString);
  if (prop.valueCode !== undefined) return String(prop.valueCode);
  if (prop.valueDateTime !== undefined) return String(prop.valueDateTime);
  if (prop.valueInteger !== undefined) return String(prop.valueInteger);
  if (prop.valueDecimal !== undefined) return String(prop.valueDecimal);
  if (prop.valueBoolean !== undefined) return String(prop.valueBoolean);
  if (prop.valueCoding)
    return prop.valueCoding.display || prop.valueCoding.code || '';
  if (prop.valueCodeableConcept)
    return extractCodeableConceptDisplay(prop.valueCodeableConcept) || '';
  return '';
}

function normalizeMappingPropKey(value) {
  return normalizeCodeKey(value).replace(/[^a-z0-9]/g, '');
}

function parseLotAgentMappingConcept(concept) {
  if (!concept || typeof concept !== 'object') {
    return null;
  }

  const lotKeys = [];
  const addLotKey = (value) => {
    const key = normalizeLotMapKey(value);
    if (!key) return;
    if (!lotKeys.includes(key)) lotKeys.push(key);
  };

  const mapped = {
    tradename: '',
    generic_name: '',
    disease: '',
    antigen: '',
    manufacturer: '',
    route: '',
    strength: '',
    dose_value: '',
    dose_unit: '',
    din: ''
  };

  addLotKey(concept.code || '');
  if (!mapped.tradename && concept.display) {
    mapped.tradename = concept.display;
  }

  for (const prop of concept.property || []) {
    const key = normalizeMappingPropKey(prop.code);
    const value = readPropertyScalar(prop);
    if (!key || !value) continue;

    if (
      (key.includes('source') || key.includes('lot')) &&
      key.includes('lot')
    ) {
      addLotKey(value);
    }

    if (key.includes('target') && key.includes('tradename'))
      mapped.tradename = value;
    else if (key.includes('tradename') && !mapped.tradename)
      mapped.tradename = value;
    else if (key.includes('generic')) mapped.generic_name = value;
    else if (key.includes('disease')) mapped.disease = value;
    else if (key.includes('antigen')) mapped.antigen = value;
    else if (key.includes('manufacturer')) mapped.manufacturer = value;
    else if (key.includes('route')) mapped.route = value;
    else if (key.includes('strength')) mapped.strength = value;
    else if (
      key.includes('dose') &&
      (key.includes('unit') || key.includes('uom'))
    )
      mapped.dose_unit = value;
    else if (key.includes('dose')) mapped.dose_value = value;
    else if (key === 'din' || key.includes('drugidentificationnumber'))
      mapped.din = value;
  }

  if (!lotKeys.length) {
    return null;
  }

  return { lotKeys, mapped };
}

function buildLotAgentMappingIndex(rows) {
  const index = {};
  for (const row of rows || []) {
    const parsed = parseLotAgentMappingConcept(row?.concept);
    if (!parsed) continue;
    for (const lotKey of parsed.lotKeys) {
      if (!index[lotKey]) {
        index[lotKey] = { ...parsed.mapped };
        continue;
      }
      mergeDefinedVaccineFields(index[lotKey], parsed.mapped);
      if (parsed.mapped.din && !index[lotKey].din) {
        index[lotKey].din = parsed.mapped.din;
      }
    }
  }
  return index;
}

function extractLotNumber(concept) {
  for (const prop of concept.property || []) {
    if (prop.code === 'lotNumber') {
      return prop.valueString;
    }
  }
  return null;
}

function extractLotDIN(concept) {
  for (const prop of concept.property || []) {
    if (prop.code === 'drugIdentificationNumber') {
      const valueCoding = prop.valueCoding;
      if (valueCoding) {
        return valueCoding.code || valueCoding.display || null;
      }
      if (prop.valueString) return prop.valueString;
      if (prop.valueCodeableConcept)
        return extractCodeableConceptDisplay(prop.valueCodeableConcept);
    }
  }
  return null;
}

function extractLotExpiry(concept) {
  for (const prop of concept.property || []) {
    if (prop.code === 'expiryDate' || prop.code === 'originalExpiryDate') {
      return prop.valueDateTime;
    }
  }
  return null;
}

function extractLotManufacturer(concept) {
  // First try extensions (market authorization holder)
  for (const ext of concept.extension || []) {
    if (
      ext.url ===
      'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-linked-to-market-authorization-holder'
    ) {
      return extractCodeableConceptDisplay(ext.valueCodeableConcept);
    }
  }
  // Then try properties
  for (const prop of concept.property || []) {
    if (prop.code === 'manufacturer') {
      const valueCoding = prop.valueCoding;
      if (valueCoding) {
        return valueCoding.display || valueCoding.code;
      }
    }
  }
  return null;
}

function getLotTradenameReferences(concept) {
  const refs = [];
  for (const ext of concept.extension || []) {
    const url = normalizeCodeKey(ext.url);
    if (
      !url.includes('linked-tradename-concept') &&
      !url.endsWith('/tradename')
    ) {
      continue;
    }
    const cc = ext.valueCodeableConcept || null;
    const coding = cc?.coding?.[0] || null;
    refs.push({
      code: coding?.code || '',
      display: coding?.display || cc?.text || '',
      raw: cc?.text || ''
    });
  }

  for (const prop of concept.property || []) {
    const code = normalizeCodeKey(prop.code);
    if (
      code !== 'tradename' &&
      code !== 'trade name' &&
      code !== 'tradenamecode'
    ) {
      continue;
    }
    const coding =
      prop.valueCoding || prop.valueCodeableConcept?.coding?.[0] || null;
    refs.push({
      code: coding?.code || '',
      display: coding?.display || prop.valueCodeableConcept?.text || '',
      raw: prop.valueString || ''
    });
  }

  const seen = new Set();
  return refs.filter((ref) => {
    const key = [
      normalizeCodeKey(ref.code),
      normalizeNameKey(ref.display),
      normalizeNameKey(ref.raw)
    ].join('|');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractTradenameDIN(concept) {
  for (const ext of concept.extension || []) {
    if (
      ext.url ===
      'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-din'
    ) {
      const cc = ext.valueCodeableConcept;
      if (cc && cc.coding && cc.coding[0]) {
        return cc.coding[0].code || cc.coding[0].display;
      }
    }
  }
  for (const prop of concept.property || []) {
    const code = normalizeCodeKey(prop.code);
    if (code === 'drugidentificationnumber' || code === 'din') {
      if (prop.valueCoding)
        return prop.valueCoding.code || prop.valueCoding.display || null;
      if (prop.valueString) return prop.valueString;
      if (prop.valueCodeableConcept)
        return extractCodeableConceptDisplay(prop.valueCodeableConcept);
    }
  }
  return null;
}

function normalizeCodeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function conceptRichness(concept) {
  if (!concept || typeof concept !== 'object') return 0;
  const extCount = Array.isArray(concept.extension)
    ? concept.extension.length
    : 0;
  const propCount = Array.isArray(concept.property)
    ? concept.property.length
    : 0;
  const desigCount = Array.isArray(concept.designation)
    ? concept.designation.length
    : 0;
  const hasDisplay = concept.display ? 1 : 0;
  return extCount * 4 + propCount * 3 + desigCount * 2 + hasDisplay;
}

function normalizeDinKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const digitsOnly = raw.replace(/\D/g, '');
  if (digitsOnly) {
    return digitsOnly.replace(/^0+/, '') || '0';
  }
  return raw.toLowerCase();
}

function normalizeGtinKey(value) {
  const digitsOnly = String(value || '').replace(/\D/g, '');
  return digitsOnly || '';
}

function resolveTradenameCodeOverrideByGtin(gtin) {
  const gtinKey = normalizeGtinKey(gtin);
  if (!gtinKey) return '';
  return normalizeCodeKey(GTIN_TRADENAME_CODE_OVERRIDES[gtinKey] || '');
}

function resolveTradenameCodeOverrideByLot(lot) {
  const lotKey = normalizeLotMapKey(lot);
  if (!lotKey) return '';
  return normalizeCodeKey(LOT_TRADENAME_CODE_OVERRIDES[lotKey] || '');
}

function normalizeNameKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function indexTradenameNames(map, concept) {
  const candidates = [];
  if (concept && concept.display) {
    candidates.push(concept.display);
  }
  for (const designation of (concept && concept.designation) || []) {
    if (designation && designation.value) {
      candidates.push(designation.value);
    }
  }
  for (const value of candidates) {
    const key = normalizeNameKey(value);
    if (!key) continue;
    const existing = map[key];
    if (!existing || conceptRichness(concept) >= conceptRichness(existing)) {
      map[key] = concept;
    }
  }
}

function mergeDefinedVaccineFields(target, source) {
  if (!source || typeof source !== 'object') return;
  const keys = [
    'tradename',
    'generic_name',
    'disease',
    'antigen',
    'manufacturer',
    'route',
    'strength',
    'dose_value',
    'dose_unit'
  ];
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (!String(value).trim()) continue;
    target[key] = value;
  }
}

function extractLotDirectVaccineInfo(concept) {
  const refs = getLotTradenameReferences(concept);
  return {
    tradename: refs[0]?.display || refs[0]?.raw || '',
    generic_name: extractTradenameGeneric(concept) || '',
    disease: extractTradenameDisease(concept) || '',
    antigen: extractTradenameAntigen(concept) || '',
    route: extractTradenameRoute(concept) || '',
    strength: extractTradenameStrength(concept) || '',
    dose_value: extractTradenameDoseValue(concept) || '',
    dose_unit: extractTradenameDoseUnit(concept) || ''
  };
}

function extractTrademenameDisplay(concept) {
  // Look for enPublicPicklist designation
  for (const designation of concept.designation || []) {
    const use = designation.use || {};
    if (use.code === 'enPublicPicklist') {
      return designation.value;
    }
  }
  return concept.display;
}

function extractTradenameGeneric(concept) {
  for (const ext of concept.extension || []) {
    if (
      ext.url ===
      'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-linked-generic-concept'
    ) {
      const cc = ext.valueCodeableConcept;
      if (cc && cc.coding && cc.coding[0]) {
        return cc.coding[0].display || cc.coding[0].code;
      }
    }
  }
  return null;
}

function extractTradenameDisease(concept) {
  const diseases = [];
  for (const ext of concept.extension || []) {
    if (
      ext.url ===
      'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-protects-against-disease'
    ) {
      const cc = ext.valueCodeableConcept;
      if (cc && cc.coding && cc.coding[0]) {
        const display = cc.coding[0].display || cc.coding[0].code;
        if (!diseases.includes(display)) {
          diseases.push(display);
        }
      }
    }
  }
  return diseases.length > 0 ? diseases.join(', ') : null;
}

function extractTradenameAntigen(concept) {
  const values = [];
  for (const ext of concept.extension || []) {
    if (
      ext.url ===
      'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-contains-antigen'
    ) {
      const display = extractCodeableConceptDisplay(ext.valueCodeableConcept);
      if (display) {
        values.push(display);
      }
    }
  }
  // Remove duplicates and join
  const uniqueValues = [...new Set(values)];
  return uniqueValues.length > 0 ? uniqueValues.join(', ') : null;
}

function extractTradenameManufacturer(concept) {
  for (const ext of concept.extension || []) {
    if (
      ext.url ===
      'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-linked-to-market-authorization-holder'
    ) {
      return extractCodeableConceptDisplay(ext.valueCodeableConcept);
    }
  }
  return null;
}

function extractTradenameRoute(concept) {
  for (const ext of concept.extension || []) {
    if (
      ext.url ===
      'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-route-of-admin'
    ) {
      return extractCodeableConceptDisplay(ext.valueCodeableConcept);
    }
  }
  return null;
}

function collectTradenameStringValues(concept, extensionUrl) {
  const values = [];
  for (const ext of concept.extension || []) {
    if (ext.url !== extensionUrl) continue;
    const raw = String(ext.valueString || '').trim();
    if (!raw) continue;
    if (!values.includes(raw)) {
      values.push(raw);
    }
  }
  return values;
}

function extractStrengthFromTradenameDisplay(concept) {
  const display = String(concept?.display || '').trim();
  if (!display) return null;
  const match = display.match(
    /(\d+(?:\.\d+)?)\s*(?:microgram|micrograms|mcg)\b/i
  );
  return match ? match[1] : null;
}

function extractTradenameStrength(concept) {
  const values = collectTradenameStringValues(
    concept,
    'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-strength'
  );
  if (!values.length) {
    return extractStrengthFromTradenameDisplay(concept);
  }
  if (values.length === 1) {
    return values[0];
  }

  const fromDisplay = extractStrengthFromTradenameDisplay(concept);
  if (fromDisplay) {
    for (const value of values) {
      if (value === fromDisplay) {
        return value;
      }
    }
    return fromDisplay;
  }
  return values[0];
}

function extractTradenameDoseValue(concept) {
  for (const ext of concept.extension || []) {
    if (
      ext.url ===
      'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-typical-dose-size'
    ) {
      return ext.valueString || null;
    }
  }
  return null;
}

function extractTradenameDoseUnit(concept) {
  for (const ext of concept.extension || []) {
    if (
      ext.url ===
      'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-typical-dose-size-uom'
    ) {
      return ext.valueString || null;
    }
  }
  return null;
}

function extractCodeableConceptDisplay(cc) {
  if (!cc) return null;
  const coding = cc.coding || [];
  if (coding.length > 0 && coding[0].display) {
    return coding[0].display;
  }
  if (coding.length > 0 && coding[0].code) {
    return coding[0].code;
  }
  return cc.text || null;
}

function looksLikeGtinOrNumericId(key) {
  const k = String(key || '').trim();
  return /^\d{8,14}$/.test(k);
}

function lookupVaccineLot(lotNumber, options = {}) {
  const indexes = options.indexes || nvcIndexes;
  if (!lotNumber) {
    bgLog('lookupVaccineLot: no lot number provided');
    return null;
  }

  bgLog('lookupVaccineLot: Looking up lot:', lotNumber);

  try {
    const lotKey = String(lotNumber).trim().toLowerCase();
    if (!lotKey) {
      return null;
    }

    // Try to find by lot number first
    let concept = indexes.lotByLotNumber[lotKey];

    // If not found, try direct code then prefix map (O(1)).
    // Skip code/prefix for all-numeric keys (GTIN mistaken for lot -> wrong hit).
    if (!concept && !looksLikeGtinOrNumericId(lotKey)) {
      concept = indexes.lotByCode[lotKey] || indexes.lotByCodePrefix[lotKey];
    }

    if (!concept) {
      bgLog('No matching lot found for:', lotNumber);
      return null;
    }

    // Extract vaccine info from lot concept
    const vaccineInfo = {
      lot_number: extractLotNumber(concept) || lotNumber,
      lot_expiry: extractLotExpiry(concept),
      din: extractLotDIN(concept),
      manufacturer: extractLotManufacturer(concept)
    };

    const lotMapKey = normalizeLotMapKey(vaccineInfo.lot_number || lotNumber);
    const lotCodeMapKey = normalizeLotMapKey(concept.code || '');
    const lotAgentMappedInfo =
      indexes.lotAgentMappingByLot?.[lotMapKey] ||
      indexes.lotAgentMappingByLot?.[lotCodeMapKey] ||
      null;
    if (lotAgentMappedInfo) {
      bgLog('Lot-agent mapping matched:', {
        lotMapKey,
        lotCodeMapKey,
        lotAgentMappedInfo
      });
      mergeDefinedVaccineFields(vaccineInfo, lotAgentMappedInfo);
      if (!vaccineInfo.din && lotAgentMappedInfo.din) {
        vaccineInfo.din = lotAgentMappedInfo.din;
      }
    }

    mergeDefinedVaccineFields(
      vaccineInfo,
      extractLotDirectVaccineInfo(concept)
    );

    bgLog('Extracted from lot concept:', vaccineInfo);

    // Get tradename info
    const tradenameRefs = getLotTradenameReferences(concept);
    bgLog('Lot tradename references:', tradenameRefs);
    // GTIN override takes priority; lot override fires when no GTIN in the barcode.
    const gtinOverrideCode = resolveTradenameCodeOverrideByGtin(options.gtin);
    const lotOverrideCode = resolveTradenameCodeOverrideByLot(lotNumber);
    const effectiveOverrideCode = gtinOverrideCode || lotOverrideCode;
    const byCodeCandidates = [];
    let resolvedTradename = null;
    for (const ref of tradenameRefs) {
      if (!ref.code) continue;
      const info = lookupTradenameByCode(ref.code, indexes);
      if (info) {
        byCodeCandidates.push({ ref, info });
      }
    }

    if (effectiveOverrideCode && byCodeCandidates.length > 0) {
      const overrideMatch = byCodeCandidates.find(
        ({ ref }) => normalizeCodeKey(ref.code) === effectiveOverrideCode
      );
      if (overrideMatch) {
        resolvedTradename = overrideMatch.info;
        const overrideSource = gtinOverrideCode
          ? `GTIN ${options.gtin}`
          : `lot ${lotNumber}`;
        bgLog(
          'Tradename resolved from override (',
          overrideSource,
          '):',
          overrideMatch.ref.code
        );
        vaccineInfo.nvc_override = gtinOverrideCode ? 'gtin' : 'lot';
      }
    }

    if (!resolvedTradename && byCodeCandidates.length > 0) {
      resolvedTradename = byCodeCandidates[0].info;
      bgLog(
        'Tradename resolved from first code reference:',
        byCodeCandidates[0].ref.code
      );
    }

    if (!resolvedTradename) {
      for (const ref of tradenameRefs) {
        const label = ref.display || ref.raw || '';
        if (!label) continue;
        resolvedTradename = lookupTradenameByName(label, indexes);
        if (resolvedTradename) {
          bgLog('Tradename resolved from name reference:', label);
          break;
        }
      }
    }

    if (resolvedTradename) {
      mergeDefinedVaccineFields(vaccineInfo, resolvedTradename);
    } else if (vaccineInfo.din) {
      const tradenameInfo = lookupTradenameByDIN(vaccineInfo.din, indexes);
      bgLog('Tradename info from DIN:', tradenameInfo);
      if (tradenameInfo) {
        mergeDefinedVaccineFields(vaccineInfo, tradenameInfo);
      }
    }

    bgLog('Final vaccine info:', vaccineInfo);
    return vaccineInfo;
  } catch (e) {
    console.error('Error looking up vaccine lot:', e);
    return nvcFailure('unavailable');
  }
}

function lookupTradenameByCode(code, indexes = nvcIndexes) {
  const codeKey = normalizeCodeKey(code);
  const concept = indexes.tradenameByCode[codeKey];
  if (!concept) return null;

  return {
    tradename: extractTrademenameDisplay(concept),
    generic_name: extractTradenameGeneric(concept),
    disease: extractTradenameDisease(concept),
    antigen: extractTradenameAntigen(concept),
    manufacturer: extractTradenameManufacturer(concept),
    route: extractTradenameRoute(concept),
    strength: extractTradenameStrength(concept),
    dose_value: extractTradenameDoseValue(concept),
    dose_unit: extractTradenameDoseUnit(concept)
  };
}

function lookupTradenameByName(name, indexes = nvcIndexes) {
  const nameKey = normalizeNameKey(name);
  const concept = indexes.tradenameByName[nameKey];
  if (!concept) return null;
  return {
    tradename: extractTrademenameDisplay(concept),
    generic_name: extractTradenameGeneric(concept),
    disease: extractTradenameDisease(concept),
    antigen: extractTradenameAntigen(concept),
    manufacturer: extractTradenameManufacturer(concept),
    route: extractTradenameRoute(concept),
    strength: extractTradenameStrength(concept),
    dose_value: extractTradenameDoseValue(concept),
    dose_unit: extractTradenameDoseUnit(concept)
  };
}

function lookupTradenameByDIN(din, indexes = nvcIndexes) {
  const dinKey = normalizeDinKey(din);
  const concept = indexes.tradenameByDin[dinKey];
  if (!concept) return null;

  return {
    tradename: extractTrademenameDisplay(concept),
    generic_name: extractTradenameGeneric(concept),
    disease: extractTradenameDisease(concept),
    antigen: extractTradenameAntigen(concept),
    manufacturer: extractTradenameManufacturer(concept),
    route: extractTradenameRoute(concept),
    strength: extractTradenameStrength(concept),
    dose_value: extractTradenameDoseValue(concept),
    dose_unit: extractTradenameDoseUnit(concept)
  };
}

async function readScannerStatus() {
  const cachedCaptureAt =
    scannerDaemonStatusCache.lastKnownCaptureAt ||
    scannerDaemonStatusCache.lastCaptureAt;
  const bootstrap = await getScannerBootstrapState();
  let status = {
    ...bootstrap.status,
    profileId: bootstrap.profileId || bootstrap.status.profileId,
    portInfo: bootstrap.portInfo || bootstrap.status.portInfo
  };
  status.lastKnownCaptureAt =
    [cachedCaptureAt, status.lastKnownCaptureAt, status.lastCaptureAt]
      .sort()
      .at(-1) || '';
  let source = 'cached';
  let captureSource = 'cached';
  const captureError =
    scannerCaptureWarning ||
    (await getStorage([SCANNER_CAPTURE_ERROR_KEY]))[
      SCANNER_CAPTURE_ERROR_KEY
    ] === true;
  if (await hasScannerDaemonDocument()) {
    const reply = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 1000);
      sendRuntimeMessage({
        target: SCANNER_DAEMON_TARGET,
        action: SCANNER_DAEMON_ACTIONS.GET_STATUS
      }).then(
        (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        () => {
          clearTimeout(timer);
          resolve(null);
        }
      );
    });
    if (reply?.success && reply.status) {
      const liveStatus = normalizeScannerStatusSnapshot(reply.status);
      liveStatus.lastKnownCaptureAt =
        [
          status.lastKnownCaptureAt,
          liveStatus.lastKnownCaptureAt,
          liveStatus.lastCaptureAt
        ]
          .sort()
          .at(-1) || '';
      liveStatus.profileId ||= bootstrap.profileId;
      liveStatus.portInfo ||= bootstrap.portInfo;
      if (liveStatus.lastCaptureAt) captureSource = 'live';
      status = liveStatus;
      source = 'live';
    }
  }
  return { status, source, captureSource, captureError };
}

const workstationBuildAtLoad = (() => {
  const manifest = chrome.runtime.getManifest();
  return {
    version: manifest.version || '',
    versionName: manifest.version_name || '',
    name: manifest.name || '',
    fingerprint: globalThis.VAXLINK_BUILD_ID || null
  };
})();

async function getWorkstationHealth(tabId) {
  const result = {
    success: true,
    scanner: { state: 'unknown', captureSource: 'unknown', lastCaptureAt: '' },
    nvc: { state: 'unknown' },
    chart: { state: 'unknown' }
  };
  try {
    const scanner = await readScannerStatus();
    result.scanner = {
      state: !scanner.status.profileId
        ? 'unconfigured'
        : scanner.source !== 'live'
          ? 'unknown'
          : scanner.status.state === SCANNER_STATUS_STATES.CONNECTED
            ? 'connected'
            : 'disconnected',
      captureSource:
        scanner.status.lastCaptureAt || scanner.status.lastKnownCaptureAt
          ? scanner.captureSource
          : 'none',
      lastCaptureAt:
        scanner.source === 'live' && scanner.status.lastCaptureAt
          ? scanner.status.lastCaptureAt
          : scanner.status.lastKnownCaptureAt || ''
    };
  } catch (_) {
    /* Leave the category unknown. */
  }
  try {
    const nvc = await getNVCUpdateStatus();
    const age = Date.now() - Date.parse(nvc.lastCheckAt || '');
    result.nvc.state = !nvc.usable
      ? 'unavailable'
      : nvc.freshnessDegraded ||
          !Number.isFinite(age) ||
          age < 0 ||
          age > 24 * 60 * 60 * 1000
        ? 'degraded'
        : 'ready';
  } catch (_) {
    /* Leave the category unknown. */
  }
  try {
    if (!Number.isSafeInteger(tabId) || tabId < 0) return result;
    const tab = (await queryTabs({})).find((item) => item.id === tabId);
    if (!tab || (tab.url && !isSupportedChartUrl(tab.url))) {
      result.chart.state = 'missing';
      return result;
    }
    const reply = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ unknown: true }), 1000);
      chrome.tabs.sendMessage(
        tabId,
        { action: 'getPanoramaIntegration' },
        { frameId: 0 },
        (response) => {
          clearTimeout(timer);
          const error = chrome.runtime.lastError;
          resolve(
            error
              ? /Receiving end does not exist/i.test(error.message || '')
                ? { supported: false }
                : { unknown: true }
              : response || { unknown: true }
          );
        }
      );
    });
    if (reply.unknown) result.chart.state = 'unknown';
    else if (!reply.supported) result.chart.state = 'missing';
    else if (!reply.buildAtLoad) result.chart.state = 'unknown';
    else if (
      ['version', 'versionName', 'name'].some(
        (key) =>
          reply.buildAtLoad[key] &&
          reply.buildAtLoad[key] !== workstationBuildAtLoad[key]
      ) ||
      (workstationBuildAtLoad.fingerprint &&
        reply.buildAtLoad.fingerprint &&
        reply.buildAtLoad.fingerprint !== workstationBuildAtLoad.fingerprint)
    )
      result.chart.state = 'stale';
    // Unpacked source can change without a version change. Only fingerprints
    // can establish that the page and running extension use the same files.
    else if (
      ['version', 'versionName', 'name'].some(
        (key) => !reply.buildAtLoad[key]
      ) ||
      !workstationBuildAtLoad.fingerprint ||
      !reply.buildAtLoad.fingerprint
    )
      result.chart.state = 'unknown';
    else
      result.chart.state =
        reply.ready === true &&
        reply.initialized?.listener === true &&
        reply.initialized?.settings === true
          ? 'ready'
          : 'not_ready';
  } catch (_) {
    /* Leave the category unknown. */
  }
  return result;
}

function canChangeQueue(sender) {
  if (sender.id !== chrome.runtime.id) return false;
  if (sender.url === chrome.runtime.getURL('popup.html')) return true;
  return (
    sender.frameId === 0 &&
    Number.isInteger(sender.tab?.id) &&
    isSupportedChartUrl(sender.url) &&
    (!sender.tab.url || isSupportedChartUrl(sender.tab.url))
  );
}

// Listen for requests from extension contexts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.action === 'scannerPairing.open') {
    if (
      sender.id !== chrome.runtime.id ||
      sender.url !== chrome.runtime.getURL('popup.html')
    ) {
      sendResponse({
        success: false,
        error: 'Open Scanner setup from Settings.'
      });
      return false;
    }
    // Share a pending open across popups so two requests cannot open two windows.
    scannerPairingRequest ??= showScannerPairingWindow().finally(() => {
      scannerPairingRequest = null;
    });
    scannerPairingRequest.then(
      () => sendResponse({ success: true }),
      (error) => sendResponse({ success: false, error: error.message })
    );
    return true;
  }
  bgLog('Background received message:', request);
  if (request?.target === SCANNER_DAEMON_TARGET) {
    return false;
  }
  if (
    request?.action === SCANNER_DAEMON_ACTIONS.STATUS_CHANGED ||
    request?.action === 'scannerDaemon.scanEcho'
  ) {
    return false;
  }

  if (
    request?.target === SCANNER_DAEMON_BACKGROUND_TARGET &&
    request.action === SCANNER_DAEMON_ACTIONS.STATUS_UPDATE
  ) {
    persistScannerStatusSnapshot(request.status || null)
      .then((status) => broadcastScannerStatus(status).then(() => status))
      .then((status) => sendResponse({ success: true, status }))
      .catch((error) =>
        sendResponse({
          success: false,
          error: error?.message || 'Scanner status update failed'
        })
      );
    return true;
  }

  if (request.action === 'getWorkstationHealth') {
    getWorkstationHealth(request.tabId)
      .then(sendResponse)
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (request.action === SCANNER_DAEMON_ACTIONS.ENSURE) {
    ensureScannerDaemon()
      .then(() => getScannerBootstrapState())
      .then((bootstrap) =>
        sendResponse({ success: true, status: bootstrap.status })
      )
      .catch((error) =>
        sendResponse({
          success: false,
          error: error?.message || 'Scanner daemon ensure failed'
        })
      );
    return true;
  }

  if (request.action === SCANNER_DAEMON_ACTIONS.GET_STATUS) {
    readScannerStatus()
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) =>
        sendResponse({
          success: false,
          error: error?.message || 'Could not load scanner status'
        })
      );
    return true;
  }

  if (request.action === SCANNER_DAEMON_ACTIONS.ENABLE_AUTOSTART) {
    queueScannerControl(async () => {
      await requireRegularScannerControls();
      await setStorage({ [SCANNER_DAEMON_ENABLED_KEY]: true });
      return getScannerBootstrapState();
    })
      .then((bootstrap) =>
        sendResponse({ success: true, status: bootstrap.status })
      )
      .catch((error) =>
        sendResponse({
          success: false,
          error: error?.message || 'Could not enable scanner autostart'
        })
      );
    return true;
  }

  if (
    request.action === SCANNER_DAEMON_ACTIONS.CONNECT_GRANTED ||
    request.action === SCANNER_DAEMON_ACTIONS.SELECT
  ) {
    if (
      request.action === SCANNER_DAEMON_ACTIONS.SELECT &&
      !isScannerSetupPage(sender)
    ) {
      sendResponse({
        success: false,
        error: 'Open Scanner setup from Settings.'
      });
      return false;
    }
    queueScannerControl(() => connectConfiguredScanner(request)).then(
      sendResponse,
      (error) => sendResponse({ success: false, error: error.message })
    );
    return true;
  }

  if (
    request.action === SCANNER_DAEMON_ACTIONS.START_TEST ||
    request.action === SCANNER_DAEMON_ACTIONS.END_TEST
  ) {
    const tabId = sender.tab?.id;
    if (!isScannerSetupPage(sender) || !Number.isInteger(tabId)) {
      sendResponse({
        success: false,
        error: 'Open Scanner setup from Settings.'
      });
      return false;
    }
    queueScannerControl(() =>
      request.action === SCANNER_DAEMON_ACTIONS.START_TEST
        ? startScannerTest(tabId)
        : endScannerTest(tabId)
    ).then(sendResponse, (error) =>
      sendResponse({ success: false, error: error.message })
    );
    return true;
  }

  if (
    request.action === SCANNER_DAEMON_ACTIONS.DISCONNECT ||
    request.action === SCANNER_DAEMON_ACTIONS.FORGET
  ) {
    queueScannerControl(async () => {
      await requireRegularScannerControls();
      const forgetting = request.action === SCANNER_DAEMON_ACTIONS.FORGET;
      const { portInfo } = await getScannerBootstrapState();
      // An interrupted or failed close must not restart capture on startup.
      await setStorage({ [SCANNER_DAEMON_ENABLED_KEY]: false });
      const reply = await stopConfiguredScanner(request.action, portInfo);
      if (forgetting) {
        await scannerStatusWriteQueue.catch(() => undefined);
        await setStorage({
          [SCANNER_PROFILE_STORAGE_KEY]: '',
          [SCANNER_PORT_INFO_STORAGE_KEY]: null
        });
      }
      return reply;
    }).then(sendResponse, (error) =>
      sendResponse({ success: false, error: error.message })
    );
    return true;
  }

  if (request.action === 'refreshNVCBundle') {
    refreshNVCBundleFromUrl(request.sourceUrl || DEFAULT_NVC_SOURCE_URL, {
      trigger: 'manual'
    }).then(sendResponse);
    return true;
  }

  if (request.action === 'getNVCUpdateStatus') {
    getNVCUpdateStatus().then(sendResponse);
    return true;
  }

  if (request.action === 'checkNVCBundleUpdates') {
    maybeAutoRefreshNVCBundle('manual_check').then(sendResponse);
    return true;
  }

  if (request.action === 'lookupVaccineInfo') {
    lookupVaccineInfo(request.lot, {
      gtin: request.gtin,
      waitForDownload: request.waitForDownload !== false
    })
      .catch(() => nvcFailure('unavailable'))
      .then(sendResponse);

    return true;
  }

  if (request.action === 'logAnalyticsEvent') {
    logAnalyticsEvent(request.eventType, request.payload || {})
      .then(() => sendResponse({ success: true }))
      .catch((error) =>
        sendResponse({
          success: false,
          error: error?.message || 'Analytics log failed'
        })
      );
    return true;
  }

  if (
    ['mutateQueue', 'appendQueueRecord'].includes(request.action) &&
    !canChangeQueue(sender)
  ) {
    sendResponse({
      success: false,
      error: 'Queue changes require the popup or a supported chart'
    });
    return false;
  }

  if (request.action === 'mutateQueue') {
    const popup = sender.url === chrome.runtime.getURL('popup.html');
    if (
      ['setDoseCount', 'setDosePinned'].includes(request.operation) &&
      !popup
    ) {
      sendResponse({
        success: false,
        error: 'Dose changes require the popup.'
      });
      return false;
    }
    if (DOSE_RESERVATION_OPERATIONS.includes(request.operation) && popup) {
      sendResponse({
        success: false,
        error: 'Dose reservations require a supported chart.'
      });
      return false;
    }
    const change = (inactiveDose) =>
      mutateQueue(
        request.storageKey,
        request.operation,
        request.payload,
        popup,
        popup ? null : sender,
        inactiveDose
      );
    const changed =
      request.operation === 'review_dose'
        ? findInactiveDoseDocument(request.storageKey, request.payload).then(
            change
          )
        : change();
    changed
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'appendQueueRecord') {
    const { storageKey, record } = request;
    if (
      ![MULTIPLE_INJECT_QUEUE_KEY, INVENTORY_BATCH_KEY].includes(storageKey) ||
      !record ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      'dose_reservations' in record ||
      typeof record.id !== 'string' ||
      !record.id.trim()
    ) {
      sendResponse({ success: false, error: 'Invalid queue append' });
      return false;
    }
    appendQueueRecord(storageKey, record)
      .then((record) => sendResponse({ success: true, record }))
      .catch((error) =>
        sendResponse({
          success: false,
          error: error?.message || 'Queue append failed'
        })
      );
    return true;
  }

  if (request.action === 'scannerScanCaptured') {
    if (
      sender.id !== chrome.runtime.id ||
      sender.url !== chrome.runtime.getURL(SCANNER_DAEMON_OFFSCREEN_PATH)
    ) {
      sendResponse({
        success: false,
        error: 'Capture requires the scanner host.'
      });
      return false;
    }
    routeScanToActiveSupportedTab(request.scan || null)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => {
        void recordCaptureWarning().catch(() => undefined);
        sendResponse({
          success: false,
          error: error?.message || 'Scan routing failed'
        });
      });
    return true;
  }

  if (request.action === 'acknowledgeScannerCaptureError') {
    if (
      sender.id !== chrome.runtime.id ||
      sender.url !== chrome.runtime.getURL('popup.html')
    ) {
      sendResponse({ success: false });
      return false;
    }
    acknowledgeCaptureWarning()
      .then(() =>
        sendResponse({ success: true, captureError: scannerCaptureWarning })
      )
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (
    request.action === 'getHeldScannerScans' ||
    request.action === 'discardHeldScannerScan'
  ) {
    if (
      sender.id !== chrome.runtime.id ||
      sender.url !== chrome.runtime.getURL('popup.html')
    ) {
      sendResponse({ success: false });
      return false;
    }
    const result =
      request.action === 'getHeldScannerScans'
        ? getHeldScannerScans().then((scans) => ({ success: true, scans }))
        : discardHeldScannerScan(request.scan).then(() => ({ success: true }));
    result
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'getAnalyticsSummary') {
    getAnalyticsSummary()
      .then((summary) => sendResponse({ success: true, summary }))
      .catch((error) =>
        sendResponse({
          success: false,
          error: error?.message || 'Analytics summary failed'
        })
      );
    return true;
  }

  if (request.action === 'getAnalyticsExport') {
    getAnalyticsExport(request.scope === 'today' ? 'today' : 'pilot')
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) =>
        sendResponse({
          success: false,
          error: error?.message || 'Analytics export failed'
        })
      );
    return true;
  }

  if (request.action === 'setAnalyticsDeviceLabel') {
    setAnalyticsDeviceLabel(request.label || '')
      .then((store) =>
        sendResponse({ success: true, summary: buildAnalyticsSummary(store) })
      )
      .catch((error) =>
        sendResponse({
          success: false,
          error: error?.message || 'Analytics label update failed'
        })
      );
    return true;
  }

  if (request.action === 'resetAnalyticsStore') {
    resetAnalyticsStore()
      .then((store) =>
        sendResponse({ success: true, summary: buildAnalyticsSummary(store) })
      )
      .catch((error) =>
        sendResponse({
          success: false,
          error: error?.message || 'Analytics reset failed'
        })
      );
    return true;
  }

  sendResponse({
    success: false,
    error: `Unknown background action: ${request?.action || 'missing'}`
  });
  return false;
});
