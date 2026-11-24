import './shared/vaccine-label.js';
import { initializeScannerSettings } from './scanner-settings.js';
import {
  ScanQueueManager,
  buildInventorySummary,
  buildMultipleInjectSummary,
  buildQueueRecord,
  INVENTORY_BATCH_KEY,
  MULTIPLE_INJECT_QUEUE_KEY
} from './popup-inventory.js';
import {
  getExpiryStatus,
  outputTypeForExpiry,
  parseInputData
} from './popup-parser.js';
import {
  buildParsedOutputMarkup,
  escapeHtml,
  renderNVCStatus,
  formatNVCRefreshMessage,
  setButtonBusy,
  showOutput
} from './popup-ui.js';
import {
  SCANNER_DAEMON_ACTIONS,
  buildScannerStatusDescriptor,
  normalizeScannerStatusSnapshot
} from './scanner/scanner-daemon-shared.js';

let autoFillBtn;
let refreshNvcBtn;
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
let analyticsSummaryDiv;
let settingsToggleBtn;
let settingsPanel;
let analyticsToggleBtn;
let analyticsPanel;
let mainWorkflowPanel;
let exportAllAnalyticsBtn;
let resetAnalyticsBtn;
let adminDateAutofillToggle;
let adminTimeAutofillToggle;
let scannerSetupPrompt;
let scannerConnectionNote;
let continueWithoutScanner = false;
let reasonAutofillToggle;
let consentAutofillToggle;
let addQueueBtn;
let queueBarcodeInput;
let queueEntryPanel;
let queueEntryToggleBtn;
let cancelQueueEntryBtn;
let multipleQueueCount;
let inventoryBarcodeInput;
let inventoryEntryPanel;
let inventoryEntryToggleBtn;
let cancelInventoryEntryBtn;
let inventoryQueueCount;
let parsedData = null;
let activeParseRequestId = 0;
let inventoryAddInFlight = false;
let multipleAddInFlight = false;
let queueSaveNoticeVersion = 0;
let autoParseTimer = null;
let multipleInjectManager;
let inventoryManager;
let activeMode = 'single';
let scannerStatusSnapshot = normalizeScannerStatusSnapshot(null);
let scannerCaptureError = false;

const WORKFLOW_MODE_KEY = 'vaxlink_workflow_mode_v1';
const LEGACY_POPUP_MODE_KEY = 'vaxlink_popup_mode_v1';
const LEGACY_REMOTE_MODE_KEY = 'hands_free_scan_mode_v1';
const LEGACY_HANDS_FREE_KEY = 'hands_free_scan_autofill_enabled';
const SETTINGS_PANEL_OPEN_KEY = 'vaxlink_settings_panel_open_v1';
const LEGACY_ADMIN_DATETIME_AUTOFILL_KEY =
  'vaxlink_administered_datetime_autofill_v1';
const ADMIN_DATE_AUTOFILL_KEY = 'vaxlink_administered_date_autofill_v1';
const ADMIN_TIME_AUTOFILL_KEY = 'vaxlink_administered_time_autofill_v1';
const LEGACY_REASON_CONSENT_AUTOFILL_KEY = 'vaxlink_reason_consent_autofill_v1';
const REASON_AUTOFILL_KEY = 'vaxlink_reason_autofill_v1';
const CONSENT_AUTOFILL_KEY = 'vaxlink_consent_autofill_v1';
const AUTO_RESOLVE_FUNDING_KEY = 'vaxlink_auto_resolve_funding_v1';

const MODE_CONFIG = {
  single: {
    inputLabel: 'Scanned Barcode',
    inputPlaceholder: 'Paste barcode text here...',
    usesScannerInput: true
  },
  multiple: {
    usesScannerInput: false
  },
  inventory: {
    usesScannerInput: false
  }
};

