// Flip to true while developing (content script isolated world).
const VAXLINK_CONTENT_DEBUG = false;
function vlog(...args) {
  if (VAXLINK_CONTENT_DEBUG) console.log('[VaxLink]', ...args);
}

const contentManifestAtLoad = chrome.runtime.getManifest();
const contentBuildAtLoad = Object.freeze({
  version: contentManifestAtLoad.version,
  versionName: contentManifestAtLoad.version_name || null,
  name: contentManifestAtLoad.name,
  fingerprint: globalThis.VAXLINK_BUILD_ID || null
});
let panoramaSettingsInitialized = false;
const chartActivity = isHandsFreeSupportedPage()
  ? globalThis.VaxLinkRecentActivity.createChartRecorder()
  : null;

const HANDS_FREE_BUILD = '2026-03-11-hf-recovery-1';
vlog(
  'content script',
  location.href,
  'readyState=',
  document.readyState,
  'build=',
  HANDS_FREE_BUILD
);

const {
  WORKFLOW_MODE_KEY,
  LEGACY_POPUP_MODE_KEY,
  SINGLE_SCAN_AUTOFILL_KEY,
  GRID_SCAN_AUTOFILL_KEY,
  GRID_DETAIL_AUTOFILL_KEY,
  normalizeWorkflowMode
} = globalThis.VaxLinkWorkflow;
const MULTIPLE_INJECT_QUEUE_KEY = 'multiple_inject_queue_v1';
const LEGACY_ADMIN_DATETIME_AUTOFILL_KEY =
  'vaxlink_administered_datetime_autofill_v1';
const ADMIN_DATE_AUTOFILL_KEY = 'vaxlink_administered_date_autofill_v1';
const ADMIN_TIME_AUTOFILL_KEY = 'vaxlink_administered_time_autofill_v1';
const LEGACY_REASON_CONSENT_AUTOFILL_KEY = 'vaxlink_reason_consent_autofill_v1';
const REASON_AUTOFILL_KEY = 'vaxlink_reason_autofill_v1';
const CONSENT_AUTOFILL_KEY = 'vaxlink_consent_autofill_v1';
const AUTO_RESOLVE_FUNDING_KEY = 'vaxlink_auto_resolve_funding_v1';
const AUDIO_FEEDBACK_KEY = 'vaxlink_audio_feedback_enabled_v1';
const HUD_POSITION_KEY = 'vaxlink_hud_position_v1';
const HUD_HIDDEN_KEY = 'vaxlink_hud_hidden_v1';
const CHART_INSTALLATIONS_ATTRIBUTE = 'data-vaxlink-installations';
const PANORAMA_TRAINING_HOST = 'trpanoramadhir.prod.ehealthontario.ca';
const MULTIPLE_INSTALLATIONS_WARNING =
  'Two copies of VaxLink are open on this chart. Disable the extra copy in browser extensions, then refresh the chart after checking unsaved work.';
let registeredChart = null;
let activeWorkflowMode = 'immunization';
let adminDateAutofillEnabled = true;
let adminTimeAutofillEnabled = true;
let reasonAutofillEnabled = true;
let consentAutofillEnabled = true;
let autofillSettings = {};
let audioFeedbackEnabled = true;
let hudInitialized = false;
let lastHandledScanValue = '';
let lastHandledScanAt = 0;
let audioContextRef = null;
let expiryGuardHost = null;
let expiryGuardRoot = null;
let scannerDeliveryContext = null;
let panoramaContextGeneration = 0;
let lastHandledScanOwner = null;

// Preserve the old combined choices until staff set each field separately.
function normalizeAutofillSetting(stored, key, legacyKey) {
  return (stored?.[key] ?? stored?.[legacyKey]) !== false;
}

function applyAutofillSettings(stored) {
  autofillSettings = stored || {};
  adminDateAutofillEnabled = normalizeAutofillSetting(
    stored,
    ADMIN_DATE_AUTOFILL_KEY,
    LEGACY_ADMIN_DATETIME_AUTOFILL_KEY
  );
  adminTimeAutofillEnabled = normalizeAutofillSetting(
    stored,
    ADMIN_TIME_AUTOFILL_KEY,
    LEGACY_ADMIN_DATETIME_AUTOFILL_KEY
  );
  reasonAutofillEnabled = normalizeAutofillSetting(
    stored,
    REASON_AUTOFILL_KEY,
    LEGACY_REASON_CONSENT_AUTOFILL_KEY
  );
  consentAutofillEnabled = normalizeAutofillSetting(
    stored,
    CONSENT_AUTOFILL_KEY,
    LEGACY_REASON_CONSENT_AUTOFILL_KEY
  );
}

function normalizeAudioFeedbackSetting(stored) {
  return !(stored && stored[AUDIO_FEEDBACK_KEY] === false);
}

function getAudioContext() {
  if (audioContextRef) return audioContextRef;
  const AudioContextCtor =
    globalThis.AudioContext || globalThis.webkitAudioContext;
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

  const playTone = (
    frequency,
    durationMs,
    type = 'sine',
    gainValue = 0.06,
    delayMs = 0
  ) => {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime + delayMs / 1000);
    gain.gain.exponentialRampToValueAtTime(
      gainValue,
      ctx.currentTime + delayMs / 1000 + 0.01
    );
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      ctx.currentTime + delayMs / 1000 + durationMs / 1000
    );
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(ctx.currentTime + delayMs / 1000);
    oscillator.stop(
      ctx.currentTime + delayMs / 1000 + durationMs / 1000 + 0.02
    );
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

function logAnalyticsEvent(eventType, payload = {}) {
  try {
    chrome.runtime.sendMessage(
      { action: 'logAnalyticsEvent', eventType, payload },
      () => {
        void chrome.runtime.lastError;
      }
    );
  } catch (_) {
    // Ignore analytics failures on client pages.
  }
}

const gridAssignments = new Map();
let gridDetailHandoff = null;

let trayUseContext = null;
let trayUseContextGeneration = 0;
const activeTrayReservations = new Set();

function getScannerDeliveryContext(kind, explicit = false) {
  const current = explicit ? trayUseContext : scannerDeliveryContext;
  if (isScannerDeliveryContextCurrent(current?.token, kind, explicit)) {
    return current.token;
  }
  const context = {
    token: crypto.randomUUID(),
    form: getPanoramaAutofillForm(),
    url: location.href,
    step: getPanoramaMultiStepIndicatorKey({ visibleOnly: true }),
    kind: kind ?? getPanoramaFormContext({ checkReadiness: false }).kind,
    mode: activeWorkflowMode,
    generation: explicit ? trayUseContextGeneration : panoramaContextGeneration
  };
  if (explicit) trayUseContext = context;
  else scannerDeliveryContext = context;
  return context.form ? context.token : null;
}

function isScannerDeliveryContextCurrent(token, kind, explicit = false) {
  const context = explicit ? trayUseContext : scannerDeliveryContext;
  if (!token || context?.token !== token) return false;
  const current =
    context.form?.isConnected &&
    context.form === getPanoramaAutofillForm() &&
    context.url === location.href &&
    context.step === getPanoramaMultiStepIndicatorKey({ visibleOnly: true }) &&
    context.mode === activeWorkflowMode &&
    context.generation ===
      (explicit ? trayUseContextGeneration : panoramaContextGeneration) &&
    context.kind ===
      (kind ?? getPanoramaFormContext({ checkReadiness: false }).kind);
  if (!current) {
    if (explicit) trayUseContext = null;
    else scannerDeliveryContext = null;
  }
  return !!current;
}

function canAutomaticallyFillPanoramaSingle(contextToken) {
  const context = getPanoramaFormContext();
  return (
    panoramaSettingsInitialized &&
    activeWorkflowMode === 'immunization' &&
    autofillSettings[SINGLE_SCAN_AUTOFILL_KEY] !== false &&
    ['provider_single', 'non_provider_single'].includes(context.kind) &&
    context.ready &&
    isScannerDeliveryContextCurrent(contextToken, context.kind)
  );
}

function isScannerWorkerSender(sender) {
  return (
    sender.id === chrome.runtime.id &&
    !sender.tab &&
    (!sender.url || sender.url === chrome.runtime.getURL('background.js'))
  );
}

async function checkPanoramaScannerRoute(delivery, verified = false) {
  try {
    const payload = verified
      ? { scannerRoute: delivery.scannerRoute }
      : delivery;
    const result = await chrome.runtime.sendMessage({
      action: 'checkScannerChart',
      ...payload
    });
    return result?.success === true;
  } catch (_) {
    return false;
  }
}

async function reportPanoramaScannerVerification(owner, verified, data) {
  if (
    !owner?.scannerDelivery ||
    owner.scannerVerificationSent ||
    (!verified && owner.detailOutcome === 'verifying')
  )
    return false;
  owner.scannerVerificationSent = true;
  const vaccine =
    verified && data
      ? {
          lot: data.lot,
          gtin: data.gtin,
          din: data.din,
          drug_code: data.drug_code,
          tradename: data.tradename,
          generic_name: data.generic_name,
          name: data.name,
          disease: data.disease,
          antigen: data.antigen,
          manufacturer: data.manufacturer,
          inventory_expiry: data.inventory_expiry,
          barcode_expiry: data.barcode_expiry,
          expiry: data.expiry,
          nvc_lot_expiry: data.nvc_lot_expiry,
          nvc_lot_matched: data.nvc_lot_matched,
          nvc_catalogue_version: data.nvc_catalogue_version
        }
      : undefined;
  try {
    const result = await chrome.runtime.sendMessage({
      action: 'verifyScannerChartFields',
      ...owner.scannerDelivery,
      vaccine,
      verified
    });
    return verified && result?.success === true;
  } catch (_) {
    // The saved inbox row remains for staff to check.
    return false;
  }
}

