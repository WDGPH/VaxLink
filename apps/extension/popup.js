import {
  ScanQueueManager,
  buildInventorySummary,
  buildMultipleInjectSummary,
  buildQueueRecord,
  INVENTORY_BATCH_KEY,
  MULTIPLE_INJECT_QUEUE_KEY
} from './popup-inventory.js';
import { getExpiryStatus, outputTypeForExpiry, parseInputData } from './popup-parser.js';
import {
  buildParsedOutputMarkup,
  renderNVCStatus,
  setButtonBusy,
  showOutput
} from './popup-ui.js';

let autoFillBtn;
let refreshNvcBtn;
let addCurrentBtn;
let addBatchBtn;
let exportCsvBtn;
let clearInventoryBtn;
let clearMultipleBtn;
let singleModeBtn;
let multipleModeBtn;
let inventoryModeBtn;
let singleModeSection;
let multipleModeSection;
let inventoryModeSection;
let scannerInputSection;
let scannedInputLabel;
let scannedInput;
let nvcStatusDiv;
let outputDiv;
let modeHelper;
let scanStateTitle;
let scanStateSubtitle;
let analyticsSummaryDiv;
let analyticsLabelInput;
let settingsToggleBtn;
let settingsPanel;
let mainWorkflowPanel;
let saveAnalyticsLabelBtn;
let exportTodayAnalyticsBtn;
let exportPilotAnalyticsBtn;
let exportAnalyticsCsvBtn;
let resetAnalyticsBtn;
let adminDateTimeAutofillToggle;
let parsedData = null;
let activeParseRequestId = 0;
let autoParseTimer = null;
let multipleInjectManager;
let inventoryManager;
let activeMode = 'single';
let adminDateTimeAutofillEnabled = true;

const lotLookupCache = new Map();
const LOT_LOOKUP_CACHE_MAX = 64;
const WORKFLOW_MODE_KEY = 'vaxlink_workflow_mode_v1';
const LEGACY_POPUP_MODE_KEY = 'vaxlink_popup_mode_v1';
const LEGACY_REMOTE_MODE_KEY = 'hands_free_scan_mode_v1';
const LEGACY_HANDS_FREE_KEY = 'hands_free_scan_autofill_enabled';
const ANALYTICS_STORAGE_KEY = 'vaxlink_analytics_v1';
const SETTINGS_PANEL_OPEN_KEY = 'vaxlink_settings_panel_open_v1';
const ADMIN_DATETIME_AUTOFILL_KEY = 'vaxlink_administered_datetime_autofill_v1';

const MODE_CONFIG = {
  single: {
    title: 'Single Inject',
    subtitle: 'One scan fills the current chart immediately.',
    helper: 'Use this when one vaccine is being charted now. Scan into the field below to preview, or leave this mode active and scan directly on the live chart page for hands-free auto-fill.',
    inputLabel: 'Scanned Barcode',
    inputPlaceholder: 'Paste barcode here or scan with device...',
    usesScannerInput: true
  },
  multiple: {
    title: 'Multiple Inject',
    subtitle: 'Scan several vaccines now, choose them for chart fill later.',
    helper: 'Leave this mode active while walking to the fridge. Each scan on the live chart page is saved automatically. When you come back, open the queue and choose Use for Chart on each saved vaccine.',
    usesScannerInput: false
  },
  inventory: {
    title: 'Inventory',
    subtitle: 'Capture vaccines into an export tray.',
    helper: 'Use this for stock or export work. Scan into the field below and add to the inventory tray, or leave this mode active to save each live scan into the inventory export list automatically.',
    inputLabel: 'Inventory Barcode Input',
    inputPlaceholder: 'Scan one barcode per line or paste a batch...',
    usesScannerInput: true
  }
};