document.addEventListener('DOMContentLoaded', async () => {
  const version = document.getElementById('extensionVersion');
  const manifest = chrome.runtime.getManifest();
  const name = document.getElementById('extensionName');
  if (name) name.textContent = manifest.name;
  if (version)
    version.textContent = `v${manifest.version_name || manifest.version}`;

  autoFillBtn = document.getElementById('autoFillBtn');
  refreshNvcBtn = document.getElementById('refreshNvcBtn');
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
  analyticsSummaryDiv = document.getElementById('analyticsSummary');
  settingsToggleBtn = document.getElementById('settingsToggleBtn');
  settingsPanel = document.getElementById('settingsPanel');
  analyticsToggleBtn = document.getElementById('analyticsToggleBtn');
  analyticsPanel = document.getElementById('analyticsPanel');
  mainWorkflowPanel = document.getElementById('mainWorkflowPanel');
  exportAllAnalyticsBtn = document.getElementById('exportAllAnalyticsBtn');
  resetAnalyticsBtn = document.getElementById('resetAnalyticsBtn');
  adminDateAutofillToggle = document.getElementById('adminDateAutofillToggle');
  adminTimeAutofillToggle = document.getElementById('adminTimeAutofillToggle');
  scannerSetupPrompt = document.getElementById('scannerSetupPrompt');
  scannerConnectionNote = document.getElementById('scannerConnectionNote');
  reasonAutofillToggle = document.getElementById('reasonAutofillToggle');
  consentAutofillToggle = document.getElementById('consentAutofillToggle');
  addQueueBtn = document.getElementById('addQueueBtn');
  queueBarcodeInput = document.getElementById('queueBarcodeInput');
  queueEntryPanel = document.getElementById('queueEntryPanel');
  queueEntryToggleBtn = document.getElementById('queueEntryToggleBtn');
  cancelQueueEntryBtn = document.getElementById('cancelQueueEntryBtn');
  multipleQueueCount = document.getElementById('multipleQueueCount');
  inventoryBarcodeInput = document.getElementById('inventoryBarcodeInput');
  inventoryEntryPanel = document.getElementById('inventoryEntryPanel');
  inventoryEntryToggleBtn = document.getElementById('inventoryEntryToggleBtn');
  cancelInventoryEntryBtn = document.getElementById('cancelInventoryEntryBtn');
  inventoryQueueCount = document.getElementById('inventoryQueueCount');

  multipleInjectManager = new ScanQueueManager({
    storageKey: MULTIPLE_INJECT_QUEUE_KEY,
    summaryEl: document.getElementById('multipleQueueSummary'),
    listEl: document.getElementById('multipleQueueList'),
    clearButton: clearMultipleBtn,
    onUseRecord: handleUseMultipleInjectRecord,
    onNotice: (message) => writeOutput(escapeHtml(message), 'error'),
    showUseAction: true,
    useButtonLabel: 'Use for Chart',
    emptySummary: 'Scan a vaccine barcode or select + to add it as text.',
    emptyMessage: '',
    summaryBuilder: buildMultipleInjectSummary
  });

  inventoryManager = new ScanQueueManager({
    storageKey: INVENTORY_BATCH_KEY,
    summaryEl: document.getElementById('inventorySummary'),
    listEl: document.getElementById('inventoryList'),
    clearButton: clearInventoryBtn,
    exportButton: exportCsvBtn,
    onNotice: (message) => writeOutput(escapeHtml(message), 'error'),
    emptySummary: 'Scan a vaccine barcode or select + to add it as text.',
    emptyMessage: '',
    summaryBuilder: buildInventorySummary,
    exportFilenamePrefix: 'vaxlink-inventory'
  });

  await Promise.all([multipleInjectManager.load(), inventoryManager.load()]);
  renderMultipleModeCount(multipleInjectManager.count);
  renderInventoryCount(inventoryManager.count);
  await loadWorkflowMode();
  await loadSettingsPanelState();
  await loadAutofillSettings();
  await loadAnalyticsSummary();
  await loadScannerStatus();
  logAnalyticsEvent('popup_open', { workflow: activeMode, source: 'popup' });
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  chrome.storage.onChanged.addListener(handlePopupStorageChanged);

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
    inventoryModeBtn.addEventListener('click', () =>
      setActiveMode('inventory')
    );
  }

  if (settingsToggleBtn) {
    settingsToggleBtn.addEventListener('click', () => {
      const nextState = settingsPanel?.hidden ?? true;
      void setPopupPanel(nextState ? 'settings' : 'workflow');
      if (nextState) {
        void loadScannerStatus();
      }
    });
  }
  analyticsToggleBtn?.addEventListener('click', () => {
    const nextState = analyticsPanel?.hidden ?? true;
    void setPopupPanel(nextState ? 'analytics' : 'workflow');
    if (nextState) void loadAnalyticsSummary();
  });
  document.getElementById('closePanelBtn')?.addEventListener('click', () => {
    const returnTo = settingsPanel?.hidden
      ? analyticsToggleBtn
      : settingsToggleBtn;
    void setPopupPanel('workflow');
    returnTo?.focus();
  });
  document
    .getElementById('openScannerSettingsBtn')
    ?.addEventListener('click', () => {
      const section = document.getElementById('scannerSettingsSection');
      void setPopupPanel('settings');
      document.getElementById('scannerSettingsTitle')?.focus();
      section?.scrollIntoView({ block: 'nearest' });
    });
  document
    .getElementById('continueWithoutScannerBtn')
    ?.addEventListener('click', () => {
      continueWithoutScanner = true;
      renderScannerStatusUi();
      const target =
        activeMode === 'single'
          ? scannedInput
          : activeMode === 'multiple'
            ? queueEntryToggleBtn
            : inventoryEntryToggleBtn;
      target?.focus();
    });
  document
    .getElementById('autoResolveFundingToggle')
    ?.addEventListener('change', (event) => {
      void setAutofillSetting(AUTO_RESOLVE_FUNDING_KEY, event.target.checked);
    });
  adminDateAutofillToggle?.addEventListener('change', () => {
    void setAutofillSetting(
      ADMIN_DATE_AUTOFILL_KEY,
      adminDateAutofillToggle.checked
    );
  });
  adminTimeAutofillToggle?.addEventListener('change', () => {
    void setAutofillSetting(
      ADMIN_TIME_AUTOFILL_KEY,
      adminTimeAutofillToggle.checked
    );
  });
  document
    .getElementById('acknowledgeScannerErrorBtn')
    ?.addEventListener('click', () => {
      chrome.runtime.sendMessage(
        { action: 'acknowledgeScannerCaptureError' },
        (response) => {
          if (chrome.runtime.lastError || !response?.success) return;
          scannerCaptureError = response.captureError === true;
          renderScannerStatusUi();
        }
      );
    });
  reasonAutofillToggle?.addEventListener('change', () => {
    void setAutofillSetting(REASON_AUTOFILL_KEY, reasonAutofillToggle.checked);
  });
  consentAutofillToggle?.addEventListener('change', () => {
    void setAutofillSetting(
      CONSENT_AUTOFILL_KEY,
      consentAutofillToggle.checked
    );
  });

  if (autoFillBtn) {
    autoFillBtn.addEventListener('click', async () => {
      if (!parsedData) {
        writeOutput(
          'Scan a barcode first. Parsing runs automatically.',
          'error'
        );
        return;
      }

      if (globalThis.VaxLinkExpiryDate.blocksChartUse(parsedData)) {
        writeOutput(
          'This vaccine is expired. Use an in-date vaccine.',
          'error'
        );
        return;
      }

      logAnalyticsEvent('autofill_attempt', {
        workflow: activeMode,
        source: 'popup_button',
        vaccineLabel: globalThis.vaxlinkVaccineLabel(parsedData),
        manufacturer: parsedData.manufacturer || '',
        expiryFlag:
          parsedData.expiry_flag ||
          getExpiryStatus(parsedData.inventory_expiry || parsedData.expiry).flag
      });
      try {
        const response = await sendAutoFillToActiveTab(parsedData);
        if (response && response.pending) {
          writeOutput(
            response.reason === 'funding_choice_required'
              ? 'Choose the funding category in Panorama to continue.'
              : 'VaxLink is checking the lot and chart fields in Panorama.',
            'info'
          );
          return;
        }
        logAnalyticsEvent('autofill_result', {
          workflow: activeMode,
          source: 'popup_button',
          success: true,
          vaccineLabel: globalThis.vaxlinkVaccineLabel(parsedData),
          manufacturer: parsedData.manufacturer || '',
          expiryFlag:
            parsedData.expiry_flag ||
            getExpiryStatus(parsedData.inventory_expiry || parsedData.expiry)
              .flag
        });
        writeOutput(
          parsedData.lookup_error
            ? `Barcode fields filled. ${parsedData.lookup_error}. Verify vaccine details on the chart.`
            : 'Chart auto-filled',
          parsedData.lookup_error ? 'warning' : 'success'
        );
      } catch (error) {
        logAnalyticsEvent('autofill_result', {
          workflow: activeMode,
          source: 'popup_button',
          success: false,
          vaccineLabel: globalThis.vaxlinkVaccineLabel(parsedData),
          manufacturer: parsedData.manufacturer || ''
        });
        writeOutput(error.message || 'Could not auto-fill fields', 'error');
      }
    });
  }

  if (clearMultipleBtn) {
    clearMultipleBtn.addEventListener('click', async () => {
      try {
        await multipleInjectManager.clear();
      } catch (error) {
        writeOutput(escapeHtml(error.message), 'error');
        return;
      }
      logAnalyticsEvent('queue_cleared', {
        workflow: 'multiple',
        queue: 'multiple',
        source: 'popup_button'
      });
      writeOutput('Multiple Immunizations tray cleared.', 'info');
    });
  }

  queueEntryToggleBtn?.addEventListener('click', () => {
    setQueueEntryOpen(queueEntryPanel.hidden);
  });
  cancelQueueEntryBtn?.addEventListener('click', () => {
    setQueueEntryOpen(false);
  });

  if (addQueueBtn && queueBarcodeInput) {
    addQueueBtn.addEventListener('click', () => addManualScanToMultipleQueue());
    queueBarcodeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addManualScanToMultipleQueue();
      }
    });
  }

  // Enable entry after its handlers are ready; scanner status loads first.
  if (queueEntryToggleBtn) queueEntryToggleBtn.disabled = false;

  if (refreshNvcBtn) {
    refreshNvcBtn.addEventListener('click', () => {
      refreshNvcBtn.disabled = true;
      writeOutput('Refreshing NVC catalogue...', 'info');
      if (nvcStatusDiv) {
        nvcStatusDiv.hidden = false;
        nvcStatusDiv.textContent = 'NVC is refreshing.';
      }

      chrome.runtime.sendMessage({ action: 'refreshNVCBundle' }, (response) => {
        refreshNvcBtn.disabled = false;
        loadNVCStatus();
        if (chrome.runtime.lastError) {
          writeOutput(
            `NVC refresh failed: ${chrome.runtime.lastError.message}`,
            'error'
          );
          return;
        }

        writeOutput(
          formatNVCRefreshMessage(response),
          response?.success ? 'success' : 'error'
        );
      });
    });
  }

  if (exportAllAnalyticsBtn) {
    exportAllAnalyticsBtn.addEventListener('click', async () => {
      await exportAnalyticsJson();
    });
  }

  if (resetAnalyticsBtn) {
    resetAnalyticsBtn.addEventListener('click', async () => {
      try {
        const result = await sendRuntimeMessage({
          action: 'resetAnalyticsStore'
        });
        if (!result?.success)
          throw new Error(result?.error || 'Could not reset analytics');
        renderAnalyticsSummary(result.summary);
        writeOutput('Activity reset.', 'info');
      } catch (error) {
        writeOutput(error.message || 'Could not reset analytics', 'error');
      }
    });
  }

  inventoryEntryToggleBtn?.addEventListener('click', () => {
    setInventoryEntryOpen(inventoryEntryPanel.hidden);
  });
  cancelInventoryEntryBtn?.addEventListener('click', () => {
    setInventoryEntryOpen(false);
  });
  if (addBatchBtn) {
    addBatchBtn.addEventListener('click', () => addPendingScansToInventory());
  }
  if (inventoryEntryToggleBtn) inventoryEntryToggleBtn.disabled = false;

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
      writeOutput(
        `CSV export started for ${inventoryManager.count} scan(s).`,
        'success'
      );
    });
  }

  if (clearInventoryBtn) {
    clearInventoryBtn.addEventListener('click', async () => {
      await inventoryManager.clear();
      logAnalyticsEvent('queue_cleared', {
        workflow: 'inventory',
        queue: 'inventory',
        source: 'popup_button'
      });
      writeOutput('Inventory tray cleared.', 'info');
    });
  }

  document
    .getElementById('dismissQueueSaveNotice')
    ?.addEventListener('click', () => {
      document.getElementById('queueSaveNotice').hidden = true;
    });

  loadNVCStatus();
  void renderHeldScannerScans();
});

