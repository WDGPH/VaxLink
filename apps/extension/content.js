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
const ADMIN_DATETIME_AUTOFILL_KEY = 'vaxlink_administered_datetime_autofill_v1';
const AUDIO_FEEDBACK_KEY = 'vaxlink_audio_feedback_enabled_v1';
const HUD_POSITION_KEY = 'vaxlink_hud_position_v1';
const HUD_HIDDEN_KEY = 'vaxlink_hud_hidden_v1';
let activeWorkflowMode = 'single';
let adminDateTimeAutofillEnabled = true;
let audioFeedbackEnabled = true;
let hudInitialized = false;
let lastAutoDrainAt = 0;
let lastVaxlinkFillAt = 0;
let lastHandledScanValue = '';
let lastHandledScanAt = 0;
let audioContextRef = null;
let expiryGuardHost = null;
let expiryGuardRoot = null;
let pendingScannerDrainRequested = false;

function normalizeAdminDateTimeAutofillSetting(stored) {
  return !(stored && stored[ADMIN_DATETIME_AUTOFILL_KEY] === false);
}

function normalizeAudioFeedbackSetting(stored) {
  return !(stored && stored[AUDIO_FEEDBACK_KEY] === false);
}

function getAudioContext() {
  if (audioContextRef) return audioContextRef;
  const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextCtor) return null;
  audioContextRef = new AudioContextCtor();
  return audioContextRef;
}

function playAudioCue(kind) {
  if (!audioFeedbackEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => undefined);
  }

  const playTone = (frequency, durationMs, type = 'sine', gainValue = 0.06, delayMs = 0) => {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime + (delayMs / 1000));
    gain.gain.exponentialRampToValueAtTime(gainValue, ctx.currentTime + (delayMs / 1000) + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + (delayMs / 1000) + (durationMs / 1000));
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(ctx.currentTime + (delayMs / 1000));
    oscillator.stop(ctx.currentTime + (delayMs / 1000) + (durationMs / 1000) + 0.02);
  };

  if (kind === 'success') {
    playTone(880, 90, 'sine', 0.045, 0);
    playTone(1175, 120, 'sine', 0.05, 95);
    return;
  }
  if (kind === 'error') {
    playTone(220, 220, 'square', 0.055, 0);
    return;
  }
  if (kind === 'duplicate') {
    playTone(440, 90, 'square', 0.05, 0);
    playTone(330, 110, 'square', 0.05, 120);
    return;
  }
  if (kind === 'expiry_warning') {
    playTone(980, 110, 'square', 0.06, 0);
    playTone(980, 110, 'square', 0.06, 170);
  }
}

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

function requestPendingScannerScans() {
  if (pendingScannerDrainRequested || !isHandsFreeSupportedPage()) return;
  pendingScannerDrainRequested = true;
  try {
    chrome.runtime.sendMessage({ action: 'drainPendingScannerScans' }, () => {
      void chrome.runtime.lastError;
    });
  } catch (_) {
    // Pending scan drain is best effort.
  }
}