function setupMessageListener() {
  if (window.__vaxlinkMessageListenerInitialized) {
    return;
  }
  window.__vaxlinkMessageListenerInitialized = true;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    vlog('autoFill message', request?.action, request?.data);
    if (request.action === 'getPanoramaIntegration') {
      const supported = isHandsFreeSupportedPage();
      const formContext = supported ? getPanoramaFormContext() : null;
      const contextToken = supported
        ? getScannerDeliveryContext(
            formContext.kind,
            request.forTrayUse === true
          )
        : null;
      const initialized = {
        listener: window.__vaxlinkMessageListenerInitialized === true,
        settings: panoramaSettingsInitialized
      };
      sendResponse({
        supported,
        contextToken,
        formContext,
        ready:
          supported &&
          !!contextToken &&
          initialized.listener &&
          initialized.settings,
        initialized,
        buildAtLoad: contentBuildAtLoad
      });
      return true;
    }
    if (
      ['useTrayVaccine', 'vaxlinkGridScanCaptured'].includes(request.action)
    ) {
      const gridScan = request.action === 'vaxlinkGridScanCaptured';
      const authorized = gridScan
        ? isScannerWorkerSender(sender)
        : sender.id === chrome.runtime.id &&
          sender.url === chrome.runtime.getURL('popup.html');
      if (!authorized || window.top !== window.self) return false;
      if (gridScan && !Number.isFinite(request.scannerRoute?.startBy))
        return false;
      useTrayVaccine(
        request.recordId,
        request.contextToken,
        gridScan ? request.scannerRoute : null
      )
        .then((result) =>
          sendResponse({
            ...result,
            success:
              isAutofillSuccess(result) || result.status === 'grid_added',
            pending: isAutofillPending(result)
          })
        )
        .catch((error) =>
          sendResponse({ success: false, error: error.message })
        );
      return true;
    }
    if (request.action === 'isDoseReservationActive') {
      if (sender.id !== chrome.runtime.id || window.top !== window.self)
        return false;
      sendResponse({ active: activeTrayReservations.has(request.token) });
      return false;
    }
    if (request.action === 'showScannerBarcodeFeedback') {
      if (
        !isScannerWorkerSender(sender) ||
        !isScannerDeliveryContextCurrent(request.contextToken)
      )
        return false;
      const { status, lot, expiry } = request.feedback || {};
      if (status === 'expired')
        blockIneligibleChartUse({ lot, expiry, expiry_flag: 'expired' });
      if (status === 'missing_lot' || status === 'parse_error')
        showVaxlinkToast({ _barcodeFeedback: status });
      return false;
    }
    if (request.action === 'vaxlinkScanCaptured') {
      if (!isScannerWorkerSender(sender)) return false;
      if (window.top !== window.self) {
        return false;
      }
      if (!isHandsFreeSupportedPage()) {
        sendResponse({ success: false, error: 'Unsupported chart page' });
        return true;
      }
      if (
        !Number.isFinite(request.scannerRoute?.startBy) ||
        typeof request.scan?.captureId !== 'string' ||
        !canAutomaticallyFillPanoramaSingle(request.contextToken)
      ) {
        sendResponse({
          accepted: false,
          success: false,
          error: 'Chart context changed; scan held in VaxLink'
        });
        return true;
      }
      const stage = 'detail';
      const activity = chartActivity?.begin('single', stage);
      Promise.resolve(
        handleHandsFreeScan(
          request.scan?.rawText || '',
          request.scan?.source || 'scanner-channel',
          {
            captureId: request.scan.captureId,
            contextToken: request.contextToken,
            scannerRoute: request.scannerRoute
          },
          activity
        )
      )
        .then((result) => {
          const accepted = result?.accepted !== false;
          const activityRecording = chartActivity?.isCurrent(activity) === true;
          if (accepted && activityRecording)
            chartActivity.record(activity, 'scan', { decision: 'accepted' });
          sendResponse({
            accepted,
            activityRecording: accepted && activityRecording,
            activityStage: stage,
            success: !!result?.success,
            pending: !!result?.pending,
            status: result?.status || (result?.success ? 'success' : 'failed'),
            error: result?.error || '',
            chartNeedsReview: result?.chartNeedsReview === true,
            duplicate_ignored: !!result?.duplicate_ignored,
            command_handled: !!result?.command_handled
          });
        })
        .catch((error) =>
          sendResponse({
            success: false,
            error: error?.message || 'Scan handling failed'
          })
        );
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

function lookupVaccineInfoByLot(lot, gtin, waitForDownload) {
  return new Promise((resolve) => {
    if (!lot) {
      resolve(null);
      return;
    }
    const request = { action: 'lookupVaccineInfo', lot, waitForDownload };
    if (gtin) {
      request.gtin = gtin;
    }
    chrome.runtime.sendMessage(request, (response) => {
      if (chrome.runtime.lastError) {
        console.warn(
          'Hands-free lot lookup failed:',
          chrome.runtime.lastError.message
        );
        resolve({
          error: 'NVC lookup is unavailable',
          errorCategory: 'unavailable'
        });
        return;
      }
      if (!response || response.error) {
        resolve(
          response || {
            error: 'NVC lookup is unavailable',
            errorCategory: 'unavailable'
          }
        );
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

function getExpiryStatus(value) {
  const expiry = globalThis.VaxLinkExpiryDate.parseDateToLocal(value);
  if (!expiry) {
    return {
      flag: 'unknown',
      daysRemaining: null
    };
  }

  const daysRemaining = globalThis.VaxLinkExpiryDate.daysUntil(expiry);

  if (daysRemaining < 0) {
    return { flag: 'expired', daysRemaining };
  }
  if (daysRemaining <= 30) {
    return { flag: 'expiring_soon', daysRemaining };
  }
  return { flag: 'valid', daysRemaining };
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
    parsed.expiry =
      toIsoDate(vaccineInfo.lot_expiry) ||
      vaccineInfo.lot_expiry ||
      parsed.expiry;
  }
}

async function handleHandsFreeScan(
  scanValue,
  source,
  scannerDelivery,
  activity
) {
  const {
    contextToken,
    scannerRoute: { startBy }
  } = scannerDelivery;
  const workflow = 'immunization';
  const trimmed = String(scanValue || '').trim();
  if (!trimmed) {
    return {
      accepted: true,
      success: false,
      status: 'empty_scan',
      error: 'Scan event missing raw text'
    };
  }

  if (!isPanoramaChartActive() || Date.now() >= startBy) {
    return {
      accepted: false,
      success: false,
      status: 'cancelled',
      error: 'Autofill stopped: chart lost focus or entry timed out'
    };
  }

  if (handleVaxlinkCommand(trimmed)) {
    return {
      accepted: true,
      success: true,
      status: 'command_handled',
      command_handled: true
    };
  }

  const entryBlocked = panoramaEntryBlockReason();
  if (entryBlocked) {
    warnPanoramaEntryBlocked(entryBlocked);
    return {
      accepted: false,
      success: false,
      status: 'entry_blocked',
      error: entryBlocked
    };
  }

  const scanCapturedAt = new Date().toISOString();
  vlog('hands-free candidate', {
    source,
    length: trimmed.length
  });

  const now = Date.now();
  if (
    trimmed === lastHandledScanValue &&
    now - lastHandledScanAt < 1500 &&
    isPanoramaAutofillCurrent({ _vaxlinkOwner: lastHandledScanOwner })
  ) {
    return {
      accepted: true,
      success: true,
      status: 'duplicate_ignored',
      duplicate_ignored: true
    };
  }
  let parsed;
  try {
    parsed = globalThis.VaxLinkGS1Parser.isRetailBarcode(trimmed)
      ? {}
      : parseGS1BarcodeFromScanner(trimmed);
  } catch (error) {
    chartActivity?.record(activity, 'barcode', {
      result: 'malformed',
      barcode: ''
    });
    console.warn('Hands-free scan ignored (not valid GS1):', error.message);
    playAudioCue('error');
    showVaxlinkToast({ _barcodeFeedback: 'parse_error' });
    logAnalyticsEvent('parse_error', {
      workflow,
      source
    });
    return {
      accepted: true,
      success: false,
      status: 'parse_error',
      error: error.message || 'Scan was not valid GS1'
    };
  }
  if (!String(parsed.lot || '').trim()) {
    if (chartActivity?.isCurrent(activity)) {
      chartActivity.record(activity, 'barcode', {
        result: 'missing_lot',
        barcode: globalThis.VaxLinkRecentActivity.scannedBarcode(trimmed)
      });
      chartActivity.record(activity, 'nvc_lookup', {
        result: 'no_lot',
        catalogueVersion: null
      });
    }
    logAnalyticsEvent('barcode_missing_lot', {
      workflow,
      source
    });
    showVaxlinkToast({ _barcodeFeedback: 'missing_lot' });
    return {
      accepted: true,
      success: false,
      status: 'missing_lot',
      error: 'The barcode has no lot number'
    };
  }
  if (chartActivity?.isCurrent(activity))
    chartActivity.record(activity, 'barcode', {
      result: 'parsed',
      barcode: globalThis.VaxLinkRecentActivity.scannedBarcode(trimmed)
    });
  logAnalyticsEvent('parse_success', {
    workflow,
    source,
    expiryFlag: getExpiryStatus(parsed.expiry).flag
  });
  parsed.scanned_at = parsed.scanned_at || scanCapturedAt;
  parsed.barcode_expiry = parsed.expiry || '';

  try {
    let vaccineInfo = null;
    let lookupAttempted = false;
    if (!globalThis.VaxLinkExpiryDate.isExpiredVaccine(parsed)) {
      lookupAttempted = true;
      const lookup = await lookupVaccineInfoByLot(
        parsed.lot,
        parsed.gtin,
        true
      );
      if (chartActivity?.isCurrent(activity)) {
        const diagnostics = globalThis.VaxLinkRecentActivity;
        chartActivity.record(activity, 'nvc_lookup', {
          result: diagnostics.lookupResult(lookup),
          catalogueVersion: diagnostics.catalogueVersion(
            lookup?.catalogueVersion
          )
            ? lookup.catalogueVersion
            : null
        });
      }
      parsed.nvc_catalogue_version = lookup?.catalogueVersion;
      if (lookup?.error) {
        parsed.lookup_error = lookup.error;
        parsed.lookup_error_category = lookup.errorCategory;
        parsed.nvc_lot_expiry = lookup.lot_expiry;
      } else {
        vaccineInfo = lookup;
      }
    }

    // Do not treat GTIN as a lot lookup key (pilot: wrong agent / e.g. TI vs HB).
    if (!vaccineInfo && parsed.gtin) {
      vlog('skip GTIN lot lookup (hands-free)');
    }

    if (vaccineInfo) {
      mergeVaccineInfoIntoParsed(parsed, vaccineInfo);
    }

    if (lookupAttempted) {
      const lookupExpiryFlag = getExpiryStatus(
        parsed.expiry || parsed.nvc_lot_expiry
      ).flag;
      if (!vaccineInfo) {
        playAudioCue('error');
      }
      logAnalyticsEvent(vaccineInfo ? 'lookup_success' : 'lookup_error', {
        workflow,
        source,
        vaccineLabel: parsed.tradename || parsed.generic_name || '',
        manufacturer: parsed.manufacturer || '',
        expiryFlag: lookupExpiryFlag
      });
    }
  } catch (error) {
    chartActivity?.record(activity, 'nvc_lookup', {
      result: 'unavailable',
      catalogueVersion: null
    });
    console.warn('Hands-free lookup error:', error);
    logAnalyticsEvent('lookup_error', {
      workflow,
      source
    });
  }

  // The saved scan still belongs to its original Single form while lookup runs.
  if (
    !isPanoramaChartActive() ||
    Date.now() >= startBy ||
    !canAutomaticallyFillPanoramaSingle(contextToken)
  ) {
    return {
      accepted: false,
      success: false,
      status: 'cancelled',
      error: 'Chart context changed. The scan was held.'
    };
  }

  const expired = globalThis.VaxLinkExpiryDate.isExpiredVaccine(parsed);
  const finalExpiryFlag = expired
    ? 'expired'
    : getExpiryStatus(parsed.expiry || parsed.nvc_lot_expiry).flag;
  logAnalyticsEvent('scan_captured', {
    workflow,
    source,
    vaccineLabel: parsed.tradename || parsed.generic_name || '',
    manufacturer: parsed.manufacturer || '',
    expiryFlag: finalExpiryFlag
  });

  const blocked = blockIneligibleChartUse(parsed);
  if (blocked) return { accepted: true, ...blocked };

  if (!getPanoramaAgentCandidates(parsed).length) {
    const warning =
      'VaxLink could not identify the Agent for this lot. The scan was held. Verify the vaccine before entering it.';
    warnPanoramaEntryBlocked(warning);
    return {
      accepted: false,
      success: false,
      status: 'unknown_agent',
      error: warning
    };
  }
  if (
    !(await checkPanoramaScannerRoute(scannerDelivery)) ||
    !isPanoramaChartActive() ||
    Date.now() >= startBy ||
    !canAutomaticallyFillPanoramaSingle(contextToken)
  ) {
    return {
      accepted: false,
      success: false,
      status: 'cancelled',
      error: 'Chart context changed. The scan was held.'
    };
  }
  const owned = beginPanoramaAutofill(parsed, true, {
    automatic: true,
    startBy
  });
  owned._vaxlinkOwner.scannerDelivery = scannerDelivery;
  owned._vaxlinkOwner.activity = activity;

  parsed._vaxlinkResultSource = source;
  logAnalyticsEvent('autofill_attempt', {
    workflow,
    source,
    vaccineLabel: parsed.tradename || parsed.generic_name || '',
    manufacturer: parsed.manufacturer || '',
    expiryFlag: finalExpiryFlag
  });
  const autofillResult = autoFillPanorama(parsed);
  const success = isAutofillSuccess(autofillResult);
  const pending = isAutofillPending(autofillResult);
  if (success || pending) {
    lastHandledScanValue = trimmed;
    lastHandledScanAt = Date.now();
    lastHandledScanOwner = parsed._vaxlinkOwner;
  }
  if (!pending)
    logAnalyticsEvent('autofill_result', {
      workflow,
      source,
      success,
      vaccineLabel: parsed.tradename || parsed.generic_name || '',
      manufacturer: parsed.manufacturer || '',
      expiryFlag: finalExpiryFlag
    });
  if (success) {
    showVaxlinkToast(parsed);
  } else if (!pending) {
    playAudioCue('error');
    if (parsed.lookup_error) showVaxlinkToast(parsed);
  }
  vlog('hands-free autofill', autofillResult?.status, { source });
  return {
    accepted: true,
    success,
    pending,
    chartNeedsReview:
      !success && !pending && parsed._vaxlinkOwner?.writeAttempted === true,
    status: autofillResult?.status || 'failed',
    error:
      autofillResult?.error ||
      (!success && !pending ? 'Could not auto-fill fields' : '')
  };
}

function isHandsFreeSupportedPage() {
  try {
    if (window.location.protocol !== 'https:') return false;
    if (window.top !== window.self) {
      return false;
    }

    const host = String(window.location.hostname || '').toLowerCase();
    if (!host) return false;

    // Exclude known third-party iframes that may include the app URL in hash/query.
    if (host.includes('stripe.network') || host.includes('stripe.com')) {
      return false;
    }

    const isPanorama =
      (host === 'www.panorama.prod.ehealthontario.ca' ||
        host === 'panorama.prod.ehealthontario.ca' ||
        host === 'trpanoramadhir.prod.ehealthontario.ca') &&
      /^\/(?:phsdsm\/)?ImmsWeb\/pages\/recordImms\//.test(
        window.location.pathname
      );
    return isPanorama;
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

  const keys = [
    WORKFLOW_MODE_KEY,
    LEGACY_POPUP_MODE_KEY,
    SINGLE_SCAN_AUTOFILL_KEY,
    GRID_SCAN_AUTOFILL_KEY,
    GRID_DETAIL_AUTOFILL_KEY,
    LEGACY_ADMIN_DATETIME_AUTOFILL_KEY,
    ADMIN_DATE_AUTOFILL_KEY,
    ADMIN_TIME_AUTOFILL_KEY,
    LEGACY_REASON_CONSENT_AUTOFILL_KEY,
    REASON_AUTOFILL_KEY,
    CONSENT_AUTOFILL_KEY,
    AUTO_RESOLVE_FUNDING_KEY,
    AUDIO_FEEDBACK_KEY
  ];
  function applySettings(stored) {
    updatePanoramaWorkflowMode(normalizeWorkflowMode(stored));
    applyAutofillSettings(stored);
    audioFeedbackEnabled = normalizeAudioFeedbackSetting(stored);
  }

  chrome.storage.local.get(keys, (stored) => {
    applySettings(stored);
    panoramaSettingsInitialized = true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const changedKeys = keys.filter((key) => key in changes);
    if (!changedKeys.length) return;
    const next = { ...autofillSettings };
    for (const key of changedKeys) next[key] = changes[key].newValue;
    applySettings(next);
    if (next[GRID_DETAIL_AUTOFILL_KEY] === false) clearGridCarry();
    const owner = panoramaAutofillOwner;
    const scanPreference = owner?.gridDetail
      ? GRID_DETAIL_AUTOFILL_KEY
      : owner?.kind === 'multiple_grid'
        ? GRID_SCAN_AUTOFILL_KEY
        : SINGLE_SCAN_AUTOFILL_KEY;
    if (
      (owner?.automatic && next[scanPreference] === false) ||
      (owner?.autoResolveFunding && next[AUTO_RESOLVE_FUNDING_KEY] === false)
    )
      cancelPanoramaAutofill();
  });

  for (const type of ['pointerdown', 'input', 'change', 'keydown']) {
    document.addEventListener(
      type,
      handlePanoramaAutofillUserInteraction,
      true
    );
  }
  document.addEventListener('click', startGridHandoff, true);
  for (const type of ['pagehide', 'popstate', 'hashchange']) {
    window.addEventListener(type, () => {
      clearGridCarry();
      cancelPanoramaAutofill();
      if (type === 'pagehide') chartActivity?.flush();
    });
  }
  window.addEventListener('blur', invalidateAutomaticPanoramaContext);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') return;
    clearGridCarry();
    if (panoramaAutofillOwner?.trayDose) cancelPanoramaAutofill();
    else {
      trayUseContextGeneration += 1;
      invalidateAutomaticPanoramaContext();
    }
  });
}

// Register listener immediately
setupMessageListener();
initHandsFreeScanner();

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

function getFields(selectors, scope = document) {
  const seen = new Set();
  const fields = [];
  for (const selector of selectors) {
    const matches = scope.querySelectorAll(selector);
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
  return (
    hint.includes('agentiterm') ||
    hint.includes('recordimms_agent') ||
    hint.includes('agentmenu') ||
    /\bagent\b/.test(hint)
  );
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
  const ariaAuto =
    (field.getAttribute && field.getAttribute('aria-autocomplete')) || '';
  const ariaHasPopup =
    (field.getAttribute && field.getAttribute('aria-haspopup')) || '';
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
      console.warn(
        'Could not convert date for field:',
        field.name || field.id,
        nextValue
      );
      return false;
    }
    nextValue = iso;
  }

  assertPanoramaAutofillWrite();
  field.focus();
  assertPanoramaAutofillWrite();
  field.value = nextValue;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  assertPanoramaAutofillWrite();
  field.dispatchEvent(new Event('change', { bubbles: true }));
  assertPanoramaAutofillWrite();
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

  return [...new Set(aliases.map((v) => normalizeForMatch(v)).filter(Boolean))];
}

function isLooseSelectTextMatch(optionTextNorm, desiredNorm) {
  if (!optionTextNorm || !desiredNorm) return false;
  if (optionTextNorm === desiredNorm) return true;

  const optionTokens = optionTextNorm.split(' ').filter(Boolean);
  const desiredTokens = desiredNorm.split(' ').filter(Boolean);

  // Allow short forms (e.g. "IM") only as full tokens, not fuzzy substring matches.
  if (desiredNorm.length <= 2 || optionTextNorm.length <= 2) {
    return (
      optionTokens.includes(desiredNorm) ||
      desiredTokens.includes(optionTextNorm)
    );
  }

  // Prevent downgrading specific values to broader ones (e.g., "mmr var" -> "mmr").
  if (desiredTokens.length > optionTokens.length) {
    const optionIsSubset = optionTokens.every((token) =>
      desiredTokens.includes(token)
    );
    if (optionIsSubset) {
      return false;
    }
  }

  // Single-token desired (e.g. "mmr", "hb") must not match a longer product line via substring
  // (pilot: MMR -> MMRV, HB -> combination agents).
  if (desiredTokens.length === 1 && optionTokens.length > 1) {
    return false;
  }

  return (
    optionTextNorm.includes(desiredNorm) || desiredNorm.includes(optionTextNorm)
  );
}

function fillSelectField(field, value, canWrite = () => true) {
  const rawValue = String(value).trim();
  if (!rawValue) return false;
  const candidates = getValueAliases(rawValue, field);
  const options = Array.from(field.options || []).filter(
    (opt) => opt && opt.value !== ''
  );
  if (!options.length) return false;
  const agentStrict = isPanoramaAgentControl(field);

  let matched = options.find(
    (opt) => opt.value === rawValue || opt.text.trim() === rawValue
  );
  if (!matched) {
    matched = options.find((opt) =>
      candidates.includes(normalizeForMatch(opt.text))
    );
  }
  if (!matched && agentStrict && candidates.length > 0) {
    matched = options.find((opt) => {
      const bracket = extractBracketAgentCode(opt.text);
      return bracket && candidates.includes(bracket);
    });
  }
  if (!matched && !agentStrict && candidates.length > 0) {
    matched = options.find((opt) => {
      const optNorm = normalizeForMatch(opt.text);
      return candidates.some((desired) =>
        isLooseSelectTextMatch(optNorm, desired)
      );
    });
  }
  if (!matched || matched.disabled || !canWrite()) return false;

  assertPanoramaAutofillWrite();
  field.focus();
  assertPanoramaAutofillWrite();
  // A focus handler can replace the options without replacing the select.
  if (
    field.isConnected === false ||
    !Array.from(field.options || []).includes(matched) ||
    matched.disabled ||
    !canWrite()
  )
    return false;
  field.value = matched.value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  assertPanoramaAutofillWrite();
  if (field.isConnected === false || field.value !== matched.value)
    return false;
  field.dispatchEvent(new Event('change', { bubbles: true }));
  assertPanoramaAutofillWrite();
  if (field.isConnected === false || field.value !== matched.value)
    return false;
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

  assertPanoramaAutofillWrite();
  field.focus();
  if ('value' in field) {
    assertPanoramaAutofillWrite();
    field.value = preferredTypedValue;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    assertPanoramaAutofillWrite();
    field.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'a', bubbles: true })
    );
  }
  assertPanoramaAutofillWrite();
  field.click();
  assertPanoramaAutofillWrite();
  field.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
  );

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
    const hit = options.find((opt) => {
      const text = opt.textContent || '';
      const optNorm = normalizeForMatch(text);
      if (agentStrict) {
        if (candidates.includes(optNorm)) return true;
        const bracket = extractBracketAgentCode(text);
        return !!(bracket && candidates.includes(bracket));
      }
      return candidates.some((desired) =>
        isLooseSelectTextMatch(optNorm, desired)
      );
    });
    if (hit) {
      assertPanoramaAutofillWrite();
      hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      assertPanoramaAutofillWrite();
      hit.click();
      assertPanoramaAutofillWrite();
      field.dispatchEvent(new Event('change', { bubbles: true }));
      assertPanoramaAutofillWrite();
      field.blur();
      return true;
    }
  }

  // Keyboard fallback for autocomplete controls.
  assertPanoramaAutofillWrite();
  field.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
  );
  assertPanoramaAutofillWrite();
  field.dispatchEvent(new Event('change', { bubbles: true }));
  assertPanoramaAutofillWrite();
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
  const container =
    field.closest('.x-form-trigger-wrap, .x-form-field-wrap') ||
    field.parentElement;
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

function canFillPanoramaControl(field) {
  if (!field || field.disabled) return false;
  if (
    field.tagName === 'INPUT' &&
    String(field.type || '').toLowerCase() === 'hidden'
  ) {
    return false;
  }
  return true;
}

function getFieldFilledText(field) {
  if (!field) return '';
  if (field.tagName === 'SELECT') {
    const selected =
      field.options && field.selectedIndex >= 0
        ? field.options[field.selectedIndex]
        : null;
    return String(selected?.text || field.value || '').trim();
  }
  const id = String(field.id || '');
  if (id.endsWith('_focus')) {
    const label = document.getElementById(id.slice(0, -6) + '_label');
    return String(label?.textContent || '').trim();
  }
  if (id.endsWith('_input')) {
    const label = document.getElementById(id.slice(0, -6) + '_label');
    if (label && String(label.textContent || '').trim()) {
      return String(label.textContent || '').trim();
    }
  }
  return String(field.value || field.textContent || '').trim();
}

function isAgentTextAccepted(candidate, selected) {
  const expected = normalizeForMatch(candidate);
  return (
    !!expected &&
    (normalizeForMatch(selected) === expected ||
      panoramaAgentIdentity(selected) === expected)
  );
}

function fillPanoramaAgentField(fields, candidate, scope) {
  for (const field of fields) {
    if (!fillField(field, candidate)) {
      continue;
    }
    if (
      getPanoramaSelectedAgentTexts(scope).some((text) =>
        isAgentTextAccepted(candidate, text)
      )
    ) {
      return true;
    }
  }
  return false;
}

function parseAdministeredDateTime(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  const mdyHm = raw.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/
  );
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

// One timestamp belongs to this fill, never to the saved scan. Retain it when
// Panorama rerenders so retries cannot change the date or advance the time.
function markPanoramaAutofillStarted(data) {
  if (!data._vaxlinkAutofillAt)
    data._vaxlinkAutofillAt = new Date().toISOString();
}