function handleRuntimeMessage(request) {
  if (request?.action === SCANNER_DAEMON_ACTIONS.STATUS_CHANGED) {
    applyScannerStatus(request.status);
    return false;
  }
  if (request?.action === 'scannerDaemon.scanEcho') {
    if (request.response?.success === false) {
      scannerCaptureError = true;
      renderScannerStatusUi();
    } else {
      const status = request.response?.response?.status;
      if (status === 'missing_lot' || status === 'parse_error')
        showBarcodeHelp(status);
      if (status === 'expired')
        writeOutput(
          'This vaccine is expired. Use an in-date vaccine.',
          'error'
        );
    }
  }
  return false;
}

async function renderHeldScannerScans() {
  const host = document.getElementById('heldScannerScans');
  const list = document.getElementById('heldScannerScanList');
  if (!host || !list) return;
  try {
    const result = await sendRuntimeMessage({ action: 'getHeldScannerScans' });
    if (!result?.success) return;
    host.hidden = !result.scans.length;
    document.getElementById('heldScannerScanCount').textContent =
      `Held scanner scans (${result.scans.length})`;
    list.replaceChildren();
    for (const scan of result.scans) {
      const row = document.createElement('div');
      const label = document.createElement('p');
      label.textContent = scan.capturedAt || 'Capture time unknown';
      const barcode = document.createElement('textarea');
      barcode.readOnly = true;
      barcode.value = scan.rawText || '';
      barcode.setAttribute(
        'aria-label',
        'Held barcode; select and copy for manual input'
      );
      const discard = document.createElement('button');
      discard.textContent = 'Discard held scan';
      discard.addEventListener('click', async () => {
        discard.disabled = true;
        try {
          const result = await sendRuntimeMessage({
            action: 'discardHeldScannerScan',
            scan
          });
          if (!result?.success)
            throw new Error(result?.error || 'Could not discard scan');
          await renderHeldScannerScans();
        } catch (error) {
          writeOutput(error.message, 'error');
        } finally {
          discard.disabled = false;
        }
      });
      row.append(label, barcode, discard);
      list.append(row);
    }
  } catch (error) {
    writeOutput(error.message, 'error');
  }
}