function setupMessageListener() {
  if (window.__vaxlinkMessageListenerInitialized) {
    return;
  }
  window.__vaxlinkMessageListenerInitialized = true;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    vlog('autoFill message', request?.action, request?.data);
    if (request.action === 'vaxlinkScanCaptured') {
      if (window.top !== window.self) {
        return false;
      }
      if (!isHandsFreeSupportedPage()) {
        sendResponse({ success: false, error: 'Unsupported chart page' });
        return true;
      }
      Promise.resolve(handleHandsFreeScan(request.scan?.rawText || '', request.scan?.source || 'scanner-channel'))
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, error: error?.message || 'Scan handling failed' }));
      return true;
    }
    if (request.action === 'autoFill') {
      // Only the top frame should respond to autoFill messages from the popup.
      // With all_frames:true, iframes also receive the message; if an iframe
      // responds first with { success: false } (no matching fields), the popup
      // sees a failure even though the main frame would succeed. Returning
      // false lets the top frame's response through. (Edge delivers iframe
      // responses before the main frame more often than Chrome, causing
      // multi-inject to fail.)
      if (window.top !== window.self) {
        return false;
      }
      try {
        const result = autoFillTelus(request.data);
        vlog('autoFillTelus', result?.status, result);
        sendResponse({
          success: isAutofillSuccess(result),
          pending: isAutofillPending(result),
          status: result?.status || 'failed',
          error: result?.error || ''
        });
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

function getGS1Parser() {
  if (!globalThis.VaxLinkGS1Parser) {
    throw new Error('VaxLink GS1 parser is not loaded');
  }
  return globalThis.VaxLinkGS1Parser;
}

function parseGS1BarcodeFromScanner(rawScan) {
  return getGS1Parser().parseGS1Barcode(rawScan);
}

function lookupVaccineInfoByLot(lot, gtin) {
  return new Promise((resolve) => {
    if (!lot) {
      resolve(null);
      return;
    }
    const request = { action: 'lookupVaccineInfo', lot };
    if (gtin) {
      request.gtin = gtin;
    }
    chrome.runtime.sendMessage(request, (response) => {
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

function getPositiveInt(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function getQueueRemainingDoses(row, fallback = 1) {
  const remaining = getPositiveInt(row && row.remaining_doses, null);
  if (remaining !== null) {
    return remaining;
  }
  const total = getPositiveInt(row && row.total_doses, null);
  return total !== null ? total : fallback;
}

function buildQueueRowsAfterRecordUse(rows, record, recordIndex) {
  const nextRows = Array.isArray(rows) ? rows.slice() : [];
  nextRows.splice(recordIndex, 1);

  const remaining = getQueueRemainingDoses(record, null);
  if (remaining === null) {
    nextRows.splice(recordIndex, 0, record);
  } else if (remaining > 1) {
    nextRows.splice(recordIndex, 0, { ...record, remaining_doses: remaining - 1 });
  }

  return nextRows;
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
  parsed.nvc_override = vaccineInfo.nvc_override || null;
  parsed.name = vaccineInfo.generic_name || vaccineInfo.tradename || vaccineInfo.din;

  if (!parsed.lot && vaccineInfo.lot_number) {
    parsed.lot = vaccineInfo.lot_number;
  }
  if (!parsed.expiry && vaccineInfo.lot_expiry) {
    parsed.expiry = toIsoDate(vaccineInfo.lot_expiry) || vaccineInfo.lot_expiry || parsed.expiry;
  }
}

async function handleHandsFreeScan(scanValue, source = 'unknown') {
  if (!isHandsFreeSupportedPage()) {
    return;
  }

  const trimmed = String(scanValue || '').trim();
  if (!trimmed) return;

  if (handleVaxlinkCommand(trimmed)) return;

  const scanCapturedAt = new Date().toISOString();
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
    playAudioCue('error');
    logAnalyticsEvent('parse_error', {
      workflow: activeWorkflowMode,
      source,
      note: error.message
    });
    return;
  }
  parsed.scanned_at = parsed.scanned_at || scanCapturedAt;

  try {
    let vaccineInfo = null;
    let lookupAttempted = false;
    if (parsed.lot) {
      lookupAttempted = true;
      vaccineInfo = await lookupVaccineInfoByLot(parsed.lot, parsed.gtin);
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
      if (!vaccineInfo) {
        playAudioCue('error');
      }
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
      if (record.duplicate_ignored) {
        playAudioCue('duplicate');
        showVaxlinkToast({ ...parsed, _duplicateIgnored: true });
        vlog('duplicate scan ignored', { mode: activeWorkflowMode, source, lot: record.lot });
        logAnalyticsEvent('queue_duplicate_ignored', {
          workflow: activeWorkflowMode,
          queue: queueKey,
          source,
          vaccineLabel: record.tradename || record.generic_name || record.name || record.lot || '',
          manufacturer: record.manufacturer || '',
          expiryFlag: record.expiry_flag || finalExpiryFlag
        });
        return;
      }
      // Expired records get the expiry_warning cue from the persistent toast.
      if (record.expiry_flag !== 'expired') {
        playAudioCue('success');
      }
      showVaxlinkToast({ ...parsed, _queuedCount: record.queueSizeAfter || 0 });
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
  if (adminDateTimeAutofillEnabled) {
    parsed.administered_at = parsed.administered_at || parsed.scanned_at || scanCapturedAt;
  } else {
    delete parsed.administered_at;
  }
  const autofillResult = autoFillTelus(parsed);
  const success = isAutofillSuccess(autofillResult);
  const pending = isAutofillPending(autofillResult);
  logAnalyticsEvent('autofill_result', {
    workflow: activeWorkflowMode,
    source,
    success,
    pending,
    vaccineLabel: parsed.tradename || parsed.generic_name || parsed.lot || parsed.gtin || '',
    manufacturer: parsed.manufacturer || '',
    expiryFlag: finalExpiryFlag
  });
  if (success) {
    showVaxlinkToast(parsed);
  }
  vlog('hands-free autofill', autofillResult?.status, { source, parsed });
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

    const path = String(window.location.pathname || '').toLowerCase();
    const isPanorama =
      (host === 'www.panorama.prod.ehealthontario.ca' ||
       host === 'panorama.prod.ehealthontario.ca') &&
      path.includes('/recordimms/');
    const isInputHealth = host === 'inputhealth.com' || host.endsWith('.inputhealth.com');

    return isPanorama || isInputHealth;
  } catch (error) {
    return false;
  }
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
    LEGACY_HANDS_FREE_KEY,
    ADMIN_DATETIME_AUTOFILL_KEY,
    AUDIO_FEEDBACK_KEY
  ], (stored) => {
    activeWorkflowMode = normalizeWorkflowMode(stored);
    adminDateTimeAutofillEnabled = normalizeAdminDateTimeAutofillSetting(stored);
    audioFeedbackEnabled = normalizeAudioFeedbackSetting(stored);
    requestPendingScannerScans();
    vlog('active workflow mode', activeWorkflowMode);

    // On Panorama SPA navigations the page is already fully loaded when this
    // content script injects, so document.readyState is NOT 'loading'.
    // initClickReductionFeatures() therefore ran synchronously — BEFORE this
    // callback fired.  At that point activeWorkflowMode was still the default
    // 'single', so every mode guard in checkGrid() and the tryAutoDrain
    // setTimeout evaluated false and bailed.
    //
    // Now that the real mode is known, re-kick both paths:
    //  • maybeAutoFillPanoramaMultipleGrid – fills the agent+date grid
    //  • tryAutoDrain – fills the single-immunization form after save
    //
    // A 250 ms head-start lets PrimeFaces settle; both functions guard
    // internally (isPrimeFacesAjaxBusy, multiGridFillPending, etc.) and
    // the MutationObserver catches any subsequent retry-worthy mutations.
    if (activeWorkflowMode === 'multiple') {
      setTimeout(() => void maybeAutoFillPanoramaMultipleGrid(), 250);
      setTimeout(() => tryAutoDrain(), 1200);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (
      !(WORKFLOW_MODE_KEY in changes) &&
      !(LEGACY_POPUP_MODE_KEY in changes) &&
      !(LEGACY_REMOTE_MODE_KEY in changes) &&
      !(LEGACY_HANDS_FREE_KEY in changes) &&
      !(ADMIN_DATETIME_AUTOFILL_KEY in changes) &&
      !(AUDIO_FEEDBACK_KEY in changes)
    ) {
      return;
    }
    const nextState = {
      [WORKFLOW_MODE_KEY]: WORKFLOW_MODE_KEY in changes ? changes[WORKFLOW_MODE_KEY].newValue : activeWorkflowMode,
      [LEGACY_POPUP_MODE_KEY]: LEGACY_POPUP_MODE_KEY in changes ? changes[LEGACY_POPUP_MODE_KEY].newValue : undefined,
      [LEGACY_REMOTE_MODE_KEY]: LEGACY_REMOTE_MODE_KEY in changes ? changes[LEGACY_REMOTE_MODE_KEY].newValue : undefined,
      [LEGACY_HANDS_FREE_KEY]: LEGACY_HANDS_FREE_KEY in changes ? changes[LEGACY_HANDS_FREE_KEY].newValue : undefined,
      [ADMIN_DATETIME_AUTOFILL_KEY]: ADMIN_DATETIME_AUTOFILL_KEY in changes
        ? changes[ADMIN_DATETIME_AUTOFILL_KEY].newValue
        : adminDateTimeAutofillEnabled,
      [AUDIO_FEEDBACK_KEY]: AUDIO_FEEDBACK_KEY in changes
        ? changes[AUDIO_FEEDBACK_KEY].newValue
        : audioFeedbackEnabled
    };
    activeWorkflowMode = normalizeWorkflowMode(nextState);
    adminDateTimeAutofillEnabled = normalizeAdminDateTimeAutofillSetting(nextState);
    audioFeedbackEnabled = normalizeAudioFeedbackSetting(nextState);
    vlog('workflow mode changed', activeWorkflowMode);
  });

  document.addEventListener('pointerdown', cancelPanoramaFillRetriesForManualEdit, true);
  document.addEventListener('change', cancelPanoramaFillRetriesForManualEdit, true);
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
  // 'agentiterm'       → single-immunization detail page (immsDetailssection_recordImms_agentiterm)
  // 'recordimms_agent' → legacy selector variant
  // 'agentmenu'        → multi-immunization grid page  (historicalfactoryTable:…:immsAgentMenu)
  //                      NOTE: \bagent\b does NOT fire here because 'immsAgentMenu' lowercases to
  //                      'immsagentmenu' where 'agent' has no word boundaries on either side.
  return hint.includes('agentiterm') || hint.includes('recordimms_agent') || hint.includes('agentmenu') || /\bagent\b/.test(hint);
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
  if (field.id && field.id.endsWith('_input')) {
    const labelId = `${field.id.slice(0, -6)}_label`;
    const label = document.getElementById(labelId);
    if (label) {
      label.textContent = matched.text;
      label.setAttribute('title', matched.text);
    }
  }
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

function getFieldFilledText(field) {
  if (!field) return '';
  if (field.tagName === 'SELECT') {
    const selected = field.options && field.selectedIndex >= 0 ? field.options[field.selectedIndex] : null;
    return String(selected?.text || field.value || '').trim();
  }
  const id = String(field.id || '');
  if (id.endsWith('_focus')) {
    const label = document.getElementById(id.slice(0, -6) + '_label');
    if (label) {
      const labelText = String(label.textContent || '').trim();
      return labelText;
    }
  }
  if (id.endsWith('_input')) {
    const label = document.getElementById(id.slice(0, -6) + '_label');
    if (label && String(label.textContent || '').trim()) {
      return String(label.textContent || '').trim();
    }
  }
  return String(field.value || field.textContent || '').trim();
}

function isShortAgentCandidate(value) {
  const compact = normalizeForMatch(value).replace(/[^a-z0-9]/g, '');
  return compact.length > 0 && compact.length <= 3;
}

function filledAgentTextMatchesCandidate(filledRawValue, candidate) {
  const candidateNorm = normalizeForMatch(candidate);
  if (!candidateNorm) return false;
  const filledRaw = String(filledRawValue || '').trim();
  const filledNorm = normalizeForMatch(filledRaw);
  if (!filledNorm) return false;
  if (filledNorm === candidateNorm) return true;
  // Reject if the filled text is a compound variant of the candidate (e.g. "HB-pediatric" for "HB").
  // normalizeForMatch converts dashes to spaces, so "HB-pediatric" → "hb pediatric", which would
  // otherwise pass the .includes("hb") check below and falsely accept the pediatric agent for adults.
  const candidateRaw = String(candidate || '').trim();
  if (candidateRaw && filledRaw.trim().toLowerCase().startsWith(candidateRaw.toLowerCase() + '-')) return false;
  if (filledNorm.includes(candidateNorm)) return true;

  const candidateTokens = candidateNorm.split(' ').filter(t => t.length >= 3);
  return candidateTokens.length > 0 && candidateTokens.every(t => filledNorm.includes(t));
}

function isAgentTextAccepted(candidate, filledRawValue) {
  const candidateNorm = normalizeForMatch(candidate);
  const filledRaw = String(filledRawValue || '').trim();
  const filledNorm = normalizeForMatch(filledRaw);
  if (filledAgentTextMatchesCandidate(filledRaw, candidate)) return true;

  if (isShortAgentCandidate(candidate)) {
    const token = candidateNorm.replace(/[^a-z0-9]/g, '');
    // Exact compact match: field shows precisely this code (e.g. "HB").
    const filledCompact = filledNorm.replace(/[^a-z0-9]/g, '');
    if (filledCompact === token) return true;
    // Bracket code match: field shows a display name with code in brackets (e.g. "Hepatitis B [HB]").
    // filledTokens.includes(token) is intentionally NOT used here — it would accept "HB-pediatric"
    // (normalized to "hb pediatric") for the adult "HB" candidate since "hb" appears as a token.
    const bracketMatch = filledNorm.match(/\[([^\]]+)\]/);
    return !!(bracketMatch && normalizeForMatch(bracketMatch[1]).replace(/[^a-z0-9]/g, '') === token);
  }

  const candidateTokens = candidateNorm.split(' ').filter(t => t.length >= 3);
  return candidateTokens.length > 0 && candidateTokens.every(t => filledNorm.includes(t));
}

function fieldFilledTextMatchesCandidate(field, candidate) {
  return filledAgentTextMatchesCandidate(getFieldFilledText(field), candidate);
}

function isAgentCandidateAccepted(candidate, field) {
  return isAgentTextAccepted(candidate, getFieldFilledText(field));
}

function fillPanoramaAgentField(selectors, candidate) {
  if (!candidate) return false;
  const fields = getFields(selectors).filter(canFillPanoramaControl);
  for (const field of fields) {
    if (!fillField(field, candidate)) {
      continue;
    }
    if (isAgentCandidateAccepted(candidate, field)) {
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

function parseAdministeredDateTime(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  const mdyHm = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (mdyHm) {
    const month = Number(mdyHm[1]);
    const day = Number(mdyHm[2]);
    const year = Number(mdyHm[3]);
    const hour = Number(mdyHm[4] || 0);
    const minute = Number(mdyHm[5] || 0);
    return new Date(year, month - 1, day, hour, minute, 0, 0);
  }

  return null;
}

function formatPanoramaDateValue(dateValue) {
  const yyyy = dateValue.getFullYear();
  const mm = String(dateValue.getMonth() + 1).padStart(2, '0');
  const dd = String(dateValue.getDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

function formatPanoramaTimeValue(dateValue) {
  const hh = String(dateValue.getHours()).padStart(2, '0');
  const mm = String(dateValue.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function getPanoramaAdministeredDateTimeValues(data) {
  const sourceValue = data?.administered_at || (adminDateTimeAutofillEnabled ? data?.scanned_at : '');
  const parsed = parseAdministeredDateTime(sourceValue);
  if (!parsed) {
    return { date: '', time: '' };
  }
  return {
    date: formatPanoramaDateValue(parsed),
    time: formatPanoramaTimeValue(parsed)
  };
}

function getPanoramaTradeCandidates(data) {
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
  add(data?.tradename);
  add(data?.name);
  add(data?.generic_name);
  return values;
}

function getPanoramaTradeSelectors() {
  return [
    'select[id*="immsDetailssection_createImms_tradenameinput:selectOneMenu_input"]',
    'input[id*="immsDetailssection_createImms_tradenameinput:selectOneMenu_focus"]',
    'select[id*="createImms_tradenameinput:selectOneMenu_input"]',
    'input[id*="createImms_tradenameinput:selectOneMenu_focus"]'
  ];
}

function hasPanoramaTradeSelection(data) {
  const candidates = getPanoramaTradeCandidates(data);
  if (!candidates.length) return false;
  const fields = getFields(getPanoramaTradeSelectors()).filter(canFillPanoramaControl);
  if (!fields.length) return false;
  return fields.some((field) => (
    candidates.some((candidate) => fieldFilledTextMatchesCandidate(field, candidate))
  ));
}

function fillPanoramaTradeName(data) {
  const candidates = getPanoramaTradeCandidates(data);
  if (!candidates.length) return false;
  const selectors = getPanoramaTradeSelectors();
  for (const candidate of candidates) {
    if (fillFirstMatchingField(selectors, candidate)) {
      return true;
    }
  }
  return false;
}

function getPanoramaAgentSelectors() {
  return [
    'select[id*="immsDetailssection_recordImms_agentiterm:selectOneMenu_input"]',
    'input[id*="immsDetailssection_recordImms_agentiterm:selectOneMenu_focus"]'
  ];
}

function getPanoramaCurrentAgentSelectionText() {
  const fields = getFields(getPanoramaAgentSelectors()).filter(canFillPanoramaControl);
  for (const field of fields) {
    const raw = String(getFieldFilledText(field) || '').trim();
    const norm = normalizeForMatch(raw);
    if (norm && norm !== 'select' && norm !== '--') {
      return raw;
    }
  }
  return '';
}

function hasPanoramaAgentSelection(data) {
  const fields = getFields(getPanoramaAgentSelectors()).filter(canFillPanoramaControl);
  if (!fields.length) return false;

  const candidates = getPanoramaAgentCandidates(data);
  if (!candidates.length) {
    return fields.some((field) => normalizeForMatch(getFieldFilledText(field)).length > 0);
  }

  return fields.some((field) => candidates.some((candidate) => isAgentCandidateAccepted(candidate, field)));
}

function queueRecordMatchesPanoramaAgentText(record, agentText) {
  const payload = buildAutofillPayloadFromQueueRecord(record);
  if (!payload) return false;
  const candidates = getPanoramaAgentCandidates(payload);
  return candidates.some((candidate) => isAgentTextAccepted(candidate, agentText));
}

function findMatchingQueueRecordIndexForPanoramaAgent(rows, agentText) {
  const raw = String(agentText || '').trim();
  if (!raw || !Array.isArray(rows) || !rows.length) return -1;
  return rows.findIndex((row) => queueRecordMatchesPanoramaAgentText(row, raw));
}

function tryFillPanoramaAgent(data) {
  const candidates = getPanoramaAgentCandidates(data);
  if (!candidates.length) return false;
  const selectors = getPanoramaAgentSelectors();
  for (const candidate of candidates) {
    if (fillPanoramaAgentField(selectors, candidate)) {
      return true;
    }
  }
  return false;
}

function hasPanoramaDeferredDetailData(data) {
  const administered = getPanoramaAdministeredDateTimeValues(data);
  return !!(administered.date || administered.time);
}

function getPanoramaAdministeredDateTimeFields() {
  return {
    dateField: getFields([
      'input[id*="immsDetailssection_dateAdministedDate:dateInput_input"]',
      'input[id*="dateAdministedDate:dateInput_input"]'
    ]).find(field => canFillPanoramaControl(field) && isVisible(field)),
    timeField: getFields([
      'input[id*="immsDetailssection_dateAdministedDate:timeInput:timeInput"]',
      'input[id*="dateAdministedDate:timeInput:timeInput"]'
    ]).find(field => canFillPanoramaControl(field) && isVisible(field))
  };
}

function hasPanoramaDeferredDetailFieldsFilled(data) {
  const administered = getPanoramaAdministeredDateTimeValues(data);
  if (!administered.date && !administered.time) return true;

  const { dateField, timeField } = getPanoramaAdministeredDateTimeFields();
  const dateMatches = !administered.date || String(dateField?.value || '').trim() === administered.date;
  const timeMatches = !administered.time || String(timeField?.value || '').trim() === administered.time;
  return dateMatches && timeMatches;
}

function fillPanoramaMaskedTextInput(field, nextValue) {
  if (!field || !nextValue) return false;
  const value = String(nextValue).trim();
  if (!value) return false;
  field.focus();
  field.value = '';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1) || '0', bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  field.blur();
  return String(field.value || '').trim() === value;
}

function fillPanoramaAdministeredDateTimeFields(data) {
  const administered = getPanoramaAdministeredDateTimeValues(data);
  if (!administered.date && !administered.time) return 0;

  const { dateField, timeField } = getPanoramaAdministeredDateTimeFields();

  let fillCount = 0;
  if (administered.date && fillPanoramaMaskedTextInput(dateField, administered.date)) {
    fillCount += 1;
  }
  if (administered.time && fillPanoramaMaskedTextInput(timeField, administered.time)) {
    fillCount += 1;
  }
  return fillCount;
}

function isPrimeFacesAjaxBusy() {
  try {
    const queue = globalThis.PrimeFaces && globalThis.PrimeFaces.ajax && globalThis.PrimeFaces.ajax.Queue;
    if (!queue) return false;
    if (typeof queue.isEmpty === 'function') {
      return !queue.isEmpty();
    }
    if (Array.isArray(queue.requests)) {
      return queue.requests.length > 0;
    }
  } catch (_) {
    return false;
  }
  return false;
}

function buildPanoramaDeferredDetailMappings(data) {
  void data;
  return [];
}

function fillPanoramaDeferredDetailFields(data) {
  if (!data) return 0;
  return fillPanoramaAdministeredDateTimeFields(data);
}

function normalizePanoramaLotToken(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

// Inventory confirmed these product families can legitimately carry the same
// lot in both Panorama funding buckets. For them, falling back to SHOW_ALL can
// silently select the wrong funding row, so VaxLink must keep funding explicit.
const PANORAMA_SHARED_FUNDING_LOT_PRODUCTS = Object.freeze([
  { label: 'Arexvy', terms: ['arexvy'] },
  { label: 'Bexsero', terms: ['bexsero'] },
  { label: 'Engerix B', terms: ['engerix b'] },
  { label: 'Gardasil 9', terms: ['gardasil 9'] },
  { label: 'Havrix', terms: ['havrix 1440', 'havrix 720', 'havrix'] },
  { label: 'Avaxim', terms: ['avaxim'] },
  { label: 'Nimenrix', terms: ['nimenrix'] },
  { label: 'RabAvert', terms: ['rabavert'] },
  { label: 'Imovax Rabies', terms: ['imovax rabies'] },
  { label: 'Shingrix', terms: ['shingrix'] },
  { label: 'Tubersol', terms: ['tubersol'] }
]);

function buildPanoramaFundingSourceText(data) {
  return normalizeForMatch([
    data?.name,
    data?.tradename,
    data?.generic_name
  ].filter(Boolean).join(' '));
}

function getPanoramaSharedFundingLotProductLabel(data) {
  const source = buildPanoramaFundingSourceText(data);
  if (!source) return '';
  for (const product of PANORAMA_SHARED_FUNDING_LOT_PRODUCTS) {
    if ((product.terms || []).some((term) => source.includes(normalizeForMatch(term)))) {
      return product.label;
    }
  }
  return '';
}

function hasPanoramaFundedRadio() {
  return !!document.querySelector('input[id*="fundedRadio:selectOneRadio"]');
}

function getPanoramaFundedRadioValue() {
  const checked = Array.from(document.querySelectorAll('input[id*="fundedRadio:selectOneRadio"]'))
    .find((radio) => radio && radio.checked);
  return String(checked?.value || '').trim();
}

function isExplicitPanoramaFundingValue(value) {
  return value === 'PUBLICLY_FUNDED' || value === 'NON_PUBLICLY_FUNDED';
}

function getPanoramaFundingLabel(value) {
  if (value === 'PUBLICLY_FUNDED') return 'Publicly Funded';
  if (value === 'NON_PUBLICLY_FUNDED') return 'Non-Publicly Funded';
  if (value === 'SHOW_ALL') return 'Show All';
  return 'funding filter';
}

function optionTextMatchesLotExactly(optionText, lotValue) {
  const lotToken = normalizePanoramaLotToken(lotValue);
  if (!lotToken) return false;
  const rawText = String(optionText || '');
  // Panorama options look like "LOT123 - Exp. 2026-01-31"; the lot is the
  // left-of-dash token. Exact equality avoids "ABC1" selecting "ABC12".
  const leftPart = rawText.split('-')[0] || rawText;
  return normalizePanoramaLotToken(leftPart) === lotToken;
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

// Prefer an exact lot match across all candidates before falling back to a
// substring match, so a scanned lot that prefixes a longer lot in the
// dropdown never selects the wrong one.
function findBestLotMatch(candidates, getText, lotValue) {
  return candidates.find(c => optionTextMatchesLotExactly(getText(c), lotValue))
    || candidates.find(c => optionTextContainsLot(getText(c), lotValue))
    || null;
}

function fillPanoramaLotFromSelect(lotValue) {
  const selectors = [
    'select[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_input"]',
    'select[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_input"]',
    'select[id*="LotInfo:lotNumberSelect:selectOneMenu_input"]'
  ];
  const fields = getFields(selectors).filter(canFillPanoramaControl);
  for (const field of fields) {
    const options = Array.from(field.options || []).filter(opt => opt && opt.value !== '');
    const matched = findBestLotMatch(options, opt => opt.text, lotValue);
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

function setPanoramaFundedRadioValue(value) {
  const desired = String(value || '').trim();
  const radio = document.querySelector(`input[id*="fundedRadio:selectOneRadio"][value="${desired}"]`);
  if (!radio) return 'not_found';
  if (radio.checked) return 'already';
  const box = radio.closest('.ui-radiobutton')?.querySelector('.ui-radiobutton-box');
  if (box) box.click();
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
  vlog('VaxLink: funded radio set to', desired);
  return 'clicked';
}

function resetPanoramaFundedRadioToShowAll() {
  return setPanoramaFundedRadioValue('SHOW_ALL');
}

function openPanoramaLotDropdown() {
  const selectors = [
    '[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu"] .ui-selectonemenu-trigger',
    '[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu"] .ui-selectonemenu-trigger',
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
    'input[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_filter"]',
    'input[id*="LotInfo:lotNumberSelect:selectOneMenu_filter"]'
  ];
  const lotText = String(lotValue || '');
  const lotToken = normalizePanoramaLotToken(lotText);
  const filters = getFields(filterSelectors).filter(canFillPanoramaControl);
  for (const filterInput of filters) {
    filterInput.focus();
    filterInput.value = lotText;
    filterInput.dispatchEvent(new Event('input', { bubbles: true }));
    filterInput.dispatchEvent(new KeyboardEvent('keyup', { key: lotText.slice(-1) || 'a', bubbles: true }));
    filterInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const itemSelectors = [
    'li[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_"]',
    'li[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_"]',
    'li[id*="LotInfo:lotNumberSelect:selectOneMenu_"]',
    '.ui-selectonemenu-panel .ui-selectonemenu-item'
  ];
  for (const selector of itemSelectors) {
    const items = Array.from(document.querySelectorAll(selector))
      .filter((item) => {
        if (!item) return false;
        if (item.classList && item.classList.contains('ui-helper-hidden')) return false;
        const text = String(
          item.getAttribute?.('data-label')
          || item.getAttribute?.('title')
          || item.textContent
          || ''
        ).trim();
        return isVisible(item) && text.length > 0;
      });
    const getItemText = (item) => String(
      item.getAttribute?.('data-label')
      || item.getAttribute?.('title')
      || item.textContent
      || ''
    );
    const matched = findBestLotMatch(items, getItemText, lotValue);
    if (!matched) continue;
    matched.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    matched.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    matched.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    matched.click();
    const selectedLotLabels = getFields([
      'label[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_label"]',
      'label[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_label"]',
      'label[id*="LotInfo:lotNumberSelect:selectOneMenu_label"]'
    ]);
    const confirmed = selectedLotLabels.some((label) => (
      normalizePanoramaLotToken(label?.textContent || '').includes(lotToken)
    ));
    if (confirmed) {
      return true;
    }
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
  if (!data) return false;
  if (data.lot) return tryFillPanoramaLot(data.lot);
  return fillPanoramaTradeName(data);
}

function hasPanoramaLotSelection(lotValue) {
  if (!lotValue) return false;

  const selectFields = getFields([
    'select[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_input"]',
    'select[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_input"]',
    'select[id*="LotInfo:lotNumberSelect:selectOneMenu_input"]'
  ]).filter(canFillPanoramaControl);
  if (selectFields.some((field) => optionTextContainsLot(getFieldFilledText(field), lotValue))) {
    return true;
  }

  const selectedLotLabels = getFields([
    'label[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_label"]',
    'label[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_label"]',
    'label[id*="LotInfo:lotNumberSelect:selectOneMenu_label"]'
  ]);
  return selectedLotLabels.some((label) => optionTextContainsLot(label?.textContent || '', lotValue));
}

function hasPanoramaLotOrTradeSelection(data) {
  if (!data) return false;
  if (data.lot) {
    return hasPanoramaLotSelection(data.lot);
  }
  return hasPanoramaTradeSelection(data);
}

let stopPanoramaLotTradeWatcher = null;

// Issue #26: a real user interaction with the agent/lot/tradename widgets means
// the nurse is taking over — pending VaxLink fill retries must not overwrite
// her choice. PrimeFaces re-dispatches synthetic events (isTrusted === false),
// and so do VaxLink's own fills, so only trusted events count as manual.
const PANORAMA_AGENT_LOT_WIDGET_ID_PATTERN = /agentiterm|tradenameinput|lotnumberselect/i;

function isPanoramaAgentLotWidgetNode(node) {
  if (!node || typeof node.closest !== 'function') return false;
  const widget = node.closest('.ui-selectonemenu, .ui-selectonemenu-panel, select');
  if (!widget) return false;
  return PANORAMA_AGENT_LOT_WIDGET_ID_PATTERN.test(String(widget.id || ''));
}

function cancelPanoramaFillRetriesForManualEdit(event) {
  if (!event.isTrusted) return;
  if (typeof stopPanoramaLotTradeWatcher !== 'function') return;
  if (!isPanoramaAgentLotWidgetNode(event.target)) return;
  stopPanoramaLotTradeWatcher();
  stopPanoramaLotTradeWatcher = null;
  vlog('manual agent/lot interaction — cancelled pending VaxLink fill retries');
}

function schedulePanoramaLotOrTradeSelection(data, initialDelayMs = 0, options = {}) {
  if (!data) return;
  if (typeof stopPanoramaLotTradeWatcher === 'function') {
    stopPanoramaLotTradeWatcher();
    stopPanoramaLotTradeWatcher = null;
  }

  const hasLot = !!String(data?.lot || '').trim();
  const hasTrade = getPanoramaTradeCandidates(data).length > 0;
  const hasAgent = getPanoramaAgentCandidates(data).length > 0;
  const shouldTryLotOrTrade = hasLot || hasTrade;
  const shouldFillDeferredFields = hasPanoramaDeferredDetailData(data);
  if (!shouldTryLotOrTrade && !shouldFillDeferredFields && !hasAgent) {
    return;
  }

  const maxDurationMs = 16000;
  const attemptDelaysMs = [0, 120, 260, 450, 800, 1300, 1900, 2800, 4100, 5600, 8000, 11000, 14000];
  const minAttemptGapMs = 110;
  let observer = null;
  const timers = [];
  let stopped = false;
  let lastAttemptAt = 0;
  let stablePasses = 0;
  let fundedRadioEnsured = !!options.fundedRadioEnsured;
  const preserveFundingFilter = options.preserveFundingFilter === true;
  let sharedFundingMisses = 0;
  let finalizeOnResolved = options.finalizeOnResolved === true;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    while (timers.length > 0) {
      const timer = timers.pop();
      clearTimeout(timer);
    }
    if (stopPanoramaLotTradeWatcher === stop) {
      stopPanoramaLotTradeWatcher = null;
    }
  };
  stopPanoramaLotTradeWatcher = stop;

  const runAttempt = () => {
    if (stopped) return;
    const now = Date.now();
    if ((now - lastAttemptAt) < minAttemptGapMs) return;
    lastAttemptAt = now;
    const busy = isPrimeFacesAjaxBusy();

    let hasResolvedAgent = !hasAgent || hasPanoramaAgentSelection(data);
    if (!hasResolvedAgent && !busy) {
      hasResolvedAgent = tryFillPanoramaAgent(data) || hasPanoramaAgentSelection(data);
    }

    let resolved = !shouldTryLotOrTrade;
    if (!resolved && hasResolvedAgent) {
      resolved = hasPanoramaLotOrTradeSelection(data);
    }
    if (!resolved && hasResolvedAgent && !busy) {
      if (preserveFundingFilter && hasLot && hasPanoramaFundedRadio()) {
        const fundedValue = getPanoramaFundedRadioValue();
        if (!isExplicitPanoramaFundingValue(fundedValue)) {
          showVaxlinkToast({
            ...data,
            _sharedFundingLotFilterRequired: true,
            _sharedFundingLotLabel: getPanoramaSharedFundingLotProductLabel(data),
            _fundedRadioValue: fundedValue
          }, 12000);
          stop();
          return;
        }
      }

      // Try lot fill with the current radio state first — avoids triggering a
      // funded-radio AJAX that can reset the agent and create a re-fill cascade.
      resolved = tryFillPanoramaLotOrTrade(data) || hasPanoramaLotOrTradeSelection(data);
      if (!resolved && preserveFundingFilter && hasLot && hasPanoramaFundedRadio()) {
        sharedFundingMisses += 1;
        if (sharedFundingMisses >= 3) {
          showVaxlinkToast({
            ...data,
            _sharedFundingLotSwitchFilter: true,
            _sharedFundingLotLabel: getPanoramaSharedFundingLotProductLabel(data),
            _fundedRadioValue: getPanoramaFundedRadioValue()
          }, 12000);
          stop();
          return;
        }
      } else if (resolved) {
        sharedFundingMisses = 0;
      }
      if (!resolved && !fundedRadioEnsured && !preserveFundingFilter) {
        fundedRadioEnsured = true;
        const radioResult = resetPanoramaFundedRadioToShowAll();
        if (radioResult === 'clicked') return; // wait for AJAX to refresh lot panel
        // Radio was already at SHOW_ALL or not found — retry immediately
        resolved = tryFillPanoramaLotOrTrade(data) || hasPanoramaLotOrTradeSelection(data);
      }
    }

    if (!resolved && hasLot && hasResolvedAgent && !busy) {
      if (!hasPanoramaLotSelection(data?.lot)) {
        openPanoramaLotDropdown();
      }
      resolved = fillPanoramaLotFromPanelItems(data?.lot) || hasPanoramaLotSelection(data?.lot) || resolved;
    }

    let deferredResolved = !shouldFillDeferredFields || hasPanoramaDeferredDetailFieldsFilled(data);
    if (!deferredResolved && !busy) {
      fillPanoramaDeferredDetailFields(data);
      deferredResolved = hasPanoramaDeferredDetailFieldsFilled(data);
    }

    // Require a stable follow-up pass before stopping so we do not exit while
    // PrimeFaces is still applying dependent field refreshes.
    if (!busy && resolved && deferredResolved) {
      stablePasses += 1;
    } else {
      stablePasses = 0;
    }

    if (stablePasses >= 2) {
      if (finalizeOnResolved) {
        finalizeOnResolved = false;
        void finalizeDeferredPanoramaAutofill(data);
      }
      stop();
    }
  };

  const start = () => {
    if (stopped) return;
    for (const delayMs of attemptDelaysMs) {
      timers.push(setTimeout(runAttempt, delayMs));
    }
    timers.push(setTimeout(stop, maxDurationMs));
    timers.push(setInterval(runAttempt, 500));

    if (typeof MutationObserver === 'function' && document.body) {
      observer = new MutationObserver(() => {
        runAttempt();
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'aria-expanded']
      });
    }
  };

  timers.push(setTimeout(start, Math.max(0, Number(initialDelayMs) || 0)));
}

function isPanoramaRecordImmsPage() {
  try {
    const host = String(window.location.hostname || '').toLowerCase();
    const isPanorama =
      host === 'www.panorama.prod.ehealthontario.ca' ||
      host === 'panorama.prod.ehealthontario.ca';
    if (!isPanorama) return false;
    return window.location.pathname.toLowerCase().includes('/recordimms/');
  } catch {
    return false;
  }
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
  const sharedFundingProductLabel = getPanoramaSharedFundingLotProductLabel(data);
  const preserveFundingFilter = !!(sharedFundingProductLabel && String(data?.lot || '').trim());
  const fundedValue = getPanoramaFundedRadioValue();
  if (preserveFundingFilter && hasPanoramaFundedRadio() && !isExplicitPanoramaFundingValue(fundedValue)) {
    showVaxlinkToast({
      ...data,
      _sharedFundingLotFilterRequired: true,
      _sharedFundingLotLabel: sharedFundingProductLabel,
      _fundedRadioValue: fundedValue
    }, 12000);
    return createAutofillResult('pending', { reason: 'funding_choice_required' });
  }

  // Switch to SHOW_ALL early, before the agent/lot AJAX settles, so the radio's
  // own AJAX cascade doesn't land mid-fill and reset the agent (issue: lot and
  // expiry not selected after selecting the agent). The scheduler below only
  // falls back to resetting it again if this attempt found no radio at all.
  const radioResult = preserveFundingFilter ? 'preserved' : resetPanoramaFundedRadioToShowAll();

  let agentCount = 0;
  if (hasPanoramaAgentSelection(data) || tryFillPanoramaAgent(data)) {
    agentCount = 1;
  }

  let fillCount = agentCount;
  const lotCount = (data.lot && !isPrimeFacesAjaxBusy()) ? (tryFillPanoramaLot(data.lot) ? 1 : 0) : 0;
  fillCount += lotCount;
  fillCount += fillPanoramaDeferredDetailFields(data);

  // Panorama refreshes lot options and dependent controls asynchronously after selection.
  const finalizeOnResolved = preserveFundingFilter && !!data?.lot && !hasPanoramaLotSelection(data.lot);
  if (agentCount > 0 || data.lot || hasPanoramaDeferredDetailData(data) || getPanoramaTradeCandidates(data).length > 0) {
    schedulePanoramaLotOrTradeSelection(data, agentCount > 0 ? 1200 : 350, {
      fundedRadioEnsured: !preserveFundingFilter && radioResult !== 'not_found',
      preserveFundingFilter,
      finalizeOnResolved
    });
  }

  if (preserveFundingFilter && data?.lot) {
    if (hasPanoramaLotSelection(data.lot)) {
      return createAutofillResult('success', { fillCount });
    }
    return createAutofillResult('pending', {
      reason: 'waiting_for_lot_resolution',
      fillCount
    });
  }

  if (fillCount > 0) {
    return createAutofillResult('success', { fillCount });
  }

  // If agent did not fill, still attempt lot/trade directly.
  if (tryFillPanoramaLotOrTrade(data)) {
    fillCount += 1;
  }
  if (fillCount > 0) {
    return createAutofillResult('success', { fillCount });
  }

  const fallbackMapping = [
    {
      value: getPanoramaAgentCandidates(data)[0] || (data.name || data.generic_name || data.tradename || data.din),
      labels: ['Agent'],
      preferLast: false
    }
  ];

  let fallbackCount = 0;
  const usedFields = new Set();
  for (const entry of fallbackMapping) {
    if (!entry.value) continue;
    const field = findFieldByLabelText(entry.labels, { preferLast: entry.preferLast });
    if (!field || usedFields.has(field)) continue;
    if (!fillField(field, entry.value)) {
      continue;
    }
    if (entry.labels && entry.labels.includes('Agent') && !isAgentCandidateAccepted(entry.value, field)) {
      continue;
    }
    {
      usedFields.add(field);
      fallbackCount += 1;
    }
  }
  return createAutofillResult(fallbackCount > 0 ? 'success' : 'failed', { fillCount: fallbackCount });
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

function getNormalizedSourceTokens(sourceText) {
  return String(sourceText || '')
    .split(' ')
    .map(token => token.trim())
    .filter(Boolean);
}

function panoramaSourceHasNormalizedTerm(sourceText, sourceTokens, term) {
  const normalizedTerm = normalizeForMatch(term);
  if (!normalizedTerm) return false;

  const termTokens = normalizedTerm.split(' ').filter(Boolean);
  if (!termTokens.length) return false;

  if (termTokens.length === 1) {
    const token = termTokens[0];
    // Keep short rule terms strict (e.g., "tig", "hb", "mmr") so they do not
    // match inside longer words like "antigen".
    if (token.length <= 3) {
      return sourceTokens.includes(token);
    }
    return sourceTokens.includes(token) || sourceText.includes(token);
  }

  if (sourceText.includes(normalizedTerm)) {
    return true;
  }

  return termTokens.every((token) => (
    token.length <= 3
      ? sourceTokens.includes(token)
      : (sourceTokens.includes(token) || sourceText.includes(token))
  ));
}

function panoramaSourceHasAll(sourceText, sourceTokens, terms) {
  return terms.every(term => panoramaSourceHasNormalizedTerm(sourceText, sourceTokens, term));
}

function panoramaSourceHasAny(sourceText, sourceTokens, terms) {
  return terms.some(term => panoramaSourceHasNormalizedTerm(sourceText, sourceTokens, term));
}

function panoramaAgentRuleClauseMatches(sourceText, clause) {
  const sourceTokens = getNormalizedSourceTokens(sourceText);
  if (clause.any && !panoramaSourceHasAny(sourceText, sourceTokens, clause.any)) return false;
  if (clause.all && !panoramaSourceHasAll(sourceText, sourceTokens, clause.all)) return false;
  if (clause.notAny && panoramaSourceHasAny(sourceText, sourceTokens, clause.notAny)) return false;
  if (clause.notAll && panoramaSourceHasAll(sourceText, sourceTokens, clause.notAll)) return false;
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

  add(data?.tradename);
  add(data?.generic_name);
  add(data?.name);

  const sourceText = buildPanoramaAgentSourceText(data);
  for (const rule of PANORAMA_AGENT_RULES) {
    if (!panoramaAgentRuleMatches(sourceText, rule)) continue;
    for (const output of rule.outputs || []) {
      add(output);
    }
  }

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

function buildAutofillPayloadFromQueueRecord(record) {
  if (!record) return null;
  const payload = {
    scanned_at: record.scanned_at || '',
    gtin: record.gtin || '',
    lot: record.lot || '',
    serial: record.serial || '',
    expiry: record.barcode_expiry || record.inventory_expiry || '',
    inventory_expiry: record.inventory_expiry || record.barcode_expiry || '',
    nvc_lot_expiry: record.nvc_lot_expiry || '',
    expiry_flag: record.expiry_flag || '',
    expiry_days_remaining: record.expiry_days_remaining ?? '',
    expiry_source: record.expiry_source || (record.barcode_expiry ? 'barcode' : 'none'),
    tradename: record.tradename || '',
    generic_name: record.generic_name || '',
    disease: record.disease || '',
    antigen: record.antigen || '',
    manufacturer: record.manufacturer || '',
    route: record.route || '',
    strength: record.strength || '',
    dose_value: record.dose_value || '',
    dose_unit: record.dose_unit || '',
    din: record.din || '',
    drug_code: record.drug_code || record.din || '',
    lookup_error: record.lookup_error || '',
    name: record.name || record.generic_name || record.tradename || record.din || ''
  };
  if (adminDateTimeAutofillEnabled) {
    payload.administered_at = record.scanned_at || new Date().toISOString();
  }
  return payload;
}

function createAutofillResult(status, extra = {}) {
  return { status, ...extra };
}

function isAutofillSuccess(result) {
  return !!result && result.status === 'success';
}

function isAutofillPending(result) {
  return !!result && result.status === 'pending';
}

async function consumeQueueRecordAfterDeferredAutofill(queueContext) {
  const storageKey = String(queueContext?.storageKey || '').trim();
  const recordId = String(queueContext?.recordId || '').trim();
  if (!storageKey || !recordId) {
    return null;
  }

  const stored = await getLocalStorage([storageKey]);
  const rows = (stored && Array.isArray(stored[storageKey])) ? stored[storageKey] : [];
  const recordIndex = rows.findIndex((row) => row && String(row.id || '') === recordId);
  if (recordIndex < 0) {
    return null;
  }

  const record = rows[recordIndex];
  const nextRows = buildQueueRowsAfterRecordUse(rows, record, recordIndex);
  await setLocalStorage({ [storageKey]: nextRows });

  const workflow = queueContext.workflow || 'multiple';
  const source = queueContext.source || 'queue';
  const expiryFlag = record.expiry_flag || getExpiryStatus(record.inventory_expiry || record.barcode_expiry).flag;
  logAnalyticsEvent('queue_used', {
    workflow,
    queue: queueContext.queue || workflow,
    source,
    count: 1,
    queueSizeAfter: nextRows.length,
    vaccineLabel: record.tradename || record.generic_name || record.name || record.lot || '',
    manufacturer: record.manufacturer || '',
    expiryFlag
  });
  logAnalyticsEvent('autofill_result', {
    workflow,
    source,
    success: true,
    deferred: true,
    vaccineLabel: record.tradename || record.generic_name || record.name || record.lot || '',
    manufacturer: record.manufacturer || '',
    expiryFlag
  });

  return { record, queueSizeAfter: nextRows.length };
}

async function finalizeDeferredPanoramaAutofill(data) {
  if (!data || data._vaxlinkDeferredFinalized) {
    return;
  }
  data._vaxlinkDeferredFinalized = true;

  try {
    await consumeQueueRecordAfterDeferredAutofill(data._vaxlinkQueueContext);
  } catch (error) {
    console.warn('VaxLink deferred queue finalize failed:', error);
  }

  showVaxlinkToast(data);
}

function autoFillTelus(data) {
  try {
    if (isPanoramaImmunizationPage()) {
      const panoramaResult = fillPanoramaImmunizationFields(data);
      vlog('Panorama autofill result', panoramaResult?.status, panoramaResult);
      lastVaxlinkFillAt = Date.now();
      return panoramaResult;
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
    return createAutofillResult(fillCount > 0 ? 'success' : 'failed', { fillCount });
  } catch (e) {
    console.error('Auto-fill error:', e);
    return createAutofillResult('failed', { error: e.message || 'Auto-fill failed' });
  }
}

// ---------------------------------------------------------------------------
// Scanner-triggered mode switch (VAXLINK: command barcodes)
// ---------------------------------------------------------------------------

function handleVaxlinkCommand(value) {
  const upper = String(value).trim().toUpperCase();
  if (!upper.startsWith('VAXLINK:')) return false;
  const command = upper.slice('VAXLINK:'.length).trim();
  const modeMap = { SINGLE: 'single', MULTIPLE: 'multiple', INVENTORY: 'inventory' };
  const newMode = modeMap[command];
  if (!newMode) {
    vlog('unknown VAXLINK command', command);
    return true;
  }
  activeWorkflowMode = newMode;
  chrome.storage.local.set({ [WORKFLOW_MODE_KEY]: newMode });
  logAnalyticsEvent('workflow_mode_set', { workflow: newMode, source: 'scanner_command' });
  showVaxlinkToast({ _commandMode: newMode });
  vlog('scanner command mode switch', newMode);
  return true;
}

// ---------------------------------------------------------------------------
// In-page toast notifications
// ---------------------------------------------------------------------------

let toastHost = null;
let toastRoot = null;
// Two stacked slots so a persistent expired warning and routine feedback
// (queued / duplicate / mode switch) can coexist instead of clobbering each
// other (issue #28): warning on top, routine toasts below it.
let toastWarningSlot = null;
let toastRoutineSlot = null;
let toastDismissTimer = null;

function ensureToastHost() {
  if (toastHost && document.body.contains(toastHost)) return toastRoot;
  toastHost = document.createElement('div');
  toastHost.id = 'vaxlink-toast-host';
  const shadow = toastHost.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .vl-toast-stack {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      pointer-events: none;
    }
    .vl-toast {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      line-height: 1.4;
      padding: 10px 16px;
      border-radius: 8px;
      color: #fff;
      max-width: 360px;
      box-shadow: 0 4px 14px rgba(0,0,0,.25);
      opacity: 0;
      transform: translateY(-8px);
      transition: opacity .2s, transform .2s;
      pointer-events: none;
    }
    .vl-toast.show {
      opacity: 1;
      transform: translateY(0);
    }
    .vl-toast.valid   { background: #047857; }
    .vl-toast.expiring { background: #b45309; }
    .vl-toast.expired  { background: #b91c1c; }
    .vl-toast.info     { background: #0e7490; }
    .vl-toast.duplicate { background: #52525b; }
    .vl-toast.persistent { pointer-events: auto; }
    .vl-toast-dismiss {
      margin-top: 8px;
      padding: 4px 10px;
      border: 1px solid rgba(255,255,255,.6);
      border-radius: 5px;
      background: rgba(0,0,0,.25);
      color: #fff;
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .vl-toast-dismiss:hover { background: rgba(0,0,0,.4); }
    .vl-toast-title { font-weight: 600; margin-bottom: 2px; }
    .vl-toast-detail { opacity: .9; font-size: 12px; }
    .vl-toast-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 10px;
    }
    .vl-toast-action {
      padding: 5px 10px;
      border: 1px solid rgba(255,255,255,.65);
      border-radius: 6px;
      background: rgba(255,255,255,.14);
      color: #fff;
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .vl-toast-action:hover { background: rgba(255,255,255,.22); }
    .vl-toast-action.secondary {
      background: rgba(0,0,0,.22);
      border-color: rgba(255,255,255,.35);
    }
  `;
  shadow.appendChild(style);
  toastRoot = document.createElement('div');
  toastRoot.className = 'vl-toast-stack';
  toastWarningSlot = document.createElement('div');
  toastRoutineSlot = document.createElement('div');
  toastRoot.appendChild(toastWarningSlot);
  toastRoot.appendChild(toastRoutineSlot);
  shadow.appendChild(toastRoot);
  document.body.appendChild(toastHost);
  return toastRoot;
}

function showVaxlinkToast(data, durationMs = 4000) {
  if (!isHandsFreeSupportedPage()) return;
  ensureToastHost();

  // Routine toasts share one slot and one auto-dismiss timer; the persistent
  // expired warning lives in its own slot above and is never replaced by them.
  const showRoutineToast = (html, ms, options = {}) => {
    if (toastDismissTimer) {
      clearTimeout(toastDismissTimer);
      toastDismissTimer = null;
    }
    toastRoutineSlot.innerHTML = html;
    if (!options.persistent) {
      toastDismissTimer = setTimeout(() => dismissToast(toastRoutineSlot), ms);
    }
  };

  if (data._commandMode) {
    const modeLabels = { single: 'Single Inject', multiple: 'Multiple Inject', inventory: 'Inventory' };
    const sourceDetail = data._commandSource === 'hud'
      ? 'Switched from VaxLink HUD'
      : 'Switched via scanner command';
    showRoutineToast(`<div class="vl-toast info show">
      <div class="vl-toast-title">Mode: ${modeLabels[data._commandMode] || data._commandMode}</div>
      <div class="vl-toast-detail">${sourceDetail}</div>
    </div>`, durationMs);
    return;
  }

  if (data._queueEmpty) {
    showRoutineToast(`<div class="vl-toast info show">
      <div class="vl-toast-title">Queue empty</div>
      <div class="vl-toast-detail">Scan more vaccines or switch to Single mode</div>
    </div>`, durationMs);
    return;
  }

  if (data._stepMatchMissing) {
    showRoutineToast(`<div class="vl-toast info show">
      <div class="vl-toast-title">No queued match for this agent</div>
      <div class="vl-toast-detail">Panorama selected an agent that is not represented in the queue. VaxLink left the queue unchanged.</div>
    </div>`, durationMs + 2000);
    return;
  }

  if (data._sharedFundingLotFilterRequired || data._sharedFundingLotSwitchFilter) {
    const productLabel = data._sharedFundingLotLabel || data.tradename || data.generic_name || data.name || 'This product';
    const needsInitialChoice = !!data._sharedFundingLotFilterRequired;
    const title = needsInitialChoice ? 'Choose PF or NPF' : 'Try the other funding bucket';
    const detail = needsInitialChoice
      ? `${productLabel} can use the same lot in both Panorama funding buckets.`
      : `${productLabel}${data.lot ? ` lot ${data.lot}` : ''} was not found under ${getPanoramaFundingLabel(data._fundedRadioValue)}.`;
    const followUp = needsInitialChoice
      ? `Pick Publicly Funded or Non-Publicly Funded and VaxLink will continue automatically.`
      : 'Pick the funding bucket to try and VaxLink will continue automatically.';

    showRoutineToast(`<div class="vl-toast info persistent show">
      <div class="vl-toast-title">${escapeToastHtml(title)}</div>
      <div class="vl-toast-detail">${escapeToastHtml(detail)}</div>
      <div class="vl-toast-detail">${escapeToastHtml(followUp)}</div>
      <div class="vl-toast-actions">
        <button class="vl-toast-action" type="button" data-vl-funded-choice="PUBLICLY_FUNDED">Publicly Funded</button>
        <button class="vl-toast-action" type="button" data-vl-funded-choice="NON_PUBLICLY_FUNDED">Non-Publicly Funded</button>
        <button class="vl-toast-action secondary" type="button" data-vl-funded-choice-dismiss="true">Not now</button>
      </div>
    </div>`, durationMs, { persistent: true });

    toastRoutineSlot.querySelectorAll('[data-vl-funded-choice]').forEach((button) => {
      button.addEventListener('click', async () => {
        const fundedChoice = button.getAttribute('data-vl-funded-choice');
        if (toastDismissTimer) {
          clearTimeout(toastDismissTimer);
          toastDismissTimer = null;
        }
        toastRoutineSlot.innerHTML = '';
        const radioResult = setPanoramaFundedRadioValue(fundedChoice);
        if (radioResult === 'not_found') {
          showRoutineToast(`<div class="vl-toast info show">
            <div class="vl-toast-title">Funding selector not found</div>
            <div class="vl-toast-detail">Panorama did not expose the PF/NPF selector yet. Try again once the lot section finishes loading.</div>
          </div>`, 7000);
          return;
        }
        const autofillResult = autoFillTelus(data);
        if (isAutofillSuccess(autofillResult)) {
          await finalizeDeferredPanoramaAutofill(data);
        }
      });
    });
    const dismissBtn = toastRoutineSlot.querySelector('[data-vl-funded-choice-dismiss]');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => dismissToast(toastRoutineSlot));
    }
    return;
  }

  const label = data.tradename || data.generic_name || data.name || data.lot || 'Vaccine';
  const lot = data.lot || '';
  const flag = data.expiry_flag || getExpiryStatus(data.inventory_expiry || data.expiry || data.nvc_lot_expiry).flag;
  const expiry = data.inventory_expiry || data.expiry || data.nvc_lot_expiry || '';

  let expiryText = '';
  if (expiry) {
    const friendlyDate = expiry.length > 10 ? expiry.slice(0, 10) : expiry;
    const flagLabels = { valid: 'Valid', expiring_soon: 'Expiring soon', expired: 'Expired' };
    expiryText = `${flagLabels[flag] || 'Unknown'} (exp ${friendlyDate})`;
  }
  const detail = [lot ? `Lot ${lot}` : '', expiryText].filter(Boolean).join(' \u2014 ');

  if (data._duplicateIgnored) {
    showRoutineToast(`<div class="vl-toast duplicate show">
      <div class="vl-toast-title">Duplicate scan ignored</div>
      <div class="vl-toast-detail">${escapeToastHtml(label)} is already in the queue</div>
      ${detail ? `<div class="vl-toast-detail">${escapeToastHtml(detail)}</div>` : ''}
    </div>`, durationMs);
    return;
  }

  const cssClass = flag === 'expired' ? 'expired' : (flag === 'expiring_soon' ? 'expiring' : 'valid');
  const isExpired = flag === 'expired';
  const queuedNote = data._queuedCount
    ? `<div class="vl-toast-detail">Added to queue (${Number(data._queuedCount)} queued)</div>`
    : '';

  const toastHtml = `<div class="vl-toast ${cssClass}${isExpired ? ' persistent' : ''} show">
    <div class="vl-toast-title">${isExpired ? '\u26a0 Expired vaccine scanned' : escapeToastHtml(label)}</div>
    ${isExpired ? `<div class="vl-toast-detail">${escapeToastHtml(label)}</div>` : ''}
    ${detail ? `<div class="vl-toast-detail">${escapeToastHtml(detail)}</div>` : ''}
    ${queuedNote}
    ${isExpired ? '<button class="vl-toast-dismiss" type="button">Dismiss</button>' : ''}
  </div>`;

  if (isExpired) {
    // Persistent: own slot, no timer \u2014 stays until the nurse dismisses it
    // (issue #28). Routine toasts keep flowing in the slot below.
    toastWarningSlot.innerHTML = toastHtml;
    playAudioCue('expiry_warning');
    const dismissBtn = toastWarningSlot.querySelector('.vl-toast-dismiss');
    if (dismissBtn) dismissBtn.addEventListener('click', () => dismissToast(toastWarningSlot));
    return;
  }
  showRoutineToast(toastHtml, durationMs);
}

function dismissToast(slot) {
  const el = slot && slot.querySelector('.vl-toast');
  if (el) el.classList.remove('show');
  setTimeout(() => { if (slot) slot.innerHTML = ''; }, 300);
}

function escapeToastHtml(text) {
  const d = document.createElement('span');
  d.textContent = text;
  return d.innerHTML;
}

// ---------------------------------------------------------------------------
// In-page floating HUD for multiple-inject queue
// ---------------------------------------------------------------------------

let hudHost = null;
let hudShadow = null;
let hudCountEl = null;
let hudApplyBtn = null;
let hudContainer = null;
let hudModeToggleBtn = null;
let hudQueueWrap = null;
let hudQueueListEl = null;
let hudClearBtn = null;
let hudMiniEl = null;
let hudUserHidden = false;
let hudCurrentLeft = null;
let hudCurrentTop = null;
let hudIsDragging = false;
let hudDragOffsetX = 0;
let hudDragOffsetY = 0;
let hudMiniPointerDown = false;
let hudMiniDidDrag = false;
let hudMiniDragOffsetX = 0;
let hudMiniDragOffsetY = 0;
let hudMiniDownX = 0;
let hudMiniDownY = 0;

function setHudModeToggleState(button, activeMode) {
  if (!button) return;
  const mode = activeMode === 'multiple' ? 'multiple' : 'single';
  const nextMode = mode === 'multiple' ? 'single' : 'multiple';
  const label = mode === 'multiple' ? 'Multiple' : 'Single';
  const targetLabel = nextMode === 'multiple' ? 'Multiple' : 'Single';
  button.innerHTML = `
    <span class="vl-hud-mode-top">Chart Mode</span>
    <span class="vl-hud-mode-main">
      <span class="vl-hud-mode-current">${label}</span>
      <span class="vl-hud-mode-next">Switch to ${targetLabel}</span>
    </span>
  `;
  button.dataset.mode = mode;
  button.setAttribute('aria-label', `Switch to ${targetLabel} mode`);
  button.setAttribute('title', `Switch to ${targetLabel} mode`);
}

async function setHudWorkflowMode(newMode) {
  const nextMode = newMode === 'multiple' ? 'multiple' : 'single';
  if (activeWorkflowMode === nextMode) {
    updateHudState();
    return;
  }

  activeWorkflowMode = nextMode;
  updateHudState();
  try {
    await setLocalStorage({ [WORKFLOW_MODE_KEY]: nextMode });
    logAnalyticsEvent('workflow_mode_set', { workflow: nextMode, source: 'hud_toggle' });
    showVaxlinkToast({ _commandMode: nextMode, _commandSource: 'hud' });
  } catch (error) {
    console.warn('VaxLink HUD mode switch error:', error);
  }
}

function initHud() {
  if (hudInitialized) return;
  if (!isHandsFreeSupportedPage()) return;
  hudInitialized = true;

  hudHost = document.createElement('div');
  hudHost.id = 'vaxlink-hud-host';
  hudShadow = hudHost.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .vl-hud {
      position: relative;
      position: fixed;
      bottom: 16px;
      right: 16px;
      z-index: 2147483647;
      font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 10px;
      background:
        radial-gradient(circle at top left, rgba(125, 211, 252, .22), transparent 42%),
        linear-gradient(180deg, rgba(15, 58, 79, .96) 0%, rgba(12, 44, 61, .96) 100%);
      color: #f4fbff;
      padding: 12px;
      border-radius: 20px;
      border: 1px solid rgba(173, 216, 230, .16);
      box-shadow: 0 16px 34px rgba(3, 20, 30, .34);
      font-size: 13px;
      cursor: default;
      user-select: none;
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      transition: opacity .2s, transform .2s;
      min-width: 188px;
    }
    .vl-hud.hidden { display: none; }
    .vl-hud-head {
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .vl-hud-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: linear-gradient(180deg, #67e8f9 0%, #22d3ee 100%);
      box-shadow: 0 0 0 4px rgba(103, 232, 249, .12);
      flex: 0 0 auto;
    }
    .vl-hud-queue {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .vl-hud-queue.hidden { display: none; }
    .vl-hud-count {
      background: rgba(207, 250, 254, .14);
      color: #dffaff;
      border-radius: 999px;
      padding: 4px 10px;
      font-weight: 700;
      min-width: 20px;
      text-align: center;
      box-shadow: inset 0 0 0 1px rgba(207, 250, 254, .08);
    }
    .vl-hud-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 180px;
      overflow-y: auto;
    }
    .vl-hud-list.hidden { display: none; }
    .vl-hud-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      background: rgba(207, 250, 254, .08);
      border-radius: 8px;
      padding: 4px 8px;
      font-size: 11.5px;
      color: #dffaff;
    }
    .vl-hud-item-label {
      min-width: 0;
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .vl-hud-item-label.expired { color: #fca5a5; font-weight: 700; }
    .vl-hud-item-remove {
      background: transparent;
      border: none;
      color: rgba(232, 249, 253, .6);
      font-size: 15px;
      line-height: 1;
      cursor: pointer;
      padding: 0 4px;
      border-radius: 6px;
      flex-shrink: 0;
    }
    .vl-hud-item-remove:hover { background: rgba(248, 113, 113, .25); color: #fff; }
    .vl-hud-clear-btn {
      background: transparent;
      color: rgba(232, 249, 253, .75);
      box-shadow: inset 0 0 0 1px rgba(232, 249, 253, .25);
    }
    .vl-hud-clear-btn:hover { background: rgba(248, 113, 113, .2); color: #fff; }
    .vl-hud-btn {
      background: #ecfeff;
      color: #0f4357;
      border: none;
      border-radius: 16px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
      letter-spacing: .01em;
      transition: transform .16s ease, box-shadow .16s ease, background .16s ease, color .16s ease;
    }
    .vl-hud-mode-toggle {
      width: 100%;
      position: relative;
      overflow: hidden;
      text-align: left;
      padding: 11px 12px 12px;
      background: linear-gradient(180deg, rgba(240, 253, 255, .18) 0%, rgba(224, 247, 250, .08) 100%);
      color: #f4fbff;
      box-shadow:
        inset 0 0 0 1px rgba(255,255,255,.12),
        0 10px 22px rgba(7, 29, 40, .22);
    }
    .vl-hud-mode-toggle[data-mode="multiple"] {
      background: linear-gradient(180deg, rgba(236, 254, 255, .98) 0%, rgba(194, 244, 248, .94) 100%);
      color: #0f4357;
      box-shadow: 0 12px 22px rgba(8, 58, 77, .18);
    }
    .vl-hud-mode-toggle::before {
      content: "";
      position: absolute;
      inset: auto -18% -42% auto;
      width: 118px;
      height: 118px;
      border-radius: 999px;
      background: rgba(125, 211, 252, .14);
      pointer-events: none;
    }
    .vl-hud-btn:hover {
      background: #fff;
      transform: translateY(-1px);
      box-shadow: 0 8px 18px rgba(9, 40, 53, .18);
    }
    .vl-hud-mode-toggle:hover {
      background: linear-gradient(180deg, rgba(240, 253, 255, .24) 0%, rgba(224, 247, 250, .12) 100%);
      color: #f4fbff;
    }
    .vl-hud-mode-toggle[data-mode="multiple"]:hover {
      background: linear-gradient(180deg, rgba(255, 255, 255, 1) 0%, rgba(214, 248, 251, .98) 100%);
      color: #0f4357;
    }
    .vl-hud-btn:disabled { opacity: .5; cursor: default; }
    .vl-hud-btn:active { transform: translateY(0); }
    .vl-hud-label {
      font-size: 11px;
      letter-spacing: .03em;
      text-transform: uppercase;
      color: rgba(232, 249, 253, .82);
    }
    .vl-hud-mode-top {
      display: block;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
      opacity: .72;
      margin-bottom: 5px;
    }
    .vl-hud-mode-main {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
      position: relative;
      z-index: 1;
    }
    .vl-hud-mode-current {
      display: inline-block;
      font-size: 18px;
      line-height: 1;
      font-weight: 800;
      letter-spacing: -.02em;
    }
    .vl-hud-mode-next {
      display: inline-block;
      font-size: 11px;
      font-weight: 700;
      opacity: .78;
      white-space: nowrap;
    }
    .vl-hud-head {
      cursor: grab;
    }
    .vl-hud-head.dragging {
      cursor: grabbing;
    }
    .vl-hud-hide-btn {
      margin-left: auto;
      background: transparent;
      color: rgba(232, 249, 253, .55);
      font-size: 18px;
      line-height: 1;
      padding: 0 5px;
      border-radius: 8px;
      font-weight: 300;
      min-width: unset;
      flex-shrink: 0;
    }
    .vl-hud-hide-btn:hover {
      background: rgba(232, 249, 253, .12);
      color: #f4fbff;
      transform: none;
      box-shadow: none;
    }
    .vl-hud-mini {
      position: fixed;
      bottom: 16px;
      right: 16px;
      z-index: 2147483647;
      width: 36px;
      height: 36px;
      border-radius: 999px;
      background:
        radial-gradient(circle at top left, rgba(125, 211, 252, .22), transparent 42%),
        linear-gradient(180deg, rgba(15, 58, 79, .96) 0%, rgba(12, 44, 61, .96) 100%);
      border: 1px solid rgba(173, 216, 230, .2);
      box-shadow: 0 8px 18px rgba(3, 20, 30, .3);
      cursor: grab;
      display: none;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      transition: transform .16s ease, box-shadow .16s ease;
    }
    .vl-hud-mini.visible { display: flex; }
    .vl-hud-mini:hover {
      transform: scale(1.1);
      box-shadow: 0 10px 24px rgba(3, 20, 30, .44);
    }
    .vl-hud-mini-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: linear-gradient(180deg, #67e8f9 0%, #22d3ee 100%);
      box-shadow: 0 0 0 4px rgba(103, 232, 249, .18);
    }
  `;
  hudShadow.appendChild(style);

  hudContainer = document.createElement('div');
  hudContainer.className = 'vl-hud hidden';

  const head = document.createElement('div');
  head.className = 'vl-hud-head';

  const dot = document.createElement('span');
  dot.className = 'vl-hud-dot';

  const label = document.createElement('span');
  label.className = 'vl-hud-label';
  label.textContent = 'VaxLink';

  const hideBtn = document.createElement('button');
  hideBtn.className = 'vl-hud-btn vl-hud-hide-btn';
  hideBtn.title = 'Hide VaxLink HUD';
  hideBtn.setAttribute('aria-label', 'Hide VaxLink HUD');
  hideBtn.textContent = '−';
  hideBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setHudHidden(true);
  });

  head.appendChild(dot);
  head.appendChild(label);
  head.appendChild(hideBtn);
  hudContainer.appendChild(head);

  hudModeToggleBtn = document.createElement('button');
  hudModeToggleBtn.className = 'vl-hud-btn vl-hud-mode-toggle';
  hudModeToggleBtn.addEventListener('click', () => {
    const nextMode = activeWorkflowMode === 'multiple' ? 'single' : 'multiple';
    void setHudWorkflowMode(nextMode);
  });
  hudContainer.appendChild(hudModeToggleBtn);

  hudQueueWrap = document.createElement('div');
  hudQueueWrap.className = 'vl-hud-queue hidden';

  hudCountEl = document.createElement('span');
  hudCountEl.className = 'vl-hud-count';
  hudCountEl.textContent = '0';

  hudApplyBtn = document.createElement('button');
  hudApplyBtn.className = 'vl-hud-btn';
  hudApplyBtn.textContent = 'Apply Next';
  hudApplyBtn.addEventListener('click', applyNextQueueItem);

  hudClearBtn = document.createElement('button');
  hudClearBtn.className = 'vl-hud-btn vl-hud-clear-btn';
  hudClearBtn.textContent = 'Clear';
  hudClearBtn.title = 'Clear the multiple-inject queue';
  hudClearBtn.addEventListener('click', () => {
    // Two-step confirm so a stray click cannot wipe a clinic's scans.
    if (hudClearBtn.dataset.confirming === 'true') {
      delete hudClearBtn.dataset.confirming;
      hudClearBtn.textContent = 'Clear';
      void clearHudQueue();
      return;
    }
    hudClearBtn.dataset.confirming = 'true';
    hudClearBtn.textContent = 'Sure?';
    setTimeout(() => {
      delete hudClearBtn.dataset.confirming;
      hudClearBtn.textContent = 'Clear';
    }, 3000);
  });

  hudQueueWrap.appendChild(hudCountEl);
  hudQueueWrap.appendChild(hudApplyBtn);
  hudQueueWrap.appendChild(hudClearBtn);
  hudContainer.appendChild(hudQueueWrap);

  hudQueueListEl = document.createElement('div');
  hudQueueListEl.className = 'vl-hud-list hidden';
  hudContainer.appendChild(hudQueueListEl);
  hudShadow.appendChild(hudContainer);

  hudMiniEl = document.createElement('button');
  hudMiniEl.className = 'vl-hud-mini';
  hudMiniEl.title = 'Show VaxLink HUD';
  hudMiniEl.setAttribute('aria-label', 'Show VaxLink HUD');
  const miniDot = document.createElement('span');
  miniDot.className = 'vl-hud-mini-dot';
  hudMiniEl.appendChild(miniDot);
  // Mini: mousedown starts potential drag; mouseup without movement restores HUD
  hudMiniEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    hudMiniPointerDown = true;
    hudMiniDidDrag = false;
    const rect = hudMiniEl.getBoundingClientRect();
    hudMiniDragOffsetX = e.clientX - rect.left;
    hudMiniDragOffsetY = e.clientY - rect.top;
    hudMiniDownX = e.clientX;
    hudMiniDownY = e.clientY;
    hudMiniEl.style.cursor = 'grabbing';
    e.preventDefault();
  });
  hudShadow.appendChild(hudMiniEl);

  document.body.appendChild(hudHost);

  // Drag-to-move: drag the head to reposition the HUD
  head.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    hudIsDragging = true;
    const rect = hudContainer.getBoundingClientRect();
    hudDragOffsetX = e.clientX - rect.left;
    hudDragOffsetY = e.clientY - rect.top;
    head.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (hudIsDragging) {
      let newLeft = e.clientX - hudDragOffsetX;
      let newTop = e.clientY - hudDragOffsetY;
      newLeft = Math.max(0, Math.min(window.innerWidth - hudContainer.offsetWidth, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - hudContainer.offsetHeight, newTop));
      applyHudPosition({ left: newLeft, top: newTop });
    } else if (hudMiniPointerDown) {
      const dx = e.clientX - hudMiniDownX;
      const dy = e.clientY - hudMiniDownY;
      if (!hudMiniDidDrag && (Math.abs(dx) + Math.abs(dy) > 4)) {
        hudMiniDidDrag = true;
      }
      if (hudMiniDidDrag) {
        let newLeft = e.clientX - hudMiniDragOffsetX;
        let newTop = e.clientY - hudMiniDragOffsetY;
        newLeft = Math.max(0, Math.min(window.innerWidth - 36, newLeft));
        newTop = Math.max(0, Math.min(window.innerHeight - 36, newTop));
        hudCurrentLeft = newLeft;
        hudCurrentTop = newTop;
        applyMiniPosition();
      }
    }
  });

  document.addEventListener('mouseup', () => {
    if (hudIsDragging) {
      hudIsDragging = false;
      head.classList.remove('dragging');
      if (hudCurrentLeft !== null && hudCurrentTop !== null) {
        chrome.storage.local.set({ [HUD_POSITION_KEY]: { left: hudCurrentLeft, top: hudCurrentTop } });
      }
    } else if (hudMiniPointerDown) {
      hudMiniPointerDown = false;
      hudMiniEl.style.cursor = '';
      if (hudMiniDidDrag) {
        chrome.storage.local.set({ [HUD_POSITION_KEY]: { left: hudCurrentLeft, top: hudCurrentTop } });
      } else {
        setHudHidden(false);
      }
    }
  });

  // Restore saved position and hidden state
  chrome.storage.local.get([HUD_POSITION_KEY, HUD_HIDDEN_KEY], (stored) => {
    if (stored && stored[HUD_POSITION_KEY]) {
      applyHudPosition(stored[HUD_POSITION_KEY]);
    }
    if (stored && stored[HUD_HIDDEN_KEY]) {
      hudUserHidden = true;
      hudContainer.classList.add('hidden');
      hudMiniEl.classList.add('visible');
      applyMiniPosition();
    }
    updateHudState();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (
      MULTIPLE_INJECT_QUEUE_KEY in changes ||
      WORKFLOW_MODE_KEY in changes ||
      LEGACY_POPUP_MODE_KEY in changes ||
      LEGACY_REMOTE_MODE_KEY in changes ||
      LEGACY_HANDS_FREE_KEY in changes
    ) {
      updateHudState();
    }
  });
}

function applyHudPosition({ left, top }) {
  hudCurrentLeft = left;
  hudCurrentTop = top;
  hudContainer.style.bottom = 'auto';
  hudContainer.style.right = 'auto';
  hudContainer.style.left = left + 'px';
  hudContainer.style.top = top + 'px';
}

function applyMiniPosition() {
  if (!hudMiniEl) return;
  if (hudCurrentLeft !== null && hudCurrentTop !== null) {
    hudMiniEl.style.removeProperty('bottom');
    hudMiniEl.style.removeProperty('right');
    hudMiniEl.style.left = hudCurrentLeft + 'px';
    hudMiniEl.style.top = hudCurrentTop + 'px';
  } else {
    hudMiniEl.style.removeProperty('left');
    hudMiniEl.style.removeProperty('top');
    hudMiniEl.style.bottom = '16px';
    hudMiniEl.style.right = '16px';
  }
}

function setHudHidden(hidden) {
  hudUserHidden = hidden;
  if (hudContainer) hudContainer.classList.toggle('hidden', hidden);
  if (hudMiniEl) {
    hudMiniEl.classList.toggle('visible', hidden);
    if (hidden) applyMiniPosition();
  }
  chrome.storage.local.set({ [HUD_HIDDEN_KEY]: hidden });
}

function updateHudState() {
  chrome.storage.local.get([MULTIPLE_INJECT_QUEUE_KEY], (stored) => {
    const rows = (stored && Array.isArray(stored[MULTIPLE_INJECT_QUEUE_KEY]))
      ? stored[MULTIPLE_INJECT_QUEUE_KEY] : [];
    const count = rows.length;
    const shouldShow = isPanoramaRecordImmsPage();
    const showQueueControls = activeWorkflowMode === 'multiple' && count > 0 && isPanoramaImmunizationPage();

    if (hudContainer) {
      hudContainer.classList.toggle('hidden', !shouldShow || hudUserHidden);
    }
    if (hudMiniEl) {
      hudMiniEl.classList.toggle('visible', shouldShow && hudUserHidden);
    }
    setHudModeToggleState(hudModeToggleBtn, activeWorkflowMode);
    if (hudQueueWrap) {
      hudQueueWrap.classList.toggle('hidden', !showQueueControls);
    }
    if (hudCountEl) {
      hudCountEl.textContent = String(count);
    }
    if (hudApplyBtn) {
      hudApplyBtn.disabled = count === 0;
    }
    renderHudQueueList(rows, showQueueControls);
  });
}

function renderHudQueueList(rows, visible) {
  if (!hudQueueListEl) return;
  hudQueueListEl.classList.toggle('hidden', !visible || rows.length === 0);
  hudQueueListEl.textContent = '';
  if (!visible) return;

  for (const row of rows) {
    if (!row) continue;
    const item = document.createElement('div');
    item.className = 'vl-hud-item';

    const label = document.createElement('span');
    label.className = 'vl-hud-item-label';
    const name = row.tradename || row.generic_name || row.name || 'Vaccine';
    label.textContent = row.lot ? `${name} · ${row.lot}` : name;
    label.title = label.textContent;
    if (row.expiry_flag === 'expired') {
      label.classList.add('expired');
      label.title += ' — EXPIRED';
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'vl-hud-item-remove';
    removeBtn.textContent = '×';
    removeBtn.title = `Remove ${name} from queue`;
    removeBtn.setAttribute('aria-label', removeBtn.title);
    removeBtn.addEventListener('click', () => {
      void removeHudQueueRow(row.id);
    });

    item.appendChild(label);
    item.appendChild(removeBtn);
    hudQueueListEl.appendChild(item);
  }
}

async function removeHudQueueRow(id) {
  if (!id || applyQueueInFlight) return;
  const stored = await getLocalStorage([MULTIPLE_INJECT_QUEUE_KEY]);
  const rows = (stored && Array.isArray(stored[MULTIPLE_INJECT_QUEUE_KEY]))
    ? stored[MULTIPLE_INJECT_QUEUE_KEY] : [];
  const next = rows.filter((row) => row && row.id !== id);
  if (next.length === rows.length) return;
  await setLocalStorage({ [MULTIPLE_INJECT_QUEUE_KEY]: next });
  updateHudState();
}

async function clearHudQueue() {
  if (applyQueueInFlight) return;
  await setLocalStorage({ [MULTIPLE_INJECT_QUEUE_KEY]: [] });
  updateHudState();
}

// Guards the read-match-write sequence below: tryAutoDrain, the multi-step
// observer, and the HUD apply button can all fire close together, and without
// this flag two callers could consume the same queued record (double-fill) or
// clobber each other's setLocalStorage (dropped record).
let applyQueueInFlight = false;

async function applyNextQueueItem(options = {}) {
  if (applyQueueInFlight) return;
  applyQueueInFlight = true;
  if (hudApplyBtn) hudApplyBtn.disabled = true;
  try {
    const matchCurrentAgent = options.matchCurrentAgent === true;
    const suppressQueueEmptyToast = options.suppressQueueEmptyToast === true;
    const stored = await getLocalStorage([MULTIPLE_INJECT_QUEUE_KEY]);
    const rows = (stored && Array.isArray(stored[MULTIPLE_INJECT_QUEUE_KEY]))
      ? stored[MULTIPLE_INJECT_QUEUE_KEY] : [];
    if (!rows.length) {
      if (!suppressQueueEmptyToast) {
        showVaxlinkToast({ _queueEmpty: true });
      }
      updateHudState();
      return 'queue_empty';
    }

    const currentAgentText = getPanoramaCurrentAgentSelectionText();
    const shouldRespectPanoramaAgent = !!currentAgentText && isPanoramaImmunizationPage();

    let recordIndex = 0;
    if (matchCurrentAgent || shouldRespectPanoramaAgent) {
      recordIndex = findMatchingQueueRecordIndexForPanoramaAgent(rows, currentAgentText);
      if (recordIndex < 0) {
        vlog('auto-fill skipped: no queued vaccine matches current Panorama agent', currentAgentText);
        showVaxlinkToast({ _stepMatchMissing: true });
        updateHudState();
        return 'no_match';
      }
    }

    const record = rows[recordIndex];
    const data = buildAutofillPayloadFromQueueRecord(record);
    if (!data) return 'no_data';
    data._vaxlinkQueueContext = {
      storageKey: MULTIPLE_INJECT_QUEUE_KEY,
      recordId: record.id,
      workflow: 'multiple',
      queue: 'multiple',
      source: 'hud'
    };

    const nextRows = buildQueueRowsAfterRecordUse(rows, record, recordIndex);

    logAnalyticsEvent('autofill_attempt', {
      workflow: 'multiple',
      source: 'hud',
      vaccineLabel: record.tradename || record.generic_name || record.name || record.lot || '',
      manufacturer: record.manufacturer || '',
      expiryFlag: record.expiry_flag || ''
    });

    const autofillResult = autoFillTelus(data);
    const success = isAutofillSuccess(autofillResult);
    const pending = isAutofillPending(autofillResult);
    if (success) {
      await setLocalStorage({ [MULTIPLE_INJECT_QUEUE_KEY]: nextRows });
    }
    logAnalyticsEvent('autofill_result', {
      workflow: 'multiple',
      source: 'hud',
      success,
      pending,
      vaccineLabel: record.tradename || record.generic_name || record.name || record.lot || '',
      manufacturer: record.manufacturer || '',
      expiryFlag: record.expiry_flag || ''
    });
    if (success) {
      logAnalyticsEvent('queue_used', {
        workflow: 'multiple',
        queue: 'multiple',
        source: 'hud',
        count: 1,
        queueSizeAfter: nextRows.length
      });
    }

    if (success) {
      showVaxlinkToast(data);
      updateHudState();
      return 'success';
    }
    if (pending) {
      updateHudState();
      return 'pending';
    }
    updateHudState();
    return 'fill_failed';
  } catch (error) {
    console.warn('VaxLink HUD apply error:', error);
    if (hudApplyBtn) hudApplyBtn.disabled = false;
    return 'error';
  } finally {
    applyQueueInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Auto-drain: auto-apply queue head when an empty immunization form is detected
// ---------------------------------------------------------------------------

function isImmunizationFormEmpty() {
  const agentSelectors = getPanoramaAgentSelectors();
  const fields = getFields(agentSelectors).filter(canFillPanoramaControl);
  for (const field of fields) {
    const filled = getFieldFilledText(field);
    if (filled && filled !== '--' && filled.toLowerCase() !== 'select' && filled.length > 1) {
      return false;
    }
  }
  return true;
}

async function tryAutoDrain() {
  if (activeWorkflowMode !== 'multiple') return;
  if (!isPanoramaImmunizationPage()) return;
  // Never pop queue items while the multi-immunization grid page is active.
  // That page uses maybeAutoFillPanoramaMultipleGrid to read queue items by
  // index WITHOUT consuming them.  Popping here shifts all entries down by one,
  // so the next grid repaint (triggered by any PrimeFaces DOM mutation) fills
  // every row with the vaccine that belongs one position later → wrong agents.
  if (isPanoramaMultipleImmunizationGridPage()) return;
  if (isPrimeFacesAjaxBusy()) return;

  const now = Date.now();
  if ((now - lastAutoDrainAt) < 3000) return;
  if ((now - lastVaxlinkFillAt) < 2000) return;

  if (!isImmunizationFormEmpty()) return;

  lastAutoDrainAt = now;
  vlog('auto-drain: empty form detected, applying queue head');
  await applyNextQueueItem();
}

// ---------------------------------------------------------------------------
// Post-save auto-advance: watch for agent field reset after Panorama save
// ---------------------------------------------------------------------------

let postSaveObserver = null;
let lastAgentFilledState = false;
let multiGridObserver = null;
let multiGridFillPending = false;
let multiStepObserver = null;
let lastObservedPanoramaStepKey = '';
let lastAutoFilledPanoramaStepKey = '';
let lastSkippedPanoramaAgentKey = '';
let multiStepAutoFillPending = false;

function isPanoramaMultipleImmunizationGridPage() {
  if (!isHandsFreeSupportedPage()) return false;
  const tableBody = document.querySelector('tbody[id*="historicalfactoryTable:dataTable_data"]');
  if (!tableBody) return false;
  const hasAddRowsButton = !!document.querySelector('button[id*="historicalfactoryTable:addButtonId:commandButtonId"]');
  if (!hasAddRowsButton) return false;
  const hasAgentField = !!document.querySelector('select[id*="historicalfactoryTable:dataTable:0:immsAgentMenu:selectOneMenu_input"]');
  const hasDateField = !!document.querySelector('input[id*="historicalfactoryTable:dataTable:0:dateIn1:dateInput_input"]');
  return hasAgentField && hasDateField;
}

function getPanoramaMultipleGridRows() {
  const body = document.querySelector('tbody[id*="historicalfactoryTable:dataTable_data"]');
  if (!body) return [];
  return Array.from(body.querySelectorAll('tr[data-ri]'));
}

function getPanoramaMultipleGridAgentField(rowIndex) {
  return document.querySelector(`select[id*="historicalfactoryTable:dataTable:${rowIndex}:immsAgentMenu:selectOneMenu_input"]`);
}

function getPanoramaMultipleGridAgentFocusField(rowIndex) {
  return document.querySelector(`input[id*="historicalfactoryTable:dataTable:${rowIndex}:immsAgentMenu:selectOneMenu_focus"]`);
}

function getPanoramaMultipleGridAgentLabel(rowIndex) {
  return document.querySelector(`label[id*="historicalfactoryTable:dataTable:${rowIndex}:immsAgentMenu:selectOneMenu_label"]`);
}

function getPanoramaMultipleGridDate1Field(rowIndex) {
  return document.querySelector(`input[id*="historicalfactoryTable:dataTable:${rowIndex}:dateIn1:dateInput_input"]`);
}

function gridAgentLabelMatchesCandidate(rowIndex, candidate) {
  const labelRaw = getPanoramaMultipleGridAgentLabel(rowIndex)?.textContent || '';
  const labelText = normalizeForMatch(labelRaw);
  const candidateNorm = normalizeForMatch(candidate);
  if (!labelText || !candidateNorm) return false;
  if (labelText === candidateNorm) return true;
  // Reject if label is a compound variant of the candidate (e.g. "HB-pediatric" label for "HB").
  const candidateRaw = String(candidate || '').trim();
  if (candidateRaw && labelRaw.trim().toLowerCase().startsWith(candidateRaw.toLowerCase() + '-')) return false;
  if (labelText.includes(candidateNorm)) return true;
  const candidateTokens = candidateNorm.split(' ').filter(t => t.length >= 3);
  return candidateTokens.length > 0 && candidateTokens.every(t => labelText.includes(t));
}

function getPanoramaMultipleGridRowState(rowIndex) {
  const agentField = getPanoramaMultipleGridAgentField(rowIndex);
  const agentFocusField = getPanoramaMultipleGridAgentFocusField(rowIndex);
  const agentLabel = getPanoramaMultipleGridAgentLabel(rowIndex);
  const dateField = getPanoramaMultipleGridDate1Field(rowIndex);
  const labelText = normalizeForMatch(agentLabel?.textContent || '');
  const selectText = normalizeForMatch(getFieldFilledText(agentField));
  const focusText = normalizeForMatch(getFieldFilledText(agentFocusField));
  return {
    agentField,
    agentFocusField,
    agentLabel,
    dateField,
    agentText: labelText || selectText || focusText,
    dateText: String(dateField?.value || '').trim()
  };
}

function fillPanoramaMultipleGridAgent(rowIndex, data) {
  const agentField = getPanoramaMultipleGridAgentField(rowIndex);
  const agentFocusField = getPanoramaMultipleGridAgentFocusField(rowIndex);
  const agentLabel = getPanoramaMultipleGridAgentLabel(rowIndex);
  if (!agentField || !canFillPanoramaControl(agentField)) return false;
  const candidates = getPanoramaAgentCandidates(data);
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (fillField(agentField, candidate) && isAgentCandidateAccepted(candidate, agentField)) {
      return true;
    }
    if (agentLabel && gridAgentLabelMatchesCandidate(rowIndex, candidate)) {
      return true;
    }
    if (agentFocusField && fillField(agentFocusField, candidate) && isAgentCandidateAccepted(candidate, agentFocusField)) {
      return true;
    }
  }
  return false;
}

function fillPanoramaMultipleGridDate1(rowIndex, data) {
  const dateField = getPanoramaMultipleGridDate1Field(rowIndex);
  if (!dateField || !canFillPanoramaControl(dateField)) return false;
  const administered = getPanoramaAdministeredDateTimeValues(data);
  if (!administered.date) return false;
  return fillPanoramaMaskedTextInput(dateField, administered.date);
}

function fillPanoramaMultipleGridRow(rowIndex, data) {
  if (!data) return false;
  const rowState = getPanoramaMultipleGridRowState(rowIndex);
  const agentNeeded = !rowState.agentText;
  const dateNeeded = !rowState.dateText;
  let changed = false;

  if (agentNeeded) {
    changed = fillPanoramaMultipleGridAgent(rowIndex, data) || changed;
  }
  if (dateNeeded) {
    changed = fillPanoramaMultipleGridDate1(rowIndex, data) || changed;
  }
  return changed;
}

async function maybeAutoFillPanoramaMultipleGrid() {
  if (multiGridFillPending) return;
  if (activeWorkflowMode !== 'multiple') return;
  if (!isPanoramaMultipleImmunizationGridPage()) return;
  if (isPrimeFacesAjaxBusy()) return;

  multiGridFillPending = true;
  try {
    const stored = await getLocalStorage([MULTIPLE_INJECT_QUEUE_KEY]);
    const rows = (stored && Array.isArray(stored[MULTIPLE_INJECT_QUEUE_KEY]))
      ? stored[MULTIPLE_INJECT_QUEUE_KEY] : [];
    if (!rows.length) return;
    if (!isPanoramaMultipleImmunizationGridPage()) return;

    const gridRows = getPanoramaMultipleGridRows();
    if (!gridRows.length) return;

    const limit = Math.min(rows.length, gridRows.length);
    for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
      const payload = buildAutofillPayloadFromQueueRecord(rows[rowIndex]);
      if (!payload) continue;
      fillPanoramaMultipleGridRow(rowIndex, payload);
    }
  } catch (error) {
    console.warn('VaxLink multi-grid autofill error:', error);
  } finally {
    multiGridFillPending = false;
  }
}

function getPanoramaCurrentTradeSelectionText() {
  const fields = getFields(getPanoramaTradeSelectors()).filter(canFillPanoramaControl);
  for (const field of fields) {
    const text = normalizeForMatch(getFieldFilledText(field));
    if (text && text !== 'select') {
      return text;
    }
  }
  return '';
}

function getPanoramaCurrentLotSelectionText() {
  const selectFields = getFields([
    'select[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_input"]',
    'select[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_input"]',
    'select[id*="LotInfo:lotNumberSelect:selectOneMenu_input"]'
  ]).filter(canFillPanoramaControl);
  for (const field of selectFields) {
    const text = normalizeForMatch(getFieldFilledText(field));
    if (text && text !== 'select') {
      return text;
    }
  }

  const selectedLotLabels = getFields([
    'label[id*="immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu_label"]',
    'label[id*="addimmsdetails_vaccDetailssection1_LotInfo:lotNumberSelect:selectOneMenu_label"]',
    'label[id*="LotInfo:lotNumberSelect:selectOneMenu_label"]'
  ]);
  for (const label of selectedLotLabels) {
    const text = normalizeForMatch(label?.textContent || '');
    if (text && text !== 'select') {
      return text;
    }
  }
  return '';
}

function getPanoramaMultiStepIndicatorKey() {
  const nodes = Array.from(document.querySelectorAll('div, span, td, th, strong, label'));
  for (const node of nodes) {
    const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
    const match = text.match(/\b(\d+)\s+of\s+(\d+)\s+immunizations?\b/i);
    if (match) {
      return `${match[1]}-of-${match[2]}`;
    }
  }
  return '';
}

function isPanoramaMultiStepDetailPageReadyForAutofill() {
  if (activeWorkflowMode !== 'multiple') return false;
  if (!isPanoramaImmunizationPage()) return false;
  if (isPrimeFacesAjaxBusy()) return false;
  if (!getPanoramaMultiStepIndicatorKey()) return false;
  if (!hasPanoramaAgentSelection(null)) return false;

  const { dateField, timeField } = getPanoramaAdministeredDateTimeFields();
  const hasDateTime = !!String(dateField?.value || '').trim() || !!String(timeField?.value || '').trim();
  if (!hasDateTime) return false;

  const hasTrade = !!getPanoramaCurrentTradeSelectionText();
  const hasLot = !!getPanoramaCurrentLotSelectionText();
  return !hasTrade && !hasLot;
}

async function maybeAutoFillPanoramaMultiStepDetailPage() {
  if (multiStepAutoFillPending) return;
  if (!isPanoramaMultiStepDetailPageReadyForAutofill()) return;

  const stepKey = getPanoramaMultiStepIndicatorKey();
  const currentAgentKey = normalizeForMatch(getPanoramaCurrentAgentSelectionText());
  const attemptKey = currentAgentKey ? `${stepKey}|${currentAgentKey}` : stepKey;
  if (!stepKey || stepKey === lastAutoFilledPanoramaStepKey || attemptKey === lastSkippedPanoramaAgentKey) return;
  if ((Date.now() - lastVaxlinkFillAt) < 1200) return;

  multiStepAutoFillPending = true;
  try {
    const stored = await getLocalStorage([MULTIPLE_INJECT_QUEUE_KEY]);
    const rows = (stored && Array.isArray(stored[MULTIPLE_INJECT_QUEUE_KEY]))
      ? stored[MULTIPLE_INJECT_QUEUE_KEY] : [];
    if (!rows.length) return;
    if (!isPanoramaMultiStepDetailPageReadyForAutofill()) return;

    const result = await applyNextQueueItem({
      matchCurrentAgent: true,
      suppressQueueEmptyToast: true
    });
    if (result === 'success') {
      lastAutoFilledPanoramaStepKey = stepKey;
      lastSkippedPanoramaAgentKey = '';
    } else if (result === 'no_match') {
      lastSkippedPanoramaAgentKey = attemptKey;
    }
  } catch (error) {
    console.warn('VaxLink multi-step autofill error:', error);
  } finally {
    multiStepAutoFillPending = false;
  }
}

function initPostSaveWatcher() {
  if (!isHandsFreeSupportedPage()) return;
  if (postSaveObserver) return;

  const checkAgentTransition = () => {
    if (activeWorkflowMode !== 'multiple') return;
    if (!isPanoramaImmunizationPage()) return;

    const wasFilledBefore = lastAgentFilledState;
    const isEmptyNow = isImmunizationFormEmpty();
    lastAgentFilledState = !isEmptyNow;

    // Detect filled -> empty transition (Panorama form reset after save)
    if (wasFilledBefore && isEmptyNow) {
      const now = Date.now();
      if ((now - lastVaxlinkFillAt) < 2000) return;
      vlog('post-save: agent field reset detected, auto-advancing');
      setTimeout(() => tryAutoDrain(), 800);
    }
  };

  const targetNode = document.body;
  if (!targetNode) return;

  postSaveObserver = new MutationObserver(() => {
    checkAgentTransition();
  });
  postSaveObserver.observe(targetNode, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'value', 'aria-expanded']
  });
}

function initPanoramaMultipleGridWatcher() {
  if (!isHandsFreeSupportedPage()) return;
  if (multiGridObserver) return;

  const checkGrid = () => {
    if (activeWorkflowMode !== 'multiple') return;
    if (!isPanoramaMultipleImmunizationGridPage()) return;
    setTimeout(() => {
      void maybeAutoFillPanoramaMultipleGrid();
    }, 250);
  };

  const targetNode = document.body;
  if (!targetNode) return;

  multiGridObserver = new MutationObserver(() => {
    checkGrid();
  });
  multiGridObserver.observe(targetNode, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'value', 'aria-expanded']
  });

  checkGrid();
}

function initPanoramaMultiStepWatcher() {
  if (!isHandsFreeSupportedPage()) return;
  if (multiStepObserver) return;

  const checkForStepTransition = () => {
    if (activeWorkflowMode !== 'multiple') return;

    const stepKey = getPanoramaMultiStepIndicatorKey();
    if (!stepKey) {
      lastObservedPanoramaStepKey = '';
      return;
    }

    if (stepKey !== lastObservedPanoramaStepKey) {
      lastObservedPanoramaStepKey = stepKey;
      setTimeout(() => {
        void maybeAutoFillPanoramaMultiStepDetailPage();
      }, 350);
      return;
    }

    if (stepKey !== lastAutoFilledPanoramaStepKey && isPanoramaMultiStepDetailPageReadyForAutofill()) {
      setTimeout(() => {
        void maybeAutoFillPanoramaMultiStepDetailPage();
      }, 200);
    }
  };

  const targetNode = document.body;
  if (!targetNode) return;

  multiStepObserver = new MutationObserver(() => {
    checkForStepTransition();
  });
  multiStepObserver.observe(targetNode, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'value', 'aria-expanded']
  });

  checkForStepTransition();
}

// ---------------------------------------------------------------------------
// Initialize new features after DOM is ready
// ---------------------------------------------------------------------------

function initClickReductionFeatures() {
  if (!isHandsFreeSupportedPage()) return;

  if (document.body) {
    initHud();
    initPostSaveWatcher();
    initPanoramaMultipleGridWatcher();
    initPanoramaMultiStepWatcher();
    // Initial auto-drain attempt after a short settle delay
    if (activeWorkflowMode === 'multiple') {
      setTimeout(() => tryAutoDrain(), 1200);
    }
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      initHud();
      initPostSaveWatcher();
      initPanoramaMultipleGridWatcher();
      initPanoramaMultiStepWatcher();
      if (activeWorkflowMode === 'multiple') {
        setTimeout(() => tryAutoDrain(), 1200);
      }
    });
  }
}

// Re-run when mode changes so HUD visibility updates
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (WORKFLOW_MODE_KEY in changes) {
    updateHudState();
    if (activeWorkflowMode === 'multiple') {
      setTimeout(() => tryAutoDrain(), 800);
    }
  }
});

if (document.readyState === 'loading') {
  // Normal page load: DOMContentLoaded fires well after chrome.storage.local.get
  // resolves, so activeWorkflowMode will be correctly set by the time
  // initClickReductionFeatures runs.
  document.addEventListener('DOMContentLoaded', initClickReductionFeatures);
} else {
  // Page is already loaded (PrimeFaces SPA navigation, or content script injected
  // late).  initHandsFreeScanner's chrome.storage.local.get callback is async and
  // hasn't fired yet, so activeWorkflowMode is still the default 'single'.
  // Deferring by one task tick gives the storage callback a chance to set the real
  // mode before initClickReductionFeatures reads it.  The storage callback also
  // schedules its own re-kick (maybeAutoFillPanoramaMultipleGrid + tryAutoDrain)
  // as a safety net in case even this deferred call races.
  setTimeout(initClickReductionFeatures, 0);
}