function getPanoramaAdministeredDateTimeValues(data) {
  const parsed = parseAdministeredDateTime(data?._vaxlinkAutofillAt);
  if (!parsed) return { date: '', time: '' };
  return {
    date: adminDateAutofillEnabled ? formatPanoramaDateValue(parsed) : '',
    time: adminTimeAutofillEnabled ? formatPanoramaTimeValue(parsed) : ''
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
  const candidates = getPanoramaTradeCandidates(data).map(normalizeForMatch);
  if (!candidates.length) return false;
  const fields = getFields(
    getPanoramaTradeSelectors(),
    data?._vaxlinkOwner?.form
  );
  return panoramaSelectionControls(fields)
    .filter((field) => field.tagName !== 'SELECT' || !!field.value)
    .some((field) =>
      candidates.includes(normalizeForMatch(getFieldFilledText(field)))
    );
}

function fillPanoramaTradeName(data) {
  const candidates = getPanoramaTradeCandidates(data);
  if (!candidates.length) return false;
  const fields = getFields(
    getPanoramaTradeSelectors(),
    data?._vaxlinkOwner?.form
  );
  for (const field of panoramaSelectionControls(fields).filter(
    canFillPanoramaControl
  )) {
    for (const candidate of candidates) {
      if (field.tagName === 'SELECT') {
        const matches = Array.from(field.options || []).filter(
          (option) =>
            option.value &&
            !option.disabled &&
            normalizeForMatch(option.text) === normalizeForMatch(candidate)
        );
        if (matches.length !== 1) continue;
        fillSelectField(field, matches[0].value);
      } else if (!fillField(field, candidate)) {
        continue;
      }
      return hasPanoramaTradeSelection(data);
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

function panoramaSelectionControls(fields) {
  // The native selection can update before the visible widget label.
  const selects = fields.filter((field) => field.tagName === 'SELECT');
  return selects.length ? selects : fields;
}

function getPanoramaDetailAgentFields(scope) {
  const fields = getFields(getPanoramaAgentSelectors(), scope);
  if (fields.length || !scope) return fields;
  const controls = [...scope.querySelectorAll('label')]
    .filter((label) => normalizeLabelText(label.textContent) === 'agent')
    .map((label) => label.control)
    .filter((control) => control && scope.contains(control));
  return controls.length === 1 ? controls : [];
}

function getPanoramaSelectedAgentTexts(scope) {
  const fields = getPanoramaDetailAgentFields(scope);
  return panoramaSelectionControls(fields)
    .filter((field) => field.tagName !== 'SELECT' || !!field.value)
    .map(getFieldFilledText)
    .filter((text) => {
      const normalized = normalizeForMatch(text);
      return (
        normalized && normalized !== 'select' && normalized !== 'select one'
      );
    });
}

function getPanoramaCurrentAgentSelectionText(scope) {
  return getPanoramaSelectedAgentTexts(scope)[0] || '';
}

function hasPanoramaAgentSelection(data) {
  const selected = getPanoramaSelectedAgentTexts(data?._vaxlinkOwner?.form);
  const candidates = getPanoramaAgentCandidates(data);
  if (!candidates.length) return selected.length > 0;
  const mappedAgents = getMappedPanoramaAgents(data);
  return selected.some((text) =>
    matchesExactPanoramaAgent(text, candidates, mappedAgents)
  );
}

function panoramaAgentIdentity(text) {
  const code = String(text || '').match(/\[([^\]]+)\]/)?.[1];
  return normalizeForMatch(code || text);
}

function queueRecordMatchesPanoramaAgentText(record, agentText) {
  const payload = buildAutofillPayloadFromQueueRecord(record);
  if (!payload) return false;
  return matchesExactPanoramaAgent(
    agentText,
    getPanoramaAgentCandidates(payload),
    getMappedPanoramaAgents(payload)
  );
}

function matchesExactPanoramaAgent(agentText, candidates, mappedAgents) {
  const selected = panoramaAgentIdentity(agentText);
  const compatible =
    /\[[^\]]+\]/.test(agentText) && mappedAgents.length
      ? mappedAgents
      : candidates;
  return compatible.some(
    (candidate) => normalizeForMatch(candidate) === selected
  );
}

function tryFillPanoramaAgent(data) {
  const candidates = getPanoramaAgentCandidates(data);
  if (!candidates.length) return false;
  const scope = data?._vaxlinkOwner?.form;
  for (const candidate of candidates) {
    const fields = panoramaSelectionControls(
      getPanoramaDetailAgentFields(scope)
    ).filter(canFillPanoramaControl);
    if (fillPanoramaAgentField(fields, candidate, scope)) return true;
  }
  return false;
}

function hasPanoramaDeferredDetailData(data) {
  const administered = getPanoramaAdministeredDateTimeValues(data);
  if (administered.date || administered.time) return true;
  if (
    reasonAutofillEnabled &&
    getFields(getPanoramaReasonForImmunizationSelectors()).length
  )
    return true;
  if (
    consentAutofillEnabled &&
    getFields(getPanoramaConsentReasonSelectors()).length
  )
    return true;
  return false;
}

function getPanoramaAdministeredDateTimeFields(
  data,
  { includeDisabled = false } = {}
) {
  const scope = data?._vaxlinkOwner?.form;
  return {
    dateField: getFields(
      [
        'input[id*="immsDetailssection_dateAdministedDate:dateInput_input"]',
        'input[id*="dateAdministedDate:dateInput_input"]'
      ],
      scope
    ).find(
      (field) =>
        (includeDisabled || canFillPanoramaControl(field)) && isVisible(field)
    ),
    timeField: getFields(
      [
        'input[id*="immsDetailssection_dateAdministedDate:timeInput:timeInput"]',
        'input[id*="dateAdministedDate:timeInput:timeInput"]'
      ],
      scope
    ).find(
      (field) =>
        (includeDisabled || canFillPanoramaControl(field)) && isVisible(field)
    )
  };
}

function panoramaDateTimeHasValue(value) {
  return /[a-z0-9]/i.test(String(value || ''));
}

const PANORAMA_DETAIL_FIELD_LABELS = {
  date: 'administration date',
  time: 'administration time',
  reason: 'Reason for Immunization',
  consent: 'Consent for Service'
};

function getPanoramaDeferredDetailFieldsNeedingReview(data, observed) {
  const scope = data?._vaxlinkOwner?.form;
  const administered = getPanoramaAdministeredDateTimeValues(data);
  const { dateField, timeField } = getPanoramaAdministeredDateTimeFields(data, {
    includeDisabled: true
  });
  const dateTimeStatus = (requested, field) =>
    !requested
      ? 'not_requested'
      : !field
        ? 'missing'
        : panoramaDateTimeHasValue(field.value)
          ? 'match'
          : canFillPanoramaControl(field)
            ? 'mismatch'
            : 'disabled';
  const statuses = {
    date: dateTimeStatus(administered.date, dateField),
    time: dateTimeStatus(administered.time, timeField),
    reason: reasonAutofillEnabled
      ? panoramaSelectAutofillStatus(
          getPanoramaReasonForImmunizationSelectors(),
          scope
        )
      : 'not_requested',
    consent: consentAutofillEnabled
      ? panoramaSelectAutofillStatus(getPanoramaConsentReasonSelectors(), scope)
      : 'not_requested'
  };
  if (observed) Object.assign(observed, statuses);
  return Object.keys(statuses).filter((key) => {
    const status = statuses[key];
    // Missing or disabled Reason and Consent controls need no write.
    return (
      status === 'mismatch' ||
      ((key === 'date' || key === 'time') &&
        (status === 'missing' || status === 'disabled'))
    );
  });
}

function hasPanoramaDeferredDetailFieldsFilled(data, observed) {
  return (
    getPanoramaDeferredDetailFieldsNeedingReview(data, observed).length === 0
  );
}

function fillPanoramaMaskedTextInput(
  field,
  nextValue,
  canWrite = () => true,
  preserveExisting = false
) {
  if (!field || !nextValue || !canWrite()) return false;
  const value = String(nextValue).trim();
  if (!value) return false;
  assertPanoramaAutofillWrite();
  field.focus();
  assertPanoramaAutofillWrite();
  if (
    field.isConnected === false ||
    !canWrite() ||
    (preserveExisting && panoramaDateTimeHasValue(field.value))
  )
    return false;
  field.value = '';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  assertPanoramaAutofillWrite();
  if (field.isConnected === false || !canWrite()) return false;
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  assertPanoramaAutofillWrite();
  field.dispatchEvent(
    new KeyboardEvent('keyup', { key: value.slice(-1) || '0', bubbles: true })
  );
  assertPanoramaAutofillWrite();
  if (field.isConnected === false || !canWrite()) return false;
  field.dispatchEvent(new Event('change', { bubbles: true }));
  assertPanoramaAutofillWrite();
  field.blur();
  return String(field.value || '').trim() === value;
}

function fillPanoramaAdministeredDateTimeFields(data, canWrite = () => true) {
  const administered = getPanoramaAdministeredDateTimeValues(data);
  if (!administered.date && !administered.time) return 0;
  let fillCount = 0;
  const { dateField } = getPanoramaAdministeredDateTimeFields(data);
  if (
    administered.date &&
    !panoramaDateTimeHasValue(dateField?.value) &&
    canWrite() &&
    fillPanoramaMaskedTextInput(dateField, administered.date, canWrite, true)
  ) {
    fillCount += 1;
  }
  const { timeField } = getPanoramaAdministeredDateTimeFields(data);
  if (
    administered.time &&
    !panoramaDateTimeHasValue(timeField?.value) &&
    canWrite() &&
    fillPanoramaMaskedTextInput(timeField, administered.time, canWrite, true)
  ) {
    fillCount += 1;
  }
  return fillCount;
}

// Reason for Immunization and consent are PrimeFaces selectonemenu widgets whose
// hidden native <select> carries the real options. Reason defaults to "Routine";
// the consent reason ("Consent obtained") only becomes enabled after the lot is
// selected, so both are handled as deferred fields and retried by the scheduler.
function getPanoramaReasonForImmunizationSelectors() {
  return ['select[id*="reasonForImmunizationSelect:iTermSelectOneMenu_input"]'];
}

function getPanoramaConsentReasonSelectors() {
  return [
    'select[id*="consentReadinessReasonSelect:iTermSelectOneMenu_input"]'
  ];
}

function getPanoramaReasonForImmunizationValue(data) {
  const explicit = String(data?.reason_for_immunization || '').trim();
  return explicit || 'Routine';
}

function getPanoramaConsentReasonValue(data) {
  const explicit = String(data?.consent_reason || '').trim();
  return explicit || 'Consent obtained';
}

function panoramaSelectAutofillStatus(selectors, scope) {
  const fields = getFields(selectors, scope);
  if (!fields.length) return 'missing';
  const editable = fields.filter(canFillPanoramaControl);
  if (!editable.length) return 'disabled';
  return editable.every((field) => field.value) ? 'match' : 'mismatch';
}

function getPanoramaDefaultOption(field, desiredText) {
  const desired = normalizeForMatch(desiredText);
  const options = [...field.options].filter(
    (option) =>
      option.value &&
      !option.disabled &&
      normalizeForMatch(option.text) === desired
  );
  return options.length === 1 ? options[0] : null;
}

function fillPanoramaReasonForImmunization(data, canWrite = () => true) {
  if (!reasonAutofillEnabled) return 0;
  const fields = getFields(
    getPanoramaReasonForImmunizationSelectors(),
    data?._vaxlinkOwner?.form
  ).filter(canFillPanoramaControl);
  if (fields.length !== 1 || fields[0].value) return 0;
  const [field] = fields;
  const option = getPanoramaDefaultOption(
    field,
    getPanoramaReasonForImmunizationValue(data)
  );
  if (!option) return 0;
  return fillSelectField(
    field,
    option.value,
    () => canWrite() && (!field.value || field.value === option.value)
  )
    ? 1
    : 0;
}

function fillPanoramaConsentReason(data, canWrite = () => true) {
  if (!consentAutofillEnabled) return 0;
  const owner = data._vaxlinkOwner;
  const now = performance.now();
  if (owner?.consentWrites >= 2 || now < (owner?.consentReadyAt ?? 0)) return 0;
  const fields = getFields(
    getPanoramaConsentReasonSelectors(),
    owner?.form
  ).filter(canFillPanoramaControl);
  if (fields.length !== 1 || fields[0].value) return 0;
  const [field] = fields;
  const requested = getPanoramaConsentReasonValue(data);
  const option = getPanoramaDefaultOption(field, requested);
  if (!option) return 0;
  const desired = normalizeForMatch(requested);
  const noteWrite = () => {
    if (!owner) return;
    owner.consentWrites = (owner.consentWrites || 0) + 1;
    owner.consentReadyAt = now + 700;
  };

  const widget = field.closest('.ui-selectonemenu');
  if (!widget) {
    if (!isVisible(field) || !canWrite()) return 0;
    noteWrite();
    return fillSelectField(
      field,
      option.value,
      () =>
        // Focusing a blank select can let Panorama assign its own value.
        canWrite() && (!field.value || field.value === option.value)
    )
      ? 1
      : 0;
  }

  // Use the visible menu so PrimeFaces runs its own item selection handler.
  const widgetId = field.id.replace(/_input$/, '');
  const findPanel = () =>
    findPanoramaWidgetPart(
      document,
      'consentReadinessReasonSelect:iTermSelectOneMenu',
      widgetId,
      'panel'
    );
  let panel = findPanel();
  if (!isVisible(panel)) {
    const trigger = widget.querySelector('.ui-selectonemenu-trigger');
    if (
      !isVisible(trigger) ||
      now < (owner?.consentOpenAgainAt ?? 0) ||
      !canWrite()
    )
      return 0;
    if (owner) owner.consentOpenAgainAt = now + 700;
    assertPanoramaAutofillWrite();
    trigger.click();
    panel = findPanel();
  }
  if (!isVisible(panel) || field.isConnected === false || field.value) return 0;
  const items = panoramaLotPanelItems(panel).filter(
    (item) =>
      isVisible(item) &&
      !item.classList.contains('ui-state-disabled') &&
      normalizeForMatch(panoramaLotPanelItemText(item)) === desired
  );
  if (items.length !== 1 || !canWrite()) return 0;
  assertPanoramaAutofillWrite();
  noteWrite();
  items[0].click();
  return 1;
}

function isPrimeFacesAjaxBusy() {
  try {
    const queue =
      globalThis.PrimeFaces &&
      globalThis.PrimeFaces.ajax &&
      globalThis.PrimeFaces.ajax.Queue;
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

function panoramaDetailAgentMatches(data) {
  return (
    !getPanoramaAgentCandidates(data).length || hasPanoramaAgentSelection(data)
  );
}

function readPanoramaLotList() {
  const widget = getPanoramaLotWidget();
  const options = panoramaLotSelectOptions(widget?.select);
  const control = options.length ? widget.select : widget?.panel;
  if (!control) return null;
  const rows = options.length
    ? options.map((option) => ({
        node: option,
        text: option.text,
        value: option.value,
        disabled: option.disabled
      }))
    : panoramaLotPanelItems(widget.panel).map((item) => ({
        node: item,
        text: panoramaLotPanelItemText(item)
      }));
  return rows.length ? { control, rows } : null;
}

function isPanoramaLotListAwaitingRefresh(data) {
  const owner = data._vaxlinkOwner;
  const before = owner?.lotListBeforeRefresh;
  if (!before) return false;
  const after = readPanoramaLotList();
  if (!after) return true;
  const unchanged =
    after.control === before.control &&
    before.rows.length === after.rows.length &&
    after.rows.every((row, i) => {
      const old = before.rows[i];
      return (
        row.node === old.node &&
        row.text === old.text &&
        row.value === old.value &&
        row.disabled === old.disabled
      );
    });
  if (!unchanged) owner.lotListBeforeRefresh = null;
  return unchanged;
}

function panoramaDetailProductMatches(data) {
  return data.lot
    ? !isPanoramaLotListAwaitingRefresh(data) &&
        hasPanoramaLotSelection(data.lot)
    : !getPanoramaTradeCandidates(data).length ||
        hasPanoramaTradeSelection(data);
}

function fillPanoramaDeferredDetailFields(data) {
  if (!data) return 0;
  // A field event can replace the selected product or the later controls.
  const canWrite = () =>
    (!data._vaxlinkOwner || isPanoramaAutofillCurrent(data)) &&
    !isPrimeFacesAjaxBusy() &&
    panoramaDetailAgentMatches(data) &&
    panoramaDetailProductMatches(data);
  if (!canWrite()) return 0;
  let count = fillPanoramaAdministeredDateTimeFields(data, canWrite);
  if (reasonAutofillEnabled && canWrite())
    count += fillPanoramaReasonForImmunization(data, canWrite);
  // A detail write can refresh the consent menu and briefly expose old options.
  if (count && data._vaxlinkOwner)
    data._vaxlinkOwner.consentReadyAt = performance.now() + 700;
  else if (consentAutofillEnabled && canWrite())
    count += fillPanoramaConsentReason(data, canWrite);
  return count;
}

function normalizePanoramaLotToken(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

const PANORAMA_FUNDING_CHOICES = ['PUBLICLY_FUNDED', 'NON_PUBLICLY_FUNDED'];

function getPanoramaFundingRadios() {
  const form =
    panoramaWritingData?._vaxlinkOwner?.form || getPanoramaAutofillForm();
  return Array.from(
    form?.querySelectorAll?.('input[id*="fundedRadio:selectOneRadio"]') || []
  );
}

function getPanoramaFundedRadioValue() {
  const checked = getPanoramaFundingRadios().find((radio) => radio.checked);
  return String(checked?.value || '').trim();
}

function isExplicitPanoramaFundingValue(value) {
  return PANORAMA_FUNDING_CHOICES.includes(value);
}

function getPanoramaFundingLabel(value) {
  if (value === 'PUBLICLY_FUNDED') return 'Publicly Funded';
  if (value === 'NON_PUBLICLY_FUNDED') return 'Non-Publicly Funded';
  if (value === 'SHOW_ALL') return 'Show All';
  return 'funding filter';
}

function readPanoramaLotLabel(optionText) {
  // Labels can add expiry and funding. A dash inside the Lot is part of
  // its identity, including segments such as PF in ABC1-PF-2.
  const expiry = /(?:\s+(?:[-–—|,]\s*)?|\s*\(\s*)exp(?:iry|iration)?[.\s:]/i;
  const funding =
    /(?:\s+(?:[-–—|,]\s*)?|\s*\(\s*)(?:npf|pf|(?:non[-_ ]?)?publicly[ _-]+funded)\s*\)?$/i;
  const [lotAndFunding] = String(optionText || '')
    .trim()
    .split(expiry, 1);
  const label = lotAndFunding.trim();
  const fundingNote = label.match(funding)?.[0] || '';
  const lot = label.replace(funding, '').trim().toUpperCase();
  const prefixed = lot.startsWith('N-');
  const markedNonPublic = /npf|non[-_ ]?publicly/i.test(fundingNote);
  return {
    lot,
    manufacturerLot: prefixed ? lot.slice(2) : lot,
    // Panorama requires N- for an NPF entry. Disagreeing marks are ambiguous.
    funding:
      fundingNote && prefixed !== markedNonPublic
        ? null
        : prefixed
          ? 'NON_PUBLICLY_FUNDED'
          : 'PUBLICLY_FUNDED'
  };
}

function getPanoramaLotText(optionText) {
  return readPanoramaLotLabel(optionText).lot;
}

function getPanoramaNonemptyLotLabel(value) {
  const lot = getPanoramaLotText(value);
  return /^(?:[-–— ]*(?:SELECT(?: ONE)?|NO RECORDS(?: FOUND)?)?[-–— ]*)$/.test(
    lot
  )
    ? ''
    : lot;
}

function getPanoramaManufacturerLotText(optionText, funding) {
  const label = readPanoramaLotLabel(optionText);
  return label.funding && (!funding || label.funding === funding)
    ? label.manufacturerLot
    : '';
}

function panoramaLotLabelMatches(optionText, lotValue, funding) {
  const lotToken = normalizePanoramaLotToken(lotValue);
  return (
    !!lotToken &&
    normalizePanoramaLotToken(
      getPanoramaManufacturerLotText(optionText, funding)
    ) === lotToken
  );
}

function findPanoramaLotChoice(items, textOf, lotValue, funding) {
  const exact = String(lotValue || '')
    .trim()
    .toUpperCase();
  if (!exact) return null;
  const exactMatches = items.filter(
    (item) => getPanoramaManufacturerLotText(textOf(item), funding) === exact
  );
  if (exactMatches.length)
    return exactMatches.length === 1 ? exactMatches[0] : null;
  const similar = items.filter((item) =>
    panoramaLotLabelMatches(textOf(item), lotValue, funding)
  );
  return similar.length === 1 ? similar[0] : null;
}

function panoramaLotSelectOptions(field) {
  return Array.from(field?.options || []).filter((option) => option.value);
}

function panoramaLotPanelItemText(item) {
  return String(
    item.getAttribute('data-label') ||
      item.getAttribute('title') ||
      item.textContent ||
      ''
  ).trim();
}

function panoramaLotPanelItems(panel) {
  return [
    ...(panel?.querySelectorAll('li[id], .ui-selectonemenu-item') || [])
  ].filter(panoramaLotPanelItemText);
}

function getPanoramaLotFundingChoices(widget, lotValue) {
  const radio = getPanoramaFundedRadioValue();
  const choice = panoramaWritingData?._fundedRadioChoice;
  if (isExplicitPanoramaFundingValue(radio))
    return choice && choice !== radio ? [] : [radio];
  if (choice) return [choice];

  const labels = [
    ...panoramaLotSelectOptions(widget?.select).map((option) => option.text),
    ...panoramaLotPanelItems(widget?.panel).map(panoramaLotPanelItemText)
  ];
  return PANORAMA_FUNDING_CHOICES.filter((funding) =>
    labels.some((label) => panoramaLotLabelMatches(label, lotValue, funding))
  );
}

function hasOnlyPanoramaLotFunding(widget, lotValue, funding) {
  const choices = getPanoramaLotFundingChoices(widget, lotValue);
  return choices.length === 1 && choices[0] === funding;
}

function panoramaLotSelectionMatches(widget, lotValue) {
  if (!widget) return false;
  const fundingChoices = getPanoramaLotFundingChoices(widget, lotValue);
  if (fundingChoices.length !== 1) return false;
  const [funding] = fundingChoices;
  const options = panoramaLotSelectOptions(widget.select);
  if (options.length) {
    const matched = findPanoramaLotChoice(
      options,
      (option) => option.text,
      lotValue,
      funding
    );
    return !!matched && widget.select.value === matched.value;
  }
  const selected = getPanoramaManufacturerLotText(
    readPanoramaLotSelection(widget),
    funding
  );
  if (!selected) return false;
  const items = panoramaLotPanelItems(widget.panel);
  if (!items.length)
    return (
      selected ===
      String(lotValue || '')
        .trim()
        .toUpperCase()
    );
  const matched = findPanoramaLotChoice(
    items,
    panoramaLotPanelItemText,
    lotValue,
    funding
  );
  return (
    !!matched &&
    selected ===
      getPanoramaManufacturerLotText(panoramaLotPanelItemText(matched), funding)
  );
}

function getPanoramaLotWidget(form = getPanoramaAutofillForm()) {
  if (!form?.isConnected) return null;
  const suffix = 'LotInfo:lotNumberSelect:selectOneMenu';
  const controls = [
    ...form.querySelectorAll(`[id$="${suffix}"], select[id$="${suffix}_input"]`)
  ];
  const ids = new Set(controls.map((node) => node.id.replace(/_input$/, '')));
  if (ids.size !== 1) return null;
  const [id] = ids;
  const roots = controls.filter((node) => node.id === id);
  const selects = controls.filter((node) => node.id === `${id}_input`);
  if (roots.length > 1 || selects.length > 1) return null;
  const [root] = roots;
  const select = selects.find((node) => !root || root.contains(node));
  if (!root && !canFillPanoramaControl(select)) return null;
  const label = root && findPanoramaWidgetPart(root, suffix, id, 'label');
  const panel = findPanoramaWidgetPart(document, suffix, id, 'panel');
  return {
    id,
    root,
    select,
    label,
    panel: panel?.isConnected ? panel : null
  };
}

function findPanoramaWidgetPart(scope, suffix, id, part) {
  const exact = [...scope.querySelectorAll(`[id$="${suffix}_${part}"]`)].filter(
    (node) => node.id === `${id}_${part}`
  );
  return exact.length === 1 ? exact[0] : null;
}

function readPanoramaLotSelection(widget) {
  if (!widget) return '';
  if (widget.select && panoramaLotSelectOptions(widget.select).length) {
    return widget.select.value ? getFieldFilledText(widget.select) : '';
  }
  return widget.label?.textContent || '';
}

function getPanoramaDisplayedLot(widget) {
  return (
    getPanoramaNonemptyLotLabel(readPanoramaLotSelection(widget)) ||
    getPanoramaNonemptyLotLabel(widget?.label?.textContent)
  );
}

function clearPanoramaSelection(field) {
  const blanks = [...(field?.options || [])].filter(
    (option) => !option.disabled && option.value === ''
  );
  if (blanks.length !== 1 || !canFillPanoramaControl(field) || !field.value)
    return false;
  assertPanoramaAutofillWrite();
  field.value = '';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  assertPanoramaAutofillWrite();
  if (field.isConnected)
    field.dispatchEvent(new Event('change', { bubbles: true }));
  assertPanoramaAutofillWrite();
  return field.isConnected && !field.value;
}

function clearPanoramaNonMatchingLot(data) {
  const owner = data._vaxlinkOwner;
  const widget = getPanoramaLotWidget();
  const selectedValue = getPanoramaNonemptyLotLabel(
    readPanoramaLotSelection(widget)
  );
  const visible = getPanoramaNonemptyLotLabel(widget?.label?.textContent);
  const selected = selectedValue || visible;
  if (!selected) return 'empty';
  const lot = normalizePanoramaLotToken(data.lot);
  const ownedAgent =
    owner.filledAgent &&
    getPanoramaCurrentAgentSelectionText(owner.form) === owner.filledAgent;
  if (
    !lot ||
    !isPanoramaAutofillCurrent(data) ||
    isPrimeFacesAjaxBusy() ||
    owner.initialLot ||
    (owner.lotSelectionWidgetId !== widget.id && !ownedAgent) ||
    (visible && visible !== selectedValue) ||
    normalizePanoramaLotToken(selected) === lot ||
    normalizePanoramaLotToken(selected.replace(/^N-/, '')) === lot
  )
    return 'review';

  // Panorama may reselect its only Lot. Reset an Agent only if this fill
  // selected it on an empty form and the same owned Agent is still current.
  if (ownedAgent && !owner.initialAgent) {
    const fields = getPanoramaDetailAgentFields(owner.form).filter(
      (field) => field.tagName === 'SELECT'
    );
    if (fields.length === 1 && clearPanoramaSelection(fields[0])) {
      return !getPanoramaCurrentAgentSelectionText(owner.form) &&
        !getPanoramaDisplayedLot(getPanoramaLotWidget())
        ? 'cleared'
        : 'review';
    }
    if (getPanoramaLotWidget()?.select !== widget.select) return 'review';
  }
  if (!clearPanoramaSelection(widget.select)) return 'review';
  const current = getPanoramaLotWidget();
  if (current?.id !== widget.id) return 'review';
  if (current.select === widget.select && current.label)
    current.label.textContent =
      widget.select.options[widget.select.selectedIndex]?.text || '';
  return getPanoramaDisplayedLot(current) ? 'review' : 'cleared';
}

function fillPanoramaLotFromSelect(widget, lotValue) {
  const field = widget.select;
  if (!canFillPanoramaControl(field)) return false;
  const fundingChoices = getPanoramaLotFundingChoices(widget, lotValue);
  if (fundingChoices.length !== 1) return false;
  const [funding] = fundingChoices;
  const options = panoramaLotSelectOptions(field);
  const matched = findPanoramaLotChoice(
    options,
    (option) => option.text,
    lotValue,
    funding
  );
  if (!matched || matched.disabled) return false;

  assertPanoramaAutofillWrite();
  field.focus();
  assertPanoramaAutofillWrite();
  // Focusing can refresh options or expose the other funding category.
  const afterFocus = getPanoramaLotWidget();
  if (
    !field.isConnected ||
    afterFocus?.select !== field ||
    !hasOnlyPanoramaLotFunding(afterFocus, lotValue, funding) ||
    findPanoramaLotChoice(
      panoramaLotSelectOptions(field),
      (option) => option.text,
      lotValue,
      funding
    ) !== matched ||
    matched.disabled
  )
    return false;
  if (panoramaWritingData?._vaxlinkOwner)
    panoramaWritingData._vaxlinkOwner.lotSelectionWidgetId = widget.id;
  field.value = matched.value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  assertPanoramaAutofillWrite();
  if (field.isConnected)
    field.dispatchEvent(new Event('change', { bubbles: true }));
  assertPanoramaAutofillWrite();
  if (field.isConnected) field.blur();
  assertPanoramaAutofillWrite();

  const current = getPanoramaLotWidget();
  if (
    current?.id !== widget.id ||
    !panoramaLotSelectionMatches(current, lotValue)
  )
    return false;
  if (current.select === field && current.label) {
    // The native value proves the match. Keep the visible label in sync while
    // Panorama processes the change and refreshes the dependent fields.
    current.label.textContent = readPanoramaLotSelection(current);
  }
  return true;
}

function setPanoramaFundedRadioValue(value) {
  const desired = String(value || '').trim();
  const radio = getPanoramaFundingRadios().find(
    (radio) => radio.value === desired
  );
  if (!radio) return 'not_found';
  if (radio.checked) return 'already';
  const box = radio
    .closest('.ui-radiobutton')
    ?.querySelector('.ui-radiobutton-box');
  if (box) {
    // A single widget click mirrors a manual selection exactly. Dispatching a
    // synthetic change on top of it queues a SECOND radio AJAX whose
    // serialization/re-render races the first — that double round-trip is
    // what wiped the "Display Expired and Recalled Lots" checkbox, which a
    // manual radio change leaves alone. Only fall back to the synthetic path
    // when the widget did not take the click.
    assertPanoramaAutofillWrite();
    box.click();
    if (radio.checked) {
      vlog('VaxLink: funded radio set to', desired);
      return 'clicked';
    }
  }
  assertPanoramaAutofillWrite();
  radio.checked = true;
  // The radio AJAX re-renders this panel with the right state, but during that
  // round trip the group still DISPLAYS the previous choice (the widget did
  // not take our click, so only the hidden input changed). Sync the widget
  // visuals immediately so the nurse sees their pick, not a SHOW_ALL blip;
  // the server response then replaces this with the authoritative markup.
  const group = radio.closest('table.ui-selectoneradio');
  if (group) {
    group.querySelectorAll('.ui-radiobutton-box').forEach((otherBox) => {
      otherBox.classList.remove('ui-state-active');
      const icon = otherBox.querySelector('.ui-radiobutton-icon');
      if (icon) {
        icon.classList.remove('ui-icon-bullet');
        icon.classList.add('ui-icon-blank');
      }
    });
  }
  if (box) {
    box.classList.add('ui-state-active');
    const icon = box.querySelector('.ui-radiobutton-icon');
    if (icon) {
      icon.classList.remove('ui-icon-blank');
      icon.classList.add('ui-icon-bullet');
    }
  }
  radio.dispatchEvent(new Event('change', { bubbles: true }));
  vlog('VaxLink: funded radio set to', desired);
  return 'clicked';
}

function blockIneligibleChartUse(data) {
  if (!globalThis.VaxLinkExpiryDate.blocksChartUse(data)) return null;
  const expiry = globalThis.VaxLinkExpiryDate.expiredVaccineDate(data);
  chartActivity?.record(data._vaxlinkOwner?.activity, 'stop', {
    reason: 'expired'
  });
  showVaxlinkToast({
    lot: data.lot,
    tradename: data.tradename,
    generic_name: data.generic_name,
    name: data.name,
    expiry,
    expiry_flag: 'expired',
    _chartUseBlocked: true,
    reference_only: data.reference_only === true
  });
  return {
    success: false,
    status: 'expired',
    error: data.reference_only
      ? 'This lot is saved for reference only.'
      : 'Expired vaccine. Autofill stopped.'
  };
}

const LOT_DROPDOWN_OPEN_COOLDOWN_MS = 2000;
let lastLotDropdownOpenClickAt = 0;

function openPanoramaLotDropdown(widget) {
  if (isVisible(widget.panel)) return;
  const now = Date.now();
  if (now - lastLotDropdownOpenClickAt < LOT_DROPDOWN_OPEN_COOLDOWN_MS) return;
  const trigger = widget.root?.querySelector('.ui-selectonemenu-trigger');
  if (!isVisible(trigger)) return;

  // Use the visible widget only when the native select path is unavailable.
  lastLotDropdownOpenClickAt = now;
  assertPanoramaAutofillWrite();
  trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  assertPanoramaAutofillWrite();
  if (trigger.isConnected) trigger.click();
}

function fillPanoramaLotFromPanelItems(widget, lotValue) {
  const panel = widget.panel;
  if (!panel) return false;
  const filter = document.getElementById(`${widget.id}_filter`);
  const lotText = String(lotValue || '');
  if (
    panel.contains(filter) &&
    canFillPanoramaControl(filter) &&
    filter.value !== lotText
  ) {
    // Reusing the existing filter text avoids stealing focus on each retry.
    assertPanoramaAutofillWrite();
    filter.focus();
    assertPanoramaAutofillWrite();
    if (!filter.isConnected) return false;
    filter.value = lotText;
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    assertPanoramaAutofillWrite();
    if (!filter.isConnected) return false;
    filter.dispatchEvent(
      new KeyboardEvent('keyup', {
        key: lotText.slice(-1) || 'a',
        bubbles: true
      })
    );
    assertPanoramaAutofillWrite();
    if (!filter.isConnected) return false;
    filter.dispatchEvent(new Event('change', { bubbles: true }));
    assertPanoramaAutofillWrite();
  }
  if (!panel.isConnected || getPanoramaLotWidget()?.panel !== panel)
    return false;

  const fundingChoices = getPanoramaLotFundingChoices(widget, lotValue);
  if (fundingChoices.length !== 1) return false;
  const [funding] = fundingChoices;
  const items = panoramaLotPanelItems(panel);
  // A filtered-out exact option still matters when deciding whether a
  // similar-looking label is safe to use.
  const matched = findPanoramaLotChoice(
    items,
    panoramaLotPanelItemText,
    lotValue,
    funding
  );
  const available =
    matched &&
    !matched.classList.contains('ui-helper-hidden') &&
    matched.getAttribute('aria-disabled') !== 'true' &&
    isVisible(matched);
  if (!available) return false;
  const options = panoramaLotSelectOptions(widget.select);
  if (
    options.some((option) =>
      panoramaLotLabelMatches(option.text, lotValue, funding)
    )
  ) {
    const nativeMatch = findPanoramaLotChoice(
      options,
      (option) => option.text,
      lotValue,
      funding
    );
    if (
      !nativeMatch ||
      getPanoramaLotText(nativeMatch.text) !==
        getPanoramaLotText(panoramaLotPanelItemText(matched))
    )
      return false;
  }
  for (const type of ['mouseover', 'mousedown', 'mouseup']) {
    assertPanoramaAutofillWrite();
    if (!matched.isConnected) return false;
    matched.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  }
  assertPanoramaAutofillWrite();
  const beforeClick = getPanoramaLotWidget();
  if (
    !matched.isConnected ||
    !isVisible(matched) ||
    beforeClick?.panel !== panel ||
    !hasOnlyPanoramaLotFunding(beforeClick, lotValue, funding) ||
    findPanoramaLotChoice(
      panoramaLotPanelItems(panel),
      panoramaLotPanelItemText,
      lotValue,
      funding
    ) !== matched
  )
    return false;
  if (panoramaWritingData?._vaxlinkOwner)
    panoramaWritingData._vaxlinkOwner.lotSelectionWidgetId = widget.id;
  matched.click();
  assertPanoramaAutofillWrite();

  const current = getPanoramaLotWidget();
  return (
    current?.id === widget.id && panoramaLotSelectionMatches(current, lotValue)
  );
}

function tryFillPanoramaLot(lotValue, { panelRescue = false } = {}) {
  if (!lotValue) return false;
  const widget = getPanoramaLotWidget();
  if (!widget) return false;
  if (panoramaLotSelectionMatches(widget, lotValue)) return true;
  if (fillPanoramaLotFromSelect(widget, lotValue)) return true;
  // Let the native options refresh before driving the visible panel.
  if (canFillPanoramaControl(widget.select) && !panelRescue) return false;
  openPanoramaLotDropdown(widget);
  const current = getPanoramaLotWidget();
  return (
    current?.id === widget.id &&
    fillPanoramaLotFromPanelItems(current, lotValue)
  );
}

function tryFillPanoramaLotOrTrade(data, options) {
  if (!data) return false;
  if (data.lot) return tryFillPanoramaLot(data.lot, options);
  return fillPanoramaTradeName(data);
}

function hasPanoramaLotSelection(lotValue) {
  return panoramaLotSelectionMatches(getPanoramaLotWidget(), lotValue);
}

function hasPanoramaLotOrTradeSelection(data) {
  if (!data) return false;
  if (data.lot) {
    return hasPanoramaLotSelection(data.lot);
  }
  return hasPanoramaTradeSelection(data);
}

let stopPanoramaLotTradeWatcher = null;

let panoramaAutofillOwner = null;
let panoramaWritingData = null;

function getPanoramaAutofillForm() {
  const forms = new Set(
    getFields([
      ...getPanoramaAgentSelectors(),
      'input[id*="dateAdministedDate:dateInput_input"]',
      'tbody[id*="historicalfactoryTable:dataTable_data"]'
    ])
      .map((node) => node.closest('form'))
      .filter(Boolean)
  );
  return forms.size === 1 ? [...forms][0] : null;
}

function isPanoramaChartActive() {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function invalidateAutomaticPanoramaContext() {
  clearGridCarry();
  // A return to this tab cannot revive a scan pinned before focus was lost.
  if (panoramaAutofillOwner?.automatic)
    cancelPanoramaAutofill({ focusOnly: true });
  else panoramaContextGeneration += 1;
}

function beginPanoramaAutofill(
  data = {},
  explicit = true,
  { automatic = !explicit, startBy = null } = {}
) {
  const form = getPanoramaAutofillForm();
  const url = location.href;
  const step = getPanoramaMultiStepIndicatorKey({ visibleOnly: true });
  const { kind } = getPanoramaFormContext({ checkReadiness: false });
  // Automatic retries keep a cancelled owner. A new form/context or a
  // deliberate scan/Fill action can start again after staff take over.
  if (
    explicit ||
    !panoramaAutofillOwner ||
    panoramaAutofillOwner.form !== form ||
    panoramaAutofillOwner.url !== url ||
    panoramaAutofillOwner.step !== step ||
    panoramaAutofillOwner.kind !== kind
  ) {
    cancelPanoramaAutofill();
    panoramaAutofillOwner = {
      document,
      form,
      url,
      step,
      kind,
      mode: activeWorkflowMode,
      automatic,
      startBy,
      autoResolveFunding: autofillSettings[AUTO_RESOLVE_FUNDING_KEY] !== false,
      fundingBucketsChecked: new Set(),
      cancelled: false
    };
  }
  data._vaxlinkOwner = panoramaAutofillOwner;
  return data;
}

function isPanoramaAutofillCurrent(data) {
  const owner = data?._vaxlinkOwner;
  if (!owner || owner !== panoramaAutofillOwner || owner.cancelled)
    return false;
  const current =
    !panoramaEntryBlockReason() &&
    owner.document === document &&
    owner.form?.isConnected &&
    owner.form === getPanoramaAutofillForm() &&
    owner.url === location.href &&
    owner.mode === activeWorkflowMode &&
    owner.step === getPanoramaMultiStepIndicatorKey({ visibleOnly: true }) &&
    owner.kind === getPanoramaFormContext({ checkReadiness: false }).kind &&
    (!owner.automatic || isPanoramaChartActive()) &&
    (!owner.trayDose || document.visibilityState === 'visible') &&
    (!owner.gridAssignment ||
      isGridAssignmentCurrent(owner.gridAssignment, owner.form)) &&
    (owner.writeAttempted ||
      owner.startBy === null ||
      Date.now() < owner.startBy);
  if (!current) cancelPanoramaAutofill();
  return !!current;
}

function updatePanoramaWorkflowMode(mode) {
  if (activeWorkflowMode === mode) return;
  clearGridCarry();
  cancelPanoramaAutofill();
  panoramaAutofillOwner = null;
  activeWorkflowMode = mode;
  if (hudInitialized) updateInventoryModeNotice();
}

function cancelPanoramaAutofill({ focusOnly = false } = {}) {
  panoramaContextGeneration += 1;
  if (!focusOnly) trayUseContextGeneration += 1;
  stopPanoramaFillOwner(panoramaAutofillOwner);
  if (stopPanoramaLotTradeWatcher) stopPanoramaLotTradeWatcher();
}

function stopPanoramaFillOwner(owner) {
  if (!owner) return;
  owner.cancelled = true;
  void stopTrayDose(owner);
  void reportPanoramaScannerVerification(owner, false);
}

function handlePanoramaAutofillUserInteraction(event) {
  if (!event.isTrusted) return;
  if (
    event.type === 'keydown' &&
    (event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      ['Tab', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(
        event.key
      ))
  )
    return;
  const target = event.target;
  const control = target?.closest?.(
    'input, select, textarea, button, a, label, [contenteditable], [role="button"], .ui-selectonemenu, .ui-selectonemenu-item, [role="option"], .ui-radiobutton, .ui-chkbox'
  );
  if (!control) return;
  const form = getPanoramaAutofillForm();
  if (!form) return;
  const overlay = target.closest(
    '.ui-selectonemenu-panel, .ui-datepicker, [role="listbox"], [role="dialog"]'
  );
  // PrimeFaces may append a dropdown to the document body. Match its exact
  // widget ID or an explicit ARIA link; another form's popup is unrelated.
  const linked =
    overlay?.id &&
    ((overlay.id.endsWith('_panel') &&
      form.contains(document.getElementById(overlay.id.slice(0, -6)))) ||
      [...form.querySelectorAll('[aria-controls], [aria-owns]')].some((node) =>
        `${node.getAttribute('aria-controls') || ''} ${node.getAttribute('aria-owns') || ''}`
          .split(/\s+/)
          .includes(overlay.id)
      ));
  if (form.contains(control) || linked) {
    if (
      gridDetailHandoff &&
      getPanoramaFormContext().kind === 'multiple_detail'
    ) {
      void releaseGridDetailStep();
    }
    beginPanoramaAutofill({}, false);
    cancelPanoramaAutofill();
  }
}

// Retain the same owner during one synchronous pass, even if a page event
// starts a newer fill. Focus/change/click handlers can replace the form before
// returning, so check again before the next field write or event.
function runPanoramaAutofill(data, callback) {
  if (!isPanoramaAutofillCurrent(data)) return false;
  const previous = panoramaWritingData;
  panoramaWritingData = data;
  try {
    return callback();
  } finally {
    panoramaWritingData = previous;
  }
}

function assertPanoramaAutofillWrite() {
  if (!panoramaWritingData) return;
  if (!isPanoramaAutofillCurrent(panoramaWritingData)) {
    throw new Error('Autofill stopped: form changed or manual takeover');
  }
  // Even focusing a control can run Panorama handlers.
  panoramaWritingData._vaxlinkOwner.writeAttempted = true;
}

function recordFundingComparison(data, outcome) {
  const owner = data._vaxlinkOwner;
  const funding = getPanoramaFundedRadioValue();
  if (
    !owner.autoResolveFunding ||
    owner.fundingComparisonRecorded ||
    data._fundedRadioChoice ||
    isExplicitPanoramaFundingValue(funding) ||
    (funding !== 'SHOW_ALL' && getPanoramaFundingRadios().length)
  )
    return;
  owner.fundingComparisonRecorded = true;
  chartActivity?.record(owner.activity, 'funding_comparison', { outcome });
  logAnalyticsEvent('funding_comparison', {
    workflow: data._vaxlinkQueueContext?.workflow || owner.mode,
    outcome
  });
}

function schedulePanoramaLotOrTradeSelection(
  data,
  initialDelayMs = 0,
  options = {}
) {
  if (!isPanoramaAutofillCurrent(data)) return;
  if (typeof stopPanoramaLotTradeWatcher === 'function') {
    stopPanoramaLotTradeWatcher();
    stopPanoramaLotTradeWatcher = null;
  }

  const hasLot = !!String(data?.lot || '').trim();
  const hasTrade = getPanoramaTradeCandidates(data).length > 0;
  const hasAgent = getPanoramaAgentCandidates(data).length > 0;
  const shouldTryLotOrTrade = hasLot || hasTrade;
  const shouldFillDeferredFields = hasPanoramaDeferredDetailData(data);
  const trace = data._vaxlinkOwner.activity;
  if (!shouldTryLotOrTrade && !shouldFillDeferredFields && !hasAgent) {
    return;
  }

  const scheduleStartedAt = performance.now();
  const firstCheckAt =
    scheduleStartedAt + Math.max(0, Number(initialDelayMs) || 0);
  const deadline = firstCheckAt + 10000;
  const minCheckGapMs = 110;
  const fallbackGapMs = 500;
  const stableGapMs = 700;
  let lastCheckAt = -Infinity;
  let nextFallbackAt = firstCheckAt;
  let stableSince = null;
  let domHint = false;
  let timer;
  let timerAt = Infinity;
  let observer;
  let stopped = false;
  let checkingRoute = false;
  let triedManualFilter = false;
  let lastFundingChangeAt = -Infinity;
  let usableMiss;

  const finalizeOnResolved = options.finalizeOnResolved === true;

  const stop = (reason = 'context', fields = {}) => {
    if (stopped) return;
    stopped = true;
    if (reason) chartActivity?.record(trace, 'stop', { reason, ...fields });
    observer?.disconnect();
    clearTimeout(timer);
    if (stopPanoramaLotTradeWatcher === stop) {
      stopPanoramaLotTradeWatcher = null;
    }
  };
  stopPanoramaLotTradeWatcher = stop;

  const stopUnverified = (reason, fields) => {
    stop(reason, fields);
    const owner = data._vaxlinkOwner;
    if (owner?.trayDose || owner?.scannerDelivery) stopPanoramaFillOwner(owner);
  };

  function finishLotMiss() {
    const owner = data._vaxlinkOwner;
    const choice = data._fundedRadioChoice;
    if (choice) {
      owner.fundingBucketsChecked.add(choice);
      chartActivity?.record(trace, 'lot_miss', { funding: choice });
    }
    if (
      choice &&
      owner.fundingBucketsChecked.size < PANORAMA_FUNDING_CHOICES.length
    ) {
      showVaxlinkToast({ ...data, _fundingChoiceRequired: 'other' });
      stop('funding');
    } else {
      const cleanup = clearPanoramaNonMatchingLot(data);
      chartActivity?.record(trace, 'lot_cleanup', { result: cleanup });
      if (isPanoramaAutofillCurrent(data)) {
        recordDeferredAutofillResult(data, false);
        showVaxlinkToast({
          ...data,
          _fillFeedback: choice ? 'funding_exhausted' : 'lot_not_matched',
          _lotNeedsReview: cleanup === 'review'
        });
      }
      stopUnverified(choice ? 'funding_exhausted' : 'lot_not_matched');
      return;
    }
  }

  const attempt = (now, wake) => {
    if (blockIneligibleChartUse(data)) {
      if (finalizeOnResolved) recordDeferredAutofillResult(data, false);
      // The expiry guard already recorded this stop on the same owner.
      stopUnverified(null);
      return;
    }
    if (isPrimeFacesAjaxBusy() || isPanoramaLotListAwaitingRefresh(data)) {
      usableMiss = undefined;
      stableSince = null;
      return;
    }
    const owner = data._vaxlinkOwner;
    let hasResolvedAgent = panoramaDetailAgentMatches(data);
    if (!hasResolvedAgent) {
      stableSince = null;
      usableMiss = undefined;
      const previousList = hasLot ? readPanoramaLotList() : null;
      const priorAgent = getPanoramaCurrentAgentSelectionText(owner.form);
      const started = tryFillPanoramaAgent(data);
      hasResolvedAgent = panoramaDetailAgentMatches(data);
      if (hasLot && started && hasResolvedAgent) {
        const currentAgent = getPanoramaCurrentAgentSelectionText(owner.form);
        if (currentAgent && currentAgent !== priorAgent)
          owner.filledAgent = currentAgent;
      }
      if (previousList && (started || hasResolvedAgent)) {
        owner.lotListBeforeRefresh = previousList;
        return;
      }
    }

    const choice = data._fundedRadioChoice;
    const currentFunding = hasLot ? getPanoramaFundedRadioValue() : '';
    if (hasLot && hasResolvedAgent && choice && !isPrimeFacesAjaxBusy()) {
      const conflicting =
        isExplicitPanoramaFundingValue(currentFunding) &&
        currentFunding !== choice;
      const chooseFromShowAll =
        !owner.autoResolveFunding &&
        currentFunding === 'SHOW_ALL' &&
        !triedManualFilter;
      if (conflicting || chooseFromShowAll) {
        usableMiss = undefined;
        stableSince = null;
        if (now - lastFundingChangeAt < 2500) return;
        triedManualFilter = true;
        const previousList = readPanoramaLotList();
        if (setPanoramaFundedRadioValue(choice) === 'clicked') {
          owner.lotListBeforeRefresh = previousList;
          lastFundingChangeAt = now;
          return;
        }
        if (conflicting) return;
      }
    }

    let resolved = !shouldTryLotOrTrade;
    if (!resolved && hasResolvedAgent) {
      const widget = hasLot ? getPanoramaLotWidget() : null;
      const funding = hasLot
        ? getPanoramaLotFundingChoices(widget, data.lot)
        : [];
      if (hasLot && chartActivity?.isCurrent(trace)) {
        const options = readPanoramaLotList();
        chartActivity.record(trace, 'options', {
          count: options?.rows.length ?? 0,
          target:
            options?.rows.some(({ text }) =>
              panoramaLotLabelMatches(
                text,
                data.lot,
                isExplicitPanoramaFundingValue(currentFunding)
                  ? currentFunding
                  : undefined
              )
            ) === true,
          funding:
            isExplicitPanoramaFundingValue(currentFunding) ||
            currentFunding === 'SHOW_ALL'
              ? currentFunding
              : '',
          control: options
            ? options.control === widget?.select
              ? 'select'
              : 'panel'
            : 'missing',
          site:
            location.hostname === PANORAMA_TRAINING_HOST
              ? 'training'
              : 'production'
        });
      }
      if (funding.length === 2 && !isPrimeFacesAjaxBusy()) {
        recordFundingComparison(data, 'both');
        showVaxlinkToast({ ...data, _fundingChoiceRequired: 'both' });
        stop('funding');
        return;
      }

      resolved = hasPanoramaLotOrTradeSelection(data);
      const panelRescue = now - scheduleStartedAt >= 2000;
      if (!resolved && !isPrimeFacesAjaxBusy()) {
        stableSince = null;
        tryFillPanoramaLotOrTrade(data, { panelRescue });
        resolved = hasPanoramaLotOrTradeSelection(data);
        if (hasLot && resolved) owner.consentReadyAt = now + 700;
      }
      if (resolved) {
        usableMiss = undefined;
        if (funding.length === 1) recordFundingComparison(data, 'single');
      } else if (hasLot && panelRescue && !isPrimeFacesAjaxBusy()) {
        const list = readPanoramaLotList();
        const labels = list?.rows
          .filter(
            ({ disabled, text }) =>
              !disabled && getPanoramaNonemptyLotLabel(text)
          )
          .map(({ text, value }) => [text, value]);
        const currentWidget = getPanoramaLotWidget();
        if (
          labels?.length &&
          (list.control !== currentWidget?.panel || isVisible(list.control))
        ) {
          const signature = JSON.stringify(labels);
          if (
            usableMiss?.control !== list.control ||
            usableMiss.signature !== signature
          ) {
            usableMiss = { control: list.control, signature, since: now };
          } else if (now - usableMiss.since >= 3000) {
            if (!getPanoramaLotFundingChoices(currentWidget, data.lot).length)
              recordFundingComparison(data, 'unmatched');
            finishLotMiss();
            return;
          }
        } else {
          usableMiss = undefined;
        }
      }
    }

    const before =
      shouldFillDeferredFields &&
      resolved &&
      hasResolvedAgent &&
      chartActivity?.isCurrent(trace)
        ? {}
        : null;
    let after = before;
    let deferredResolved =
      !shouldFillDeferredFields ||
      hasPanoramaDeferredDetailFieldsFilled(data, before);
    if (!deferredResolved) {
      stableSince = null;
      fillPanoramaDeferredDetailFields(data);
      if (before) after = {};
      deferredResolved = hasPanoramaDeferredDetailFieldsFilled(data, after);
    }

    if (chartActivity?.isCurrent(trace)) {
      const status = (requested, checked, matched) =>
        !requested
          ? 'not_requested'
          : !checked
            ? 'not_checked'
            : matched
              ? 'match'
              : 'mismatch';
      chartActivity.record(trace, 'check', {
        wake,
        agent: status(hasAgent, true, hasResolvedAgent),
        lot: status(hasLot, hasResolvedAgent, resolved),
        trade: status(!hasLot && hasTrade, hasResolvedAgent, resolved),
        deferred: status(
          shouldFillDeferredFields,
          hasResolvedAgent && resolved,
          deferredResolved
        ),
        ...(before ? { deferredCheck: { before, after } } : {})
      });
    }

    if (
      !resolved ||
      !deferredResolved ||
      isPrimeFacesAjaxBusy() ||
      !panoramaDetailAgentMatches(data) ||
      !panoramaDetailProductMatches(data)
    ) {
      stableSince = null;
      return;
    }
    // A successful repair starts a new stability wait on the current form.
    stableSince ??= now;
    if (now - stableSince >= stableGapMs) {
      if (finalizeOnResolved) void finalizeDeferredPanoramaAutofill(data);
      // Panorama's dependent refreshes (trade/dose/route after lot selection,
      // consent re-enabling) can still land after we stop and clear a value we
      // already set. These late passes re-assert only what changed — every fill
      // in them is a no-op while the fields still hold the desired values.
      setTimeout(() => runDeferredPass(), 1500);
      setTimeout(() => runDeferredPass(), 3500);
      // The finalizer records its verified outcome after any queue write.
      stop(finalizeOnResolved ? null : 'settled');
    }
  };

  const runDeferredPass = async () => {
    const owner = data._vaxlinkOwner;
    if (!isPanoramaAutofillCurrent(data)) return;
    if (
      owner.scannerDelivery &&
      (owner.detailOutcome !== 'verified' ||
        !(await checkPanoramaScannerRoute(owner.scannerDelivery, true)))
    )
      return;
    if (
      owner.scannerRoute &&
      !(await checkPanoramaScannerRoute({ scannerRoute: owner.scannerRoute }))
    )
      return;
    if (globalThis.VaxLinkExpiryDate.blocksChartUse(data)) return;
    try {
      runPanoramaAutofill(data, () => fillPanoramaDeferredDetailFields(data));
    } catch (error) {
      vlog(error.message);
    }
  };
  function armNextCheck() {
    if (stopped || checkingRoute) return;
    const earliest = Math.max(firstCheckAt, lastCheckAt + minCheckGapMs);
    const requested = domHint
      ? earliest
      : Math.min(
          nextFallbackAt,
          stableSince === null ? Infinity : stableSince + stableGapMs
        );
    const desiredAt = Math.min(deadline, Math.max(earliest, requested));
    if (desiredAt >= timerAt) return;
    clearTimeout(timer);
    timerAt = desiredAt;
    timer = setTimeout(check, Math.max(0, desiredAt - performance.now()));
  }

  async function check() {
    const scheduledAt = timerAt;
    timerAt = Infinity;
    if (stopped || !isPanoramaAutofillCurrent(data)) {
      stop();
      return;
    }
    const owner = data._vaxlinkOwner;
    const delivery =
      owner.scannerDelivery ||
      (owner.scannerRoute && { scannerRoute: owner.scannerRoute });
    if (delivery) {
      checkingRoute = true;
      const active = await checkPanoramaScannerRoute(delivery);
      checkingRoute = false;
      if (stopped) return;
      if (!active || !isPanoramaAutofillCurrent(data)) {
        stopUnverified();
        return;
      }
    }
    const now = performance.now();
    if (now >= deadline) {
      let lastDeferredFields;
      if (finalizeOnResolved) {
        const feedback = runPanoramaAutofill(data, () => {
          const productVerified =
            !isPrimeFacesAjaxBusy() &&
            panoramaDetailAgentMatches(data) &&
            panoramaDetailProductMatches(data);
          return productVerified
            ? {
                _fillFeedback: 'deadline_details',
                _reviewFields:
                  getPanoramaDeferredDetailFieldsNeedingReview(data)
              }
            : { _fillFeedback: 'deadline' };
        });
        if (feedback && isPanoramaAutofillCurrent(data)) {
          lastDeferredFields = feedback._reviewFields;
          recordDeferredAutofillResult(data, false);
          showVaxlinkToast({ ...data, ...feedback });
        }
      }
      stopUnverified(
        'deadline',
        lastDeferredFields?.length ? { lastDeferredFields } : {}
      );
      return;
    }
    if (now < scheduledAt) {
      armNextCheck();
      return;
    }
    const wake =
      lastCheckAt === -Infinity
        ? 'initial'
        : domHint
          ? 'dom'
          : now >= nextFallbackAt
            ? 'fallback'
            : 'stability';
    domHint = false;
    lastCheckAt = now;
    if (now >= nextFallbackAt) {
      // Keep checking on quiet pages even when DOM hints are frequent.
      nextFallbackAt =
        firstCheckAt +
        (Math.floor((now - firstCheckAt) / fallbackGapMs) + 1) * fallbackGapMs;
    }
    try {
      runPanoramaAutofill(data, () => attempt(now, wake));
    } catch (error) {
      if (finalizeOnResolved && isPanoramaAutofillCurrent(data))
        recordDeferredAutofillResult(data, false);
      stopUnverified('error');
      vlog(error.message);
    }
    if (!stopped) armNextCheck();
  }

  if (typeof MutationObserver === 'function' && document.body) {
    observer = new MutationObserver(() => {
      domHint = true;
      armNextCheck();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'class',
        'style',
        'aria-expanded',
        'disabled',
        'label',
        'value',
        'selected'
      ]
    });
  }
  armNextCheck();
}

function isPanoramaRecordImmsPage() {
  try {
    if (window.location.protocol !== 'https:') return false;
    const host = String(window.location.hostname || '').toLowerCase();
    const isPanorama =
      host === 'www.panorama.prod.ehealthontario.ca' ||
      host === 'panorama.prod.ehealthontario.ca' ||
      host === 'trpanoramadhir.prod.ehealthontario.ca';
    if (!isPanorama) return false;
    return /^\/(?:phsdsm\/)?ImmsWeb\/pages\/recordImms\//.test(
      window.location.pathname
    );
  } catch {
    return false;
  }
}

function getPanoramaAddImmunizationTypes(section, shown) {
  if (!/immunization\s+type\s*:/i.test(section.textContent)) return null;
  const types = new Set();
  let hasAddHeading = false;
  for (const node of section.querySelectorAll(
    'h1, h2, h3, legend, [role="heading"], div, span, p, label, strong, b, dl, tr, td, th'
  )) {
    const text = node.textContent.trim();
    if (
      text.length > 100 ||
      !/^(add\s+immunization|immunization\s+type\s*:)/i.test(text) ||
      !shown(node)
    )
      continue;

    // Panorama can place the type label and value in separate elements.
    // Use the rendered text so hidden fields cannot identify a form.
    const visibleText = normalizeLabelText(
      (node.innerText || '').replace(/[-–—]/g, ' ')
    );
    if (visibleText === 'add immunization') hasAddHeading = true;
    if (visibleText === 'immunization type provider recorded')
      types.add('provider_single');
    if (visibleText === 'immunization type non provider recorded')
      types.add('non_provider_single');
  }
  return hasAddHeading ? types : null;
}

function getPanoramaFormContext({ checkReadiness = true } = {}) {
  const blocked = (kind, blockedBy) => ({ kind, ready: false, blockedBy });
  const form = getPanoramaAutofillForm();
  if (!form?.isConnected)
    return blocked('unknown', 'form_missing_or_ambiguous');

  const shown = (node) =>
    isVisible(node) && getComputedStyle(node).visibility === 'visible';
  const agent = getPanoramaDetailAgentFields(form).find((field) =>
    shown(field.closest('.ui-selectonemenu') || field)
  );
  const date = getPanoramaAdministeredDateTimeFields(
    { _vaxlinkOwner: { form } },
    { includeDisabled: true }
  ).dateField;
  const detailVisible = !!agent && shown(date);
  const gridVisible = isPanoramaMultipleImmunizationGridPage({
    visibleOnly: true
  });
  if (gridVisible) {
    if (detailVisible) return blocked('unknown', 'conflicting_controls');
    if (!checkReadiness) return { kind: 'multiple_grid', ready: false };
    if (isPrimeFacesAjaxBusy())
      return blocked('multiple_grid', 'panorama_busy');
    if (!getPanoramaMultipleGridRows().some(shown))
      return blocked('multiple_grid', 'no_grid_rows');
    if (!canFillPanoramaControl(getPanoramaMultipleGridAgentField(0)))
      return blocked('multiple_grid', 'agent_control_unavailable');
    if (!canFillPanoramaControl(getPanoramaMultipleGridDate1Field(0)))
      return blocked('multiple_grid', 'date_control_unavailable');
    return { kind: 'multiple_grid', ready: true };
  }

  const section = form.closest('.ui-dialog') || form;
  const titles = [
    ...section.querySelectorAll('h1, h2, h3, legend, .ui-dialog-title')
  ]
    .filter(shown)
    .map((title) =>
      normalizeLabelText(title.textContent.replace(/[-–—]/g, ' '))
    );
  const hasProviderTitle = titles.includes('add provider recorded');
  const hasNonProviderTitle = titles.includes('add non provider recorded');
  const step = getPanoramaMultiStepIndicatorKey({ visibleOnly: true });
  if (step && (hasProviderTitle || hasNonProviderTitle))
    return blocked('unknown', 'conflicting_titles');
  const addTypes = step
    ? null
    : getPanoramaAddImmunizationTypes(section, shown);
  const provider = hasProviderTitle || addTypes?.has('provider_single');
  const nonProvider =
    hasNonProviderTitle || addTypes?.has('non_provider_single');
  // The type line can also appear on a multiple detail step. A step hidden
  // inside this form is still a reason to avoid treating it as a single form.
  if (
    (provider && nonProvider) ||
    (addTypes?.size &&
      getPanoramaMultiStepIndicatorKey({ scope: section, exact: true }))
  )
    return blocked('unknown', 'conflicting_titles');
  const kind = step
    ? 'multiple_detail'
    : provider
      ? 'provider_single'
      : nonProvider
        ? 'non_provider_single'
        : null;
  if (!kind) return blocked('unknown', 'unrecognized_title');
  if (!checkReadiness) return { kind, ready: false };
  if (!agent || !canFillPanoramaControl(agent))
    return blocked(kind, 'agent_control_unavailable');
  if (!shown(date) || !canFillPanoramaControl(date))
    return blocked(kind, 'date_control_unavailable');
  if (isPrimeFacesAjaxBusy()) return blocked(kind, 'panorama_busy');
  if (step) return { kind, ready: true };

  if (
    getPanoramaCurrentAgentSelectionText(form) ||
    getPanoramaCurrentLotSelectionText(form) ||
    getPanoramaCurrentTradeSelectionText(form)
  )
    return blocked(kind, 'already_has_vaccine');
  return { kind, ready: true };
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
  if (markerSelectors.some((selector) => document.querySelector(selector))) {
    return true;
  }

  const hasTitle = Array.from(
    document.querySelectorAll('h1, h2, h3, legend, div, span, td, th, strong')
  ).some((el) => normalizeLabelText(el.textContent || '') === 'immunizations');
  if (!hasTitle) return false;

  const hasDateAdminLabel = Array.from(
    document.querySelectorAll('label, span, div, td, th, strong')
  ).some(
    (el) => normalizeLabelText(el.textContent || '') === 'date administered'
  );
  return hasDateAdminLabel;
}

function fillPanoramaImmunizationFields(data) {
  const blocked = blockIneligibleChartUse(data);
  if (blocked) return blocked;
  const owner = data._vaxlinkOwner;
  owner.activity ??= chartActivity?.begin(
    owner.kind === 'multiple_detail' ? 'multiple' : 'single',
    'detail'
  );
  if (data.lot) {
    if (!Object.hasOwn(owner, 'initialLot')) {
      const widget = getPanoramaLotWidget();
      owner.initialLot = widget ? getPanoramaDisplayedLot(widget) : null;
      owner.initialAgent = getPanoramaCurrentAgentSelectionText(owner.form);
    }
    const selectedFunding = getPanoramaFundedRadioValue();
    if (
      !data._fundedRadioChoice &&
      isExplicitPanoramaFundingValue(selectedFunding)
    )
      data._fundedRadioChoice = selectedFunding;
    if (!owner.autoResolveFunding && !data._fundedRadioChoice) {
      showVaxlinkToast({ ...data, _fundingChoiceRequired: 'manual' });
      return createAutofillResult('pending', {
        reason: 'funding_choice_required'
      });
    }
    markPanoramaAutofillStarted(data);
    schedulePanoramaLotOrTradeSelection(data, 0, { finalizeOnResolved: true });
    return createAutofillResult('pending', {
      reason: 'waiting_for_required_selection'
    });
  }

  markPanoramaAutofillStarted(data);

  const agentRequested = getPanoramaAgentCandidates(data).length > 0;
  let agentMatches = hasPanoramaAgentSelection(data);
  if (agentRequested && !agentMatches && !isPrimeFacesAjaxBusy()) {
    tryFillPanoramaAgent(data);
    agentMatches = hasPanoramaAgentSelection(data);
  }

  const tradeRequested = getPanoramaTradeCandidates(data).length > 0;
  let fillCount = agentMatches ? 1 : 0;
  if ((!agentRequested || agentMatches) && tradeRequested) {
    if (!panoramaDetailProductMatches(data) && !isPrimeFacesAjaxBusy())
      tryFillPanoramaLotOrTrade(data);
    if (panoramaDetailProductMatches(data)) fillCount += 1;
  }
  fillCount += fillPanoramaDeferredDetailFields(data);
  if (!isPanoramaAutofillCurrent(data))
    return createAutofillResult('failed', {
      error: 'Autofill stopped: form changed or manual takeover'
    });

  const waitingForSelection =
    !panoramaDetailAgentMatches(data) || !panoramaDetailProductMatches(data);
  const pending = waitingForSelection || !!data._vaxlinkQueueContext?.dose;
  if (agentRequested || tradeRequested || hasPanoramaDeferredDetailData(data)) {
    schedulePanoramaLotOrTradeSelection(data, agentMatches ? 200 : 100, {
      finalizeOnResolved: pending
    });
  }

  return pending
    ? createAutofillResult('pending', {
        reason: 'waiting_for_required_selection',
        fillCount
      })
    : createAutofillResult(fillCount > 0 ? 'success' : 'failed', { fillCount });
}

const PANORAMA_AGENT_RULES = Array.isArray(
  globalThis.VAXLINK_PANORAMA_AGENT_RULES
)
  ? globalThis.VAXLINK_PANORAMA_AGENT_RULES
  : [];

function buildPanoramaAgentSourceText(data) {
  return normalizeForMatch(
    [
      data?.name,
      data?.generic_name,
      data?.tradename,
      data?.disease,
      data?.antigen,
      data?.manufacturer,
      data?.route,
      data?.strength
    ]
      .filter(Boolean)
      .join(' ')
  );
}

function getNormalizedSourceTokens(sourceText) {
  return String(sourceText || '')
    .split(' ')
    .map((token) => token.trim())
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

  return termTokens.every((token) =>
    token.length <= 3
      ? sourceTokens.includes(token)
      : sourceTokens.includes(token) || sourceText.includes(token)
  );
}

function panoramaSourceHasAll(sourceText, sourceTokens, terms) {
  return terms.every((term) =>
    panoramaSourceHasNormalizedTerm(sourceText, sourceTokens, term)
  );
}

function panoramaSourceHasAny(sourceText, sourceTokens, terms) {
  return terms.some((term) =>
    panoramaSourceHasNormalizedTerm(sourceText, sourceTokens, term)
  );
}

function panoramaAgentRuleClauseMatches(sourceText, clause) {
  const sourceTokens = getNormalizedSourceTokens(sourceText);
  if (clause.any && !panoramaSourceHasAny(sourceText, sourceTokens, clause.any))
    return false;
  if (clause.all && !panoramaSourceHasAll(sourceText, sourceTokens, clause.all))
    return false;
  if (
    clause.notAny &&
    panoramaSourceHasAny(sourceText, sourceTokens, clause.notAny)
  )
    return false;
  if (
    clause.notAll &&
    panoramaSourceHasAll(sourceText, sourceTokens, clause.notAll)
  )
    return false;
  return true;
}

function panoramaAgentRuleMatches(sourceText, rule) {
  return (rule.clauses || []).some((clause) =>
    panoramaAgentRuleClauseMatches(sourceText, clause)
  );
}

function getMappedPanoramaAgents(data) {
  const sourceText = buildPanoramaAgentSourceText(data);
  return PANORAMA_AGENT_RULES.filter((rule) =>
    panoramaAgentRuleMatches(sourceText, rule)
  ).flatMap((rule) => rule.outputs || []);
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

  for (const output of getMappedPanoramaAgents(data)) add(output);
  add(data?.din);
  return values;
}

function buildAutofillPayloadFromQueueRecord(record) {
  if (!record) return null;
  const payload = {
    scanned_at: record.scanned_at || '',
    gtin: record.gtin || '',
    lot: record.lot || '',
    serial: record.serial || '',
    expiry:
      record.expiry || record.barcode_expiry || record.inventory_expiry || '',
    inventory_expiry: record.inventory_expiry || record.barcode_expiry || '',
    nvc_lot_expiry: record.nvc_lot_expiry || '',
    expiry_flag: record.expiry_flag || '',
    expiry_days_remaining: record.expiry_days_remaining ?? '',
    expiry_source:
      record.expiry_source || (record.barcode_expiry ? 'barcode' : 'none'),
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
    lookup_error_category: record.lookup_error_category || '',
    nvc_catalogue_version: record.nvc_catalogue_version || '',
    nvc_lot_matched: record.nvc_lot_matched === true,
    reference_only: record.reference_only === true,
    barcode_expiry: record.barcode_expiry || '',
    name:
      record.name || record.generic_name || record.tradename || record.din || ''
  };
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

function mutateQueueViaBackground(storageKey, operation, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'mutateQueue', storageKey, operation, payload },
      (response) => {
        if (chrome.runtime.lastError || !response?.success) {
          reject(
            new Error(
              chrome.runtime.lastError?.message ||
                response?.error ||
                'Tray update failed'
            )
          );
        } else {
          resolve(response);
        }
      }
    );
  });
}

async function useTrayVaccine(recordId, contextToken, scannerRoute = null) {
  if (
    typeof recordId !== 'string' ||
    !recordId.trim() ||
    activeWorkflowMode === 'inventory'
  )
    throw new Error('Choose an available dose in the chart tray.');
  const context = getPanoramaFormContext();
  const current = () =>
    isScannerDeliveryContextCurrent(contextToken, context.kind, !scannerRoute);
  if (!current() || !context.ready || document.visibilityState !== 'visible')
    throw new Error('Open a supported Panorama form that is ready for entry.');
  if (
    scannerRoute &&
    (context.kind !== 'multiple_grid' ||
      autofillSettings[GRID_SCAN_AUTOFILL_KEY] === false ||
      !isPanoramaChartActive() ||
      Date.now() >= scannerRoute.startBy ||
      !(await checkPanoramaScannerRoute({ scannerRoute })) ||
      !current() ||
      !isPanoramaChartActive())
  )
    throw new Error('The grid changed. The vaccine remains in the tray.');

  if (!scannerRoute && context.kind === 'multiple_detail') {
    await releaseGridDetailStep();
    if (!current() || document.visibilityState !== 'visible')
      throw new Error(
        'Panorama changed. Check the chart and choose the vaccine again.'
      );
  }

  const data = beginPanoramaAutofill({}, true, {
    automatic: !!scannerRoute,
    startBy: scannerRoute?.startBy ?? null
  });
  data._vaxlinkOwner.scannerRoute = scannerRoute;
  return fillReservedTrayRecord(
    recordId,
    data,
    scannerRoute ? 'web-serial' : 'queue',
    context.kind
  );
}

async function fillReservedTrayRecord(
  recordId,
  ownerData,
  source,
  requiredKind,
  carriedDose = null
) {
  if (!isPanoramaAutofillCurrent(ownerData)) {
    throw new Error(
      'Panorama changed. Check the chart and choose the vaccine again.'
    );
  }
  const owner = ownerData._vaxlinkOwner;
  if (owner.trayDose)
    return createAutofillResult('failed', {
      error: 'This chart already has a tray fill.'
    });
  const dose = carriedDose || { recordId, token: crypto.randomUUID() };
  dose.owner = owner;
  owner.trayDose = dose;
  activeTrayReservations.add(dose.token);
  let keepReservation = false;
  let verifiedGridAssignment = false;
  try {
    const { record, reserved } = await mutateQueueViaBackground(
      MULTIPLE_INJECT_QUEUE_KEY,
      'reserve_dose',
      { id: recordId, token: dose.token }
    );
    dose.reserved = reserved;
    if (!reserved) activeTrayReservations.delete(dose.token);
    if (!isPanoramaAutofillCurrent(ownerData)) {
      throw new Error(
        'Panorama changed. Check the chart and choose the vaccine again.'
      );
    }
    if (
      owner.scannerRoute &&
      (!(await checkPanoramaScannerRoute({
        scannerRoute: owner.scannerRoute
      })) ||
        !isPanoramaAutofillCurrent(ownerData) ||
        autofillSettings[
          owner.gridDetail ? GRID_DETAIL_AUTOFILL_KEY : GRID_SCAN_AUTOFILL_KEY
        ] === false)
    )
      throw new Error('The grid changed. The vaccine remains in the tray.');
    if (requiredKind) {
      const current = getPanoramaFormContext();
      if (!current.ready || current.kind !== requiredKind)
        throw new Error(
          'Panorama changed. Check the chart and choose the vaccine again.'
        );
    }

    if (owner.gridDetail) {
      if (!matchesGridDetail(owner.gridDetail))
        throw new Error('The matching Enter Details step is no longer open.');
      if (hasDifferentGridDetailLot(owner.gridDetail))
        throw new Error(DIFFERENT_GRID_DETAIL_LOT);
    }
    if (
      requiredKind === 'multiple_detail' &&
      !queueRecordMatchesPanoramaAgentText(
        record,
        getPanoramaCurrentAgentSelectionText()
      )
    ) {
      throw new Error(
        'Choose a vaccine that matches the Agent on this Panorama step.'
      );
    }
    const data = buildAutofillPayloadFromQueueRecord(record);
    if (
      !data ||
      (!String(data.lot || '').trim() &&
        !getPanoramaTradeCandidates(data).length)
    )
      throw new Error(
        'The saved vaccine has no Lot or Trade that Panorama can verify.'
      );
    const blocked = blockIneligibleChartUse(data);
    if (blocked) return blocked;
    dose.record = record;
    data._vaxlinkOwner = owner;
    data._vaxlinkQueueContext = {
      storageKey: MULTIPLE_INJECT_QUEUE_KEY,
      recordId,
      workflow: 'multiple',
      queue: 'multiple',
      source,
      dose
    };
    if (requiredKind === 'multiple_grid') {
      const assignment = runPanoramaAutofill(data, () =>
        assignTrayVaccineToGrid(data)
      );
      verifiedGridAssignment = !!assignment;
      keepReservation =
        assignment && rememberGridAssignment(assignment, dose, record, source);
      return assignment
        ? createAutofillResult('grid_added', {
            carryToDetails: !!keepReservation
          })
        : createAutofillResult('failed', {
            error: 'Check the current grid row and choose the vaccine again.'
          });
    }
    logAnalyticsEvent('autofill_attempt', {
      workflow: 'multiple',
      source,
      vaccineLabel: globalThis.vaxlinkVaccineLabel(record),
      manufacturer: record.manufacturer || '',
      expiryFlag: record.expiry_flag || ''
    });
    const result = autoFillPanorama(data);
    keepReservation = isAutofillPending(result);
    if (!keepReservation) recordDeferredAutofillResult(data, false);
    return result;
  } finally {
    if (!keepReservation) {
      if (dose.reserved) await stopTrayDose(owner, verifiedGridAssignment);
      else activeTrayReservations.delete(dose.token);
    }
  }
}

async function stopTrayDose(
  owner,
  verifiedGridAssignment = false,
  dose = owner?.trayDose
) {
  if (
    !dose?.reserved ||
    owner.detailOutcome === 'verifying' ||
    dose.stopping ||
    !activeTrayReservations.has(dose.token)
  )
    return;
  owner.cancelled = true;
  dose.stopping = true;
  const written = owner.writeAttempted === true && !verifiedGridAssignment;
  try {
    await mutateQueueViaBackground(MULTIPLE_INJECT_QUEUE_KEY, 'stop_dose', {
      id: dose.recordId,
      token: dose.token,
      written
    });
    if (!written) return;
  } catch (error) {
    console.warn('VaxLink could not confirm the tray stop:', error);
  } finally {
    activeTrayReservations.delete(dose.token);
  }
  if (!toastWarningSlot?.innerHTML) {
    showVaxlinkToast({
      _entryWarning:
        'Check the original chart before using the held tray dose again.'
    });
  }
}

async function consumeQueueRecordAfterDeferredAutofill(queueContext) {
  const storageKey = String(queueContext?.storageKey || '').trim();
  const recordId = String(queueContext?.recordId || '').trim();
  if (!storageKey || !recordId) {
    return null;
  }

  const dose = queueContext.dose;
  let record;
  let nextRows;
  if (dose && !dose.reserved) {
    // A pin or older unknown count remains unchanged even if another popup
    // gives that row a count while this fill is in progress.
    record = dose.record;
    nextRows = (await getLocalStorage([storageKey]))[storageKey] || [];
  } else {
    const result = await mutateQueueViaBackground(storageKey, 'consume', {
      id: recordId,
      ...(dose && { token: dose.token })
    });
    record = result.consumed;
    nextRows = result.rows;
    if (dose && record) activeTrayReservations.delete(dose.token);
  }
  if (!record) return null;

  const workflow = queueContext.workflow || 'multiple';
  const source = queueContext.source || 'queue';
  const expiryFlag =
    record.expiry_flag ||
    getExpiryStatus(record.inventory_expiry || record.barcode_expiry).flag;
  logAnalyticsEvent('queue_used', {
    workflow,
    queue: queueContext.queue || workflow,
    source,
    count: 1,
    queueSizeAfter: nextRows.length,
    vaccineLabel: globalThis.vaxlinkVaccineLabel(record),
    manufacturer: record.manufacturer || '',
    expiryFlag
  });
  return { record, queueSizeAfter: nextRows.length };
}

function logDeferredAutofillResult(data, success, record) {
  const context = data._vaxlinkQueueContext;
  logAnalyticsEvent('autofill_result', {
    workflow: context?.workflow || data._vaxlinkOwner.mode,
    source: context
      ? context.source || 'queue'
      : data._vaxlinkResultSource || 'popup_button',
    success,
    ...(record && {
      deferred: true,
      vaccineLabel: globalThis.vaxlinkVaccineLabel(record),
      manufacturer: record.manufacturer || '',
      expiryFlag:
        record.expiry_flag ||
        getExpiryStatus(record.inventory_expiry || record.barcode_expiry).flag
    })
  });
}

function recordDeferredAutofillResult(data, success) {
  const owner = data._vaxlinkOwner;
  if (owner.detailOutcome) return;
  owner.detailOutcome = success ? 'verified' : 'failed';
  logDeferredAutofillResult(data, success);
}

async function finalizeDeferredPanoramaAutofill(data) {
  const owner = data._vaxlinkOwner;
  if (!isPanoramaAutofillCurrent(data) || owner.detailOutcome) return;
  // Funding retries can copy the payload, so claim this outcome on the owner.
  owner.detailOutcome = 'verifying';

  const queueContext = data._vaxlinkQueueContext;
  let verified = false;
  let consumed;
  if (owner.scannerDelivery) {
    verified = await reportPanoramaScannerVerification(owner, true, data);
  } else {
    try {
      consumed = await consumeQueueRecordAfterDeferredAutofill(queueContext);
      verified = !queueContext || !!consumed;
    } catch (error) {
      console.warn('VaxLink deferred queue finalize failed:', error);
    }
  }
  owner.detailOutcome = verified ? 'verified' : 'failed';
  chartActivity?.record(owner.activity, 'stop', {
    reason: verified ? 'settled' : 'error'
  });
  logDeferredAutofillResult(data, verified, consumed?.record);
  if (owner.detailOutcome === 'failed') {
    await stopTrayDose(owner);
  } else if (isPanoramaAutofillCurrent(data)) {
    showVaxlinkToast(data);
  }
}

function autoFillPanorama(data) {
  try {
    if (isHandsFreeSupportedPage() && isPanoramaImmunizationPage()) {
      if (!isPanoramaAutofillCurrent(data))
        return createAutofillResult('failed', {
          error: 'Autofill stopped: form changed or manual takeover'
        });
      const panoramaResult = runPanoramaAutofill(data, () =>
        fillPanoramaImmunizationFields(data)
      );
      vlog('Panorama autofill result', panoramaResult?.status, panoramaResult);
      return panoramaResult;
    }

    return createAutofillResult('failed', {
      error: 'Open a Panorama immunization form'
    });
  } catch (e) {
    console.error('Auto-fill error:', e);
    return createAutofillResult('failed', {
      error: e.message || 'Auto-fill failed'
    });
  }
}

// ---------------------------------------------------------------------------
// Scanner-triggered mode switch (VAXLINK: command barcodes)
// ---------------------------------------------------------------------------

function handleVaxlinkCommand(value) {
  const upper = String(value).trim().toUpperCase();
  if (!upper.startsWith('VAXLINK:')) return false;
  const command = upper.slice('VAXLINK:'.length).trim();
  const modeMap = {
    SINGLE: 'immunization',
    MULTIPLE: 'immunization',
    IMMUNIZATION: 'immunization',
    INVENTORY: 'inventory'
  };
  const newMode = modeMap[command];
  if (!newMode) {
    vlog('unknown VAXLINK command', command);
    return true;
  }
  updatePanoramaWorkflowMode(newMode);
  chrome.storage.local.set({ [WORKFLOW_MODE_KEY]: newMode });
  logAnalyticsEvent('workflow_mode_set', {
    workflow: newMode,
    source: 'scanner_command'
  });
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
let toastInventorySlot = null;
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
    .vl-toast-report { display: inline-block; margin-top: 6px; color: #fff; }
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
  toastInventorySlot = document.createElement('div');
  toastRoot.appendChild(toastInventorySlot);
  toastRoot.appendChild(toastWarningSlot);
  toastRoot.appendChild(toastRoutineSlot);
  shadow.appendChild(toastRoot);
  document.body.appendChild(toastHost);
  return toastRoot;
}

function updateInventoryModeNotice() {
  if (activeWorkflowMode !== 'inventory') {
    toastInventorySlot?.replaceChildren();
    return;
  }
  if (!document.body || !isHandsFreeSupportedPage()) return;
  ensureToastHost();
  toastInventorySlot.innerHTML = `<div class="vl-toast info show" role="status">
    <div class="vl-toast-title">Inventory mode</div>
    <div class="vl-toast-detail">Scans go to Inventory. Select Immunization in VaxLink to fill a chart.</div>
  </div>`;
}

function showVaxlinkToast(data, durationMs = 4000) {
  if (!isHandsFreeSupportedPage()) return;
  ensureToastHost();

  if (data._entryWarning) {
    toastWarningSlot.innerHTML = `<div class="vl-toast expired persistent show" role="alert">
      <div class="vl-toast-detail">${escapeToastHtml(data._entryWarning)}</div>
      <button class="vl-toast-dismiss" type="button">Dismiss</button>
    </div>`;
    toastWarningSlot
      .querySelector('button')
      .addEventListener('click', () => dismissToast(toastWarningSlot));
    return;
  }

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

  if (data._barcodeFeedback) {
    const title =
      data._barcodeFeedback === 'missing_lot'
        ? 'This barcode has no lot number'
        : 'This barcode could not be read';
    showRoutineToast(
      `<div class="vl-toast info show">
        <div class="vl-toast-title">${title}</div>
        <div class="vl-toast-detail">Scan the 2D barcode with the lot number on the package, vial, or prefilled syringe.</div>
      </div>`,
      durationMs
    );
    return;
  }

  if (data._gridAdded) {
    showRoutineToast(
      '<div class="vl-toast info show"><div class="vl-toast-title">Added to the grid</div><div class="vl-toast-detail">The vaccine stays in the tray for Enter Details.</div></div>',
      durationMs
    );
    return;
  }
  if (data._commandMode) {
    const modeLabels = {
      immunization: 'Immunization',
      inventory: 'Inventory'
    };
    const sourceDetail =
      data._commandSource === 'hud'
        ? 'Switched from VaxLink HUD'
        : 'Switched via scanner command';
    showRoutineToast(
      `<div class="vl-toast info show">
      <div class="vl-toast-title">Mode: ${modeLabels[data._commandMode] || data._commandMode}</div>
      <div class="vl-toast-detail">${sourceDetail}</div>
    </div>`,
      durationMs
    );
    return;
  }

  const panoramaMiss =
    data._fillFeedback === 'lot_not_matched' ||
    data._fillFeedback === 'funding_exhausted';
  const trainingMiss =
    panoramaMiss && location.hostname === PANORAMA_TRAINING_HOST;
  const catalogueMatched =
    panoramaMiss && globalThis.VaxLinkNvcLotReport.hasCatalogueMatch(data);
  const reportUrl = globalThis.VaxLinkNvcLotReport.makeDraft(data, {
    panorama: catalogueMatched,
    training: trainingMiss,
    bothFundingCategories: data._fillFeedback === 'funding_exhausted'
  });
  const reportMarkup = reportUrl
    ? `<a class="vl-toast-action vl-toast-report" href="${escapeToastHtml(reportUrl)}">${catalogueMatched ? 'Email Panorama lot report' : 'Email lot report'}</a>`
    : '';

  if (data._fillFeedback) {
    const catalogueMiss = data.lookup_error_category === 'not_found';
    let title = 'Autofill needs review';
    let detail = 'Check the Agent and Lot in Panorama.';
    if (panoramaMiss) {
      title = trainingMiss
        ? 'Lot not found in Panorama training'
        : 'Lot not found in Panorama';
      detail = trainingMiss
        ? 'The training lot list may be incomplete or out of date.'
        : 'Verify the lot and funding in Panorama. If the lot is still missing, contact your Panorama Resolution Coordinator (PRC).';
      if (data._fillFeedback === 'funding_exhausted' && !trainingMiss)
        title = 'Lot not found in either funding category';
    } else if (data._fillFeedback === 'deadline_details') {
      detail = data._reviewFields?.length
        ? `Check the ${new Intl.ListFormat('en').format(data._reviewFields.map((field) => PANORAMA_DETAIL_FIELD_LABELS[field]))} in Panorama.`
        : 'Review the autofilled fields in Panorama.';
    }
    const catalogueStatus = catalogueMiss
      ? 'The lot was missing from the National Vaccine Catalogue.'
      : catalogueMatched
        ? 'Found in the National Vaccine Catalogue.'
        : data.lookup_error || '';
    showRoutineToast(
      `<div class="vl-toast info show" role="status">
        <div class="vl-toast-title">${escapeToastHtml(title)}</div>
        <div class="vl-toast-detail">${escapeToastHtml(detail)}</div>
        ${data._lotNeedsReview ? '<div class="vl-toast-detail">The Lot field still needs review. Clear any entry that does not match the scanned lot.</div>' : ''}
        ${catalogueStatus ? `<div class="vl-toast-detail">${escapeToastHtml(catalogueStatus)}</div>` : ''}
        ${reportMarkup}
      </div>`,
      reportUrl ? 12000 : 9000
    );
    return;
  }

  if (data._fundingChoiceRequired) {
    const owner = data._vaxlinkOwner;
    const workflow = data._vaxlinkQueueContext?.workflow || owner.mode;
    const reason = data._fundingChoiceRequired;
    const options = PANORAMA_FUNDING_CHOICES.filter(
      (choice) => !owner.fundingBucketsChecked.has(choice)
    );
    const title =
      reason === 'other'
        ? 'Try the other funding category'
        : 'Choose vaccine funding';
    const detail =
      reason === 'both'
        ? 'Panorama lists this lot under both funding categories. Choose one to continue.'
        : reason === 'other'
          ? `VaxLink could not verify this lot as ${getPanoramaFundingLabel(data._fundedRadioChoice)}.`
          : 'Choose the funding category to check in Panorama.';
    const buttons = options
      .map(
        (choice) =>
          `<button class="vl-toast-action" type="button" data-vl-funded-choice="${choice}">${getPanoramaFundingLabel(choice)}</button>`
      )
      .join('');
    showRoutineToast(
      `<div class="vl-toast info persistent show">
        <div class="vl-toast-title">${title}</div>
        <div class="vl-toast-detail">${escapeToastHtml(detail)}</div>
        <div class="vl-toast-actions">${buttons}
          <button class="vl-toast-action secondary" type="button" data-vl-funded-choice-dismiss>Not now</button>
        </div>
      </div>`,
      durationMs,
      { persistent: true }
    );
    chartActivity?.record(owner.activity, 'funding_prompt', { reason });
    logAnalyticsEvent('funding_prompt_shown', { workflow });
    let answered = false;
    toastRoutineSlot
      .querySelectorAll('[data-vl-funded-choice]')
      .forEach((button) => {
        button.addEventListener('click', () => {
          const funding = button.getAttribute('data-vl-funded-choice');
          if (
            answered ||
            !options.includes(funding) ||
            !isPanoramaAutofillCurrent(data)
          )
            return;
          answered = true;
          toastRoutineSlot.innerHTML = '';
          if (blockIneligibleChartUse(data)) {
            recordDeferredAutofillResult(data, false);
            stopPanoramaFillOwner(data._vaxlinkOwner);
            return;
          }
          chartActivity?.record(owner.activity, 'funding_choice', { funding });
          logAnalyticsEvent('funding_choice_made', { workflow });
          const { _fundingChoiceRequired, ...rest } = data;
          const next = { ...rest, _fundedRadioChoice: funding };
          const result = autoFillPanorama(next);
          if (!isAutofillPending(result) && isPanoramaAutofillCurrent(next)) {
            recordDeferredAutofillResult(next, false);
            stopPanoramaFillOwner(next._vaxlinkOwner);
          }
        });
      });
    toastRoutineSlot
      .querySelector('[data-vl-funded-choice-dismiss]')
      ?.addEventListener('click', () => {
        answered = true;
        dismissToast(toastRoutineSlot);
        if (isPanoramaAutofillCurrent(data)) cancelPanoramaAutofill();
      });
    return;
  }

  const label =
    data.tradename || data.generic_name || data.name || data.lot || 'Vaccine';
  const lot = data.lot || '';
  const flag =
    data.expiry_flag ||
    getExpiryStatus(data.inventory_expiry || data.expiry || data.nvc_lot_expiry)
      .flag;
  const expiry =
    data.inventory_expiry || data.expiry || data.nvc_lot_expiry || '';

  let expiryText = '';
  if (expiry) {
    const friendlyDate = expiry.length > 10 ? expiry.slice(0, 10) : expiry;
    const flagLabels = {
      valid: 'Valid',
      expiring_soon: 'Expiring soon',
      expired: 'Expired'
    };
    expiryText = `${flagLabels[flag] || 'Unknown'} (exp ${friendlyDate})`;
  }
  const detail = [lot ? `Lot ${lot}` : '', expiryText]
    .filter(Boolean)
    .join(' \u2014 ');

  if (data._duplicateIgnored) {
    showRoutineToast(
      `<div class="vl-toast duplicate show">
      <div class="vl-toast-title">Duplicate scan ignored</div>
      <div class="vl-toast-detail">${escapeToastHtml(label)} is already in the tray</div>
      ${detail ? `<div class="vl-toast-detail">${escapeToastHtml(detail)}</div>` : ''}
    </div>`,
      durationMs
    );
    return;
  }

  const cssClass =
    flag === 'expired'
      ? 'expired'
      : flag === 'expiring_soon'
        ? 'expiring'
        : 'valid';
  const isExpired = flag === 'expired';
  const queuedNote = data._queuedCount
    ? `<div class="vl-toast-detail">Added to tray (${Number(data._queuedCount)} saved)</div>`
    : '';

  const toastHtml = `<div class="vl-toast ${cssClass}${isExpired ? ' persistent' : ''} show">
    <div class="vl-toast-title">${isExpired ? 'Expired vaccine' : escapeToastHtml(label)}</div>
    ${data._chartUseBlocked ? `<div class="vl-toast-detail">${data.reference_only ? 'Saved for reference only.' : 'Autofill stopped. Use an in-date vaccine.'}</div>` : ''}
    ${isExpired ? `<div class="vl-toast-detail">${escapeToastHtml(label)}</div>` : ''}
    ${detail ? `<div class="vl-toast-detail">${escapeToastHtml(detail)}</div>` : ''}
    ${queuedNote}
    ${data.lookup_error ? `<div class="vl-toast-detail">${escapeToastHtml(data.lookup_error)}. Vaccine details are incomplete; verify the chart.</div>` : ''}
    ${reportMarkup}
    ${isExpired ? '<button class="vl-toast-dismiss" type="button">Dismiss</button>' : ''}
  </div>`;

  if (isExpired) {
    // Persistent: own slot, no timer \u2014 stays until the nurse dismisses it
    // (issue #28). Routine toasts keep flowing in the slot below.
    toastWarningSlot.innerHTML = toastHtml;
    logAnalyticsEvent('expiry_notice_shown', {
      workflow: data._vaxlinkQueueContext?.workflow || activeWorkflowMode
    });
    playAudioCue('expiry_warning');
    const dismissBtn = toastWarningSlot.querySelector('.vl-toast-dismiss');
    if (dismissBtn)
      dismissBtn.addEventListener('click', () =>
        dismissToast(toastWarningSlot)
      );
    return;
  }
  showRoutineToast(
    toastHtml,
    reportUrl ? Math.max(durationMs, 10000) : durationMs
  );
  if (flag === 'expiring_soon')
    logAnalyticsEvent('expiry_notice_shown', {
      workflow: data._vaxlinkQueueContext?.workflow || activeWorkflowMode
    });
}

function dismissToast(slot) {
  const el = slot && slot.querySelector('.vl-toast');
  if (el) el.classList.remove('show');
  setTimeout(() => {
    if (slot) slot.innerHTML = '';
  }, 300);
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
let hudContainer = null;
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

function initHud() {
  if (hudInitialized) return;
  if (!isHandsFreeSupportedPage()) return;
  hudInitialized = true;
  updateInventoryModeNotice();

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
    .vl-hud-btn:hover {
      background: #fff;
      transform: translateY(-1px);
      box-shadow: 0 8px 18px rgba(9, 40, 53, .18);
    }
    .vl-hud-btn:disabled { opacity: .5; cursor: default; }
    .vl-hud-btn:active { transform: translateY(0); }
    .vl-hud-label {
      font-size: 11px;
      letter-spacing: .03em;
      text-transform: uppercase;
      color: rgba(232, 249, 253, .82);
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

  hudQueueWrap = document.createElement('div');
  hudQueueWrap.className = 'vl-hud-queue hidden';

  hudCountEl = document.createElement('span');
  hudCountEl.className = 'vl-hud-count';
  hudCountEl.textContent = '0';

  hudClearBtn = document.createElement('button');
  hudClearBtn.className = 'vl-hud-btn vl-hud-clear-btn';
  hudClearBtn.textContent = 'Clear';
  hudClearBtn.title = 'Clear the immunization tray';
  hudClearBtn.addEventListener('click', () => {
    // Two-step confirm so a stray click cannot wipe a clinic's scans.
    if (hudClearBtn.dataset.confirming === 'true') {
      delete hudClearBtn.dataset.confirming;
      hudClearBtn.textContent = 'Clear';
      void clearHudQueue().catch((error) =>
        showVaxlinkToast({ _entryWarning: error.message })
      );
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
      newLeft = Math.max(
        0,
        Math.min(window.innerWidth - hudContainer.offsetWidth, newLeft)
      );
      newTop = Math.max(
        0,
        Math.min(window.innerHeight - hudContainer.offsetHeight, newTop)
      );
      applyHudPosition({ left: newLeft, top: newTop });
    } else if (hudMiniPointerDown) {
      const dx = e.clientX - hudMiniDownX;
      const dy = e.clientY - hudMiniDownY;
      if (!hudMiniDidDrag && Math.abs(dx) + Math.abs(dy) > 4) {
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
        chrome.storage.local.set({
          [HUD_POSITION_KEY]: { left: hudCurrentLeft, top: hudCurrentTop }
        });
      }
    } else if (hudMiniPointerDown) {
      hudMiniPointerDown = false;
      hudMiniEl.style.cursor = '';
      if (hudMiniDidDrag) {
        chrome.storage.local.set({
          [HUD_POSITION_KEY]: { left: hudCurrentLeft, top: hudCurrentTop }
        });
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
      LEGACY_POPUP_MODE_KEY in changes
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
    const rows =
      stored && Array.isArray(stored[MULTIPLE_INJECT_QUEUE_KEY])
        ? stored[MULTIPLE_INJECT_QUEUE_KEY]
        : [];
    const count = rows.length;
    const shouldShow = isPanoramaRecordImmsPage();
    const showQueueControls =
      activeWorkflowMode === 'immunization' && count > 0;

    if (hudContainer) {
      hudContainer.classList.toggle('hidden', !shouldShow || hudUserHidden);
    }
    if (hudMiniEl) {
      hudMiniEl.classList.toggle('visible', shouldShow && hudUserHidden);
    }
    if (hudQueueWrap) {
      hudQueueWrap.classList.toggle('hidden', !showQueueControls);
    }
    if (hudCountEl) {
      hudCountEl.textContent = String(count);
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

    item.appendChild(label);
    const heldDose =
      row.dose_reservations?.find((dose) => dose.review) ||
      row.dose_reservations?.[0];
    if (heldDose) {
      const review = document.createElement('button');
      review.type = 'button';
      review.className = 'vl-hud-btn';
      review.textContent = 'Review dose';
      review.setAttribute('aria-label', `Review dose for ${label.textContent}`);
      review.addEventListener('click', () =>
        showDoseReview(row, heldDose.token)
      );
      item.appendChild(review);
      hudQueueListEl.appendChild(item);
      continue;
    }

    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'vl-hud-btn';
    use.textContent = 'Use';
    use.setAttribute('aria-label', `Use ${label.textContent}`);
    use.disabled = globalThis.VaxLinkExpiryDate.blocksChartUse(row);
    use.addEventListener('click', () => {
      const context = getPanoramaFormContext();
      const token = getScannerDeliveryContext(context.kind, true);
      void useTrayVaccine(row.id, token)
        .then((result) => {
          if (result.status === 'grid_added')
            showVaxlinkToast({ _gridAdded: true });
          else if (!isAutofillPending(result) && !isAutofillSuccess(result))
            warnPanoramaEntryBlocked(
              result.error || 'Check the chart before trying again.'
            );
        })
        .catch((error) => warnPanoramaEntryBlocked(error.message));
    });
    item.appendChild(use);
    const removeBtn = document.createElement('button');
    removeBtn.className = 'vl-hud-item-remove';
    removeBtn.textContent = '×';
    removeBtn.title = `Remove ${name} from tray`;
    removeBtn.setAttribute('aria-label', removeBtn.title);
    removeBtn.addEventListener('click', () => {
      void removeHudQueueRow(row.id);
    });

    item.appendChild(removeBtn);
    hudQueueListEl.appendChild(item);
  }
}

function showDoseReview(row, token) {
  ensureToastHost();
  const product = row.tradename || row.generic_name || row.name || 'Vaccine';
  const description = [product, row.lot].filter(Boolean).join(' · ');
  toastWarningSlot.innerHTML = `<div class="vl-toast expired persistent show" role="alert">
    <div class="vl-toast-title">${escapeToastHtml(description)}</div>
    <div class="vl-toast-detail">Check the original chart to see whether this dose was used.</div>
    <div class="vl-toast-actions">
      <button class="vl-toast-action" data-used="true" type="button">Dose used</button>
      <button class="vl-toast-action" data-used="false" type="button">Dose unused</button>
      <button class="vl-toast-dismiss" type="button">Not now</button>
    </div>
  </div>`;
  toastWarningSlot.querySelectorAll('[data-used]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await mutateQueueViaBackground(
          MULTIPLE_INJECT_QUEUE_KEY,
          'review_dose',
          {
            id: row.id,
            token,
            used: button.dataset.used === 'true'
          }
        );
        dismissToast(toastWarningSlot);
      } catch (error) {
        showVaxlinkToast({ _entryWarning: error.message });
      }
    });
  });
  toastWarningSlot
    .querySelector('.vl-toast-dismiss')
    .addEventListener('click', () => dismissToast(toastWarningSlot));
}

async function removeHudQueueRow(id) {
  if (!id) return;
  await mutateQueueViaBackground(MULTIPLE_INJECT_QUEUE_KEY, 'remove', { id });
  updateHudState();
}

async function clearHudQueue() {
  await mutateQueueViaBackground(MULTIPLE_INJECT_QUEUE_KEY, 'clear');
  updateHudState();
}

function isPanoramaMultipleImmunizationGridPage({ visibleOnly = false } = {}) {
  if (!isHandsFreeSupportedPage()) return false;
  const tableBody = document.querySelector(
    'tbody[id*="historicalfactoryTable:dataTable_data"]'
  );
  if (
    !tableBody ||
    (visibleOnly &&
      (!isVisible(tableBody) ||
        getComputedStyle(tableBody).visibility !== 'visible'))
  ) {
    return false;
  }
  const addRowsButton = document.querySelector(
    'button[id*="historicalfactoryTable:addButtonId:commandButtonId"]'
  );
  if (!addRowsButton) return false;
  if (visibleOnly)
    return (
      isVisible(addRowsButton) &&
      getComputedStyle(addRowsButton).visibility === 'visible'
    );
  const hasAgentField = !!document.querySelector(
    'select[id*="historicalfactoryTable:dataTable:0:immsAgentMenu:selectOneMenu_input"]'
  );
  const hasDateField = !!document.querySelector(
    'input[id*="historicalfactoryTable:dataTable:0:dateIn1:dateInput_input"]'
  );
  return hasAgentField && hasDateField;
}

function getPanoramaMultipleGridRows() {
  const body = document.querySelector(
    'tbody[id*="historicalfactoryTable:dataTable_data"]'
  );
  if (!body) return [];
  return Array.from(body.querySelectorAll('tr[data-ri]'));
}

function getPanoramaMultipleGridAgentField(rowIndex) {
  return document.querySelector(
    `select[id*="historicalfactoryTable:dataTable:${rowIndex}:immsAgentMenu:selectOneMenu_input"]`
  );
}

function getPanoramaMultipleGridAgentFocusField(rowIndex) {
  return document.querySelector(
    `input[id*="historicalfactoryTable:dataTable:${rowIndex}:immsAgentMenu:selectOneMenu_focus"]`
  );
}

function getPanoramaMultipleGridAgentLabel(rowIndex) {
  return document.querySelector(
    `label[id*="historicalfactoryTable:dataTable:${rowIndex}:immsAgentMenu:selectOneMenu_label"]`
  );
}

function getPanoramaMultipleGridDate1Field(rowIndex) {
  return document.querySelector(
    `input[id*="historicalfactoryTable:dataTable:${rowIndex}:dateIn1:dateInput_input"]`
  );
}

function panoramaGridAgentMatchesCandidate(rowIndex, candidate) {
  const field = getPanoramaMultipleGridAgentField(rowIndex);
  return (
    !!field?.value && isAgentTextAccepted(candidate, getFieldFilledText(field))
  );
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
    agentText: agentField
      ? agentField.value
        ? selectText
        : ''
      : labelText || focusText,
    dateText: String(dateField?.value || '').trim()
  };
}

function fillPanoramaMultipleGridAgent(rowIndex, data) {
  const agentField = getPanoramaMultipleGridAgentField(rowIndex);
  const agentFocusField = getPanoramaMultipleGridAgentFocusField(rowIndex);
  if (!agentField || !canFillPanoramaControl(agentField)) return false;
  const candidates = getPanoramaAgentCandidates(data);
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (panoramaGridAgentMatchesCandidate(rowIndex, candidate)) return true;
    if (
      fillField(agentField, candidate) &&
      panoramaGridAgentMatchesCandidate(rowIndex, candidate)
    )
      return true;
    if (
      agentFocusField &&
      fillField(agentFocusField, candidate) &&
      panoramaGridAgentMatchesCandidate(rowIndex, candidate)
    ) {
      return true;
    }
  }
  return false;
}

function fillPanoramaMultipleGridDate1(rowIndex, data) {
  const dateField = getPanoramaMultipleGridDate1Field(rowIndex);
  if (!dateField || !canFillPanoramaControl(dateField)) return false;
  const administered = getPanoramaAdministeredDateTimeValues(data);
  if (!administered.date || panoramaDateTimeHasValue(dateField.value))
    return false;
  return fillPanoramaMaskedTextInput(
    dateField,
    administered.date,
    undefined,
    true
  );
}

function fillPanoramaMultipleGridRow(rowIndex, data) {
  if (!data || globalThis.VaxLinkExpiryDate.blocksChartUse(data)) return false;
  const rowState = getPanoramaMultipleGridRowState(rowIndex);
  if (!rowState.agentText || !panoramaDateTimeHasValue(rowState.dateText))
    markPanoramaAutofillStarted(data);
  const agentChanged =
    !rowState.agentText && fillPanoramaMultipleGridAgent(rowIndex, data);
  const current = getPanoramaMultipleGridRowState(rowIndex);
  const candidates = getPanoramaAgentCandidates(data);
  const agentMatches =
    !!current.agentText &&
    (!candidates.length ||
      candidates.some((candidate) =>
        isAgentTextAccepted(candidate, current.agentText)
      ));
  // Panorama can populate the grid date while handling the Agent change.
  const dateChanged =
    agentMatches &&
    !panoramaDateTimeHasValue(current.dateText) &&
    !isPrimeFacesAjaxBusy() &&
    fillPanoramaMultipleGridDate1(rowIndex, data);
  return agentChanged || dateChanged;
}

function isGridAssignmentCurrent(assignment, form) {
  const { row, key, index } = assignment;
  return (
    row.isConnected &&
    form.contains(row) &&
    row.getAttribute('data-ri') === index &&
    row.getAttribute('data-rk') === key
  );
}

function assignTrayVaccineToGrid(data) {
  const candidates = getPanoramaAgentCandidates(data);
  if (!candidates.length) return null;
  const { _vaxlinkOwner: owner } = data;
  const row = getPanoramaMultipleGridRows().find((candidate) => {
    const index = candidate.getAttribute('data-ri');
    return (
      /^\d+$/.test(index) &&
      isVisible(candidate) &&
      !getPanoramaMultipleGridRowState(index).agentText
    );
  });
  if (!row) return null;
  const index = row.getAttribute('data-ri');
  const key = row.getAttribute('data-rk');
  const assignment = { row, index, key };
  owner.gridAssignment = assignment;
  fillPanoramaMultipleGridRow(index, data);
  if (!isPanoramaAutofillCurrent(data)) return null;
  const { agentText, dateText } = getPanoramaMultipleGridRowState(index);
  if (
    !candidates.some((candidate) => isAgentTextAccepted(candidate, agentText))
  )
    return null;
  assignment.agent = panoramaAgentIdentity(agentText);
  assignment.date = dateText;
  return assignment;
}

async function readGridAssignmentRoute() {
  try {
    const reply = await chrome.runtime.sendMessage({
      action: 'checkScannerChart'
    });
    return reply?.success ? reply.scannerRoute : null;
  } catch (_) {
    return null;
  }
}

function rememberGridAssignment(assignment, dose, record, source) {
  if (!assignment.date || autofillSettings[GRID_DETAIL_AUTOFILL_KEY] === false)
    return false;
  const { owner } = dose;
  const route = owner.scannerRoute
    ? Promise.resolve({
        epoch: owner.scannerRoute.epoch,
        generation: owner.scannerRoute.generation
      })
    : readGridAssignmentRoute();
  const prior = gridAssignments.get(assignment.index);
  if (prior) void releaseGridAssignment(prior);
  const entry = {
    ...assignment,
    form: owner.form,
    url: owner.url,
    route,
    dose,
    lot: record.lot,
    source
  };
  gridAssignments.set(entry.index, entry);
  // A verified Agent/date assignment is not a product write. Keep its
  // reservation separate from the grid owner as the form changes to details.
  owner.trayDose = null;
  void route.then((active) => {
    if (!active && gridAssignments.get(entry.index) === entry) {
      gridAssignments.delete(entry.index);
      void releaseGridAssignment(entry);
    }
  });
  return true;
}

function releaseGridAssignment(entry) {
  return stopTrayDose(entry.dose.owner, true, entry.dose);
}

function clearGridCarry() {
  for (const entry of gridAssignments.values())
    void releaseGridAssignment(entry);
  gridAssignments.clear();
  const handoff = gridDetailHandoff;
  if (!handoff) return;
  gridDetailHandoff = null;
  handoff.observer.disconnect();
  clearTimeout(handoff.opening);
  for (const row of handoff.rows)
    if (row.entry) void releaseGridAssignment(row.entry);
}

function visiblePopulatedGridRows() {
  return getPanoramaMultipleGridRows()
    .filter(isVisible)
    .flatMap((row) => {
      const index = row.getAttribute('data-ri');
      const { agentText, dateText } = getPanoramaMultipleGridRowState(index);
      const agent = panoramaAgentIdentity(agentText);
      return agent
        ? [
            {
              row,
              index,
              key: row.getAttribute('data-rk'),
              agent,
              date: dateText
            }
          ]
        : [];
    });
}

function sameGridAssignment(left, right) {
  return (
    right &&
    left.row === right.row &&
    left.index === right.index &&
    left.key === right.key &&
    left.agent === right.agent &&
    left.date === right.date
  );
}

function startGridHandoff(event) {
  if (!event.isTrusted || (!gridAssignments.size && !gridDetailHandoff)) return;
  const button = event.target?.closest?.(
    'button, a, input[type="submit"], input[type="button"], [role="button"]'
  );
  if (!button) return;
  const label = normalizeLabelText(
    button.textContent || button.value || button.title
  );
  if (['cancel', 'close', 'reset'].includes(label)) {
    clearGridCarry();
    return;
  }
  if (!gridAssignments.size || label !== 'enter details') return;
  const form = getPanoramaAutofillForm();
  if (
    !form?.contains(button) ||
    !isPanoramaChartActive() ||
    getPanoramaFormContext({ checkReadiness: false }).kind !== 'multiple_grid'
  )
    return;
  const rows = visiblePopulatedGridRows();
  for (const row of rows) {
    const entry = gridAssignments.get(row.index);
    if (
      entry?.form !== form ||
      entry.url !== location.href ||
      !sameGridAssignment(row, entry)
    )
      continue;
    if (rows.some((other) => other !== row && other.agent === row.agent))
      continue;
    row.entry = entry;
    gridAssignments.delete(row.index);
  }
  clearGridCarry();
  if (!rows.some((row) => row.entry)) return;

  const observer = new MutationObserver(() => {
    void advanceGridHandoff();
  });
  const handoff = {
    rows,
    form,
    url: location.href,
    observer,
    step: 0,
    attempted: 0
  };
  gridDetailHandoff = handoff;
  handoff.opening = setTimeout(() => {
    if (gridDetailHandoff === handoff && !handoff.step) clearGridCarry();
  }, 16000);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      'disabled',
      'class',
      'style',
      'value',
      'data-ri',
      'data-rk'
    ]
  });
}

