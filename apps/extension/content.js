// Flip to true while developing (content script isolated world).
const VAXLINK_CONTENT_DEBUG = false;
function vlog(...args) {
  if (VAXLINK_CONTENT_DEBUG) console.log('[VaxLink]', ...args);
}

const HANDS_FREE_BUILD = '2026-03-11-hf-recovery-1';
vlog('content script', location.href, 'readyState=', document.readyState, 'build=', HANDS_FREE_BUILD);

const WORKFLOW_MODE_KEY = 'vaxlink_workflow_mode_v1';
const LEGACY_POPUP_MODE_KEY = 'vaxlink_popup_mode_v1';
const LEGACY_HANDS_FREE_KEY = 'hands_free_scan_autofill_enabled';
const LEGACY_REMOTE_MODE_KEY = 'hands_free_scan_mode_v1';
const MULTIPLE_INJECT_QUEUE_KEY = 'multiple_inject_queue_v1';
const INVENTORY_BATCH_KEY = 'inventory_scan_batch_v1';
let activeWorkflowMode = 'single';
let scannerBuffer = '';
let scannerStartedAt = 0;
let scannerLastAt = 0;
let scannerIdleTimer = null;
let scannerInputTimer = null;
let lastHandledScanValue = '';
let lastHandledScanAt = 0;
let lastInputCandidate = '';
let lastInputCandidateAt = 0;

const SCAN_MIN_LENGTH = 8;
const SCAN_MAX_DURATION_MS = 6000;
const SCAN_MAX_AVG_INTERVAL_MS = 220;
const SCAN_CHAR_GAP_RESET_MS = 1500;
const SCAN_IDLE_COMMIT_MS = 1500;
const INPUT_CANDIDATE_TTL_MS = 5000;

function normalizeWorkflowMode(stored) {
  const direct = stored && stored[WORKFLOW_MODE_KEY];
  if (direct === 'single' || direct === 'multiple' || direct === 'inventory') {
    return direct;
  }

  const legacyPopup = stored && stored[LEGACY_POPUP_MODE_KEY];
  if (legacyPopup === 'inventory') {
    return 'inventory';
  }
  if (legacyPopup === 'inject') {
    return 'single';
  }

  const legacyRemote = stored && stored[LEGACY_REMOTE_MODE_KEY];
  if (legacyRemote === 'tray') {
    return 'multiple';
  }
  if (legacyRemote === 'autofill') {
    return 'single';
  }

  if (stored && stored[LEGACY_HANDS_FREE_KEY]) {
    return 'single';
  }

  return 'single';
}

function getQueueStorageKeyForWorkflow(mode) {
  if (mode === 'multiple') {
    return MULTIPLE_INJECT_QUEUE_KEY;
  }
  if (mode === 'inventory') {
    return INVENTORY_BATCH_KEY;
  }
  return '';
}

function logAnalyticsEvent(eventType, payload = {}) {
  try {
    chrome.runtime.sendMessage({ action: 'logAnalyticsEvent', eventType, payload }, () => {
      void chrome.runtime.lastError;
    });
  } catch (_) {
    // Ignore analytics failures on client pages.
  }
}

function setupMessageListener() {
  if (window.__vaxlinkMessageListenerInitialized) {
    return;
  }
  window.__vaxlinkMessageListenerInitialized = true;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    vlog('autoFill message', request?.action, request?.data);
    if (request.action === 'autoFill') {
      try {
        const success = autoFillTelus(request.data);
        vlog('autoFillTelus', success);
        sendResponse({ success: success });
      } catch (e) {
        console.error('Error in autoFillTelus:', e);
        sendResponse({ success: false, error: e.message });
      }
      return true;
    }
    vlog('unknown action', request?.action);
    sendResponse({ success: false, error: 'Unknown action' });
    return true;
  });
  vlog('message listener registered');
}

function resetScannerBuffer() {
  if (scannerIdleTimer) {
    clearTimeout(scannerIdleTimer);
    scannerIdleTimer = null;
  }
  if (scannerInputTimer) {
    clearTimeout(scannerInputTimer);
    scannerInputTimer = null;
  }
  scannerBuffer = '';
  scannerStartedAt = 0;
  scannerLastAt = 0;
}

function isTextEntryElement(el) {
  if (!el) return false;
  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = String(el.type || '').toLowerCase();
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'file'].includes(type);
  }
  return !!el.isContentEditable;
}

function isLikelyScannerSequence() {
  const value = String(scannerBuffer || '');
  if (value.length < SCAN_MIN_LENGTH) return false;
  if (!scannerStartedAt || !scannerLastAt) return false;
  const duration = scannerLastAt - scannerStartedAt;
  if (duration < 0 || duration > SCAN_MAX_DURATION_MS) return false;
  const avgInterval = duration / Math.max(value.length - 1, 1);
  return avgInterval <= SCAN_MAX_AVG_INTERVAL_MS;
}

function parseScannerDate(yymmdd) {
  if (!yymmdd || yymmdd.length !== 6) return null;
  const yy = yymmdd.substring(0, 2);
  const mm = yymmdd.substring(2, 4);
  const dd = yymmdd.substring(4, 6);
  return `${mm}/${dd}/20${yy}`;
}

function parseScannerIsLikelyAIStart(s, idx) {
  if (idx < 0 || idx > s.length - 2) return false;
  const ai = s.substring(idx, idx + 2);
  if (ai === '17') {
    if (idx + 8 > s.length) return false;
    return /^\d{6}$/.test(s.substring(idx + 2, idx + 8));
  }
  return ai === '10' || ai === '21';
}

function parseScannerCanParseTailNoGS(s, idx, memo) {
  if (idx >= s.length) return true;
  if (memo.has(idx)) return memo.get(idx);

  let ok = false;
  const ai = s.substring(idx, idx + 2);
  if (ai === '17') {
    ok = idx + 8 <= s.length &&
      /^\d{6}$/.test(s.substring(idx + 2, idx + 8)) &&
      parseScannerCanParseTailNoGS(s, idx + 8, memo);
  } else if (ai === '10' || ai === '21') {
    const valueStart = idx + 2;
    if (valueStart < s.length) {
      const next = parseScannerFindNextAINoGS(s, valueStart, memo, ai);
      ok = next === -1 ? true : (next > valueStart && parseScannerCanParseTailNoGS(s, next, memo));
    }
  } else {
    ok = false;
  }

  memo.set(idx, ok);
  return ok;
}

function parseScannerFindNextAINoGS(s, startIdx, memo, currentVariableAI = null) {
  for (let i = startIdx + 1; i < s.length - 1; i++) {
    if (!parseScannerIsLikelyAIStart(s, i)) continue;
    const candidateAI = s.substring(i, i + 2);
    if (currentVariableAI && candidateAI === currentVariableAI) continue;
    if (parseScannerCanParseTailNoGS(s, i, memo)) {
      return i;
    }
  }
  return -1;
}