function handlePopupStorageChanged(changes, area) {
  if (area === 'local' && AUTO_RESOLVE_FUNDING_KEY in changes)
    void loadAutofillSettings();
  if (area === 'local' && changes.vaxlink_pending_scan_inbox_v1)
    void renderHeldScannerScans();
  if (area === 'local' && INVENTORY_BATCH_KEY in changes) {
    const rows = changes[INVENTORY_BATCH_KEY]?.newValue;
    renderInventoryCount(Array.isArray(rows) ? rows.length : 0);
  }
  if (area !== 'local' || !(MULTIPLE_INJECT_QUEUE_KEY in changes)) return;
  const rows = Array.isArray(changes[MULTIPLE_INJECT_QUEUE_KEY]?.newValue)
    ? changes[MULTIPLE_INJECT_QUEUE_KEY].newValue
    : [];
  renderMultipleModeCount(rows.length);
}

function renderInventoryCount(count) {
  if (inventoryQueueCount) inventoryQueueCount.textContent = String(count);
}

function renderMultipleModeCount(count) {
  const normalized = Math.max(0, Number.parseInt(count, 10) || 0);
  if (multipleQueueCount) multipleQueueCount.textContent = String(normalized);
  if (multipleModeBtn)
    multipleModeBtn.textContent =
      normalized > 0
        ? `Multiple Immunizations (${normalized})`
        : 'Multiple Immunizations';
}

function writeOutput(message, type = 'info') {
  showOutput(outputDiv, message, type);
}

async function loadScannerStatus() {
  try {
    const response = await sendScannerDaemonCommand(
      SCANNER_DAEMON_ACTIONS.GET_STATUS
    );
    if (response && response.success && response.status) {
      scannerCaptureError = response.captureError === true;
      applyScannerStatus(response.status);
      return;
    }
  } catch (_) {
    // Leave the last known UI in place if the daemon status is temporarily unavailable.
  }
  renderScannerStatusUi();
}

function applyScannerStatus(status) {
  scannerStatusSnapshot = normalizeScannerStatusSnapshot(status);
  renderScannerStatusUi();
}

function renderScannerStatusUi() {
  const descriptor = buildScannerStatusDescriptor(scannerStatusSnapshot);
  const captureWarning = document.getElementById('scannerCaptureWarning');
  if (captureWarning) captureWarning.hidden = !scannerCaptureError;
  const needsSetup = ['never_configured', 'permission_lost'].includes(
    scannerStatusSnapshot.state
  );
  const showSetup = needsSetup && !continueWithoutScanner;
  mainWorkflowPanel?.classList.toggle('scanner-setup-required', showSetup);
  if (scannerSetupPrompt) scannerSetupPrompt.hidden = !showSetup;
  if (scannerConnectionNote) {
    scannerConnectionNote.textContent = needsSetup ? '' : descriptor.bannerText;
    scannerConnectionNote.hidden = !scannerConnectionNote.textContent;
  }
}

async function loadSettingsPanelState() {
  try {
    const stored = await getLocalStorage([SETTINGS_PANEL_OPEN_KEY]);
    applyPopupPanel(stored[SETTINGS_PANEL_OPEN_KEY] ? 'settings' : 'workflow');
  } catch (_) {
    applyPopupPanel('workflow');
  }
}

async function setPopupPanel(panel) {
  applyPopupPanel(panel);
  if (panel !== 'workflow') document.getElementById('closePanelBtn')?.focus();
  try {
    await setLocalStorage({ [SETTINGS_PANEL_OPEN_KEY]: panel === 'settings' });
  } catch (_) {
    // Keep the UI responsive even if the preference does not persist.
  }
}

function applyPopupPanel(panel) {
  const workflowHeader = document.getElementById('workflowHeader');
  const panelHeader = document.getElementById('panelHeader');
  const panelTitle = document.getElementById('panelTitle');
  const closeButton = document.getElementById('closePanelBtn');
  const title = panel === 'settings' ? 'Settings' : 'Local Activity';
  if (workflowHeader) workflowHeader.hidden = panel !== 'workflow';
  if (panelHeader) panelHeader.hidden = panel === 'workflow';
  if (panelTitle) panelTitle.textContent = title;
  closeButton?.setAttribute('aria-label', `Close ${title}`);
  closeButton?.setAttribute('title', `Close ${title}`);
  if (panel === 'settings') initializeScannerSettings();
  if (settingsPanel) {
    settingsPanel.hidden = panel !== 'settings';
  }
  if (mainWorkflowPanel) {
    mainWorkflowPanel.hidden = panel !== 'workflow';
  }
  if (settingsToggleBtn) {
    settingsToggleBtn.setAttribute(
      'aria-expanded',
      String(panel === 'settings')
    );
  }
  if (analyticsPanel) analyticsPanel.hidden = panel !== 'analytics';
  analyticsToggleBtn?.setAttribute(
    'aria-expanded',
    String(panel === 'analytics')
  );
}

// Each old combined switch remains the default until its fields are set separately.
async function loadAutofillSettings() {
  const preferences = [
    [
      document.getElementById('autoResolveFundingToggle'),
      AUTO_RESOLVE_FUNDING_KEY
    ],
    [
      adminDateAutofillToggle,
      ADMIN_DATE_AUTOFILL_KEY,
      LEGACY_ADMIN_DATETIME_AUTOFILL_KEY
    ],
    [
      adminTimeAutofillToggle,
      ADMIN_TIME_AUTOFILL_KEY,
      LEGACY_ADMIN_DATETIME_AUTOFILL_KEY
    ],
    [
      reasonAutofillToggle,
      REASON_AUTOFILL_KEY,
      LEGACY_REASON_CONSENT_AUTOFILL_KEY
    ],
    [
      consentAutofillToggle,
      CONSENT_AUTOFILL_KEY,
      LEGACY_REASON_CONSENT_AUTOFILL_KEY
    ]
  ];
  let stored = {};
  try {
    stored = await getLocalStorage(
      preferences.flatMap(([, key, legacyKey]) =>
        legacyKey ? [key, legacyKey] : [key]
      )
    );
  } catch (_) {}
  for (const [toggle, key, legacyKey] of preferences) {
    if (toggle) toggle.checked = (stored[key] ?? stored[legacyKey]) !== false;
  }
}

