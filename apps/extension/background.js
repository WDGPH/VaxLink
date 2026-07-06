const VAXLINK_BG_DEBUG = false;
importScripts('shared/gs1-parser.js');

function bgLog(...args) {
  if (VAXLINK_BG_DEBUG) console.log('[VaxLink]', ...args);
}

let nvcBundle = null;
let nvcIndexes = {};
let bundleLoadPromise = null;
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
  'Y016312': '6951000087100',
  'Y020519': '6951000087100',
  // VAQTA (HA) adult — NVC lists this lot's pediatric tradename link before
  // the adult one, so the default first-match resolution picks pediatric.
  'Y018089': '6901000087101'
});
const STORAGE_KEYS = {
  bundle: 'nvc_bundle_override',
  sourceUrl: 'nvc_bundle_source_url',
  updatedAt: 'nvc_bundle_updated_at',
  lastCheckAt: 'nvc_bundle_last_check_at',
  bundleSha256: 'nvc_bundle_sha256',
  metaVersion: 'nvc_bundle_meta_version'
};
const ANALYTICS_STORAGE_KEY = 'vaxlink_analytics_v1';
const ANALYTICS_MAX_RECENT_EVENTS = 2000;
const ANALYTICS_TOP_LIMIT = 12;
let analyticsWriteQueue = Promise.resolve();
let iconInitPromise = null;
const WORKFLOW_MODE_KEY = 'vaxlink_workflow_mode_v1';
const LEGACY_POPUP_MODE_KEY = 'vaxlink_popup_mode_v1';
const LEGACY_HANDS_FREE_KEY = 'hands_free_scan_autofill_enabled';
const LEGACY_REMOTE_MODE_KEY = 'hands_free_scan_mode_v1';
const MULTIPLE_INJECT_QUEUE_KEY = 'multiple_inject_queue_v1';
const INVENTORY_BATCH_KEY = 'inventory_scan_batch_v1';
const PENDING_SCAN_INBOX_KEY = 'vaxlink_pending_scan_inbox_v1';
const PENDING_SCAN_INBOX_LIMIT = 25;
const BADGE_COLOR = '#0891b2';
const SCANNER_PROFILE_STORAGE_KEY = 'vaxlink_serial_scanner_profile_v1';
const SCANNER_PORT_INFO_STORAGE_KEY = 'vaxlink_serial_scanner_port_info_v1';
const SCANNER_DAEMON_ENABLED_KEY = 'vaxlink_scanner_daemon_enabled_v1';
const SCANNER_STATUS_SNAPSHOT_KEY = 'vaxlink_scanner_status_snapshot_v1';
const SCANNER_DAEMON_OFFSCREEN_PATH = 'scanner-daemon.html';
const SCANNER_DAEMON_TARGET = 'scannerDaemon';
const SCANNER_DAEMON_BACKGROUND_TARGET = 'scannerDaemonBackground';
const SCANNER_DAEMON_ACTIONS = Object.freeze({
  ENSURE: 'scannerDaemon.ensure',
  GET_STATUS: 'scannerDaemon.getStatus',
  CONNECT_GRANTED: 'scannerDaemon.connectGranted',
  DISCONNECT: 'scannerDaemon.disconnect',
  ENABLE_AUTOSTART: 'scannerDaemon.enableAutostart',
  STATUS_CHANGED: 'scannerDaemon.statusChanged',
  STATUS_UPDATE: 'scannerDaemon.statusUpdate'
});
const SCANNER_STATUS_STATES = Object.freeze({
  NEVER_CONFIGURED: 'never_configured',
  STARTING: 'starting',
  CONNECTED: 'connected',
  RECOVERING: 'recovering',
  WAITING_FOR_DEVICE: 'waiting_for_device',
  PERMISSION_LOST: 'permission_lost',
  BUSY: 'busy',
  ERROR: 'error',
  DISABLED: 'disabled'
});
const VALID_SCANNER_STATES = new Set(Object.values(SCANNER_STATUS_STATES));
let scannerDaemonCreatePromise = null;
let scannerDaemonStatusCache = createScannerStatusSnapshot();

// Load NVC bundle on installation/startup
chrome.runtime.onInstalled.addListener(() => {
  bgLog('Vaccine Scanner extension installed');
  ensureActionIcon();
  initializeNVCSync();
  void maybeStartScannerDaemon('install').catch((error) => {
    console.warn('Scanner daemon startup failed on install:', error);
  });
});