function currentGridDetailStep() {
  const [step, , total] = getPanoramaMultiStepIndicatorKey({
    visibleOnly: true
  })
    .split('-')
    .map(Number);
  return { step, total };
}

function matchesGridDetail(entry) {
  const form = getPanoramaAutofillForm();
  const { dateField } = getPanoramaAdministeredDateTimeFields({
    _vaxlinkOwner: { form }
  });
  return (
    panoramaAgentIdentity(getPanoramaCurrentAgentSelectionText(form)) ===
      entry.agent && dateField?.value.trim() === entry.date
  );
}

const DIFFERENT_GRID_DETAIL_LOT =
  'Panorama selected a different lot. Check the lot on the chart before continuing.';

function hasDifferentGridDetailLot(entry) {
  const lot = getPanoramaDisplayedLot(getPanoramaLotWidget());
  if (!lot) return false;
  const intended = normalizePanoramaLotToken(entry.lot);
  const displayed = normalizePanoramaLotToken(
    getPanoramaManufacturerLotText(lot, getPanoramaFundedRadioValue())
  );
  return !intended || displayed !== intended;
}

async function releaseGridDetailStep() {
  const handoff = gridDetailHandoff;
  if (!handoff) return;
  const { step, total } = currentGridDetailStep();
  if (total !== handoff.rows.length) return;
  const row = handoff.rows[step - 1];
  handoff.attempted = step;
  if (!row?.entry) return;
  const entry = row.entry;
  row.entry = null;
  await releaseGridAssignment(entry);
}