function parseScannerFindNextAI(s, startIdx, GS, currentVariableAI = null) {
  if (GS && s.includes(GS) && s.substring(startIdx).includes(GS)) {
    const ais = ['17', '10', '21'];
    for (let i = startIdx; i < s.length - 1; i++) {
      const twoChar = s.substring(i, i + 2);
      if (ais.includes(twoChar) && i > 0 && s.charAt(i - 1) === GS) {
        return i;
      }
    }
  }

  const memo = new Map();
  return parseScannerFindNextAINoGS(s, startIdx, memo, currentVariableAI);
}

function parseGS1BarcodeFromScanner(rawScan) {
  const GS = String.fromCharCode(0x1d);
  let s = String(rawScan || '')
    .trim()
    .replace(/[\t\r\n]/g, GS)
    .replace(/^\]C1/i, '')
    .replace(/\(/g, '')
    .replace(/\)/g, '')
    .replace(/[^\x20-\x7E\x1D]/g, '');

  if (!s.startsWith('01')) {
    const first01 = s.indexOf('01');
    if (first01 > 0) {
      s = s.substring(first01);
    }
  }

  if (!s) {
    throw new Error('Empty scan payload');
  }

  const data = { gtin: null, expiry: null, lot: null, serial: null };
  let idx = 0;
  if (s.startsWith('01')) {
    if (s.length < 16) {
      throw new Error('AI(01) GTIN incomplete');
    }
    data.gtin = s.substring(2, 16);
    idx = 16;
  } else if (!parseScannerIsLikelyAIStart(s, 0)) {
    throw new Error('Expected a GS1 AI sequence (01/17/10/21)');
  }

  while (idx < s.length) {
    // Skip explicit separators.
    if (s.charAt(idx) === GS) {
      idx += 1;
      continue;
    }

    const currentAI = s.substring(idx, idx + 2);
    if (currentAI === '17') {
      if (s.length < idx + 8) {
        throw new Error('AI(17) expiry date incomplete');
      }
      const yymmdd = s.substring(idx + 2, idx + 8);
      data.expiry = parseScannerDate(yymmdd);
      idx += 8;
    } else if (currentAI === '10') {
      idx += 2;
      let lotEnd = parseScannerFindNextAI(s, idx, GS, '10');
      if (lotEnd === -1) {
        lotEnd = s.length;
      }
      data.lot = s.substring(idx, lotEnd);
      idx = lotEnd;
    } else if (currentAI === '21') {
      idx += 2;
      let serialEnd = parseScannerFindNextAI(s, idx, GS, '21');
      if (serialEnd === -1) {
        serialEnd = s.length;
      }
      data.serial = s.substring(idx, serialEnd);
      idx = serialEnd;
    } else {
      // Recover from unknown/intermediate AIs by finding the next recognized AI.
      const nextKnownAI = parseScannerFindNextAI(s, idx, GS, null);
      if (nextKnownAI > idx) {
        idx = nextKnownAI;
        continue;
      }
      break;
    }
  }

  if (!data.gtin && !data.expiry && !data.lot && !data.serial) {
    throw new Error('No recognized GS1 fields found');
  }

  return data;
}

function lookupVaccineInfoByLot(lot) {
  return new Promise((resolve) => {
    if (!lot) {
      resolve(null);
      return;
    }
    chrome.runtime.sendMessage({ action: 'lookupVaccineInfo', lot }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('Hands-free lot lookup failed:', chrome.runtime.lastError.message);
        resolve(null);
        return;
      }
      if (!response || response.error) {
        resolve(null);
        return;
      }
      resolve(response);
    });
  });
}

function getLocalStorage(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function setLocalStorage(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function appendQueueRecordViaBackground(storageKey, record) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'appendQueueRecord', storageKey, record }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || !response.success) {
        reject(new Error(response?.error || 'Queue append failed'));
        return;
      }
      resolve(response.record || null);
    });
  });
}

function parseDateToLocal(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }

  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    return new Date(Number(mdy[3]), Number(mdy[1]) - 1, Number(mdy[2]));
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function getExpiryStatus(value) {
  const expiry = parseDateToLocal(value);
  if (!expiry) {
    return {
      flag: 'unknown',
      daysRemaining: null
    };
  }

  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysRemaining = Math.floor((expiry.getTime() - todayMidnight.getTime()) / msPerDay);

  if (daysRemaining < 0) {
    return { flag: 'expired', daysRemaining };
  }
  if (daysRemaining <= 30) {
    return { flag: 'expiring_soon', daysRemaining };
  }
  return { flag: 'valid', daysRemaining };
}

function buildInventoryRecordFromParsed(data, rawBarcode) {
  const inventoryExpiry = data.inventory_expiry || data.expiry || data.nvc_lot_expiry || '';
  const expiryStatus = getExpiryStatus(inventoryExpiry);
  const expirySource = data.expiry
    ? 'barcode'
    : (data.nvc_lot_expiry ? 'nvc' : (data.expiry_source || 'none'));

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    scanned_at: new Date().toISOString(),
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
    din: data.din || '',
    drug_code: data.drug_code || data.din || '',
    lookup_error: data.lookup_error || ''
  };
}

async function saveScanToQueue(data, rawBarcode, storageKey) {
  if (!storageKey) {
    throw new Error('No storage key configured for queued scan mode');
  }
  const record = buildInventoryRecordFromParsed(data, rawBarcode);
  const appended = await appendQueueRecordViaBackground(storageKey, record);
  return appended || record;
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
  parsed.name = vaccineInfo.generic_name || vaccineInfo.tradename || vaccineInfo.din;

  if (!parsed.lot && vaccineInfo.lot_number) {
    parsed.lot = vaccineInfo.lot_number;
  }
  if (!parsed.expiry && vaccineInfo.lot_expiry) {
    parsed.expiry = toIsoDate(vaccineInfo.lot_expiry) || vaccineInfo.lot_expiry || parsed.expiry;
  }
}

function mergeParsedScanFields(base, extra) {
  if (!extra) return base;
  return {
    gtin: base.gtin || extra.gtin || null,
    expiry: base.expiry || extra.expiry || null,
    lot: base.lot || extra.lot || null,
    serial: base.serial || extra.serial || null,
    tradename: base.tradename || extra.tradename,
    generic_name: base.generic_name || extra.generic_name,
    disease: base.disease || extra.disease,
    antigen: base.antigen || extra.antigen,
    manufacturer: base.manufacturer || extra.manufacturer,
    nvc_lot_expiry: base.nvc_lot_expiry || extra.nvc_lot_expiry,
    din: base.din || extra.din,
    route: base.route || extra.route,
    strength: base.strength || extra.strength,
    dose_value: base.dose_value || extra.dose_value,
    dose_unit: base.dose_unit || extra.dose_unit,
    drug_code: base.drug_code || extra.drug_code,
    name: base.name || extra.name
  };
}

function rememberRecentInputCandidate(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value || !isCandidateGS1Text(value)) return;
  lastInputCandidate = value;
  lastInputCandidateAt = Date.now();
}