async function setAutofillSetting(key, enabled) {
  try {
    await setLocalStorage({ [key]: !!enabled });
  } catch (error) {
    writeOutput(
      error.message || 'Could not save autofill preference.',
      'error'
    );
  }
}

function logAnalyticsEvent(eventType, payload = {}) {
  void sendRuntimeMessage({ action: 'logAnalyticsEvent', eventType, payload })
    .then((result) => {
      if (result?.success) return loadAnalyticsSummary();
    })
    .catch(() => undefined);
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
    const result = await sendRuntimeMessage({ action: 'getAnalyticsSummary' });
    if (!result?.success) throw new Error(result?.error);
    renderAnalyticsSummary(result.summary);
  } catch (_) {
    if (analyticsSummaryDiv) {
      analyticsSummaryDiv.textContent =
        'Local activity is unavailable on this device.';
    }
  }
}

function renderAnalyticsSummary(summary) {
  if (!summary || !analyticsSummaryDiv) return;
  const metrics = (day, daysTracked) => {
    const scannerCaptures = ['single', 'multiple', 'inventory'].reduce(
      (total, workflow) => total + (day.workflows?.[workflow]?.liveScans || 0),
      0
    );
    const manualEntries = ['single', 'multiple', 'inventory'].reduce(
      (total, workflow) =>
        total + (day.workflows?.[workflow]?.popupParses || 0),
      0
    );
    const funding = day.funding || {};
    const matched = (funding.single || 0) + (funding.both || 0);
    const share = (count) =>
      matched ? `${Math.round(((count || 0) / matched) * 100)}%` : '—';
    return {
      Scans: scannerCaptures + manualEntries,
      'Funding prompts': funding.prompts || 0,
      'Funding choices': funding.choices || 0,
      'One funding category matched': share(funding.single),
      'Both funding categories matched': share(funding.both),
      'No funding category matched': funding.unmatched || 0,
      'Forms filled': day.autofill?.success || 0,
      'Inventory exports': day.exports?.inventoryCount || 0,
      'Expiry notices shown': day.expiry?.noticesShown ?? '—',
      'Scanner captures': scannerCaptures,
      'Manual entries': manualEntries,
      'Immunization tray adds': day.queues?.multipleSaved || 0,
      'Tray to chart': day.queues?.multipleUsed || 0,
      'Days tracked': daysTracked
    };
  };
  const today = summary.today || {};
  const todayMetrics = metrics(today, Object.keys(today).length ? 1 : 0);
  const allMetrics = metrics(summary.rollup || {}, summary.daysTracked);
  const renderRow = (label) => `
    <tr><th scope="row">${escapeAnalyticsHtml(label)}</th><td>${formatAnalyticsNumber(todayMetrics[label])}</td><td>${formatAnalyticsNumber(allMetrics[label])}</td></tr>
  `;
  const groups = [
    [
      'Scanning',
      ['Scans', 'Scanner captures', 'Manual entries', 'Expiry notices shown']
    ],
    ['Charting', ['Forms filled', 'Tray to chart']],
    [
      'Funding',
      [
        'Funding prompts',
        'Funding choices',
        'One funding category matched',
        'Both funding categories matched',
        'No funding category matched'
      ]
    ],
    ['Trays & exports', ['Immunization tray adds', 'Inventory exports']]
  ];
  analyticsSummaryDiv.innerHTML = `
    <table class="activity-table" aria-label="Activity statistics">
      <thead><tr><td class="activity-group-title">Scanning</td><th scope="col">Today</th><th scope="col">All time</th></tr></thead>
      ${groups
        .map(
          ([title, labels], index) => `
        <tbody aria-label="${escapeAnalyticsHtml(title)}">
          ${index === 0 ? '' : `<tr class="activity-group"><th scope="rowgroup" colspan="3">${escapeAnalyticsHtml(title)}</th></tr>`}
          ${labels.map(renderRow).join('')}
        </tbody>
      `
        )
        .join('')}
      <tfoot>${renderRow('Days tracked')}</tfoot>
    </table>
  `;
}