// Also load on startup
chrome.runtime.onStartup.addListener(() => {
  ensureActionIcon();
  initializeNVCSync();
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
bgLog('Service worker started, loading NVC bundle');
ensureActionIcon();
initializeNVCSync();
initQueueBadge();

// One-time cleanup: tear down any offscreen scanner daemon left over from the
// disabled daemon architecture. If it is still alive it can hold the serial
// COM port open and make in-page capture fail with "Failed to open serial port".
(async () => {
  try {
    if (
      chrome.offscreen &&
      typeof chrome.offscreen.closeDocument === 'function' &&
      await hasScannerDaemonDocument()
    ) {
      await chrome.offscreen.closeDocument();
      bgLog('Closed leftover offscreen scanner daemon document');
    }
  } catch (_) {
    // Best effort; nothing to clean up.
  }
})();

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

function updateQueueBadge(rows) {
  const count = Array.isArray(rows) ? rows.length : 0;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
}

function initQueueBadge() {
  chrome.storage.local.get([MULTIPLE_INJECT_QUEUE_KEY], (stored) => {
    updateQueueBadge(stored && stored[MULTIPLE_INJECT_QUEUE_KEY]);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (MULTIPLE_INJECT_QUEUE_KEY in changes) {
      updateQueueBadge(changes[MULTIPLE_INJECT_QUEUE_KEY].newValue);
    }
  });
}

function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function setStorage(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

function normalizeScannerIsoTimestamp(value) {
  if (!value) return '';
  const parsed = new Date(String(value).trim());
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function normalizeScannerPortInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const normalized = {};
  if (info.usbVendorId !== undefined && info.usbVendorId !== null && info.usbVendorId !== '') {
    const vendorId = Number(info.usbVendorId);
    if (Number.isFinite(vendorId)) normalized.usbVendorId = vendorId;
  }
  if (info.usbProductId !== undefined && info.usbProductId !== null && info.usbProductId !== '') {
    const productId = Number(info.usbProductId);
    if (Number.isFinite(productId)) normalized.usbProductId = productId;
  }
  if (info.bluetoothServiceClassId) {
    normalized.bluetoothServiceClassId = String(info.bluetoothServiceClassId);
  }
  return Object.keys(normalized).length ? normalized : null;
}

function createScannerStatusSnapshot(overrides = {}) {
  return normalizeScannerStatusSnapshot({
    state: SCANNER_STATUS_STATES.NEVER_CONFIGURED,
    profileId: '',
    portInfo: null,
    lastConnectedAt: '',
    lastDisconnectedAt: '',
    lastError: '',
    recoverAttemptCount: 0,
    ...overrides
  });
}

function normalizeScannerStatusSnapshot(snapshot) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return {
    state: VALID_SCANNER_STATES.has(source.state)
      ? source.state
      : SCANNER_STATUS_STATES.NEVER_CONFIGURED,
    profileId: String(source.profileId || '').trim(),
    portInfo: normalizeScannerPortInfo(source.portInfo),
    lastConnectedAt: normalizeScannerIsoTimestamp(source.lastConnectedAt),
    lastDisconnectedAt: normalizeScannerIsoTimestamp(source.lastDisconnectedAt),
    lastError: String(source.lastError || '').trim(),
    recoverAttemptCount: Math.max(0, Number.parseInt(source.recoverAttemptCount, 10) || 0)
  };
}

function buildDefaultScannerStatus({ enabled = false, profileId = '', portInfo = null } = {}) {
  const normalizedProfileId = String(profileId || '').trim();
  if (!normalizedProfileId) {
    return createScannerStatusSnapshot();
  }
  return createScannerStatusSnapshot({
    state: enabled ? SCANNER_STATUS_STATES.WAITING_FOR_DEVICE : SCANNER_STATUS_STATES.DISABLED,
    profileId: normalizedProfileId,
    portInfo: normalizeScannerPortInfo(portInfo)
  });
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
  const portInfo = normalizeScannerPortInfo(stored[SCANNER_PORT_INFO_STORAGE_KEY]);
  const status = stored[SCANNER_STATUS_SNAPSHOT_KEY]
    ? normalizeScannerStatusSnapshot(stored[SCANNER_STATUS_SNAPSHOT_KEY])
    : buildDefaultScannerStatus({ enabled, profileId, portInfo });
  scannerDaemonStatusCache = status;
  return { enabled, profileId, portInfo, status };
}

async function persistScannerStatusSnapshot(snapshot) {
  const normalized = normalizeScannerStatusSnapshot(snapshot);
  scannerDaemonStatusCache = normalized;
  const values = {
    [SCANNER_STATUS_SNAPSHOT_KEY]: normalized
  };
  if (normalized.profileId) {
    values[SCANNER_PROFILE_STORAGE_KEY] = normalized.profileId;
  }
  if (normalized.portInfo) {
    values[SCANNER_PORT_INFO_STORAGE_KEY] = normalized.portInfo;
  }
  await setStorage(values);
  return normalized;
}

async function broadcastScannerStatus(snapshot) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      action: SCANNER_DAEMON_ACTIONS.STATUS_CHANGED,
      status: snapshot
    }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
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

  if (typeof clients === 'undefined' || typeof clients.matchAll !== 'function') {
    return false;
  }
  const matchedClients = await clients.matchAll();
  return matchedClients.some((client) => client.url === offscreenUrl);
}