function getRecentRichScanCandidate(expectedGtin) {
  const now = Date.now();
  const candidates = [];
  if (lastInputCandidate && (now - lastInputCandidateAt) <= INPUT_CANDIDATE_TTL_MS) {
    candidates.push(lastInputCandidate);
  }

  const activeValue = getActiveElementScanCandidate();
  if (activeValue) {
    candidates.push(activeValue);
  }

  for (const raw of candidates) {
    try {
      const parsed = parseGS1BarcodeFromScanner(raw);
      if (expectedGtin && parsed.gtin && parsed.gtin !== expectedGtin) {
        continue;
      }
      if (parsed.lot || parsed.expiry || parsed.serial) {
        return { raw, parsed };
      }
    } catch (_) {
      // Ignore non-GS1 candidates.
    }
  }
  return null;
}

async function handleHandsFreeScan(scanValue, source = 'unknown') {
  if (!isHandsFreeSupportedPage()) {
    return;
  }

  const trimmed = String(scanValue || '').trim();
  if (!trimmed) return;
  vlog('hands-free candidate', { source, length: trimmed.length, preview: trimmed.slice(0, 80) });

  const now = Date.now();
  if (trimmed === lastHandledScanValue && (now - lastHandledScanAt) < 1500) {
    return;
  }
  lastHandledScanValue = trimmed;
  lastHandledScanAt = now;

  let parsed;
  try {
    parsed = parseGS1BarcodeFromScanner(trimmed);
    logAnalyticsEvent('parse_success', {
      workflow: activeWorkflowMode,
      source,
      vaccineLabel: parsed.lot || parsed.gtin || '',
      expiryFlag: getExpiryStatus(parsed.expiry).flag
    });
  } catch (error) {
    console.warn('Hands-free scan ignored (not valid GS1):', error.message);
    logAnalyticsEvent('parse_error', {
      workflow: activeWorkflowMode,
      source,
      note: error.message
    });
    return;
  }

  if (!parsed.lot && !parsed.expiry && !parsed.serial) {
    const recovered = getRecentRichScanCandidate(parsed.gtin);
    if (recovered) {
      parsed = mergeParsedScanFields(parsed, recovered.parsed);
      vlog('hands-free recovered from input candidate', {
        source,
        candidatePreview: recovered.raw.slice(0, 80),
        parsed
      });
    }
  }

  try {
    let vaccineInfo = null;
    let lookupAttempted = false;
    if (parsed.lot) {
      lookupAttempted = true;
      vaccineInfo = await lookupVaccineInfoByLot(parsed.lot);
    }

    // Do not treat GTIN as a lot lookup key (pilot: wrong agent / e.g. TI vs HB).
    if (!vaccineInfo && parsed.gtin) {
      vlog('skip GTIN lot lookup (hands-free)');
    }

    if (vaccineInfo) {
      mergeVaccineInfoIntoParsed(parsed, vaccineInfo);
    }

    if (lookupAttempted) {
      const lookupExpiryFlag = getExpiryStatus(parsed.expiry || parsed.nvc_lot_expiry).flag;
      logAnalyticsEvent(vaccineInfo ? 'lookup_success' : 'lookup_error', {
        workflow: activeWorkflowMode,
        source,
        vaccineLabel: parsed.tradename || parsed.generic_name || parsed.lot || parsed.gtin || '',
        manufacturer: parsed.manufacturer || '',
        expiryFlag: lookupExpiryFlag
      });
    }
  } catch (error) {
    console.warn('Hands-free lookup error:', error);
    logAnalyticsEvent('lookup_error', {
      workflow: activeWorkflowMode,
      source,
      note: error?.message || 'Lookup failed'
    });
  }

  if (!parsed.lot && !parsed.expiry && !parsed.serial) {
    console.warn(
      'Hands-free scan parsed GTIN only (no AI10 lot / AI17 expiry / AI21 serial). Configure scanner for full GS1 payload.',
      parsed
    );
  }

  const finalExpiryFlag = getExpiryStatus(parsed.expiry || parsed.nvc_lot_expiry).flag;
  logAnalyticsEvent('scan_captured', {
    workflow: activeWorkflowMode,
    source,
    vaccineLabel: parsed.tradename || parsed.generic_name || parsed.lot || parsed.gtin || '',
    manufacturer: parsed.manufacturer || '',
    expiryFlag: finalExpiryFlag
  });

  const queueStorageKey = getQueueStorageKeyForWorkflow(activeWorkflowMode);
  if (queueStorageKey) {
    try {
      const record = await saveScanToQueue(parsed, trimmed, queueStorageKey);
      const queueKey = activeWorkflowMode === 'inventory' ? 'inventory' : 'multiple';
      vlog('workflow scan saved to queue', {
        mode: activeWorkflowMode,
        source,
        id: record.id,
        lot: record.lot,
        tradename: record.tradename
      });
      logAnalyticsEvent('queue_saved', {
        workflow: activeWorkflowMode,
        queue: queueKey,
        source,
        count: 1,
        queueSizeAfter: record.queueSizeAfter || 0,
        vaccineLabel: record.tradename || record.generic_name || record.name || record.lot || '',
        manufacturer: record.manufacturer || '',
        expiryFlag: record.expiry_flag || finalExpiryFlag
      });
    } catch (error) {
      console.warn('Workflow queue save failed:', error);
    }
    return;
  }

  logAnalyticsEvent('autofill_attempt', {
    workflow: activeWorkflowMode,
    source,
    vaccineLabel: parsed.tradename || parsed.generic_name || parsed.lot || parsed.gtin || '',
    manufacturer: parsed.manufacturer || '',
    expiryFlag: finalExpiryFlag
  });
  const success = autoFillTelus(parsed);
  logAnalyticsEvent('autofill_result', {
    workflow: activeWorkflowMode,
    source,
    success,
    vaccineLabel: parsed.tradename || parsed.generic_name || parsed.lot || parsed.gtin || '',
    manufacturer: parsed.manufacturer || '',
    expiryFlag: finalExpiryFlag
  });
  vlog('hands-free autofill', success, { source, parsed });
}

function flushHandsFreeBuffer(event) {
  if (!scannerBuffer) return;
  const captured = scannerBuffer;
  const likelyScanner = isLikelyScannerSequence() || isCandidateGS1Text(captured);
  resetScannerBuffer();

  if (!likelyScanner) return;

  if (event) {
    event.preventDefault();
  }
  handleHandsFreeScan(captured, 'keyboard-buffer');
}

function scheduleScannerFlush() {
  if (scannerIdleTimer) {
    clearTimeout(scannerIdleTimer);
  }
  scannerIdleTimer = setTimeout(() => {
    flushHandsFreeBuffer();
  }, SCAN_IDLE_COMMIT_MS);
}

function getActiveElementScanCandidate() {
  const el = document.activeElement;
  if (!isTextEntryElement(el)) return '';
  if (!el || !('value' in el)) return '';
  const raw = String(el.value || '').trim();
  // Field values on app forms can be truncated by maxlength/masks.
  // Accept short AI-only GS1 payloads too (e.g., 17+10 without AI01).
  if (raw.length < 8) return '';
  if (!isCandidateGS1Text(raw)) {
    return '';
  }
  return raw;
}