function formatAnalyticsNumber(value) {
  if (typeof value === 'string') return value;
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

async function exportAnalyticsJson() {
  try {
    const result = await sendRuntimeMessage({ action: 'getAnalyticsExport' });
    if (!result?.success)
      throw new Error(result?.error || 'Could not export analytics');
    const data = result.data;
    const filename = `vaxlink-activity-${data.exportedAt.replace(/[:.]/g, '-')}.json`;
    downloadTextFile(
      filename,
      JSON.stringify(data, null, 2),
      'application/json;charset=utf-8'
    );
    await loadAnalyticsSummary();
    writeOutput(`Analytics export ready: ${filename}`, 'success');
  } catch (error) {
    writeOutput(error.message || 'Could not export analytics', 'error');
  }
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

async function loadWorkflowMode() {
  try {
    const stored = await getLocalStorage([
      WORKFLOW_MODE_KEY,
      LEGACY_POPUP_MODE_KEY,
      LEGACY_REMOTE_MODE_KEY,
      LEGACY_HANDS_FREE_KEY
    ]);
    await setActiveMode(normalizeWorkflowMode(stored), {
      persist: false,
      track: false
    });
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
  renderScannerStatusUi();

  if (options.persist !== false) {
    await setLocalStorage({ [WORKFLOW_MODE_KEY]: activeMode });
  }
  if (options.track !== false && previousMode !== activeMode) {
    logAnalyticsEvent('workflow_mode_set', {
      workflow: activeMode,
      source: 'popup_tab'
    });
  }
}

function toggleModeButton(button, isActive) {
  if (!button) return;
  button.classList.toggle('active', isActive);
  button.setAttribute('aria-selected', isActive ? 'true' : 'false');
}

function showBarcodeHelp(status) {
  const message =
    status === 'missing_lot'
      ? 'This barcode has no lot number.'
      : 'This barcode could not be read.';
  writeOutput(
    `${message} Scan the 2D barcode with the lot number on the package, vial, or prefilled syringe.`,
    'error'
  );
}

function parseImmunizationInput(raw, workflow, source) {
  let status;
  try {
    const parsed = globalThis.VaxLinkGS1Parser.isRetailBarcode(raw)
      ? {}
      : parseInputData(raw);
    if (String(parsed.lot || '').trim()) return parsed;
    status = 'missing_lot';
  } catch (_) {
    status = 'parse_error';
  }
  logAnalyticsEvent(status === 'missing_lot' ? 'barcode_missing_lot' : status, {
    workflow,
    source
  });
  showBarcodeHelp(status);
  return null;
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
      parsedData =
        activeMode === 'single'
          ? parseImmunizationInput(barcode, activeMode, 'popup_input')
          : parseInputData(barcode);
      if (!parsedData) return;
      if (!parsedData.scanned_at) {
        parsedData.scanned_at = new Date().toISOString();
      }
      logAnalyticsEvent('parse_success', {
        workflow: activeMode,
        source: 'popup_input',
        expiryFlag: getExpiryStatus(parsedData.expiry).flag
      });
      await displayParsedData(parsedData, parseRequestId);
    } catch (error) {
      parsedData = null;
      logAnalyticsEvent('parse_error', {
        workflow: activeMode,
        source: 'popup_input'
      });
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

function loadNVCStatus() {
  chrome.runtime.sendMessage({ action: 'getNVCUpdateStatus' }, (status) => {
    if (chrome.runtime.lastError || !status) {
      if (nvcStatusDiv) {
        nvcStatusDiv.hidden = false;
        nvcStatusDiv.textContent =
          'NVC status could not be checked. Try Recheck.';
      }
      return;
    }
    renderNVCStatus(status, nvcStatusDiv);
    if (status?.state === 'refreshing') setTimeout(loadNVCStatus, 1000);
  });
}

async function sendAutoFillToActiveTab(data) {
  const payload = { ...(data || {}) };
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
        if (response && (response.success || response.pending)) {
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

function sendScannerDaemonCommand(action, payload = {}) {
  return sendRuntimeMessage({ action, ...payload });
}

async function lookupVaccineInfo(lot, gtin, waitForDownload) {
  const lotKey = String(lot || '')
    .trim()
    .toLowerCase();
  if (!lotKey) {
    return { error: 'No lot number provided' };
  }
  const message = { action: 'lookupVaccineInfo', lot, waitForDownload };
  if (gtin) {
    message.gtin = gtin;
  }
  return sendRuntimeMessage(message);
}

function showQueueSaveFailure(message) {
  queueSaveNoticeVersion += 1;
  // Keep save failures visible while the preview and selected mode change.
  document.getElementById('queueSaveNoticeText').textContent = message;
  document.getElementById('queueSaveNotice').hidden = false;
}

function clearQueueSaveFailure(version) {
  // A save already in flight must not hide a failure reported after it started.
  if (version === queueSaveNoticeVersion) {
    document.getElementById('queueSaveNotice').hidden = true;
  }
}

function setInventoryEntryOpen(open) {
  if (!inventoryEntryPanel || !inventoryEntryToggleBtn) return;
  inventoryEntryPanel.hidden = !open;
  inventoryEntryToggleBtn.textContent = open ? '×' : '+';
  inventoryEntryToggleBtn.setAttribute('aria-expanded', String(open));
  const label = open ? 'Close barcode entry' : 'Add a vaccine as text';
  inventoryEntryToggleBtn.setAttribute('aria-label', label);
  inventoryEntryToggleBtn.title = label;
  if (open) inventoryBarcodeInput?.focus();
  else inventoryEntryToggleBtn.focus();
}

function setQueueEntryOpen(open) {
  if (!queueEntryPanel || !queueEntryToggleBtn) return;
  queueEntryPanel.hidden = !open;
  queueEntryToggleBtn.textContent = open ? '×' : '+';
  queueEntryToggleBtn.setAttribute('aria-expanded', String(open));
  const label = open ? 'Close barcode entry' : 'Add a vaccine as text';
  queueEntryToggleBtn.setAttribute('aria-label', label);
  queueEntryToggleBtn.title = label;
  if (open) queueBarcodeInput?.focus();
  else queueEntryToggleBtn.focus();
}

function confirmExpiredTrayAdd(lot) {
  const dialog = document.getElementById('expiredTrayDialog');
  document.getElementById('expiredTrayMessage').textContent =
    `Lot ${lot} has expired. You can save it for reference. VaxLink will block chart entry.`;
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => resolve(dialog.returnValue === 'add'),
      { once: true }
    );
    dialog.showModal();
  });
}

async function addManualScanToMultipleQueue() {
  if (multipleAddInFlight) return;
  const modeSnapshot = activeMode;
  const inputSnapshot = queueBarcodeInput?.value || '';
  const rawBarcode = inputSnapshot.trim();
  if (!rawBarcode) {
    writeOutput('Paste a barcode into the Barcode field first.', 'error');
    return;
  }

  const noticeVersion = queueSaveNoticeVersion;
  let closeEntry = false;
  multipleAddInFlight = true;
  setButtonBusy(addQueueBtn, true, 'Adding...');
  // Hiding the entry cannot cancel a save that has already started.
  if (queueEntryToggleBtn) queueEntryToggleBtn.disabled = true;
  if (cancelQueueEntryBtn) cancelQueueEntryBtn.disabled = true;
  try {
    const baseData = parseImmunizationInput(
      rawBarcode,
      'multiple',
      'popup_manual_entry'
    );
    if (!baseData) return;
    if (!baseData.scanned_at) {
      baseData.scanned_at = new Date().toISOString();
    }
    const enriched = await enrichParsedData(baseData, 'multiple');
    const record = buildQueueRecord(enriched, rawBarcode, { chartDose: true });
    const expired = globalThis.VaxLinkExpiryDate.isExpiredVaccine(record);
    if (expired && !(await confirmExpiredTrayAdd(record.lot))) return;
    await multipleInjectManager.add(record, { confirmExpired: expired });
    clearQueueSaveFailure(noticeVersion);
    logAnalyticsEvent('queue_saved', {
      workflow: 'multiple',
      queue: 'multiple',
      source: 'popup_manual_entry',
      count: 1,
      queueSizeAfter: multipleInjectManager.count,
      vaccineLabel: globalThis.vaxlinkVaccineLabel(enriched),
      manufacturer: enriched.manufacturer || '',
      expiryFlag:
        enriched.expiry_flag ||
        getExpiryStatus(enriched.inventory_expiry || enriched.expiry).flag
    });
    const currentInput = queueBarcodeInput.value === inputSnapshot;
    if (currentInput) queueBarcodeInput.value = '';
    const label =
      enriched.tradename ||
      enriched.generic_name ||
      enriched.lot ||
      'Unknown vaccine';
    if (activeMode === modeSnapshot && currentInput) {
      closeEntry = true;
      writeOutput(
        expired
          ? `Saved for reference only: ${escapeHtml(label)}`
          : `✓ Added to Multiple Immunizations tray: ${escapeHtml(label)}`,
        expired ? 'warning' : 'success'
      );
    }
  } catch (error) {
    showQueueSaveFailure(
      `Multiple Immunizations save not confirmed: ${error.message}. Check the tray before retrying.`
    );
  } finally {
    multipleAddInFlight = false;
    setButtonBusy(addQueueBtn, false);
    if (queueEntryToggleBtn) queueEntryToggleBtn.disabled = false;
    if (cancelQueueEntryBtn) cancelQueueEntryBtn.disabled = false;
    if (closeEntry) setQueueEntryOpen(false);
  }
}

async function addPendingScansToInventory() {
  if (inventoryAddInFlight) return;
  const modeSnapshot = activeMode;
  const inputSnapshot = inventoryBarcodeInput?.value || '';
  const lines = inputSnapshot
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    writeOutput('Paste a barcode into the Barcode field first.', 'error');
    return;
  }

  const noticeVersion = queueSaveNoticeVersion;
  let closeEntry = false;
  inventoryAddInFlight = true;
  setButtonBusy(addBatchBtn, true, 'Adding...');
  // Keep entry visible until the save finishes; closing it cannot cancel a save.
  if (inventoryEntryToggleBtn) inventoryEntryToggleBtn.disabled = true;
  if (cancelInventoryEntryBtn) cancelInventoryEntryBtn.disabled = true;
  const records = [];
  let addedCount = 0;
  let lastRecord = null;
  const errors = [];
  const failedLines = [];

  try {
    for (let index = 0; index < lines.length; index += 1) {
      const rawBarcode = lines[index];
      try {
        const baseData = parseInputData(rawBarcode);
        const enriched = await enrichParsedData(baseData, 'inventory');
        records.push(buildQueueRecord(enriched, rawBarcode));
        lastRecord = enriched;
        addedCount += 1;
      } catch (error) {
        errors.push(`Line ${index + 1}: ${error.message}`);
        failedLines.push(rawBarcode);
      }
    }

    if (records.length) {
      await inventoryManager.addMany(records);
      if (!errors.length) clearQueueSaveFailure(noticeVersion);
      logAnalyticsEvent('queue_saved', {
        workflow: 'inventory',
        queue: 'inventory',
        source: 'popup_manual_batch',
        count: addedCount,
        queueSizeAfter: inventoryManager.count,
        vaccineLabel: globalThis.vaxlinkVaccineLabel(lastRecord),
        manufacturer: lastRecord?.manufacturer || '',
        expiryFlag:
          lastRecord?.expiry_flag ||
          getExpiryStatus(lastRecord?.inventory_expiry).flag
      });
    }
    const currentInput = inventoryBarcodeInput?.value === inputSnapshot;
    if (currentInput) {
      // Only failed lines remain, so retrying does not add confirmed rows twice.
      inventoryBarcodeInput.value = failedLines.join('\n');
      closeEntry = activeMode === modeSnapshot && !errors.length;
    }

    if (errors.length) {
      showQueueSaveFailure(
        `Inventory batch: ${errors.length} barcode(s) could not be added. ${errors.join('; ')}`
      );
      logAnalyticsEvent('parse_error', {
        workflow: 'inventory',
        source: 'popup_batch',
        count: errors.length
      });
    }

    if (activeMode !== modeSnapshot || !currentInput) return;
    if (addedCount) {
      const message = errors.length
        ? `Added ${addedCount} scan(s). ${errors.length} line(s) failed.`
        : `Added ${addedCount} scan(s) to inventory.`;
      writeOutput(message, errors.length ? 'warning' : 'success');
    } else {
      writeOutput(errors.join('<br>') || 'No scans were added.', 'error');
    }
  } catch (error) {
    showQueueSaveFailure(
      `Inventory save not confirmed: ${error.message}. Check the tray before retrying.`
    );
  } finally {
    inventoryAddInFlight = false;
    setButtonBusy(addBatchBtn, false);
    if (inventoryEntryToggleBtn) inventoryEntryToggleBtn.disabled = false;
    if (cancelInventoryEntryBtn) cancelInventoryEntryBtn.disabled = false;
    if (closeEntry) setInventoryEntryOpen(false);
  }
}

let trayUseInFlight = false;

async function handleUseMultipleInjectRecord(record) {
  if (trayUseInFlight || activeMode !== 'multiple') return;
  if (globalThis.VaxLinkExpiryDate.blocksChartUse(record)) return;
  trayUseInFlight = true;
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });
    if (!tab?.id) throw new Error('Open a Panorama immunization form.');
    const chart = await chrome.tabs
      .sendMessage(
        tab.id,
        { action: 'getPanoramaIntegration', forTrayUse: true },
        { frameId: 0 }
      )
      .catch(() => null);
    if (!chart?.ready || !chart.formContext?.ready || !chart.contextToken) {
      throw new Error(
        'Open a supported Panorama form that is ready for entry.'
      );
    }
    const result = await chrome.tabs.sendMessage(
      tab.id,
      {
        action: 'useTrayVaccine',
        recordId: record.id,
        contextToken: chart.contextToken
      },
      { frameId: 0 }
    );
    if (result?.status === 'expired') return;
    if (!result?.success && !result?.pending)
      throw new Error(result?.error || 'Check the chart before trying again.');

    const message =
      result.reason === 'funding_choice_required'
        ? 'Choose the funding category in Panorama to continue.'
        : result.pending
          ? 'VaxLink is waiting for Panorama. Check the chart before continuing.'
          : 'Vaccine details filled. Review the chart before saving.';
    writeOutput(message, result.pending ? 'info' : 'success');
  } catch (error) {
    writeOutput(escapeHtml(error.message), 'error');
  } finally {
    trayUseInFlight = false;
  }
}