async function advanceGridHandoff() {
  const handoff = gridDetailHandoff;
  if (!handoff) return;
  const context = getPanoramaFormContext();
  if (
    !isPanoramaChartActive() ||
    handoff.url !== location.href ||
    (context.kind === 'multiple_grid' && handoff.step) ||
    ['provider_single', 'non_provider_single'].includes(context.kind)
  ) {
    clearGridCarry();
    return;
  }
  if (context.kind === 'multiple_grid') {
    const visible = visiblePopulatedGridRows();
    // Panorama can remove the old grid while building the detail form.
    if (
      visible.length &&
      (visible.length !== handoff.rows.length ||
        handoff.rows.some(
          (row, index) => !sameGridAssignment(row, visible[index])
        ))
    )
      clearGridCarry();
    return;
  }
  if (context.kind !== 'multiple_detail') return;

  const { step, total } = currentGridDetailStep();
  const row = handoff.rows[step - 1];
  const form = getPanoramaAutofillForm();
  if (
    !row ||
    total !== handoff.rows.length ||
    step < handoff.step ||
    step > handoff.step + 1 ||
    (form !== handoff.form && (!form?.id || form.id !== handoff.form.id))
  ) {
    clearGridCarry();
    return;
  }
  if (step > handoff.step && handoff.step) {
    const previous = handoff.rows[handoff.step - 1];
    if (previous.entry) void releaseGridAssignment(previous.entry);
    previous.entry = null;
  }
  handoff.step = step;
  clearTimeout(handoff.opening);
  if (!row.entry || !context.ready || handoff.attempted === step) return;
  handoff.attempted = step;
  const entry = row.entry;
  try {
    const route = await entry.route;
    if (!route || !(await checkPanoramaScannerRoute({ scannerRoute: route })))
      return;
    const current = getPanoramaFormContext();
    const detail = currentGridDetailStep();
    if (
      gridDetailHandoff !== handoff ||
      row.entry !== entry ||
      current.kind !== 'multiple_detail' ||
      !current.ready ||
      getPanoramaAutofillForm() !== form ||
      detail.step !== step ||
      detail.total !== total ||
      !matchesGridDetail(entry)
    )
      return;
    if (hasDifferentGridDetailLot(entry)) {
      showVaxlinkToast({ _entryWarning: DIFFERENT_GRID_DETAIL_LOT });
      return;
    }

    const data = beginPanoramaAutofill({}, true, { automatic: true });
    if (!isPanoramaAutofillCurrent(data)) return;
    data._vaxlinkOwner.scannerRoute = route;
    data._vaxlinkOwner.gridDetail = entry;
    row.entry = null;
    await fillReservedTrayRecord(
      entry.dose.recordId,
      data,
      entry.source,
      'multiple_detail',
      entry.dose
    );
  } catch (error) {
    showVaxlinkToast({ _entryWarning: error.message });
  } finally {
    if (row.entry === entry) {
      row.entry = null;
      await releaseGridAssignment(entry);
    }
  }
}