async function ensureScannerDaemon() {
  // The offscreen scanner daemon is permanently disabled: navigator.serial is
  // not available in offscreen documents, so it can never capture, and creating
  // it only risks grabbing/locking the COM port out from under the in-page
  // Web Serial capture (scanner-setup.js), which surfaces as
  // "Failed to open serial port". Never create the offscreen document.
  throw new Error('Offscreen scanner daemon is disabled; Web Serial is captured in-page.');

  // eslint-disable-next-line no-unreachable
  if (!chrome.offscreen || typeof chrome.offscreen.createDocument !== 'function') {
    throw new Error('The Offscreen API is not available in this browser context.');
  }

  if (await hasScannerDaemonDocument()) {
    return { created: false };
  }

  if (!scannerDaemonCreatePromise) {
    scannerDaemonCreatePromise = chrome.offscreen.createDocument({
      url: SCANNER_DAEMON_OFFSCREEN_PATH,
      reasons: ['WORKERS'],
      justification: 'Keep a previously granted scanner connection active without a visible tab.'
    }).finally(() => {
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

async function maybeStartScannerDaemon(trigger = 'startup') {
  // Web Serial (navigator.serial) is not available inside an offscreen
  // document, so the offscreen scanner daemon can never open the port. Serial
  // capture now happens in-page in scanner-setup.js, which routes scans via the
  // `scannerScanCaptured` message. We intentionally do NOT auto-start the
  // offscreen daemon: starting it only produces error-state noise and risks
  // contending for the COM port. Capture works through the visible setup page.
  const bootstrap = await getScannerBootstrapState();
  return { started: false, status: bootstrap.status };
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
  const lot = String(record.lot || '').trim().toUpperCase();
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

async function appendQueueRecord(storageKey, record) {
  if (!storageKey) {
    throw new Error('Missing queue storage key');
  }
  if (!record || typeof record !== 'object') {
    throw new Error('Missing queue record');
  }
  const stored = await getStorage([storageKey]);
  const rows = stored && Array.isArray(stored[storageKey]) ? stored[storageKey] : [];

  if (storageKey === MULTIPLE_INJECT_QUEUE_KEY) {
    const recordScannedAt = Date.parse(record.scanned_at);
    const nowMs = Number.isFinite(recordScannedAt) ? recordScannedAt : Date.now();
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

function isSupportedChartUrl(urlValue) {
  try {
    const url = new URL(String(urlValue || ''));
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    const isPanorama =
      (host === 'www.panorama.prod.ehealthontario.ca' ||
       host === 'panorama.prod.ehealthontario.ca') &&
      path.includes('/recordimms/');
    const isInputHealth = host === 'inputhealth.com' || host.endsWith('.inputhealth.com');
    return isPanorama || isInputHealth;
  } catch (_) {
    return false;
  }
}

function tabMayBeSupportedChart(tab) {
  if (!tab || tab.id === undefined) return false;
  if (!tab.url) return true;
  return isSupportedChartUrl(tab.url);
}

function tabAcceptedScannerScan(response) {
  return !!(
    response &&
    (response.accepted === true ||
      response.success === true ||
      response.pending === true ||
      response.queued === true ||
      response.duplicate_ignored === true ||
      response.command_handled === true)
  );
}

function sendScanToTab(tabId, scan) {
  return new Promise((resolve, reject) => {
    if (!tabId && tabId !== 0) {
      reject(new Error('Missing tab id'));
      return;
    }
    chrome.tabs.sendMessage(tabId, { action: 'vaxlinkScanCaptured', scan }, { frameId: 0 }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!tabAcceptedScannerScan(response)) {
        reject(new Error(response?.error || 'Tab did not accept scan'));
        return;
      }
      resolve(response);
    });
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

function parseDateToLocal(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return new Date(Number(mdy[3]), Number(mdy[1]) - 1, Number(mdy[2]));

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function getExpiryStatus(value) {
  const expiry = parseDateToLocal(value);
  if (!expiry) {
    return { flag: 'unknown', daysRemaining: null };
  }

  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const daysRemaining = Math.floor((expiry.getTime() - todayMidnight.getTime()) / (24 * 60 * 60 * 1000));
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
  parsed.name = vaccineInfo.generic_name || vaccineInfo.tradename || vaccineInfo.din;

  if (!parsed.lot && vaccineInfo.lot_number) {
    parsed.lot = vaccineInfo.lot_number;
  }
  if (!parsed.expiry && vaccineInfo.lot_expiry) {
    parsed.expiry = vaccineInfo.lot_expiry || parsed.expiry;
  }
}

function buildQueueRecordFromParsed(data, rawBarcode) {
  const totalDoses = getPositiveInt(data.total_doses, null);
  const fallbackDose = getPositiveInt(totalDoses, null);
  const inventoryExpiry = data.inventory_expiry || data.expiry || data.nvc_lot_expiry || '';
  const expiryStatus = getExpiryStatus(inventoryExpiry);
  const expirySource = data.expiry
    ? 'barcode'
    : (data.nvc_lot_expiry ? 'nvc' : (data.expiry_source || 'none'));

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
    barcode_expiry: data.expiry || '',
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
    lookup_error: data.lookup_error || ''
  };
}

async function saveScannerScanToWorkflowQueue(scan, mode) {
  const storageKey = getQueueStorageKeyForWorkflow(mode);
  if (!storageKey) return null;

  const parser = globalThis.VaxLinkGS1Parser;
  if (!parser || typeof parser.parseGS1Barcode !== 'function') {
    throw new Error('VaxLink GS1 parser is not loaded');
  }

  const parsed = parser.parseGS1Barcode(scan.rawText);
  parsed.scanned_at = scan.capturedAt || new Date().toISOString();

  await Promise.resolve(bundleLoadPromise || loadNVCBundle());
  if (parsed.lot) {
    const vaccineInfo = lookupVaccineLot(parsed.lot, { gtin: parsed.gtin });
    if (vaccineInfo) {
      mergeVaccineInfoIntoParsed(parsed, vaccineInfo);
    } else {
      parsed.lookup_error = 'Vaccine not found in NVC database';
    }
  }

  const record = await appendQueueRecord(storageKey, buildQueueRecordFromParsed(parsed, scan.rawText));
  const expiryFlag = record.expiry_flag || getExpiryStatus(parsed.expiry || parsed.nvc_lot_expiry).flag;
  await logAnalyticsEvent('scan_captured', {
    workflow: mode,
    source: scan.source || 'web-serial',
    vaccineLabel: record.tradename || record.generic_name || record.name || record.lot || record.gtin || '',
    manufacturer: record.manufacturer || '',
    expiryFlag
  });
  await logAnalyticsEvent('queue_saved', {
    workflow: mode,
    queue: mode === 'inventory' ? 'inventory' : 'multiple',
    source: scan.source || 'web-serial',
    count: 1,
    queueSizeAfter: record.queueSizeAfter || 0,
    vaccineLabel: record.tradename || record.generic_name || record.name || record.lot || '',
    manufacturer: record.manufacturer || '',
    expiryFlag
  });

  return {
    queuedToWorkflow: true,
    workflow: mode,
    storageKey,
    record
  };
}

async function enqueuePendingScan(scan) {
  const stored = await getStorage([PENDING_SCAN_INBOX_KEY]);
  const rows = Array.isArray(stored && stored[PENDING_SCAN_INBOX_KEY])
    ? stored[PENDING_SCAN_INBOX_KEY]
    : [];
  rows.push(scan);
  const nextRows = rows.slice(-PENDING_SCAN_INBOX_LIMIT);
  await setStorage({ [PENDING_SCAN_INBOX_KEY]: nextRows });
  return nextRows.length;
}

async function drainPendingScansToTab(tabId) {
  const stored = await getStorage([PENDING_SCAN_INBOX_KEY]);
  const rows = Array.isArray(stored && stored[PENDING_SCAN_INBOX_KEY])
    ? stored[PENDING_SCAN_INBOX_KEY]
    : [];
  if (!rows.length) {
    return { drained: 0, remaining: 0 };
  }

  const remaining = [];
  let drained = 0;
  for (const row of rows) {
    try {
      await sendScanToTab(tabId, normalizeScanEvent(row));
      drained += 1;
    } catch (_) {
      remaining.push(row);
    }
  }

  await setStorage({ [PENDING_SCAN_INBOX_KEY]: remaining });
  return { drained, remaining: remaining.length };
}

async function routeScanToActiveSupportedTab(rawScan) {
  const scan = normalizeScanEvent(rawScan);
  const storedWorkflow = await getStorage([
    WORKFLOW_MODE_KEY,
    LEGACY_POPUP_MODE_KEY,
    LEGACY_REMOTE_MODE_KEY,
    LEGACY_HANDS_FREE_KEY
  ]);
  const workflowMode = normalizeWorkflowMode(storedWorkflow);
  const tried = new Set();
  const activeTabs = await queryTabs({ active: true, currentWindow: true });
  const allTabs = await queryTabs({});
  const candidates = [...activeTabs, ...allTabs].filter(tabMayBeSupportedChart);

  for (const tab of candidates) {
    if (!tab || tab.id === undefined || tried.has(tab.id)) continue;
    tried.add(tab.id);
    try {
      const response = await sendScanToTab(tab.id, scan);
      return {
        routed: true,
        queued: false,
        tabId: tab.id,
        response
      };
    } catch (_) {
      // Try the next tab; unsupported pages simply do not have the content script.
    }
  }

  const workflowQueueResult = await saveScannerScanToWorkflowQueue(scan, workflowMode).catch((error) => ({
    queuedToWorkflow: false,
    workflow: workflowMode,
    error: error?.message || 'Workflow queue save failed'
  }));
  if (workflowQueueResult && workflowQueueResult.queuedToWorkflow) {
    return {
      routed: false,
      queued: true,
      queuedToWorkflow: true,
      workflow: workflowQueueResult.workflow,
      storageKey: workflowQueueResult.storageKey,
      queueSizeAfter: workflowQueueResult.record?.queueSizeAfter || 0
    };
  }

  const pendingCount = await enqueuePendingScan(scan);
  return {
    routed: false,
    queued: true,
    queuedToWorkflow: false,
    workflow: workflowMode,
    pendingCount,
    queueError: workflowQueueResult?.error || ''
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
    parsing: { success: 0, error: 0 },
    lookup: { success: 0, error: 0 },
    autofill: { attempts: 0, success: 0, failure: 0, fromQueueSuccess: 0 },
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
    expiry: { expired: 0, expiringSoon: 0, valid: 0, unknown: 0 },
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
    days: {},
    recentEvents: []
  };
}

async function getAnalyticsStore() {
  const stored = await getStorage([ANALYTICS_STORAGE_KEY]);
  const existing = stored[ANALYTICS_STORAGE_KEY];
  if (!existing || typeof existing !== 'object') {
    const created = createAnalyticsStore();
    await setStorage({ [ANALYTICS_STORAGE_KEY]: created });
    return created;
  }
  if (!existing.deviceId) {
    existing.deviceId = buildAnalyticsId();
  }
  if (!existing.firstSeenAt) {
    existing.firstSeenAt = new Date().toISOString();
  }
  if (!existing.days || typeof existing.days !== 'object') {
    existing.days = {};
  }
  if (!Array.isArray(existing.recentEvents)) {
    existing.recentEvents = [];
  }
  if (typeof existing.deviceLabel !== 'string') {
    existing.deviceLabel = '';
  }
  return existing;
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
  return String(value || '').trim().slice(0, maxLength);
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

function appendRecentAnalyticsEvent(store, event) {
  store.recentEvents.push(event);
  if (store.recentEvents.length > ANALYTICS_MAX_RECENT_EVENTS) {
    store.recentEvents = store.recentEvents.slice(-ANALYTICS_MAX_RECENT_EVENTS);
  }
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
    day.expiry[normalizeExpiryKey(event.expiryFlag)] += count;
  }

  switch (event.eventType) {
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
        day.queues.maxMultipleDepth = Math.max(day.queues.maxMultipleDepth, Number(event.queueSizeAfter) || 0);
      } else {
        day.queues.inventorySaved += count;
        day.queues.maxInventoryDepth = Math.max(day.queues.maxInventoryDepth, Number(event.queueSizeAfter) || 0);
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
    case 'autofill_result':
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
    id: buildAnalyticsId(),
    ts,
    day: analyticsDayKey(ts),
    eventType,
    workflow: normalizeWorkflowKey(payload.workflow),
    queue: payload.queue ? normalizeQueueKey(payload.queue) : '',
    source: trimAnalyticsLabel(payload.source, 40),
    success: !!payload.success,
    count: safeAnalyticsCount(payload.count, 1),
    rows: safeAnalyticsCount(payload.rows, 0),
    queueSizeAfter: safeAnalyticsCount(payload.queueSizeAfter, 0),
    expiryFlag: payload.expiryFlag || '',
    vaccineLabel: trimAnalyticsLabel(payload.vaccineLabel, 60),
    manufacturer: trimAnalyticsLabel(payload.manufacturer, 60),
    trigger: payload.trigger || '',
    note: trimAnalyticsLabel(payload.note, 120)
  };
}

function mutateAnalyticsStore(mutator) {
  analyticsWriteQueue = analyticsWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const store = await getAnalyticsStore();
      await mutator(store);
      await setStorage({ [ANALYTICS_STORAGE_KEY]: store });
      return store;
    });
  return analyticsWriteQueue;
}

async function logAnalyticsEvent(eventType, payload = {}) {
  return mutateAnalyticsStore((store) => {
    const event = makeAnalyticsEvent(eventType, payload);
    const day = ensureAnalyticsDay(store, event.day);
    applyAnalyticsEvent(day, event);
    appendRecentAnalyticsEvent(store, event);
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
    ['success', 'error'].forEach((key) => {
      rollup.parsing[key] += day.parsing?.[key] || 0;
      rollup.lookup[key] += day.lookup?.[key] || 0;
    });
    ['attempts', 'success', 'failure', 'fromQueueSuccess'].forEach((key) => {
      rollup.autofill[key] += day.autofill?.[key] || 0;
    });
    ['multipleSaved', 'multipleUsed', 'multipleCleared', 'inventorySaved', 'inventoryCleared'].forEach((key) => {
      rollup.queues[key] += day.queues?.[key] || 0;
    });
    rollup.queues.maxMultipleDepth = Math.max(rollup.queues.maxMultipleDepth, day.queues?.maxMultipleDepth || 0);
    rollup.queues.maxInventoryDepth = Math.max(rollup.queues.maxInventoryDepth, day.queues?.maxInventoryDepth || 0);
    ['inventoryCount', 'inventoryRows'].forEach((key) => {
      rollup.exports[key] += day.exports?.[key] || 0;
    });
    ['manualSuccess', 'manualFailure', 'autoSuccess', 'autoFailure'].forEach((key) => {
      rollup.nvc[key] += day.nvc?.[key] || 0;
    });
    ['expired', 'expiringSoon', 'valid', 'unknown'].forEach((key) => {
      rollup.expiry[key] += day.expiry?.[key] || 0;
    });
    sumObjectCounters(rollup.sources, day.sources);
    sumObjectCounters(rollup.vaccines, day.vaccines);
    sumObjectCounters(rollup.manufacturers, day.manufacturers);
  }
  return rollup;
}

async function getAnalyticsSummary() {
  const store = await getAnalyticsStore();
  const dayKeys = Object.keys(store.days).sort();
  const todayKey = analyticsDayKey();
  const today = store.days[todayKey] || createAnalyticsDay(todayKey);
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
  const store = await getAnalyticsStore();
  const dayKeys = Object.keys(store.days).sort();
  const todayKey = analyticsDayKey();
  const selectedKeys = scope === 'today'
    ? dayKeys.filter((key) => key === todayKey)
    : dayKeys;
  const selectedDays = Object.fromEntries(selectedKeys.map((key) => [key, store.days[key]]));
  return {
    exportedAt: new Date().toISOString(),
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
  return mutateAnalyticsStore((store) => {
    store.deviceLabel = trimAnalyticsLabel(label, 80);
  });
}

async function markAnalyticsExported() {
  return mutateAnalyticsStore((store) => {
    store.lastExportAt = new Date().toISOString();
  });
}

async function resetAnalyticsStore() {
  const fresh = createAnalyticsStore();
  await setStorage({ [ANALYTICS_STORAGE_KEY]: fresh });
  return fresh;
}

function normalizeSourceUrl(url) {
  const value = String(url || '').trim();
  if (!value) return DEFAULT_NVC_SOURCE_URL;
  const lower = value.toLowerCase();
  if (lower.includes('localhost') || lower.includes('127.0.0.1')) {
    return DEFAULT_NVC_SOURCE_URL;
  }
  return value;
}

async function sha256Hex(text) {
  const encoded = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function setupAutoSyncAlarm() {
  chrome.alarms.create(AUTO_SYNC_ALARM_NAME, { periodInMinutes: AUTO_SYNC_INTERVAL_MINUTES });
}

async function ensureDefaultSourceUrl() {
  const stored = await getStorage([STORAGE_KEYS.sourceUrl]);
  const normalized = normalizeSourceUrl(stored[STORAGE_KEYS.sourceUrl]);
  if (stored[STORAGE_KEYS.sourceUrl] !== normalized) {
    await setStorage({ [STORAGE_KEYS.sourceUrl]: normalized });
  }
}

async function initializeNVCSync() {
  setupAutoSyncAlarm();
  await ensureDefaultSourceUrl();
  await loadNVCBundle();
  maybeAutoRefreshNVCBundle('startup');
}

function validateBundleShape(data) {
  return !!(data && typeof data === 'object' && Array.isArray(data.entry));
}

function applyBundleData(data, source) {
  if (!validateBundleShape(data)) {
    throw new Error('Bundle JSON is invalid: expected object with entry[]');
  }
  nvcBundle = data;
  buildNVCIndexes();
  bgLog('NVC bundle applied from source:', source);
}

function loadNVCBundle(forceReload = false) {
  if (bundleLoadPromise && !forceReload) {
    return bundleLoadPromise;
  }

  bundleLoadPromise = getStorage([STORAGE_KEYS.bundle, STORAGE_KEYS.sourceUrl])
    .then((stored) => {
      if (stored[STORAGE_KEYS.bundle]) {
        applyBundleData(stored[STORAGE_KEYS.bundle], stored[STORAGE_KEYS.sourceUrl] || 'storage');
        return true;
      }
      // No packaged bundle is shipped (raw NVC bundles are never committed);
      // first-run lookups stay unavailable until the remote sync in
      // maybeAutoRefreshNVCBundle populates storage.
      bgLog('No cached NVC bundle yet; waiting for remote sync');
      return false;
    })
    .catch(error => {
      console.error('Failed to load NVC bundle:', error);
      return false;
    });

  return bundleLoadPromise;
}

async function fetchJsonWithHeaders(url) {
  const response = await fetch(url, { cache: 'no-store', headers: NVC_FETCH_HEADERS });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function refreshNVCBundleFromUrl(sourceUrl, options = {}) {
  const effectiveSourceUrl = normalizeSourceUrl(sourceUrl || DEFAULT_NVC_SOURCE_URL);
  if (!effectiveSourceUrl) {
    return { success: false, error: 'No valid NVC source URL available' };
  }

  const force = !!options.force;
  const trigger = options.trigger === 'manual' ? 'manual' : 'auto';
  try {
    const nowIso = new Date().toISOString();
    const stored = await getStorage([STORAGE_KEYS.bundleSha256, STORAGE_KEYS.updatedAt]);
    const previousHash = stored[STORAGE_KEYS.bundleSha256];

    const firstPayload = await fetchJsonWithHeaders(effectiveSourceUrl);
    let metadata = null;
    let bundle = null;
    let bundleUrl = effectiveSourceUrl;

    if (validateBundleShape(firstPayload)) {
      bundle = firstPayload;
    } else if (firstPayload && typeof firstPayload === 'object' && firstPayload.bundleUrl) {
      metadata = firstPayload;
      bundleUrl = String(metadata.bundleUrl).trim();
      if (!bundleUrl) {
        throw new Error('Metadata is missing a valid bundleUrl');
      }

      if (!force && metadata.sha256 && previousHash && String(metadata.sha256).toLowerCase() === String(previousHash).toLowerCase()) {
        await setStorage({ [STORAGE_KEYS.lastCheckAt]: nowIso });
        const result = {
          success: true,
          unchanged: true,
          sourceUrl: effectiveSourceUrl,
          updatedAt: stored[STORAGE_KEYS.updatedAt] || metadata.updatedAt || nowIso
        };
        await logAnalyticsEvent('nvc_refresh_result', { trigger, success: true, note: 'unchanged' });
        return result;
      }

      bundle = await fetchJsonWithHeaders(bundleUrl);
    } else {
      throw new Error('Expected either an NVC bundle or metadata with bundleUrl');
    }

    if (!validateBundleShape(bundle)) {
      throw new Error('Bundle JSON is invalid: expected object with entry[]');
    }

    const bundleText = JSON.stringify(bundle);
    const computedSha256 = await sha256Hex(bundleText);
    if (metadata && metadata.sha256 && String(metadata.sha256).toLowerCase() !== computedSha256.toLowerCase()) {
      throw new Error('Bundle checksum verification failed');
    }

    applyBundleData(bundle, bundleUrl);
    const updatedAt = (metadata && metadata.updatedAt) ? metadata.updatedAt : nowIso;
    await setStorage({
      [STORAGE_KEYS.bundle]: bundle,
      [STORAGE_KEYS.sourceUrl]: effectiveSourceUrl,
      [STORAGE_KEYS.bundleSha256]: computedSha256,
      [STORAGE_KEYS.lastCheckAt]: nowIso,
      [STORAGE_KEYS.metaVersion]: metadata ? (metadata.version || null) : null,
      [STORAGE_KEYS.updatedAt]: updatedAt
    });

    const result = {
      success: true,
      sourceUrl: effectiveSourceUrl,
      bundleUrl,
      updatedAt,
      checkedAt: nowIso,
      entryCount: bundle.entry.length,
      sha256: computedSha256,
      version: metadata ? (metadata.version || null) : null
    };
    await logAnalyticsEvent('nvc_refresh_result', { trigger, success: true });
    return result;
  } catch (error) {
    console.error('Failed to refresh NVC bundle:', error);
    await logAnalyticsEvent('nvc_refresh_result', { trigger, success: false, note: error.message });
    return { success: false, error: error.message };
  }
}

async function maybeAutoRefreshNVCBundle(trigger) {
  try {
    const stored = await getStorage([STORAGE_KEYS.sourceUrl, STORAGE_KEYS.lastCheckAt]);
    const sourceUrl = normalizeSourceUrl(stored[STORAGE_KEYS.sourceUrl]);
    const lastCheckAt = stored[STORAGE_KEYS.lastCheckAt];
    const now = Date.now();
    const last = lastCheckAt ? Date.parse(lastCheckAt) : 0;
    const intervalMs = AUTO_SYNC_INTERVAL_MINUTES * 60 * 1000;

    if (last && (now - last) < intervalMs) {
      return { success: true, skipped: true, reason: 'interval_not_elapsed' };
    }

    const result = await refreshNVCBundleFromUrl(sourceUrl, { force: false, trigger });
    if (!result.success) {
      console.warn('Auto NVC refresh failed; using existing bundle:', result.error);
    }
    return result;
  } catch (error) {
    console.error('Auto refresh process failed:', error);
    return { success: false, error: error.message };
  }
}

async function getNVCUpdateStatus() {
  const stored = await getStorage([
    STORAGE_KEYS.sourceUrl,
    STORAGE_KEYS.updatedAt,
    STORAGE_KEYS.lastCheckAt,
    STORAGE_KEYS.bundleSha256,
    STORAGE_KEYS.metaVersion
  ]);

  return {
    sourceUrl: normalizeSourceUrl(stored[STORAGE_KEYS.sourceUrl]),
    updatedAt: stored[STORAGE_KEYS.updatedAt] || null,
    lastCheckAt: stored[STORAGE_KEYS.lastCheckAt] || null,
    sha256: stored[STORAGE_KEYS.bundleSha256] || null,
    version: stored[STORAGE_KEYS.metaVersion] || null,
    autoSyncIntervalMinutes: AUTO_SYNC_INTERVAL_MINUTES
  };
}

function buildNVCIndexes() {
  bgLog('buildNVCIndexes called');
  if (!nvcBundle || !nvcBundle.entry) {
    console.error('nvcBundle not loaded or no entries');
    return;
  }
  
  bgLog('nvcBundle has', nvcBundle.entry.length, 'entries');
  
  const tradenames = collectTradenameConceptsFromBundle();
  const lots = collectLotConceptsFromBundle();
  const lotAgentRows = collectLotAgentMappingRowsFromBundle();
  
  bgLog('Collected', tradenames.length, 'tradename concepts');
  bgLog('Collected', lots.length, 'lot concepts');
  bgLog('Collected', lotAgentRows.length, 'lot-agent mapping rows');
  
  // Index tradenames by code and by DIN
  const tradenameByCode = {};
  const tradenameByDin = {};
  const tradenameByName = {};
  
  for (const concept of tradenames) {
    const codeKey = normalizeCodeKey(concept.code);
    if (codeKey) {
      const existingByCode = tradenameByCode[codeKey];
      if (!existingByCode || conceptRichness(concept) >= conceptRichness(existingByCode)) {
        tradenameByCode[codeKey] = concept;
      }
    }
    const din = extractTradenameDIN(concept);
    const dinKey = normalizeDinKey(din);
    if (dinKey) {
      const existingByDin = tradenameByDin[dinKey];
      if (!existingByDin || conceptRichness(concept) >= conceptRichness(existingByDin)) {
        tradenameByDin[dinKey] = concept;
      }
    }
    indexTradenameNames(tradenameByName, concept);
  }
  
  bgLog('Indexed', Object.keys(tradenameByCode).length, 'tradenames by code');
  bgLog('Indexed', Object.keys(tradenameByDin).length, 'tradenames by DIN');
  bgLog('Indexed', Object.keys(tradenameByName).length, 'tradenames by name');
  
  // Index lots by lot number and by code
  const lotByLotNumber = {};
  const lotByCode = {};
  const lotByCodePrefix = {};
  
  for (const concept of lots) {
    const code = concept.code;
    if (code) {
      const codeKey = code.toLowerCase();
      lotByCode[codeKey] = concept;
      const underscoreIdx = codeKey.indexOf('_');
      const prefix = underscoreIdx > 0 ? codeKey.substring(0, underscoreIdx) : codeKey;
      if (prefix && !lotByCodePrefix[prefix]) {
        lotByCodePrefix[prefix] = concept;
      }
    }
    const lotNumber = extractLotNumber(concept);
    if (lotNumber) {
      lotByLotNumber[lotNumber.toLowerCase()] = concept;
    }
  }
  
  bgLog('Indexed', Object.keys(lotByLotNumber).length, 'lots by lot number');
  bgLog('Indexed', Object.keys(lotByCode).length, 'lots by code');
  const lotAgentMappingByLot = buildLotAgentMappingIndex(lotAgentRows);
  bgLog('Indexed', Object.keys(lotAgentMappingByLot).length, 'lot-agent mappings by lot key');
  
  nvcIndexes = {
    tradenameByCode,
    tradenameByDin,
    tradenameByName,
    tradenameConceptsArray: tradenames,
    lotByLotNumber,
    lotByCode,
    lotByCodePrefix,
    lotAgentMappingByLot
  };
  
  bgLog('NVC Indexes built successfully');
}

function collectTradenameConceptsFromBundle() {
  const concepts = [];
  if (!nvcBundle.entry) return concepts;
  
  for (const entry of nvcBundle.entry) {
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

function collectLotConceptsFromBundle() {
  const concepts = [];
  if (!nvcBundle.entry) return concepts;
  
  for (const entry of nvcBundle.entry) {
    const resource = entry.resource;
    if (resource.resourceType === 'CodeSystem' && resource.id === 'nvc-vaccine-lot-id') {
      concepts.push(...(resource.concept || []));
    }
  }
  return concepts;
}

function collectLotAgentMappingRowsFromBundle() {
  const rows = [];
  if (!nvcBundle.entry) return rows;

  for (const entry of nvcBundle.entry) {
    const resource = entry.resource;
    if (!resource || !resource.resourceType) continue;
    const identity = normalizeCodeKey([
      resource.id,
      resource.name,
      resource.title,
      resource.url
    ].filter(Boolean).join(' '));
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
  if (prop.valueCoding) return prop.valueCoding.display || prop.valueCoding.code || '';
  if (prop.valueCodeableConcept) return extractCodeableConceptDisplay(prop.valueCodeableConcept) || '';
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

    if ((key.includes('source') || key.includes('lot')) && key.includes('lot')) {
      addLotKey(value);
    }

    if (key.includes('target') && key.includes('tradename')) mapped.tradename = value;
    else if (key.includes('tradename') && !mapped.tradename) mapped.tradename = value;
    else if (key.includes('generic')) mapped.generic_name = value;
    else if (key.includes('disease')) mapped.disease = value;
    else if (key.includes('antigen')) mapped.antigen = value;
    else if (key.includes('manufacturer')) mapped.manufacturer = value;
    else if (key.includes('route')) mapped.route = value;
    else if (key.includes('strength')) mapped.strength = value;
    else if (key.includes('dose') && (key.includes('unit') || key.includes('uom'))) mapped.dose_unit = value;
    else if (key.includes('dose')) mapped.dose_value = value;
    else if (key === 'din' || key.includes('drugidentificationnumber')) mapped.din = value;
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
      if (prop.valueCodeableConcept) return extractCodeableConceptDisplay(prop.valueCodeableConcept);
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
    if (ext.url === 'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-linked-to-market-authorization-holder') {
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
    if (!url.includes('linked-tradename-concept') && !url.endsWith('/tradename')) {
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
    if (code !== 'tradename' && code !== 'trade name' && code !== 'tradenamecode') {
      continue;
    }
    const coding = prop.valueCoding || prop.valueCodeableConcept?.coding?.[0] || null;
    refs.push({
      code: coding?.code || '',
      display: coding?.display || prop.valueCodeableConcept?.text || '',
      raw: prop.valueString || ''
    });
  }

  const seen = new Set();
  return refs.filter((ref) => {
    const key = [normalizeCodeKey(ref.code), normalizeNameKey(ref.display), normalizeNameKey(ref.raw)].join('|');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractLotTradenameCode(concept) {
  const refs = getLotTradenameReferences(concept);
  const first = refs[0];
  return first ? (first.code || first.display || first.raw || null) : null;
}

function extractTradenameDIN(concept) {
  for (const ext of concept.extension || []) {
    if (ext.url === 'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-din') {
      const cc = ext.valueCodeableConcept;
      if (cc && cc.coding && cc.coding[0]) {
        return cc.coding[0].code || cc.coding[0].display;
      }
    }
  }
  for (const prop of concept.property || []) {
    const code = normalizeCodeKey(prop.code);
    if (code === 'drugidentificationnumber' || code === 'din') {
      if (prop.valueCoding) return prop.valueCoding.code || prop.valueCoding.display || null;
      if (prop.valueString) return prop.valueString;
      if (prop.valueCodeableConcept) return extractCodeableConceptDisplay(prop.valueCodeableConcept);
    }
  }
  return null;
}

function normalizeCodeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function conceptRichness(concept) {
  if (!concept || typeof concept !== 'object') return 0;
  const extCount = Array.isArray(concept.extension) ? concept.extension.length : 0;
  const propCount = Array.isArray(concept.property) ? concept.property.length : 0;
  const desigCount = Array.isArray(concept.designation) ? concept.designation.length : 0;
  const hasDisplay = concept.display ? 1 : 0;
  return (extCount * 4) + (propCount * 3) + (desigCount * 2) + hasDisplay;
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
  const keys = ['tradename', 'generic_name', 'disease', 'antigen', 'manufacturer', 'route', 'strength', 'dose_value', 'dose_unit'];
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
    if (ext.url === 'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-linked-generic-concept') {
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
    if (ext.url === 'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-protects-against-disease') {
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
    if (ext.url === 'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-contains-antigen') {
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
    if (ext.url === 'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-linked-to-market-authorization-holder') {
      return extractCodeableConceptDisplay(ext.valueCodeableConcept);
    }
  }
  return null;
}

function extractTradenameRoute(concept) {
  for (const ext of concept.extension || []) {
    if (ext.url === 'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-route-of-admin') {
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
  const match = display.match(/(\d+(?:\.\d+)?)\s*(?:microgram|micrograms|mcg)\b/i);
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
    if (ext.url === 'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-typical-dose-size') {
      return ext.valueString || null;
    }
  }
  return null;
}

function extractTradenameDoseUnit(concept) {
  for (const ext of concept.extension || []) {
    if (ext.url === 'https://nvc-cnv.canada.ca/fhir/v2/StructureDefinition/nvc-typical-dose-size-uom') {
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
    let concept = nvcIndexes.lotByLotNumber[lotKey];
    
    // If not found, try direct code then prefix map (O(1)).
    // Skip code/prefix for all-numeric keys (GTIN mistaken for lot -> wrong hit).
    if (!concept && !looksLikeGtinOrNumericId(lotKey)) {
      concept = nvcIndexes.lotByCode[lotKey] || nvcIndexes.lotByCodePrefix[lotKey];
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
      nvcIndexes.lotAgentMappingByLot?.[lotMapKey] ||
      nvcIndexes.lotAgentMappingByLot?.[lotCodeMapKey] ||
      null;
    if (lotAgentMappedInfo) {
      bgLog('Lot-agent mapping matched:', { lotMapKey, lotCodeMapKey, lotAgentMappedInfo });
      mergeDefinedVaccineFields(vaccineInfo, lotAgentMappedInfo);
      if (!vaccineInfo.din && lotAgentMappedInfo.din) {
        vaccineInfo.din = lotAgentMappedInfo.din;
      }
    }

    mergeDefinedVaccineFields(vaccineInfo, extractLotDirectVaccineInfo(concept));
    
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
      const info = lookupTradenameByCode(ref.code);
      if (info) {
        byCodeCandidates.push({ ref, info });
      }
    }

    if (effectiveOverrideCode && byCodeCandidates.length > 0) {
      const overrideMatch = byCodeCandidates.find(({ ref }) => normalizeCodeKey(ref.code) === effectiveOverrideCode);
      if (overrideMatch) {
        resolvedTradename = overrideMatch.info;
        const overrideSource = gtinOverrideCode ? `GTIN ${options.gtin}` : `lot ${lotNumber}`;
        bgLog('Tradename resolved from override (', overrideSource, '):', overrideMatch.ref.code);
        vaccineInfo.nvc_override = gtinOverrideCode ? 'gtin' : 'lot';
      }
    }

    if (!resolvedTradename && byCodeCandidates.length > 0) {
      resolvedTradename = byCodeCandidates[0].info;
      bgLog('Tradename resolved from first code reference:', byCodeCandidates[0].ref.code);
    }

    if (!resolvedTradename) {
      for (const ref of tradenameRefs) {
        const label = ref.display || ref.raw || '';
        if (!label) continue;
        resolvedTradename = lookupTradenameByName(label);
        if (resolvedTradename) {
          bgLog('Tradename resolved from name reference:', label);
          break;
        }
      }
    }

    if (resolvedTradename) {
      mergeDefinedVaccineFields(vaccineInfo, resolvedTradename);
    } else if (vaccineInfo.din) {
      const tradenameInfo = lookupTradenameByDIN(vaccineInfo.din);
      bgLog('Tradename info from DIN:', tradenameInfo);
      if (tradenameInfo) {
        mergeDefinedVaccineFields(vaccineInfo, tradenameInfo);
      }
    }
    
    bgLog('Final vaccine info:', vaccineInfo);
    return vaccineInfo;
  } catch (e) {
    console.error('Error looking up vaccine lot:', e);
    return null;
  }
}

function lookupTradenameByCode(code) {
  const codeKey = normalizeCodeKey(code);
  const concept = nvcIndexes.tradenameByCode[codeKey];
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

function lookupTradenameByName(name) {
  const nameKey = normalizeNameKey(name);
  const concept = nvcIndexes.tradenameByName[nameKey];
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

function lookupTradenameByDIN(din) {
  const dinKey = normalizeDinKey(din);
  const concept = nvcIndexes.tradenameByDin[dinKey];
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

// Listen for requests from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  bgLog('Background received message:', request);
  if (request?.target === SCANNER_DAEMON_TARGET) {
    return false;
  }
  if (request?.action === SCANNER_DAEMON_ACTIONS.STATUS_CHANGED || request?.action === 'scannerDaemon.scanEcho') {
    return false;
  }

  if (request?.target === SCANNER_DAEMON_BACKGROUND_TARGET && request.action === SCANNER_DAEMON_ACTIONS.STATUS_UPDATE) {
    persistScannerStatusSnapshot(request.status || null)
      .then((status) => broadcastScannerStatus(status).then(() => status))
      .then((status) => sendResponse({ success: true, status }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Scanner status update failed' }));
    return true;
  }

  if (request.action === SCANNER_DAEMON_ACTIONS.ENSURE) {
    ensureScannerDaemon()
      .then(() => getScannerBootstrapState())
      .then((bootstrap) => sendResponse({ success: true, status: bootstrap.status }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Scanner daemon ensure failed' }));
    return true;
  }

  if (request.action === SCANNER_DAEMON_ACTIONS.GET_STATUS) {
    (async () => {
      const bootstrap = await getScannerBootstrapState();
      let status = bootstrap.status;
      if (bootstrap.enabled && bootstrap.profileId) {
        await maybeStartScannerDaemon('status_request');
        const daemonResponse = await sendScannerDaemonMessage({ action: SCANNER_DAEMON_ACTIONS.GET_STATUS }).catch(() => null);
        if (daemonResponse && daemonResponse.success && daemonResponse.status) {
          status = normalizeScannerStatusSnapshot(daemonResponse.status);
          await persistScannerStatusSnapshot(status);
        }
      }
      sendResponse({ success: true, status });
    })().catch((error) => {
      sendResponse({ success: false, error: error?.message || 'Could not load scanner status' });
    });
    return true;
  }

  if (request.action === SCANNER_DAEMON_ACTIONS.ENABLE_AUTOSTART) {
    setStorage({ [SCANNER_DAEMON_ENABLED_KEY]: true })
      .then(() => getScannerBootstrapState())
      .then((bootstrap) => sendResponse({ success: true, status: bootstrap.status }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Could not enable scanner autostart' }));
    return true;
  }

  if (request.action === SCANNER_DAEMON_ACTIONS.CONNECT_GRANTED) {
    (async () => {
      const values = {};
      const requestedProfileId = String(request.profileId || '').trim();
      const requestedPortInfo = normalizeScannerPortInfo(request.preferredPortInfo);
      if (requestedProfileId) {
        values[SCANNER_PROFILE_STORAGE_KEY] = requestedProfileId;
      }
      if (requestedPortInfo) {
        values[SCANNER_PORT_INFO_STORAGE_KEY] = requestedPortInfo;
      }
      if (request.enableAutostart === true) {
        values[SCANNER_DAEMON_ENABLED_KEY] = true;
      }
      if (Object.keys(values).length) {
        await setStorage(values);
      }
      const bootstrap = await getScannerBootstrapState();
      if (!bootstrap.profileId) {
        throw new Error('No scanner profile is configured yet.');
      }
      await sendScannerDaemonMessage({
        action: SCANNER_DAEMON_ACTIONS.CONNECT_GRANTED,
        profileId: bootstrap.profileId,
        preferredPortInfo: bootstrap.portInfo,
        trigger: request.trigger || 'manual'
      });
      sendResponse({ success: true, accepted: true, status: bootstrap.status });
    })().catch((error) => {
      sendResponse({ success: false, error: error?.message || 'Scanner reconnect failed' });
    });
    return true;
  }

  if (request.action === SCANNER_DAEMON_ACTIONS.DISCONNECT) {
    sendScannerDaemonMessage({
      action: SCANNER_DAEMON_ACTIONS.DISCONNECT,
      trigger: request.trigger || 'manual'
    })
      .then((response) => sendResponse({ success: true, accepted: true, response }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Scanner disconnect failed' }));
    return true;
  }

  if (request.action === 'refreshNVCBundle') {
    const requestedSource = (request.sourceUrl || '').trim();
    const sourceUrl = normalizeSourceUrl(requestedSource || DEFAULT_NVC_SOURCE_URL);
    refreshNVCBundleFromUrl(sourceUrl, { force: true, trigger: 'manual' }).then(sendResponse);
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
    bgLog('Looking up vaccine info for lot:', request.lot, 'gtin:', request.gtin || '');

    Promise.resolve(bundleLoadPromise || loadNVCBundle())
      .then((loaded) => {
        if (loaded === false) {
          return { error: 'Failed to load NVC database' };
        }

        const vaccineInfo = lookupVaccineLot(request.lot, { gtin: request.gtin });
        bgLog('Lookup result:', vaccineInfo);

        if (vaccineInfo) {
          return vaccineInfo;
        }

        return { error: 'Vaccine not found in NVC database' };
      })
      .catch((error) => {
        console.error('Lookup pipeline failed:', error);
        return { error: error?.message || 'Failed to load NVC database' };
      })
      .then((response) => {
        sendResponse(response);
      });

    return true;
  }

  if (request.action === 'logAnalyticsEvent') {
    logAnalyticsEvent(request.eventType, request.payload || {})
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Analytics log failed' }));
    return true;
  }

  if (request.action === 'appendQueueRecord') {
    appendQueueRecord(request.storageKey || '', request.record || null)
      .then((record) => sendResponse({ success: true, record }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Queue append failed' }));
    return true;
  }

  if (request.action === 'scannerScanCaptured') {
    routeScanToActiveSupportedTab(request.scan || null)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Scan routing failed' }));
    return true;
  }

  if (request.action === 'drainPendingScannerScans') {
    const tabId = sender?.tab?.id;
    if (tabId === undefined || (sender?.tab?.url && !isSupportedChartUrl(sender.tab.url))) {
      sendResponse({ success: false, error: 'Pending scans can only drain to a supported chart tab' });
      return false;
    }
    drainPendingScansToTab(tabId)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Pending scan drain failed' }));
    return true;
  }

  if (request.action === 'getAnalyticsSummary') {
    getAnalyticsSummary()
      .then((summary) => sendResponse({ success: true, summary }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Analytics summary failed' }));
    return true;
  }

  if (request.action === 'getAnalyticsExport') {
    getAnalyticsExport(request.scope === 'today' ? 'today' : 'pilot')
      .then((data) => markAnalyticsExported().then(() => sendResponse({ success: true, data })))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Analytics export failed' }));
    return true;
  }

  if (request.action === 'setAnalyticsDeviceLabel') {
    setAnalyticsDeviceLabel(request.label || '')
      .then(() => getAnalyticsSummary())
      .then((summary) => sendResponse({ success: true, summary }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Analytics label update failed' }));
    return true;
  }

  if (request.action === 'resetAnalyticsStore') {
    resetAnalyticsStore()
      .then(() => getAnalyticsSummary())
      .then((summary) => sendResponse({ success: true, summary }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Analytics reset failed' }));
    return true;
  }

  sendResponse({ success: false, error: `Unknown background action: ${request?.action || 'missing'}` });
  return false;
});