function mergeVaccineInfoIntoParsedData(
  baseData,
  vaccineInfo,
  expiryStatus,
  expirySource
) {
  const merged = { ...baseData };
  if (vaccineInfo && !vaccineInfo.error) {
    merged.nvc_lot_matched = true;
    merged.tradename = vaccineInfo.tradename || merged.tradename || null;
    merged.generic_name =
      vaccineInfo.generic_name || merged.generic_name || null;
    merged.disease = vaccineInfo.disease || merged.disease || null;
    merged.antigen = vaccineInfo.antigen || merged.antigen || null;
    merged.manufacturer =
      vaccineInfo.manufacturer || merged.manufacturer || null;
    merged.din = vaccineInfo.din || merged.din || null;
    merged.route = vaccineInfo.route || merged.route || null;
    merged.strength = vaccineInfo.strength || merged.strength || null;
    merged.dose_value = vaccineInfo.dose_value || merged.dose_value || null;
    merged.dose_unit = vaccineInfo.dose_unit || merged.dose_unit || null;
    merged.drug_code = vaccineInfo.din || merged.drug_code || null;
    merged.name =
      merged.name ||
      vaccineInfo.generic_name ||
      vaccineInfo.tradename ||
      vaccineInfo.din ||
      null;
  }
  merged.nvc_lot_expiry =
    vaccineInfo?.lot_expiry || merged.nvc_lot_expiry || '';
  merged.nvc_catalogue_version = vaccineInfo?.catalogueVersion || '';
  merged.lookup_error_category = vaccineInfo?.errorCategory || '';
  merged.inventory_expiry = merged.expiry || merged.nvc_lot_expiry || null;
  merged.expiry_flag = expiryStatus.flag;
  merged.expiry_days_remaining = expiryStatus.daysRemaining;
  merged.expiry_source = expirySource;
  merged.lookup_error = vaccineInfo?.error || '';
  return merged;
}