document.addEventListener('DOMContentLoaded', async () => {
  autoFillBtn = document.getElementById('autoFillBtn');
  refreshNvcBtn = document.getElementById('refreshNvcBtn');
  addCurrentBtn = document.getElementById('addCurrentBtn');
  addBatchBtn = document.getElementById('addBatchBtn');
  exportCsvBtn = document.getElementById('exportCsvBtn');
  clearInventoryBtn = document.getElementById('clearInventoryBtn');
  clearMultipleBtn = document.getElementById('clearMultipleBtn');
  singleModeBtn = document.getElementById('singleModeBtn');
  multipleModeBtn = document.getElementById('multipleModeBtn');
  inventoryModeBtn = document.getElementById('inventoryModeBtn');
  singleModeSection = document.getElementById('singleModeSection');
  multipleModeSection = document.getElementById('multipleModeSection');
  inventoryModeSection = document.getElementById('inventoryModeSection');
  scannerInputSection = document.getElementById('scannerInputSection');
  scannedInputLabel = document.getElementById('scannedInputLabel');
  scannedInput = document.getElementById('scannedData');
  nvcStatusDiv = document.getElementById('nvcStatus');
  outputDiv = document.getElementById('output');
  modeHelper = document.getElementById('modeHelper');
  scanStateTitle = document.getElementById('scanStateTitle');
  scanStateSubtitle = document.getElementById('scanStateSubtitle');
  analyticsSummaryDiv = document.getElementById('analyticsSummary');
  analyticsLabelInput = document.getElementById('analyticsLabelInput');
  settingsToggleBtn = document.getElementById('settingsToggleBtn');
  settingsPanel = document.getElementById('settingsPanel');
  mainWorkflowPanel = document.getElementById('mainWorkflowPanel');
  saveAnalyticsLabelBtn = document.getElementById('saveAnalyticsLabelBtn');
  exportTodayAnalyticsBtn = document.getElementById('exportTodayAnalyticsBtn');
  exportPilotAnalyticsBtn = document.getElementById('exportPilotAnalyticsBtn');
  exportAnalyticsCsvBtn = document.getElementById('exportAnalyticsCsvBtn');
  resetAnalyticsBtn = document.getElementById('resetAnalyticsBtn');
  adminDateTimeAutofillToggle = document.getElementById('adminDateTimeAutofillToggle');

  multipleInjectManager = new ScanQueueManager({
    storageKey: MULTIPLE_INJECT_QUEUE_KEY,
    summaryEl: document.getElementById('multipleQueueSummary'),
    listEl: document.getElementById('multipleQueueList'),
    clearButton: clearMultipleBtn,
    onUseRecord: handleUseMultipleInjectRecord,
    showUseAction: true,
    useButtonLabel: 'Use for Chart',
    emptySummary: 'No saved vaccines yet.',
    emptyMessage: 'Leave Multiple Inject active, scan several vaccines on the live chart page, then come back and choose one to fill.',
    summaryBuilder: buildMultipleInjectSummary
  });

  inventoryManager = new ScanQueueManager({
    storageKey: INVENTORY_BATCH_KEY,
    summaryEl: document.getElementById('inventorySummary'),
    listEl: document.getElementById('inventoryList'),
    clearButton: clearInventoryBtn,
    exportButton: exportCsvBtn,
    emptySummary: 'No inventory scans yet.',
    emptyMessage: 'Scan vaccines into the inventory tray, then export when ready.',
    summaryBuilder: buildInventorySummary,
    exportFilenamePrefix: 'vaxlink-inventory'
  });

  await Promise.all([multipleInjectManager.load(), inventoryManager.load()]);
  await loadWorkflowMode();
  await loadSettingsPanelState();
  await loadAdminDateTimeAutofillSetting();
  await loadAnalyticsSummary();
  logAnalyticsEvent('popup_open', { workflow: activeMode, source: 'popup' });

  if (scannedInput) {
    scannedInput.addEventListener('input', () => {
      if (usesScannerInput(activeMode)) {
        queueAutoParse();
      }
    });

    scannedInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') {
        return;
      }
      event.preventDefault();
      if (activeMode === 'inventory') {
        addPreviewScanToInventory();
        return;
      }
      if (activeMode === 'single') {
        queueAutoParse(true);
      }
    });
  }

  if (singleModeBtn) {
    singleModeBtn.addEventListener('click', () => setActiveMode('single'));
  }
  if (multipleModeBtn) {
    multipleModeBtn.addEventListener('click', () => setActiveMode('multiple'));
  }
  if (inventoryModeBtn) {
    inventoryModeBtn.addEventListener('click', () => setActiveMode('inventory'));
  }

  if (settingsToggleBtn) {
    settingsToggleBtn.addEventListener('click', () => {
      void setSettingsPanelOpen(settingsPanel?.hidden ?? true);
    });
  }
  if (adminDateTimeAutofillToggle) {
    adminDateTimeAutofillToggle.addEventListener('change', () => {
      void setAdminDateTimeAutofillSetting(!!adminDateTimeAutofillToggle.checked);
    });
  }

  if (autoFillBtn) {
    autoFillBtn.addEventListener('click', async () => {
      if (!parsedData) {
        writeOutput('Scan a barcode first. Parsing runs automatically.', 'error');
        return;
      }

      logAnalyticsEvent('autofill_attempt', {
        workflow: activeMode,
        source: 'popup_button',
        vaccineLabel: parsedData.tradename || parsedData.generic_name || parsedData.name || parsedData.lot || '',
        manufacturer: parsedData.manufacturer || '',
        expiryFlag: parsedData.expiry_flag || getExpiryStatus(parsedData.inventory_expiry || parsedData.expiry).flag
      });
      try {
        await sendAutoFillToActiveTab(parsedData);
        logAnalyticsEvent('autofill_result', {
          workflow: activeMode,
          source: 'popup_button',
          success: true,
          vaccineLabel: parsedData.tradename || parsedData.generic_name || parsedData.name || parsedData.lot || '',
          manufacturer: parsedData.manufacturer || '',
          expiryFlag: parsedData.expiry_flag || getExpiryStatus(parsedData.inventory_expiry || parsedData.expiry).flag
        });
        writeOutput('Chart auto-filled', 'success');
      } catch (error) {
        logAnalyticsEvent('autofill_result', {
          workflow: activeMode,
          source: 'popup_button',
          success: false,
          vaccineLabel: parsedData.tradename || parsedData.generic_name || parsedData.name || parsedData.lot || '',
          manufacturer: parsedData.manufacturer || ''
        });
        writeOutput(error.message || 'Could not auto-fill fields', 'error');
      }
    });
  }

  if (clearMultipleBtn) {
    clearMultipleBtn.addEventListener('click', async () => {
      await multipleInjectManager.clear();
      logAnalyticsEvent('queue_cleared', { workflow: 'multiple', queue: 'multiple', source: 'popup_button' });
      writeOutput('Multiple Inject queue cleared.', 'info');
    });
  }

  if (refreshNvcBtn) {
    refreshNvcBtn.addEventListener('click', () => {
      refreshNvcBtn.disabled = true;
      writeOutput('Refreshing NVC bundle...', 'info');

      chrome.runtime.sendMessage({ action: 'refreshNVCBundle' }, (response) => {
        refreshNvcBtn.disabled = false;
        if (chrome.runtime.lastError) {
          writeOutput(`NVC refresh failed: ${chrome.runtime.lastError.message}`, 'error');
          return;
        }

        if (!response || !response.success) {
          writeOutput(`NVC refresh failed: ${response?.error || 'Unknown error'}`, 'error');
          return;
        }

        const count = response.entryCount ?? 'unknown';
        writeOutput(`NVC update successful (${count} entries).`, 'success');
        loadNVCStatus();
      });
    });
  }

  if (saveAnalyticsLabelBtn) {
    saveAnalyticsLabelBtn.addEventListener('click', async () => {
      try {
        const store = await getLocalAnalyticsStore();
        store.deviceLabel = String(analyticsLabelInput?.value || '').trim().slice(0, 80);
        await setLocalAnalyticsStore(store);
        renderAnalyticsSummary(buildAnalyticsSummaryFromStore(store));
        writeOutput('Analytics label saved locally.', 'success');
      } catch (error) {
        writeOutput(error.message || 'Could not save analytics label', 'error');
      }
    });
  }

  if (exportTodayAnalyticsBtn) {
    exportTodayAnalyticsBtn.addEventListener('click', async () => {
      await exportAnalyticsJson('today');
    });
  }

  if (exportPilotAnalyticsBtn) {
    exportPilotAnalyticsBtn.addEventListener('click', async () => {
      await exportAnalyticsJson('pilot');
    });
  }

  if (exportAnalyticsCsvBtn) {
    exportAnalyticsCsvBtn.addEventListener('click', async () => {
      await exportAnalyticsCsv();
    });
  }

  if (resetAnalyticsBtn) {
    resetAnalyticsBtn.addEventListener('click', async () => {
      try {
        const store = createEmptyAnalyticsStore();
        await setLocalAnalyticsStore(store);
        renderAnalyticsSummary(buildAnalyticsSummaryFromStore(store));
        writeOutput('Local analytics reset on this workstation.', 'info');
      } catch (error) {
        writeOutput(error.message || 'Could not reset analytics', 'error');
      }
    });
  }

  if (addCurrentBtn) {
    addCurrentBtn.addEventListener('click', () => {
      addPreviewScanToInventory();
    });
  }

  if (addBatchBtn) {
    addBatchBtn.addEventListener('click', () => {
      addPendingScansToInventory();
    });
  }

  if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', () => {
      const filename = inventoryManager.exportCsv();
      if (!filename) {
        writeOutput('Add at least one scan before exporting CSV.', 'error');
        return;
      }
      logAnalyticsEvent('inventory_export', {
        workflow: 'inventory',
        source: 'popup_button',
        rows: inventoryManager.count,
        count: 1
      });
      writeOutput(`CSV export started for ${inventoryManager.count} scan(s).`, 'success');
    });
  }

  if (clearInventoryBtn) {
    clearInventoryBtn.addEventListener('click', async () => {
      await inventoryManager.clear();
      logAnalyticsEvent('queue_cleared', { workflow: 'inventory', queue: 'inventory', source: 'popup_button' });
      writeOutput('Inventory tray cleared.', 'info');
    });
  }

  loadNVCStatus();
});