function clearActiveElementValue() {
  const el = document.activeElement;
  if (!el || !('value' in el)) return;
  el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function onHandsFreePaste(event) {
  if (!isHandsFreeSupportedPage()) return;

  const text = String((event.clipboardData && event.clipboardData.getData('text')) || '').trim();
  if (!text || text.length < SCAN_MIN_LENGTH) return;
  if (!isCandidateGS1Text(text)) return;

  event.preventDefault();
  rememberRecentInputCandidate(text);
    vlog('hands-free paste');
  handleHandsFreeScan(text, 'paste');
}

function isCandidateGS1Text(value) {
  const text = String(value || '').trim();
  if (text.length < SCAN_MIN_LENGTH) return false;
  const normalized = normalizeScannerCandidate(text);
  if (!normalized) return false;
  if (normalized.startsWith('01') || normalized.includes('01')) return true;
  if (normalized.startsWith('17')) {
    return normalized.length >= 8 && /^\d{6}$/.test(normalized.substring(2, 8));
  }
  if (normalized.startsWith('10') || normalized.startsWith('21')) {
    return normalized.length > 2;
  }
  return parseScannerIsLikelyAIStart(normalized, 0);
}

function normalizeScannerCandidate(value) {
  const GS = String.fromCharCode(0x1d);
  let s = String(value || '')
    .trim()
    .replace(/[\t\r\n]/g, GS)
    .replace(/^\]C1/i, '')
    .replace(/\(/g, '')
    .replace(/\)/g, '')
    .replace(/[^\x20-\x7E\x1D]/g, '');
  if (!s.startsWith('01')) {
    const first01 = s.indexOf('01');
    if (first01 > 0) {
      s = s.substring(first01);
    }
  }
  return s;
}

function hasPostGTINAI(value) {
  const s = normalizeScannerCandidate(value);
  if (!s.startsWith('01') || s.length <= 16) return false;
  const tail = s.substring(16);
  return tail.includes('10') || tail.includes('17') || tail.includes('21') || tail.includes(String.fromCharCode(0x1d));
}

function onHandsFreeInput(event) {
  if (!isHandsFreeSupportedPage()) return;

  const target = event && event.target;
  if (!target || !isTextEntryElement(target) || !('value' in target)) return;
  const value = String(target.value || '').trim();
  if (value.length >= 16 && isCandidateGS1Text(value)) {
    rememberRecentInputCandidate(value);
  }
  if (scannerBuffer && scannerBuffer.length > 0) return;
  if (value.length < SCAN_MIN_LENGTH || !isCandidateGS1Text(value)) return;

  if (scannerInputTimer) {
    clearTimeout(scannerInputTimer);
  }
  scannerInputTimer = setTimeout(() => {
    const latest = String(target.value || '').trim();
    if (!isCandidateGS1Text(latest)) return;
    target.value = '';
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    vlog('hands-free input event');
    handleHandsFreeScan(latest, 'input-event');
  }, SCAN_IDLE_COMMIT_MS + 120);
}

function isHandsFreeSupportedPage() {
  try {
    if (window.top !== window.self) {
      return false;
    }

    const host = String(window.location.hostname || '').toLowerCase();
    if (!host) return false;

    // Exclude known third-party iframes that may include the app URL in hash/query.
    if (host.includes('stripe.network') || host.includes('stripe.com')) {
      return false;
    }

    const isPanorama = host.includes('panorama.') || host.includes('ehealthontario.ca');
    const isInputHealth = host === 'inputhealth.com' || host.endsWith('.inputhealth.com');

    return isPanorama || isInputHealth;
  } catch (error) {
    return false;
  }
}

function onHandsFreeKeydown(event) {
  if (!isHandsFreeSupportedPage()) return;
  if (event.defaultPrevented) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  const key = event.key;
  const now = Date.now();
  if (scannerLastAt && (now - scannerLastAt) > SCAN_CHAR_GAP_RESET_MS) {
    resetScannerBuffer();
  }

  if (key === 'Tab' || key === 'Enter' || key === 'NumpadEnter') {
    // Many scanner profiles use Tab/Enter as separators between AIs, not only as suffix.
    // Treat them as GS markers and flush only after idle timeout.
    if (scannerBuffer) {
      scannerLastAt = now;
      scannerBuffer += String.fromCharCode(0x1d);
      event.preventDefault();
      event.stopPropagation();
      scheduleScannerFlush();
      return;
    }

    const activeScan = getActiveElementScanCandidate();
    if (activeScan) {
      event.preventDefault();
      clearActiveElementValue();
      vlog('hands-free focused input');
      handleHandsFreeScan(activeScan, 'focused-input');
      return;
    }

    return;
  }

  if ((key === 'Unidentified' || key === 'Process') && scannerBuffer) {
    scannerLastAt = now;
    scannerBuffer += String.fromCharCode(0x1d);
    scheduleScannerFlush();
    return;
  }

  if (key.length !== 1) {
    return;
  }

  if (!scannerStartedAt) scannerStartedAt = now;
  scannerLastAt = now;
  scannerBuffer += key;

  scheduleScannerFlush();
}

function initHandsFreeScanner() {
  if (window.__vaxlinkHandsFreeInitialized) {
    return;
  }
  if (!isHandsFreeSupportedPage()) {
    return;
  }
  window.__vaxlinkHandsFreeInitialized = true;

  chrome.storage.local.get([
    WORKFLOW_MODE_KEY,
    LEGACY_POPUP_MODE_KEY,
    LEGACY_REMOTE_MODE_KEY,
    LEGACY_HANDS_FREE_KEY
  ], (stored) => {
    activeWorkflowMode = normalizeWorkflowMode(stored);
    vlog('active workflow mode', activeWorkflowMode);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (
      !(WORKFLOW_MODE_KEY in changes) &&
      !(LEGACY_POPUP_MODE_KEY in changes) &&
      !(LEGACY_REMOTE_MODE_KEY in changes) &&
      !(LEGACY_HANDS_FREE_KEY in changes)
    ) {
      return;
    }
    const nextState = {
      [WORKFLOW_MODE_KEY]: WORKFLOW_MODE_KEY in changes ? changes[WORKFLOW_MODE_KEY].newValue : activeWorkflowMode,
      [LEGACY_POPUP_MODE_KEY]: LEGACY_POPUP_MODE_KEY in changes ? changes[LEGACY_POPUP_MODE_KEY].newValue : undefined,
      [LEGACY_REMOTE_MODE_KEY]: LEGACY_REMOTE_MODE_KEY in changes ? changes[LEGACY_REMOTE_MODE_KEY].newValue : undefined,
      [LEGACY_HANDS_FREE_KEY]: LEGACY_HANDS_FREE_KEY in changes ? changes[LEGACY_HANDS_FREE_KEY].newValue : undefined
    };
    activeWorkflowMode = normalizeWorkflowMode(nextState);
    resetScannerBuffer();
    vlog('workflow mode changed', activeWorkflowMode);
  });

  window.addEventListener('keydown', onHandsFreeKeydown, true);
  window.addEventListener('paste', onHandsFreePaste, true);
  window.addEventListener('input', onHandsFreeInput, true);
}

// Register listener immediately
setupMessageListener();
initHandsFreeScanner();