async function enrichParsedData(baseData, mode = activeMode) {
  let vaccineInfo = null;
  let lookupAttempted = false;

  if (baseData.lot) {
    try {
      lookupAttempted = true;
      vaccineInfo = await lookupVaccineInfo(
        baseData.lot,
        baseData.gtin,
        mode !== 'inventory'
      );
    } catch (error) {
      vaccineInfo = {
        error: error.message || 'Lookup failed',
        errorCategory: 'unavailable'
      };
    }
  }

  const chosenExpiry = baseData.expiry || vaccineInfo?.lot_expiry || null;
  const expiredDate = globalThis.VaxLinkExpiryDate.expiredVaccineDate({
    ...baseData,
    nvc_lot_expiry: vaccineInfo?.lot_expiry
  });
  const expiryStatus = getExpiryStatus(expiredDate || chosenExpiry);
  const expirySource = baseData.expiry
    ? 'barcode'
    : vaccineInfo?.lot_expiry
      ? 'nvc'
      : 'none';
  if (lookupAttempted) {
    logAnalyticsEvent(
      vaccineInfo && !vaccineInfo.error ? 'lookup_success' : 'lookup_error',
      {
        workflow: mode,
        source: 'popup_lookup',
        vaccineLabel: vaccineInfo?.tradename || vaccineInfo?.generic_name || '',
        manufacturer: vaccineInfo?.manufacturer || '',
        expiryFlag: expiryStatus.flag
      }
    );
  }
  return mergeVaccineInfoIntoParsedData(
    baseData,
    vaccineInfo,
    expiryStatus,
    expirySource
  );
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

function isSupportedPanoramaUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      [
        'www.panorama.prod.ehealthontario.ca',
        'panorama.prod.ehealthontario.ca',
        'trpanoramadhir.prod.ehealthontario.ca'
      ].includes(url.hostname) &&
      /^\/(?:phsdsm\/)?ImmsWeb\/pages\/recordImms\//.test(url.pathname)
    );
  } catch (_) {
    return false;
  }
}

function getTabForFill(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) =>
      resolve(
        chrome.runtime.lastError ? null : tabs?.find((tab) => tab.id === tabId)
      )
    );
  });
}

function hasPanoramaIntegration(tabId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 1000);
    chrome.tabs.sendMessage(
      tabId,
      { action: 'getPanoramaIntegration' },
      { frameId: 0 },
      (response) => {
        clearTimeout(timer);
        resolve(!chrome.runtime.lastError && response?.supported === true);
      }
    );
  });
}

async function canFillPanoramaTab(tabId) {
  const tab = await getTabForFill(tabId);
  return (
    !!tab &&
    (tab.url
      ? isSupportedPanoramaUrl(tab.url)
      : await hasPanoramaIntegration(tabId))
  );
}

async function sendAutoFillMessage(
  tabId,
  data,
  callback = handleAutoFillResponse
) {
  const chartRequired = {
    success: false,
    error:
      'Open a supported Panorama immunization page. If it’s already open, refresh it and try again.'
  };
  if (!(await canFillPanoramaTab(tabId))) return callback(chartRequired);
  chrome.tabs.sendMessage(
    tabId,
    { action: 'autoFill', data },
    { frameId: 0 },
    (response) => {
      if (!chrome.runtime.lastError) return callback(response);
      const message = chrome.runtime.lastError.message || '';
      callback(
        message.includes('Receiving end does not exist')
          ? chartRequired
          : { success: false, error: `Message send failed: ${message}` }
      );
    }
  );
}

function handleAutoFillResponse(response) {
  if (response && response.success) {
    writeOutput('Chart auto-filled', 'success');
  } else if (response && response.pending) {
    writeOutput(
      'Choose Publicly Funded or Non-Publicly Funded on the chart to continue.',
      'info'
    );
  } else if (response && response.error) {
    writeOutput(response.error, 'error');
  } else {
    writeOutput('Could not auto-fill fields', 'error');
  }
}