function writeOutput(message, type = 'info') {
  showOutput(outputDiv, message, type);
}

async function loadSettingsPanelState() {
  try {
    const stored = await getLocalStorage([SETTINGS_PANEL_OPEN_KEY]);
    applySettingsPanelState(!!stored[SETTINGS_PANEL_OPEN_KEY]);
  } catch (_) {
    applySettingsPanelState(false);
  }
}

async function setSettingsPanelOpen(isOpen) {
  applySettingsPanelState(isOpen);
  try {
    await setLocalStorage({ [SETTINGS_PANEL_OPEN_KEY]: !!isOpen });
  } catch (_) {
    // Keep the UI responsive even if the preference does not persist.
  }
}

function applySettingsPanelState(isOpen) {
  if (settingsPanel) {
    settingsPanel.hidden = !isOpen;
  }
  if (mainWorkflowPanel) {
    mainWorkflowPanel.hidden = isOpen;
  }
  if (settingsToggleBtn) {
    settingsToggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  }
}

function normalizeAdminDateTimeAutofillSetting(stored) {
  return !(stored && stored[ADMIN_DATETIME_AUTOFILL_KEY] === false);
}

function applyAdminDateTimeAutofillSetting(enabled) {
  adminDateTimeAutofillEnabled = !!enabled;
  if (adminDateTimeAutofillToggle) {
    adminDateTimeAutofillToggle.checked = adminDateTimeAutofillEnabled;
  }
}

async function loadAdminDateTimeAutofillSetting() {
  try {
    const stored = await getLocalStorage([ADMIN_DATETIME_AUTOFILL_KEY]);
    applyAdminDateTimeAutofillSetting(normalizeAdminDateTimeAutofillSetting(stored));
  } catch (_) {
    applyAdminDateTimeAutofillSetting(true);
  }
}

async function setAdminDateTimeAutofillSetting(enabled) {
  applyAdminDateTimeAutofillSetting(enabled);
  try {
    await setLocalStorage({ [ADMIN_DATETIME_AUTOFILL_KEY]: adminDateTimeAutofillEnabled });
    writeOutput(
      adminDateTimeAutofillEnabled
        ? 'Date Administered auto-fill is enabled.'
        : 'Date Administered auto-fill is disabled.',
      'info'
    );
  } catch (error) {
    writeOutput(error.message || 'Could not update Date Administered auto-fill setting.', 'error');
  }
}

function logAnalyticsEvent(eventType, payload = {}) {
  void recordLocalAnalyticsEvent(eventType, payload).then(() => loadAnalyticsSummary()).catch(() => undefined);
  chrome.runtime.sendMessage({ action: 'logAnalyticsEvent', eventType, payload }, () => {
    void chrome.runtime.lastError;
  });
}