// Also re-register when DOM is ready in case of timing issues
document.addEventListener('DOMContentLoaded', () => {
  vlog('DOMContentLoaded');
});

function toIsoDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const mm = mdy[1].padStart(2, '0');
    const dd = mdy[2].padStart(2, '0');
    return `${mdy[3]}-${mm}-${dd}`;
  }
  return null;
}

function getFields(selectors) {
  const seen = new Set();
  const fields = [];
  for (const selector of selectors) {
    const matches = document.querySelectorAll(selector);
    for (const el of matches) {
      if (!seen.has(el)) {
        seen.add(el);
        fields.push(el);
      }
    }
  }
  return fields;
}

function isPanoramaAgentControl(field) {
  const hint = `${field?.id || ''} ${field?.name || ''}`.toLowerCase();
  return hint.includes('agentiterm') || hint.includes('recordimms_agent') || /\bagent\b/.test(hint);
}

function extractBracketAgentCode(optionText) {
  const m = String(optionText || '').match(/^\s*\[([^\]]+)\]/);
  if (!m) return '';
  return normalizeForMatch(m[1]);
}

function fillField(field, value) {
  if (!field || value === undefined || value === null || value === '') {
    return false;
  }

  if (field.tagName === 'SELECT') {
    return fillSelectField(field, value);
  }

  const role = (field.getAttribute && field.getAttribute('role')) || '';
  const ariaAuto = (field.getAttribute && field.getAttribute('aria-autocomplete')) || '';
  const ariaHasPopup = (field.getAttribute && field.getAttribute('aria-haspopup')) || '';
  const classHint = (field.className || '').toLowerCase();
  const idHint = (field.id || '').toLowerCase();
  if (
    role === 'combobox' ||
    ariaAuto ||
    ariaHasPopup === 'listbox' ||
    classHint.includes('select') ||
    classHint.includes('combo') ||
    idHint.includes('selectbox') ||
    hasExtComboTrigger(field)
  ) {
    return fillComboTextField(field, value);
  }

  let nextValue = String(value);
  if (field.type === 'date') {
    const iso = toIsoDate(nextValue);
    if (!iso) {
      console.warn('Could not convert date for field:', field.name || field.id, nextValue);
      return false;
    }
    nextValue = iso;
  }

  field.focus();
  field.value = nextValue;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  field.blur();
  return true;
}

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[:/,_-]/g, ' ')
    .replace(/\broute\b/g, ' ')
    .replace(/\bqualifier\b/g, ' ')
    .replace(/\bvalue\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getValueAliases(rawValue, contextField) {
  const aliases = [];
  const normalized = normalizeForMatch(rawValue);
  if (!normalized) return aliases;

  aliases.push(rawValue);
  aliases.push(normalized);

  const unitAliases = {
    ml: ['millilitre(s)', 'millilitres', 'milliliter(s)', 'milliliters'],
    mg: ['milligram(s)', 'milligrams'],
    g: ['gram(s)', 'grams'],
    mcg: ['microgram(s)', 'micrograms'],
    ug: ['microgram(s)', 'micrograms'],
    l: ['litre(s)', 'litres', 'liter(s)', 'liters'],
    iu: ['international unit(s)', 'iu'],
    units: ['unit(s)', 'units']
  };

  const compact = normalized.replace(/\s+/g, '');
  if (unitAliases[compact]) {
    aliases.push(...unitAliases[compact]);
  }

  return [...new Set(aliases.map(v => normalizeForMatch(v)).filter(Boolean))];
}

function isLooseSelectTextMatch(optionTextNorm, desiredNorm) {
  if (!optionTextNorm || !desiredNorm) return false;
  if (optionTextNorm === desiredNorm) return true;

  const optionTokens = optionTextNorm.split(' ').filter(Boolean);
  const desiredTokens = desiredNorm.split(' ').filter(Boolean);

  // Allow short forms (e.g. "IM") only as full tokens, not fuzzy substring matches.
  if (desiredNorm.length <= 2 || optionTextNorm.length <= 2) {
    return optionTokens.includes(desiredNorm) || desiredTokens.includes(optionTextNorm);
  }

  // Prevent downgrading specific values to broader ones (e.g., "mmr var" -> "mmr").
  if (desiredTokens.length > optionTokens.length) {
    const optionIsSubset = optionTokens.every(token => desiredTokens.includes(token));
    if (optionIsSubset) {
      return false;
    }
  }

  // Single-token desired (e.g. "mmr", "hb") must not match a longer product line via substring
  // (pilot: MMR -> MMRV, HB -> combination agents).
  if (desiredTokens.length === 1 && optionTokens.length > 1) {
    return false;
  }

  return optionTextNorm.includes(desiredNorm) || desiredNorm.includes(optionTextNorm);
}

function fillSelectField(field, value) {
  const rawValue = String(value).trim();
  if (!rawValue) return false;
  const candidates = getValueAliases(rawValue, field);
  const options = Array.from(field.options || []).filter(opt => opt && opt.value !== '');
  if (!options.length) return false;
  const agentStrict = isPanoramaAgentControl(field);

  let matched = options.find(opt => opt.value === rawValue || opt.text.trim() === rawValue);
  if (!matched) {
    matched = options.find(opt => candidates.includes(normalizeForMatch(opt.text)));
  }
  if (!matched && agentStrict && candidates.length > 0) {
    matched = options.find((opt) => {
      const bracket = extractBracketAgentCode(opt.text);
      return bracket && candidates.includes(bracket);
    });
  }
  if (!matched && !agentStrict && candidates.length > 0) {
    matched = options.find(opt => {
      const optNorm = normalizeForMatch(opt.text);
      return candidates.some(desired => isLooseSelectTextMatch(optNorm, desired));
    });
  }
  if (!matched) return false;

  field.focus();
  field.value = matched.value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  field.blur();
  return true;
}

function fillComboTextField(field, value) {
  const rawValue = String(value).trim();
  if (!rawValue) return false;
  const candidates = getValueAliases(rawValue, field);
  if (!candidates.length) return false;
  const agentStrict = isPanoramaAgentControl(field);

  const unitTextAliases = {
    ml: 'Millilitre(s)',
    mg: 'Milligram(s)',
    mcg: 'Microgram(s)',
    ug: 'Microgram(s)',
    g: 'Gram(s)',
    l: 'Litre(s)',
    iu: 'International Unit(s)',
    units: 'Unit(s)'
  };
  const compactRaw = normalizeForMatch(rawValue).replace(/\s+/g, '');
  const preferredTypedValue = unitTextAliases[compactRaw] || rawValue;

  field.focus();
  if ('value' in field) {
    field.value = preferredTypedValue;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
  }
  field.click();
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

  // Best-effort pick for custom dropdown implementations (ng-select/react-select).
  const optionSelectors = [
    '[role="option"]',
    'li[role="option"]',
    '.ng-option',
    '.mat-option',
    '.x-combo-list-item',
    '.x-boundlist-item',
    '.ui-selectonemenu-item',
    '.select-option',
    '.dropdown-item',
    '.ui-menu-item',
    '.p-dropdown-item'
  ];
  for (const selector of optionSelectors) {
    const options = Array.from(document.querySelectorAll(selector));
    const hit = options.find(opt => {
      const text = opt.textContent || '';
      const optNorm = normalizeForMatch(text);
      if (agentStrict) {
        if (candidates.includes(optNorm)) return true;
        const bracket = extractBracketAgentCode(text);
        return !!(bracket && candidates.includes(bracket));
      }
      return candidates.some(desired => isLooseSelectTextMatch(optNorm, desired));
    });
    if (hit) {
      hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      hit.click();
      field.dispatchEvent(new Event('change', { bubbles: true }));
      field.blur();
      return true;
    }
  }

  // Keyboard fallback for autocomplete controls.
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  field.blur();
  return String(field.value || '').trim().length > 0;
}

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function hasExtComboTrigger(field) {
  if (!field || field.tagName !== 'INPUT') return false;
  const container = field.closest('.x-form-trigger-wrap, .x-form-field-wrap') || field.parentElement;
  if (!container) return false;
  return !!container.querySelector('.x-form-trigger, .x-form-arrow-trigger');
}

function normalizeLabelText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\*/g, ' ')
    .replace(/[:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isFillableControl(el) {
  if (!el) return false;
  const isStandardControl = el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA';
  const isRoleCombobox = (el.getAttribute && el.getAttribute('role') === 'combobox');
  if (!isStandardControl && !isRoleCombobox) return false;
  if (el.disabled) return false;
  if (el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'hidden') return false;
  return isVisible(el);
}

function scoreControlNearLabel(labelEl, controlEl) {
  const labelRect = labelEl.getBoundingClientRect();
  const controlRect = controlEl.getBoundingClientRect();
  const labelY = labelRect.top + (labelRect.height / 2);
  const controlY = controlRect.top + (controlRect.height / 2);
  const verticalDistance = Math.abs(labelY - controlY);
  const rightOfLabel = controlRect.left >= (labelRect.left - 8);
  const horizontalDistance = rightOfLabel
    ? Math.max(0, controlRect.left - labelRect.right)
    : 500 + Math.abs(controlRect.left - labelRect.left);
  return verticalDistance * 10 + horizontalDistance;
}

function findNearestControlForLabel(labelEl, scope = document) {
  if (!labelEl) return null;
  const controlSelector = 'input, select, textarea, [role="combobox"]';

  if (labelEl.tagName === 'LABEL') {
    const htmlFor = labelEl.getAttribute('for');
    if (htmlFor) {
      const direct = scope.getElementById ? scope.getElementById(htmlFor) : document.getElementById(htmlFor);
      if (isFillableControl(direct)) {
        return direct;
      }
    }
  }

  const candidates = [];
  const seen = new Set();

  const addCandidates = (container) => {
    if (!container || !container.querySelectorAll) return;
    const controls = container.querySelectorAll(controlSelector);
    for (const control of controls) {
      if (seen.has(control) || !isFillableControl(control)) continue;
      seen.add(control);
      candidates.push(control);
    }
  };

  let current = labelEl;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    addCandidates(current.parentElement);
    if (current.parentElement) {
      addCandidates(current.parentElement.nextElementSibling);
    }
    current = current.parentElement;
  }

  if (!candidates.length) {
    addCandidates(scope);
  }
  if (!candidates.length) return null;

  const ranked = candidates
    .map(control => ({ control, score: scoreControlNearLabel(labelEl, control) }))
    .sort((a, b) => a.score - b.score);

  return ranked.length ? ranked[0].control : null;
}

function findFieldByLabelText(labelTexts, options = {}) {
  const labels = Array.isArray(labelTexts) ? labelTexts : [labelTexts];
  const wanted = labels.map(normalizeLabelText).filter(Boolean);
  if (!wanted.length) return null;

  const scope = options.scope && options.scope.querySelectorAll ? options.scope : document;
  const labelSelector = 'label, span, div, td, th, strong';
  const allLabelNodes = Array.from(scope.querySelectorAll(labelSelector));
  const matchingLabels = allLabelNodes.filter((node) => {
    const text = normalizeLabelText(node.textContent || '');
    if (!text) return false;
    return wanted.some(target => text === target || text.startsWith(`${target} `));
  });

  const labelOrder = options.preferLast ? matchingLabels.slice().reverse() : matchingLabels;
  for (const labelEl of labelOrder) {
    const control = findNearestControlForLabel(labelEl, scope);
    if (control) {
      return control;
    }
  }
  return null;
}

function canFillPanoramaControl(field) {
  if (!field || field.disabled) return false;
  if (field.tagName === 'INPUT' && String(field.type || '').toLowerCase() === 'hidden') {
    return false;
  }
  return true;
}

function fillFirstMatchingField(selectors, value) {
  if (value === undefined || value === null || value === '') return false;
  const fields = getFields(selectors).filter(canFillPanoramaControl);
  for (const field of fields) {
    if (fillField(field, value)) {
      return true;
    }
  }
  return false;
}

function runPanoramaMappings(entries) {
  let fillCount = 0;
  for (const entry of entries) {
    if (!entry || !entry.value || !entry.selectors) continue;
    if (fillFirstMatchingField(entry.selectors, entry.value)) {
      fillCount += 1;
    }
  }
  return fillCount;
}

function normalizePanoramaLotToken(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function optionTextContainsLot(optionText, lotValue) {
  const lotToken = normalizePanoramaLotToken(lotValue);
  if (!lotToken) return false;
  const rawText = String(optionText || '');
  const fullToken = normalizePanoramaLotToken(rawText);
  if (fullToken.includes(lotToken)) return true;
  const leftPart = rawText.split('-')[0] || rawText;
  const leftToken = normalizePanoramaLotToken(leftPart);
  return leftToken === lotToken || leftToken.includes(lotToken);
}

function fillPanoramaLotFromSelect(lotValue) {
  const selectors = [
    'select[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_input"]',
    'select[id*="LotInfo:lotNumberSelect:selectOneMenu_input"]'
  ];
  const fields = getFields(selectors).filter(canFillPanoramaControl);
  for (const field of fields) {
    const options = Array.from(field.options || []).filter(opt => opt && opt.value !== '');
    const matched = options.find(opt => optionTextContainsLot(opt.text, lotValue));
    if (!matched) continue;

    field.focus();
    field.value = matched.value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.blur();

    if (field.id && field.id.endsWith('_input')) {
      const labelId = `${field.id.slice(0, -6)}_label`;
      const label = document.getElementById(labelId);
      if (label) {
        label.textContent = matched.text;
      }
    }
    return true;
  }
  return false;
}

function openPanoramaLotDropdown() {
  const selectors = [
    '[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu"] .ui-selectonemenu-trigger',
    '[id*="LotInfo:lotNumberSelect:selectOneMenu"] .ui-selectonemenu-trigger'
  ];
  const triggers = getFields(selectors).filter(isVisible);
  for (const trigger of triggers) {
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    trigger.click();
    return true;
  }
  return false;
}

function fillPanoramaLotFromPanelItems(lotValue) {
  const filterSelectors = [
    'input[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_filter"]',
    'input[id*="LotInfo:lotNumberSelect:selectOneMenu_filter"]'
  ];
  const filters = getFields(filterSelectors).filter(canFillPanoramaControl);
  for (const filterInput of filters) {
    filterInput.focus();
    filterInput.value = String(lotValue || '');
    filterInput.dispatchEvent(new Event('input', { bubbles: true }));
    filterInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
  }

  const itemSelectors = [
    'li[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_"]',
    'li[id*="LotInfo:lotNumberSelect:selectOneMenu_"]',
    '.ui-selectonemenu-panel .ui-selectonemenu-item'
  ];
  for (const selector of itemSelectors) {
    const items = Array.from(document.querySelectorAll(selector))
      .filter(item => isVisible(item) && String(item.textContent || '').trim());
    const matched = items.find(item => optionTextContainsLot(item.textContent, lotValue));
    if (!matched) continue;
    matched.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    matched.click();
    return true;
  }
  return false;
}

function tryFillPanoramaLot(lotValue) {
  if (!lotValue) return false;
  if (fillPanoramaLotFromSelect(lotValue)) return true;
  openPanoramaLotDropdown();
  if (fillPanoramaLotFromPanelItems(lotValue)) return true;
  return false;
}

function tryFillPanoramaLotOrTrade(data) {
  if (!data || !data.lot) return false;
  return tryFillPanoramaLot(data.lot);
}

function schedulePanoramaLotOrTradeSelection(data, initialDelayMs = 0) {
  let attempts = 0;
  const maxAttempts = 10;
  const tick = () => {
    attempts += 1;
    if (tryFillPanoramaLotOrTrade(data)) {
      return;
    }
    if (attempts < maxAttempts) {
      setTimeout(tick, attempts < 3 ? 350 : 700);
    }
  };
  setTimeout(tick, initialDelayMs);
}

function isPanoramaImmunizationPage() {
  const markerSelectors = [
    'select[id*="immsDetailssection_recordImms_agentiterm:selectOneMenu_input"]',
    'select[id*="immsDetailssection_createImms_tradenameinput:selectOneMenu_input"]',
    'select[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_input"]',
    'input[id*="addimmsdetails_vaccDetailssection1_decimal:inputText"]',
    'select[id*="addimmsdetails_vaccDetailssection1createImms_dosageuomsel1:iTermSelectOneMenu_input"]',
    'select[id*="addimmsdetails_vaccDetailssection1createImms_routeSelOne:iTermSelectOneMenu_input"]',
    'input[id*="addimmsdetails_vaccDetailssection1_createImms_manufacturerinput:inputText"]'
  ];
  if (markerSelectors.some(selector => document.querySelector(selector))) {
    return true;
  }

  const hasTitle = Array.from(document.querySelectorAll('h1, h2, h3, legend, div, span, td, th, strong'))
    .some(el => normalizeLabelText(el.textContent || '') === 'immunizations');
  if (!hasTitle) return false;

  const hasDateAdminLabel = Array.from(document.querySelectorAll('label, span, div, td, th, strong'))
    .some(el => normalizeLabelText(el.textContent || '') === 'date administered');
  return hasDateAdminLabel;
}

function fillPanoramaImmunizationFields(data) {
  const agentSelectors = [
    'select[id*="immsDetailssection_recordImms_agentiterm:selectOneMenu_input"]',
    'input[id*="immsDetailssection_recordImms_agentiterm:selectOneMenu_focus"]'
  ];
  const agentCandidates = getPanoramaAgentCandidates(data);
  let agentCount = 0;
  for (const candidate of agentCandidates) {
    if (fillFirstMatchingField(agentSelectors, candidate)) {
      agentCount = 1;
      break;
    }
  }

  let fillCount = agentCount;
  const lotCount = data.lot ? (tryFillPanoramaLot(data.lot) ? 1 : 0) : 0;
  fillCount += lotCount;

  // Panorama refreshes lot options asynchronously after selecting Agent.
  if (data.lot && (agentCount > 0 || fillCount === 0)) {
    schedulePanoramaLotOrTradeSelection(data, agentCount > 0 ? 550 : 150);
  }

  if (fillCount > 0) {
    return fillCount;
  }

  // If agent did not fill, still attempt lot/trade directly.
  if (data.lot && tryFillPanoramaLot(data.lot)) {
    fillCount += 1;
  }
  if (fillCount > 0) {
    return fillCount;
  }

  const fallbackMapping = [
    {
      value: agentCandidates.length ? agentCandidates[0] : (data.name || data.generic_name || data.tradename || data.din),
      labels: ['Agent'],
      preferLast: false
    },
    {
      value: data.lot,
      labels: ['Lot Number'],
      preferLast: false
    }
  ];

  let fallbackCount = 0;
  const usedFields = new Set();
  for (const entry of fallbackMapping) {
    if (!entry.value) continue;
    const field = findFieldByLabelText(entry.labels, { preferLast: entry.preferLast });
    if (!field || usedFields.has(field)) continue;
    if (fillField(field, entry.value)) {
      usedFields.add(field);
      fallbackCount += 1;
    }
  }
  return fallbackCount;
}

const PANORAMA_AGENT_RULES = Array.isArray(globalThis.VAXLINK_PANORAMA_AGENT_RULES)
  ? globalThis.VAXLINK_PANORAMA_AGENT_RULES
  : [];

function buildPanoramaAgentSourceText(data) {
  return normalizeForMatch([
    data?.name,
    data?.generic_name,
    data?.tradename,
    data?.disease,
    data?.antigen,
    data?.manufacturer,
    data?.route,
    data?.strength
  ].filter(Boolean).join(' '));
}

function panoramaSourceHasAll(sourceText, terms) {
  return terms.every(term => sourceText.includes(normalizeForMatch(term)));
}

function panoramaSourceHasAny(sourceText, terms) {
  return terms.some(term => sourceText.includes(normalizeForMatch(term)));
}

function panoramaAgentRuleClauseMatches(sourceText, clause) {
  if (clause.any && !panoramaSourceHasAny(sourceText, clause.any)) return false;
  if (clause.all && !panoramaSourceHasAll(sourceText, clause.all)) return false;
  if (clause.notAny && panoramaSourceHasAny(sourceText, clause.notAny)) return false;
  if (clause.notAll && panoramaSourceHasAll(sourceText, clause.notAll)) return false;
  return true;
}

function panoramaAgentRuleMatches(sourceText, rule) {
  return (rule.clauses || []).some(clause => panoramaAgentRuleClauseMatches(sourceText, clause));
}

function getPanoramaAgentCandidates(data) {
  const values = [];
  const seen = new Set();
  const add = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return;
    const key = normalizeForMatch(raw);
    if (!key || seen.has(key)) return;
    seen.add(key);
    values.push(raw);
  };

  const sourceText = buildPanoramaAgentSourceText(data);
  for (const rule of PANORAMA_AGENT_RULES) {
    if (!panoramaAgentRuleMatches(sourceText, rule)) continue;
    for (const output of rule.outputs || []) {
      add(output);
    }
  }

  add(data?.name);
  add(data?.generic_name);
  add(data?.tradename);
  add(data?.din);
  return values;
}

function getDoseUnitFieldByLayout() {
  const controlSelector = [
    'select',
    'input',
    '[role="combobox"]',
    '[aria-haspopup="listbox"]',
    '.ng-select',
    '.mat-select',
    '.p-dropdown',
    '.ui-dropdown'
  ].join(', ');

  function doseUnitFromCaptionNodes(nodes) {
    for (const label of nodes) {
      const text = normalizeForMatch(label.textContent || '');
      if (!(text === 'dose' || text.startsWith('dose '))) continue;

      const container = label.parentElement;
      if (!container) continue;

      const controls = Array.from(
        container.querySelectorAll(controlSelector)
      ).filter(el => isVisible(el) && el.type !== 'hidden' && !el.disabled);

      if (controls.length >= 2) {
        const unitControl =
          controls.find(el => el.tagName === 'SELECT' || (el.getAttribute && el.getAttribute('role') === 'combobox')) ||
          controls[1];
        if (unitControl) return unitControl;
      }

      const next = container.nextElementSibling;
      if (next) {
        const nextControls = Array.from(
          next.querySelectorAll(controlSelector)
        ).filter(el => isVisible(el) && el.type !== 'hidden' && !el.disabled);
        if (nextControls.length >= 2) {
          const unitControl =
            nextControls.find(el => el.tagName === 'SELECT' || (el.getAttribute && el.getAttribute('role') === 'combobox')) ||
            nextControls[1];
          if (unitControl) return unitControl;
        }
      }
    }
    return null;
  }

  // Labels first (cheap). Table layouts second — still tiny vs all span/div on SPAs.
  return (
    doseUnitFromCaptionNodes(document.querySelectorAll('label')) ||
    doseUnitFromCaptionNodes(document.querySelectorAll('th, td'))
  );
}

function autoFillTelus(data) {
  try {
    if (isPanoramaImmunizationPage()) {
      const panoramaFillCount = fillPanoramaImmunizationFields(data);
      vlog('Panorama fields filled', panoramaFillCount);
      return panoramaFillCount > 0;
    }

    const mapping = [
      {
        value: data.lot,
        selectors: [
          'input[name="lot_number"]',
          'input[name="parsed_lot"]',
          'input[id="lot_number"]',
          'input[id="parsed_lot"]',
          'input[id*="lot"]',
          'input[placeholder*="Lot"]'
        ]
      },
      {
        value: data.expiry,
        selectors: [
          'input[name="expiry_date"]',
          'input[name="parsed_expiry"]',
          'input[id="expiry_date"]',
          'input[id="parsed_expiry"]',
          'input[id*="expiry"]',
          'input[placeholder*="Expiry"]'
        ]
      },
      {
        value: data.gtin,
        selectors: [
          'input[name="gtin"]',
          'input[name="parsed_gtin"]',
          'input[id="gtin"]',
          'input[id="parsed_gtin"]',
          'input[id*="gtin"]',
          'input[placeholder*="GTIN"]'
        ]
      },
      {
        value: data.serial,
        selectors: [
          'input[name="serial"]',
          'input[name="parsed_serial"]',
          'input[id="serial"]',
          'input[id="parsed_serial"]',
          'input[id*="serial"]',
          'input[placeholder*="Serial"]'
        ]
      },
      {
        value: data.tradename,
        selectors: [
          'input[name="trade_name"]',
          'input[id="trade_name"]',
          'input[name="tradename"]',
          'input[id="tradename"]'
        ]
      },
      {
        value: data.generic_name,
        selectors: [
          'input[name="generic_name"]',
          'input[id="generic_name"]'
        ]
      },
      {
        value: data.name || data.generic_name || data.tradename || data.din,
        selectors: [
          'input[name="name"]',
          'input[id="name"]',
          'input[name*="vaccine_name"]',
          'input[id*="vaccine_name"]',
          'input[name*="medication_name"]',
          'input[id*="medication_name"]',
          'input[name*="name"]:not([name*="trade"]):not([name*="manufacturer"])',
          'input[id*="name"]:not([id*="trade"]):not([id*="manufacturer"])'
        ]
      },
      {
        value: data.disease,
        selectors: [
          'input[name="disease"]',
          'input[id="disease"]'
        ]
      },
      {
        value: data.antigen,
        selectors: [
          'input[name="antigen"]',
          'input[id="antigen"]'
        ]
      },
      {
        value: data.manufacturer,
        selectors: [
          'input[name="manufacturer"]',
          'input[id="manufacturer"]',
          'input[id*="manufacturer"]',
          'input[name*="manufacturer"]'
        ]
      },
      {
        value: data.route,
        selectors: [
          'select[name="route"]',
          'select[id="route"]',
          'select[name*="route"]',
          'select[id*="route"]',
          'input[name="route"]',
          'input[id="route"]',
          'input[name*="route"]',
          'input[id*="route"]'
        ]
      },
      {
        value: data.strength,
        selectors: [
          'input[name="strength"]',
          'input[id="strength"]',
          'input[name*="strength"]',
          'input[id*="strength"]'
        ]
      },
      {
        value: data.dose_value,
        selectors: [
          'input[name="dose"]',
          'input[id="dose"]',
          'input[name*="dose"]',
          'input[id*="dose"]'
        ]
      },
      {
        value: data.dose_unit,
        selectors: [
          '#ih-selectbox-32',
          '[id^="ih-selectbox-"]',
          'input[data-testid="doseUnitSelect"]',
          'select[name="dose_unit"]',
          'select[id="dose_unit"]',
          'select[name*="dose"]',
          'select[id*="dose"]',
          'select[name*="unit"]',
          'select[id*="unit"]',
          'input[name="dose_unit"]',
          'input[id="dose_unit"]',
          'input[name*="unit"]',
          'input[id*="unit"]',
          'input[role="combobox"]'
        ]
      },
      {
        value: data.nvc_lot_expiry,
        selectors: [
          'input[name="nvc_lot_expiry"]',
          'input[id="nvc_lot_expiry"]'
        ]
      },
      {
        value: data.drug_code || data.din,
        selectors: [
          'input[name="drug_code"]',
          'input[id="drug_code"]',
          'input[name*="drug_code"]',
          'input[id*="drug_code"]',
          'input[name*="drugcode"]',
          'input[id*="drugcode"]',
          'input[name*="drug"]',
          'input[id*="drug"]',
          'input[name="din"]',
          'input[id="din"]',
          'input[name*="din"]',
          'input[id*="din"]'
        ]
      }
    ];

    let fillCount = 0;
    for (const entry of mapping) {
      const fields = getFields(entry.selectors);
      for (const field of fields) {
        if (fillField(field, entry.value)) {
          fillCount += 1;
        }
      }
    }

    if (data.dose_unit) {
      const unitField = getDoseUnitFieldByLayout();
      if (unitField && fillField(unitField, data.dose_unit)) {
        fillCount += 1;
      }
    }

    vlog('generic auto-fill fields', fillCount);
    return fillCount > 0;
  } catch (e) {
    console.error('Auto-fill error:', e);
    return false;
  }
}