function getPanoramaCurrentTradeSelectionText(scope) {
  const fields = getFields(getPanoramaTradeSelectors(), scope);
  for (const field of panoramaSelectionControls(fields)) {
    if (field.tagName === 'SELECT' && !field.value) continue;
    const text = normalizeForMatch(getFieldFilledText(field));
    if (text && text !== 'select' && text !== 'select one') return text;
  }
  return '';
}

function getPanoramaCurrentLotSelectionText(scope) {
  const value = normalizeForMatch(
    readPanoramaLotSelection(getPanoramaLotWidget(scope))
  );
  return value === 'select' || value === 'select one' ? '' : value;
}

function getPanoramaMultiStepIndicatorKey({
  scope = document,
  visibleOnly = false,
  exact = visibleOnly
} = {}) {
  const nodes = scope.querySelectorAll('div, span, td, th, strong, label');
  const pattern = exact
    ? /^(\d+)\s+of\s+(\d+)\s+immunizations?$/i
    : /\b(\d+)\s+of\s+(\d+)\s+immunizations?\b/i;
  for (const node of nodes) {
    const text = String(node.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    const match = text.match(pattern);
    if (
      match &&
      (!visibleOnly ||
        (isVisible(node) && getComputedStyle(node).visibility === 'visible'))
    ) {
      return `${match[1]}-of-${match[2]}`;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Register each isolated copy on the shared chart once. The marker contains
// only public extension IDs. Read-only checks never claim the chart.
function registerPanoramaInstallation() {
  if (registeredChart || !isHandsFreeSupportedPage()) return;
  const chart = document.documentElement;
  if (!chart) return;
  registeredChart = chart;
  const ids = readPanoramaInstallations(chart);
  const id = chrome.runtime.id;
  if (!ids.includes(id)) {
    chart.setAttribute(CHART_INSTALLATIONS_ATTRIBUTE, [...ids, id].join(' '));
  }
}

function readPanoramaInstallations(chart) {
  return (chart.getAttribute(CHART_INSTALLATIONS_ATTRIBUTE) || '')
    .split(/\s+/)
    .filter(Boolean);
}

function panoramaEntryBlockReason() {
  const chart = document.documentElement;
  if (!chart || registeredChart !== chart) {
    return 'Refresh the chart to load VaxLink before filling.';
  }
  const ids = readPanoramaInstallations(chart);
  if (ids.some((id) => id !== chrome.runtime.id)) {
    return MULTIPLE_INSTALLATIONS_WARNING;
  }
  if (!ids.includes(chrome.runtime.id)) {
    return 'Refresh the chart to load VaxLink before filling.';
  }
  if (
    (contentBuildAtLoad.name !== 'VaxLink' ||
      !contentBuildAtLoad.fingerprint) &&
    location.hostname !== PANORAMA_TRAINING_HOST
  ) {
    return 'VaxLink Alpha and development copies fill training charts only.';
  }
  return '';
}

function warnPanoramaEntryBlocked(warning) {
  if (document.body) showVaxlinkToast({ _entryWarning: warning });
}

function watchPanoramaInstallations() {
  registerPanoramaInstallation();
  if (!registeredChart) return;
  const check = () => {
    const reason = panoramaEntryBlockReason();
    if (reason !== MULTIPLE_INSTALLATIONS_WARNING) return;
    cancelPanoramaAutofill();
    warnPanoramaEntryBlocked(reason);
  };
  check();
  new MutationObserver(check).observe(registeredChart, {
    attributes: true,
    attributeFilter: [CHART_INSTALLATIONS_ATTRIBUTE]
  });
}

registerPanoramaInstallation();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', watchPanoramaInstallations);
} else {
  watchPanoramaInstallations();
}

// Initialize new features after DOM is ready
// ---------------------------------------------------------------------------

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', initHud);
else initHud();