function sendAnalyticsMessage(action, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
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

async function loadAnalyticsSummary() {
  try {
    const store = await getLocalAnalyticsStore();
    renderAnalyticsSummary(buildAnalyticsSummaryFromStore(store));
  } catch (_) {
    if (analyticsSummaryDiv) {
      analyticsSummaryDiv.textContent = 'Analytics summary unavailable on this machine.';
    }
  }
}

function renderAnalyticsSummary(summary) {
  if (!summary || !analyticsSummaryDiv) return;
  if (analyticsLabelInput) {
    analyticsLabelInput.value = summary.deviceLabel || '';
  }

  const today = summary.today || {};
  const rollup = summary.rollup || {};
  const todayLiveScans =
    (today.workflows?.single?.liveScans || 0) +
    (today.workflows?.multiple?.liveScans || 0) +
    (today.workflows?.inventory?.liveScans || 0);
  const todayPopupParses =
    (today.workflows?.single?.popupParses || 0) +
    (today.workflows?.multiple?.popupParses || 0) +
    (today.workflows?.inventory?.popupParses || 0);
  const todayScans = todayLiveScans + todayPopupParses;
  const todayAutofills = today.autofill?.success || 0;
  const todayMultipleSaved = today.queues?.multipleSaved || 0;
  const todayInventoryExports = today.exports?.inventoryCount || 0;
  const todayExpiryWarnings = (today.expiry?.expired || 0) + (today.expiry?.expiringSoon || 0);

  const pilotLiveScans =
    (rollup.workflows?.single?.liveScans || 0) +
    (rollup.workflows?.multiple?.liveScans || 0) +
    (rollup.workflows?.inventory?.liveScans || 0);
  const pilotPopupParses =
    (rollup.workflows?.single?.popupParses || 0) +
    (rollup.workflows?.multiple?.popupParses || 0) +
    (rollup.workflows?.inventory?.popupParses || 0);
  const pilotScans = pilotLiveScans + pilotPopupParses;
  const pilotAutofills = rollup.autofill?.success || 0;
  const pilotQueueUses = rollup.queues?.multipleUsed || 0;
  const pilotExports = rollup.exports?.inventoryCount || 0;

  const deviceName = summary.deviceLabel || summary.deviceId || 'Unlabeled workstation';
  analyticsSummaryDiv.innerHTML = `
    <div class="analytics-hero">
      <div class="analytics-hero-label">Captured Scans Today</div>
      <div class="analytics-hero-value">${formatAnalyticsNumber(todayScans)}</div>
      <div class="analytics-hero-subtitle">${formatAnalyticsNumber(todayLiveScans)} live scan(s) and ${formatAnalyticsNumber(todayPopupParses)} popup scan(s) recorded on this workstation today.</div>
    </div>
    <div class="analytics-grid">
      <section class="analytics-card">
        <div class="analytics-card-header">
          <div class="analytics-card-title">Today</div>
          <div class="analytics-chip">${escapeAnalyticsHtml(summary.todayKey || 'Today')}</div>
        </div>
        <div class="analytics-metrics">
          ${renderAnalyticsMetric('Chart autofills', todayAutofills)}
          ${renderAnalyticsMetric('Multiple saves', todayMultipleSaved)}
          ${renderAnalyticsMetric('Inventory exports', todayInventoryExports)}
          ${renderAnalyticsMetric('Expiry warnings', todayExpiryWarnings)}
        </div>
      </section>
      <section class="analytics-card">
        <div class="analytics-card-header">
          <div class="analytics-card-title">Pilot Total</div>
          <div class="analytics-chip">${formatAnalyticsNumber(summary.daysTracked || 0)} day(s)</div>
        </div>
        <div class="analytics-metrics">
          ${renderAnalyticsMetric('Captured scans', pilotScans)}
          ${renderAnalyticsMetric('Chart autofills', pilotAutofills)}
          ${renderAnalyticsMetric('Queue to chart', pilotQueueUses)}
          ${renderAnalyticsMetric('Inventory exports', pilotExports)}
        </div>
      </section>
      <section class="analytics-card device">
        <div class="analytics-card-header">
          <div class="analytics-card-title">Device</div>
          <div class="analytics-chip">Local only</div>
        </div>
        <div class="analytics-device-name">${escapeAnalyticsHtml(deviceName)}</div>
        <div class="analytics-device-meta">
          <span class="analytics-device-pill">${formatAnalyticsNumber(todayScans)} scan(s) today</span>
          <span class="analytics-device-pill">${formatAnalyticsNumber(summary.daysTracked || 0)} tracked day(s)</span>
        </div>
      </section>
    </div>
  `;
}

function renderAnalyticsMetric(label, value) {
  return `
    <div class="analytics-metric">
      <div class="analytics-metric-label">${escapeAnalyticsHtml(label)}</div>
      <div class="analytics-metric-value">${formatAnalyticsNumber(value)}</div>
    </div>
  `;
}

function formatAnalyticsNumber(value) {
  const num = Number(value) || 0;
  return num.toLocaleString();
}

function escapeAnalyticsHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function downloadTextFile(filename, text, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportAnalyticsJson(scope) {
  try {
    const store = await getLocalAnalyticsStore();
    const normalizedScope = scope === 'today' ? 'today' : 'pilot';
    store.lastExportAt = new Date().toISOString();
    await setLocalAnalyticsStore(store);
    const data = buildAnalyticsExportFromStore(store, normalizedScope);
    const filename = `vaxlink-analytics-${normalizedScope}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    downloadTextFile(filename, JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
    await loadAnalyticsSummary();
    writeOutput(`Analytics export ready: ${filename}`, 'success');
  } catch (error) {
    writeOutput(error.message || 'Could not export analytics', 'error');
  }
}

async function exportAnalyticsCsv() {
  try {
    const store = await getLocalAnalyticsStore();
    store.lastExportAt = new Date().toISOString();
    await setLocalAnalyticsStore(store);
    const csv = buildAnalyticsCsv(buildAnalyticsExportFromStore(store, 'pilot'));
    const filename = `vaxlink-analytics-daily-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    downloadTextFile(filename, csv, 'text/csv;charset=utf-8');
    await loadAnalyticsSummary();
    writeOutput(`Analytics CSV export ready: ${filename}`, 'success');
  } catch (error) {
    writeOutput(error.message || 'Could not export analytics CSV', 'error');
  }
}

function buildAnalyticsCsv(data) {
  const headers = [
    'day',
    'popup_opens',
    'single_live_scans',
    'single_popup_parses',
    'multiple_live_scans',
    'multiple_popup_parses',
    'inventory_live_scans',
    'inventory_popup_parses',
    'total_captured_scans',
    'parse_success',
    'parse_error',
    'lookup_success',
    'lookup_error',
    'autofill_success',
    'autofill_failure',
    'multiple_saved',
    'multiple_used',
    'inventory_saved',
    'inventory_exports',
    'inventory_export_rows',
    'expired_seen',
    'expiring_soon_seen'
  ];
  const rows = [headers.join(',')];
  const days = data && data.days ? Object.entries(data.days).sort((a, b) => a[0].localeCompare(b[0])) : [];

  days.forEach(([dayKey, day]) => {
    const totalCapturedScans =
      (day.workflows?.single?.liveScans || 0) +
      (day.workflows?.single?.popupParses || 0) +
      (day.workflows?.multiple?.liveScans || 0) +
      (day.workflows?.multiple?.popupParses || 0) +
      (day.workflows?.inventory?.liveScans || 0) +
      (day.workflows?.inventory?.popupParses || 0);
    rows.push([
      csvEscape(dayKey),
      csvEscape(day.popupOpens || 0),
      csvEscape(day.workflows?.single?.liveScans || 0),
      csvEscape(day.workflows?.single?.popupParses || 0),
      csvEscape(day.workflows?.multiple?.liveScans || 0),
      csvEscape(day.workflows?.multiple?.popupParses || 0),
      csvEscape(day.workflows?.inventory?.liveScans || 0),
      csvEscape(day.workflows?.inventory?.popupParses || 0),
      csvEscape(totalCapturedScans),
      csvEscape(day.parsing?.success || 0),
      csvEscape(day.parsing?.error || 0),
      csvEscape(day.lookup?.success || 0),
      csvEscape(day.lookup?.error || 0),
      csvEscape(day.autofill?.success || 0),
      csvEscape(day.autofill?.failure || 0),
      csvEscape(day.queues?.multipleSaved || 0),
      csvEscape(day.queues?.multipleUsed || 0),
      csvEscape(day.queues?.inventorySaved || 0),
      csvEscape(day.exports?.inventoryCount || 0),
      csvEscape(day.exports?.inventoryRows || 0),
      csvEscape(day.expiry?.expired || 0),
      csvEscape(day.expiry?.expiringSoon || 0)
    ].join(','));
  });

  return rows.join('\r\n');
}

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

async function getLocalAnalyticsStore() {
  const stored = await getLocalStorage([ANALYTICS_STORAGE_KEY]);
  return normalizeAnalyticsStore(stored[ANALYTICS_STORAGE_KEY]);
}

async function setLocalAnalyticsStore(store) {
  await setLocalStorage({ [ANALYTICS_STORAGE_KEY]: normalizeAnalyticsStore(store) });
}

function createEmptyAnalyticsStore() {
  return {
    version: 1,
    deviceId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    deviceLabel: '',
    firstSeenAt: new Date().toISOString(),
    lastEventAt: null,
    lastExportAt: null,
    days: {},
    recentEvents: []
  };
}

function createEmptyAnalyticsDay(dayKey) {
  return {
    day: dayKey,
    eventCount: 0,
    popupOpens: 0,
    modeSwitches: { single: 0, multiple: 0, inventory: 0 },
    workflows: {
      single: { liveScans: 0, popupParses: 0, queueSaved: 0, queueUsed: 0, autofillSuccess: 0, autofillFailure: 0 },
      multiple: { liveScans: 0, popupParses: 0, queueSaved: 0, queueUsed: 0, autofillSuccess: 0, autofillFailure: 0 },
      inventory: { liveScans: 0, popupParses: 0, queueSaved: 0, queueUsed: 0, autofillSuccess: 0, autofillFailure: 0 }
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

function normalizeAnalyticsStore(store) {
  const normalized = store && typeof store === 'object' ? store : createEmptyAnalyticsStore();
  if (!normalized.deviceId) {
    normalized.deviceId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  if (!normalized.firstSeenAt) {
    normalized.firstSeenAt = new Date().toISOString();
  }
  if (!normalized.days || typeof normalized.days !== 'object') {
    normalized.days = {};
  }
  if (!Array.isArray(normalized.recentEvents)) {
    normalized.recentEvents = [];
  }
  if (typeof normalized.deviceLabel !== 'string') {
    normalized.deviceLabel = '';
  }
  return normalized;
}

function normalizeAnalyticsWorkflow(value) {
  return value === 'multiple' || value === 'inventory' ? value : 'single';
}

function normalizeAnalyticsQueue(value) {
  return value === 'inventory' ? 'inventory' : 'multiple';
}

function normalizeExpiryFlag(value) {
  if (value === 'expired') return 'expired';
  if (value === 'expiring_soon') return 'expiringSoon';
  if (value === 'valid') return 'valid';
  return 'unknown';
}

function safeAnalyticsCount(value, fallback = 1) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function incrementCounterMap(map, key, amount = 1) {
  if (!map || !key) return;
  map[key] = (map[key] || 0) + amount;
}

function ensureAnalyticsDay(store, dayKey) {
  if (!store.days[dayKey]) {
    store.days[dayKey] = createEmptyAnalyticsDay(dayKey);
  }
  return store.days[dayKey];
}

function buildLocalAnalyticsEvent(eventType, payload = {}) {
  const ts = new Date().toISOString();
  return {
    eventType,
    ts,
    day: ts.slice(0, 10),
    workflow: normalizeAnalyticsWorkflow(payload.workflow),
    queue: payload.queue ? normalizeAnalyticsQueue(payload.queue) : '',
    source: String(payload.source || '').trim().slice(0, 40),
    success: !!payload.success,
    count: safeAnalyticsCount(payload.count, 1),
    rows: safeAnalyticsCount(payload.rows, 0),
    queueSizeAfter: safeAnalyticsCount(payload.queueSizeAfter, 0),
    expiryFlag: payload.expiryFlag || '',
    vaccineLabel: String(payload.vaccineLabel || '').trim().slice(0, 60),
    manufacturer: String(payload.manufacturer || '').trim().slice(0, 60)
  };
}

function applyLocalAnalyticsEvent(day, event) {
  const workflow = event.workflow;
  const count = event.count;
  day.eventCount += 1;

  incrementCounterMap(day.sources, event.source, count);
  incrementCounterMap(day.vaccines, event.vaccineLabel, count);
  incrementCounterMap(day.manufacturers, event.manufacturer, count);
  if (event.expiryFlag) {
    day.expiry[normalizeExpiryFlag(event.expiryFlag)] += count;
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
      day.workflows[workflow].popupParses += count;
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
    case 'queue_saved':
      if (event.queue === 'inventory') {
        day.queues.inventorySaved += count;
        day.queues.maxInventoryDepth = Math.max(day.queues.maxInventoryDepth, event.queueSizeAfter || 0);
        day.workflows.inventory.queueSaved += count;
      } else {
        day.queues.multipleSaved += count;
        day.queues.maxMultipleDepth = Math.max(day.queues.maxMultipleDepth, event.queueSizeAfter || 0);
        day.workflows.multiple.queueSaved += count;
      }
      break;
    case 'queue_used':
      day.queues.multipleUsed += count;
      day.workflows.multiple.queueUsed += count;
      break;
    case 'queue_cleared':
      if (event.queue === 'inventory') {
        day.queues.inventoryCleared += count;
      } else {
        day.queues.multipleCleared += count;
      }
      break;
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
      day.exports.inventoryRows += event.rows || 0;
      break;
    default:
      break;
  }
}

async function recordLocalAnalyticsEvent(eventType, payload = {}) {
  const store = await getLocalAnalyticsStore();
  const event = buildLocalAnalyticsEvent(eventType, payload);
  const day = ensureAnalyticsDay(store, event.day);
  applyLocalAnalyticsEvent(day, event);
  store.lastEventAt = event.ts;
  await setLocalAnalyticsStore(store);
}

function buildAnalyticsSummaryFromStore(store) {
  const normalized = normalizeAnalyticsStore(store);
  const todayKey = new Date().toISOString().slice(0, 10);
  const today = normalized.days[todayKey] || {};
  const rollup = aggregateAnalyticsDaysLocal(Object.values(normalized.days));
  return {
    deviceId: normalized.deviceId,
    deviceLabel: normalized.deviceLabel || '',
    firstSeenAt: normalized.firstSeenAt || null,
    lastEventAt: normalized.lastEventAt || null,
    lastExportAt: normalized.lastExportAt || null,
    daysTracked: Object.keys(normalized.days).length,
    todayKey,
    today,
    rollup
  };
}

function buildAnalyticsExportFromStore(store, scope) {
  const normalized = normalizeAnalyticsStore(store);
  const todayKey = new Date().toISOString().slice(0, 10);
  const selectedKeys = Object.keys(normalized.days)
    .sort()
    .filter((key) => scope === 'today' ? key === todayKey : true);
  const days = Object.fromEntries(selectedKeys.map((key) => [key, normalized.days[key]]));
  return {
    exportedAt: new Date().toISOString(),
    scope,
    deviceId: normalized.deviceId,
    deviceLabel: normalized.deviceLabel || '',
    firstSeenAt: normalized.firstSeenAt || null,
    lastEventAt: normalized.lastEventAt || null,
    daysTracked: selectedKeys.length,
    days,
    rollup: aggregateAnalyticsDaysLocal(selectedKeys.map((key) => normalized.days[key]))
  };
}

function aggregateAnalyticsDaysLocal(days) {
  const rollup = {
    workflows: {
      single: { liveScans: 0, popupParses: 0 },
      multiple: { liveScans: 0, popupParses: 0 },
      inventory: { liveScans: 0, popupParses: 0 }
    },
    autofill: { success: 0, failure: 0 },
    queues: { multipleSaved: 0, multipleUsed: 0, inventorySaved: 0 },
    exports: { inventoryCount: 0, inventoryRows: 0 },
    expiry: { expired: 0, expiringSoon: 0 }
  };

  (days || []).forEach((day) => {
    if (!day || typeof day !== 'object') return;
    rollup.workflows.single.liveScans += day.workflows?.single?.liveScans || 0;
    rollup.workflows.single.popupParses += day.workflows?.single?.popupParses || 0;
    rollup.workflows.multiple.liveScans += day.workflows?.multiple?.liveScans || 0;
    rollup.workflows.multiple.popupParses += day.workflows?.multiple?.popupParses || 0;
    rollup.workflows.inventory.liveScans += day.workflows?.inventory?.liveScans || 0;
    rollup.workflows.inventory.popupParses += day.workflows?.inventory?.popupParses || 0;
    rollup.autofill.success += day.autofill?.success || 0;
    rollup.autofill.failure += day.autofill?.failure || 0;
    rollup.queues.multipleSaved += day.queues?.multipleSaved || 0;
    rollup.queues.multipleUsed += day.queues?.multipleUsed || 0;
    rollup.queues.inventorySaved += day.queues?.inventorySaved || 0;
    rollup.exports.inventoryCount += day.exports?.inventoryCount || 0;
    rollup.exports.inventoryRows += day.exports?.inventoryRows || 0;
    rollup.expiry.expired += day.expiry?.expired || 0;
    rollup.expiry.expiringSoon += day.expiry?.expiringSoon || 0;
  });

  return rollup;
}

function usesScannerInput(mode) {
  return !!MODE_CONFIG[mode]?.usesScannerInput;
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

function buildAutofillPayloadFromQueueRecord(record) {
  if (!record) return null;
  return {
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
}

function toIsoTimestamp(value) {
  if (!value) return '';
  const parsed = new Date(String(value).trim());
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString();
}

function buildAutoFillPayload(data, fallbackTimestamp = '') {
  const payload = { ...(data || {}) };
  if (adminDateTimeAutofillEnabled) {
    const administeredAt =
      toIsoTimestamp(payload.administered_at) ||
      toIsoTimestamp(payload.scanned_at) ||
      toIsoTimestamp(fallbackTimestamp) ||
      new Date().toISOString();
    payload.administered_at = administeredAt;
  } else {
    delete payload.administered_at;
  }
  return payload;
}

async function loadWorkflowMode() {
  try {
    const stored = await getLocalStorage([
      WORKFLOW_MODE_KEY,
      LEGACY_POPUP_MODE_KEY,
      LEGACY_REMOTE_MODE_KEY,
      LEGACY_HANDS_FREE_KEY
    ]);
    await setActiveMode(normalizeWorkflowMode(stored), { persist: false, track: false });
  } catch (_) {
    await setActiveMode('single', { persist: false, track: false });
  }
}

async function setActiveMode(mode, options = {}) {
  const previousMode = activeMode;
  activeMode = mode === 'multiple' || mode === 'inventory' ? mode : 'single';
  const config = MODE_CONFIG[activeMode];

  toggleModeButton(singleModeBtn, activeMode === 'single');
  toggleModeButton(multipleModeBtn, activeMode === 'multiple');
  toggleModeButton(inventoryModeBtn, activeMode === 'inventory');

  if (singleModeSection) {
    singleModeSection.hidden = activeMode !== 'single';
  }
  if (multipleModeSection) {
    multipleModeSection.hidden = activeMode !== 'multiple';
  }
  if (inventoryModeSection) {
    inventoryModeSection.hidden = activeMode !== 'inventory';
  }
  if (scannerInputSection) {
    scannerInputSection.hidden = !config.usesScannerInput;
  }
  if (scannedInputLabel && config.inputLabel) {
    scannedInputLabel.textContent = config.inputLabel;
  }
  if (scannedInput && config.inputPlaceholder) {
    scannedInput.placeholder = config.inputPlaceholder;
  }
  if (modeHelper) {
    modeHelper.textContent = config.helper;
  }
  if (scanStateTitle) {
    scanStateTitle.textContent = config.title;
  }
  if (scanStateSubtitle) {
    scanStateSubtitle.textContent = config.subtitle;
  }

  if (options.persist !== false) {
    await setLocalStorage({ [WORKFLOW_MODE_KEY]: activeMode });
  }
  if (options.track !== false && previousMode !== activeMode) {
    logAnalyticsEvent('workflow_mode_set', { workflow: activeMode, source: 'popup_tab' });
  }
}

function toggleModeButton(button, isActive) {
  if (!button) return;
  button.classList.toggle('active', isActive);
  button.setAttribute('aria-selected', isActive ? 'true' : 'false');
}

function queueAutoParse(immediate = false) {
  if (autoParseTimer) {
    clearTimeout(autoParseTimer);
    autoParseTimer = null;
  }

  const run = async () => {
    const barcode = getPreviewBarcodeValue();
    if (!barcode) {
      return;
    }

    const parseRequestId = ++activeParseRequestId;
    setButtonBusy(autoFillBtn, true);
    try {
      parsedData = parseInputData(barcode);
      if (!parsedData.scanned_at) {
        parsedData.scanned_at = new Date().toISOString();
      }
      logAnalyticsEvent('parse_success', {
        workflow: activeMode,
        source: 'popup_input',
        vaccineLabel: parsedData.lot || parsedData.gtin || '',
        expiryFlag: getExpiryStatus(parsedData.expiry).flag
      });
      await displayParsedData(parsedData, parseRequestId);
    } catch (error) {
      parsedData = null;
      logAnalyticsEvent('parse_error', { workflow: activeMode, source: 'popup_input' });
      writeOutput(`Error parsing barcode: ${error.message}`, 'error');
    } finally {
      if (parseRequestId === activeParseRequestId) {
        setButtonBusy(autoFillBtn, false);
      }
    }
  };

  if (immediate) {
    run();
    return;
  }

  autoParseTimer = setTimeout(run, 220);
}

function getPendingScanLines() {
  if (!scannedInput || !scannedInput.value) return [];
  return String(scannedInput.value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getPreviewBarcodeValue() {
  const lines = getPendingScanLines();
  return lines.length ? lines[lines.length - 1] : '';
}

function setPendingScanLines(lines) {
  if (!scannedInput) return;
  scannedInput.value = (lines || []).join('\n');
}

function removeLastPendingScanLine() {
  if (!scannedInput || !scannedInput.value) return;
  const lines = String(scannedInput.value).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (String(lines[i]).trim()) {
      lines.splice(i, 1);
      break;
    }
  }
  setPendingScanLines(lines.map((line) => String(line).trim()).filter(Boolean));
}

function loadNVCStatus() {
  chrome.runtime.sendMessage({ action: 'getNVCUpdateStatus' }, (status) => {
    if (chrome.runtime.lastError || !status) {
      return;
    }
    renderNVCStatus(status, nvcStatusDiv);
  });
}

async function sendAutoFillToActiveTab(data, options = {}) {
  const payload = buildAutoFillPayload(data, options.fallbackTimestamp || '');
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!tabs.length || !tabs[0]?.id) {
        reject(new Error('No active tab found'));
        return;
      }

      sendAutoFillMessage(tabs[0].id, payload, (response) => {
        if (response && response.success) {
          resolve(response);
          return;
        }
        reject(new Error(response?.error || 'Could not auto-fill fields'));
      });
    });
  });
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

function buildLotLookupCacheKey(lot, gtin) {
  const lotKey = String(lot || '').trim().toLowerCase();
  const gtinKey = String(gtin || '').replace(/\D/g, '');
  return `${lotKey}|${gtinKey}`;
}

async function lookupVaccineInfo(lot, gtin) {
  const lotKey = String(lot || '').trim().toLowerCase();
  if (!lotKey) {
    return { error: 'No lot number provided' };
  }
  const cacheKey = buildLotLookupCacheKey(lot, gtin);
  if (lotLookupCache.has(cacheKey)) {
    return lotLookupCache.get(cacheKey);
  }
  const message = { action: 'lookupVaccineInfo', lot };
  if (gtin) {
    message.gtin = gtin;
  }
  const response = await sendRuntimeMessage(message);
  if (lotLookupCache.size >= LOT_LOOKUP_CACHE_MAX) {
    const oldest = lotLookupCache.keys().next().value;
    if (oldest !== undefined) lotLookupCache.delete(oldest);
  }
  lotLookupCache.set(cacheKey, response);
  return response;
}

async function addPreviewScanToInventory() {
  const rawBarcode = getPreviewBarcodeValue();
  if (!rawBarcode) {
    writeOutput('Scan a barcode first, then add it to inventory.', 'error');
    return;
  }

  const requestId = ++activeParseRequestId;
  setButtonBusy(addCurrentBtn, true, 'Adding...');
  try {
    const baseData = parseInputData(rawBarcode);
    const enriched = await enrichParsedData(baseData);
    if (requestId !== activeParseRequestId) {
      return;
    }

    parsedData = enriched;
    await inventoryManager.add(buildQueueRecord(enriched, rawBarcode));
    logAnalyticsEvent('queue_saved', {
      workflow: 'inventory',
      queue: 'inventory',
      source: 'popup_manual_current',
      count: 1,
      queueSizeAfter: inventoryManager.count,
      vaccineLabel: enriched.tradename || enriched.generic_name || enriched.name || enriched.lot || '',
      manufacturer: enriched.manufacturer || '',
      expiryFlag: enriched.expiry_flag || getExpiryStatus(enriched.inventory_expiry).flag
    });
    removeLastPendingScanLine();
    queueAutoParse(true);
    writeOutput(buildParsedOutputMarkup(enriched), outputTypeForExpiry(getExpiryStatus(enriched.inventory_expiry)));
  } catch (error) {
    writeOutput(`Could not add scan: ${error.message}`, 'error');
  } finally {
    if (requestId === activeParseRequestId) {
      setButtonBusy(addCurrentBtn, false);
    }
  }
}

async function addPendingScansToInventory() {
  const lines = getPendingScanLines();
  if (!lines.length) {
    writeOutput('Paste or scan one barcode per line before running batch add.', 'error');
    return;
  }

  const requestId = ++activeParseRequestId;
  setButtonBusy(addBatchBtn, true, 'Adding...');
  const records = [];
  let addedCount = 0;
  let lastRecord = null;
  const errors = [];

  try {
    for (let index = 0; index < lines.length; index += 1) {
      const rawBarcode = lines[index];
      try {
        const baseData = parseInputData(rawBarcode);
        const enriched = await enrichParsedData(baseData);
        records.push(buildQueueRecord(enriched, rawBarcode));
        lastRecord = enriched;
        addedCount += 1;
      } catch (error) {
        errors.push(`Line ${index + 1}: ${error.message}`);
      }
    }

    if (requestId !== activeParseRequestId) {
      return;
    }

    if (records.length) {
      await inventoryManager.addMany(records);
      logAnalyticsEvent('queue_saved', {
        workflow: 'inventory',
        queue: 'inventory',
        source: 'popup_manual_batch',
        count: addedCount,
        queueSizeAfter: inventoryManager.count,
        vaccineLabel: lastRecord?.tradename || lastRecord?.generic_name || lastRecord?.name || lastRecord?.lot || '',
        manufacturer: lastRecord?.manufacturer || '',
        expiryFlag: lastRecord?.expiry_flag || getExpiryStatus(lastRecord?.inventory_expiry).flag
      });
    }
    setPendingScanLines([]);
    parsedData = lastRecord;

    if (errors.length) {
      logAnalyticsEvent('parse_error', {
        workflow: 'inventory',
        source: 'popup_batch',
        count: errors.length
      });
    }

    if (addedCount) {
      const message = errors.length
        ? `Added ${addedCount} scan(s). ${errors.length} line(s) failed.`
        : `Added ${addedCount} scan(s) to inventory.`;
      writeOutput(message, errors.length ? 'warning' : 'success');
    } else {
      writeOutput(errors.join('<br>') || 'No scans were added.', 'error');
    }
  } finally {
    if (requestId === activeParseRequestId) {
      setButtonBusy(addBatchBtn, false);
    }
  }
}

async function handleUseMultipleInjectRecord(record) {
  const data = buildAutofillPayloadFromQueueRecord(record);
  if (!data) {
    writeOutput('Saved vaccine could not be loaded.', 'error');
    return;
  }

  parsedData = data;
  logAnalyticsEvent('queue_used', {
    workflow: 'multiple',
    queue: 'multiple',
    source: 'queue',
    count: 1,
    queueSizeAfter: multipleInjectManager.count,
    vaccineLabel: record.tradename || record.generic_name || record.name || record.lot || '',
    manufacturer: record.manufacturer || '',
    expiryFlag: record.expiry_flag || getExpiryStatus(record.inventory_expiry || record.barcode_expiry).flag
  });
  writeOutput(
    buildParsedOutputMarkup(data),
    outputTypeForExpiry(getExpiryStatus(data.inventory_expiry || data.expiry))
  );

  try {
    logAnalyticsEvent('autofill_attempt', {
      workflow: 'multiple',
      source: 'queue',
      vaccineLabel: record.tradename || record.generic_name || record.name || record.lot || '',
      manufacturer: record.manufacturer || '',
      expiryFlag: record.expiry_flag || getExpiryStatus(record.inventory_expiry || record.barcode_expiry).flag
    });
    await sendAutoFillToActiveTab(data);
    multipleInjectManager.setActiveUse(record.id);
    logAnalyticsEvent('autofill_result', {
      workflow: 'multiple',
      source: 'queue',
      success: true,
      vaccineLabel: record.tradename || record.generic_name || record.name || record.lot || '',
      manufacturer: record.manufacturer || '',
      expiryFlag: record.expiry_flag || getExpiryStatus(record.inventory_expiry || record.barcode_expiry).flag
    });
    const label = record.tradename || record.generic_name || record.name || record.lot || 'Saved vaccine';
    writeOutput(`${label} auto-filled from Multiple Inject queue.`, 'success');
  } catch (error) {
    logAnalyticsEvent('autofill_result', {
      workflow: 'multiple',
      source: 'queue',
      success: false,
      vaccineLabel: record.tradename || record.generic_name || record.name || record.lot || '',
      manufacturer: record.manufacturer || ''
    });
    writeOutput(error.message || 'Could not auto-fill fields', 'error');
  }
}

function mergeVaccineInfoIntoParsedData(baseData, vaccineInfo, expiryStatus, expirySource) {
  const merged = { ...baseData };
  if (vaccineInfo && !vaccineInfo.error) {
    merged.tradename = vaccineInfo.tradename || merged.tradename || null;
    merged.generic_name = vaccineInfo.generic_name || merged.generic_name || null;
    merged.disease = vaccineInfo.disease || merged.disease || null;
    merged.antigen = vaccineInfo.antigen || merged.antigen || null;
    merged.manufacturer = vaccineInfo.manufacturer || merged.manufacturer || null;
    merged.nvc_lot_expiry = vaccineInfo.lot_expiry || merged.nvc_lot_expiry || null;
    merged.din = vaccineInfo.din || merged.din || null;
    merged.route = vaccineInfo.route || merged.route || null;
    merged.strength = vaccineInfo.strength || merged.strength || null;
    merged.dose_value = vaccineInfo.dose_value || merged.dose_value || null;
    merged.dose_unit = vaccineInfo.dose_unit || merged.dose_unit || null;
    merged.drug_code = vaccineInfo.din || merged.drug_code || null;
    merged.name = merged.name || vaccineInfo.generic_name || vaccineInfo.tradename || vaccineInfo.din || null;
  }
  merged.inventory_expiry = merged.expiry || vaccineInfo?.lot_expiry || null;
  merged.expiry_flag = expiryStatus.flag;
  merged.expiry_days_remaining = expiryStatus.daysRemaining;
  merged.expiry_source = expirySource;
  merged.lookup_error = vaccineInfo?.error || '';
  return merged;
}

async function enrichParsedData(baseData) {
  let vaccineInfo = null;
  let lookupAttempted = false;

  if (baseData.lot) {
    try {
      lookupAttempted = true;
      vaccineInfo = await lookupVaccineInfo(baseData.lot, baseData.gtin);
    } catch (error) {
      vaccineInfo = { error: error.message || 'Lookup failed' };
    }
  }

  const chosenExpiry = baseData.expiry || vaccineInfo?.lot_expiry || null;
  const expiryStatus = getExpiryStatus(chosenExpiry);
  const expirySource = baseData.expiry ? 'barcode' : (vaccineInfo?.lot_expiry ? 'nvc' : 'none');
  if (lookupAttempted) {
    logAnalyticsEvent(vaccineInfo && !vaccineInfo.error ? 'lookup_success' : 'lookup_error', {
      workflow: activeMode,
      source: 'popup_lookup',
      vaccineLabel: vaccineInfo?.tradename || vaccineInfo?.generic_name || baseData.lot || baseData.gtin || '',
      manufacturer: vaccineInfo?.manufacturer || '',
      expiryFlag: expiryStatus.flag
    });
  }
  return mergeVaccineInfoIntoParsedData(baseData, vaccineInfo, expiryStatus, expirySource);
}

async function displayParsedData(data, parseRequestId) {
  const previewExpiryStatus = getExpiryStatus(data.expiry);
  writeOutput(
    buildParsedOutputMarkup(data, { loading: !!data.lot }),
    outputTypeForExpiry(previewExpiryStatus)
  );

  try {
    const enriched = await enrichParsedData(data);
    if (parseRequestId !== activeParseRequestId) {
      return;
    }
    parsedData = enriched;
    writeOutput(
      buildParsedOutputMarkup(enriched),
      outputTypeForExpiry(getExpiryStatus(enriched.inventory_expiry))
    );
  } catch (error) {
    if (parseRequestId !== activeParseRequestId) {
      return;
    }
    writeOutput(
      buildParsedOutputMarkup({
        ...data,
        lookup_error: error.message || 'Lookup failed',
        inventory_expiry: data.expiry || null,
        expiry_source: data.expiry ? 'barcode' : 'none'
      }),
      'warning'
    );
  }
}

function sendAutoFillMessage(tabId, data, callback = handleAutoFillResponse) {
  // Target the main frame (frameId 0) to avoid iframe content scripts
  // responding first with { success: false } and masking the real result.
  chrome.tabs.sendMessage(tabId, { action: 'autoFill', data }, { frameId: 0 }, (response) => {
    if (chrome.runtime.lastError) {
      const message = chrome.runtime.lastError.message || '';

      if (message.includes('Receiving end does not exist')) {
        chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['panorama-agent-rules.js', 'content.js'] }, () => {
          if (chrome.runtime.lastError) {
            callback({ success: false, error: `Message failed and script injection failed: ${chrome.runtime.lastError.message}` });
            return;
          }
          chrome.tabs.sendMessage(tabId, { action: 'autoFill', data }, { frameId: 0 }, callback);
        });
        return;
      }

      callback({ success: false, error: `Message send failed: ${message}` });
      return;
    }

    callback(response);
  });
}

function handleAutoFillResponse(response) {
  if (chrome.runtime.lastError) {
    writeOutput(`Auto-fill failed: ${chrome.runtime.lastError.message}`, 'error');
    return;
  }

  if (response && response.success) {
    writeOutput('Chart auto-filled', 'success');
  } else if (response && response.error) {
    writeOutput(response.error, 'error');
  } else {
    writeOutput('Could not auto-fill fields', 'error');
  }
}
