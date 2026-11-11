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
  renderNVCStatus,
  describePanoramaIntegration,
  formatNVCRefreshMessage,
  setButtonBusy,
  showOutput
} from './popup-ui.js';
import {
  SCANNER_DAEMON_ACTIONS,
  buildScannerStatusDescriptor,
  getScannerConnectionLabel,
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
let analyticsLabelInput;
let settingsToggleBtn;
let settingsPanel;
let analyticsToggleBtn;
let analyticsPanel;
let mainWorkflowPanel;
let saveAnalyticsLabelBtn;
let exportTodayAnalyticsBtn;
let exportAllAnalyticsBtn;
let resetAnalyticsBtn;
let adminDateTimeAutofillToggle;
let scannerSettingsFrame;
let settingsTabId = null;
let scannerSetupPrompt;
let scannerConnectionNote;
let continueWithoutScanner = false;
let reasonConsentAutofillToggle;
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
let adminDateTimeAutofillEnabled = true;
let scannerStatusSnapshot = normalizeScannerStatusSnapshot(null);
let scannerStatusSource = 'cached';
let scannerCaptureError = false;
let reasonConsentAutofillEnabled = true;

const WORKFLOW_MODE_KEY = 'vaxlink_workflow_mode_v1';
const LEGACY_POPUP_MODE_KEY = 'vaxlink_popup_mode_v1';
const LEGACY_REMOTE_MODE_KEY = 'hands_free_scan_mode_v1';
const LEGACY_HANDS_FREE_KEY = 'hands_free_scan_autofill_enabled';
const ANALYTICS_STORAGE_KEY = 'vaxlink_analytics_v1';
const SETTINGS_PANEL_OPEN_KEY = 'vaxlink_settings_panel_open_v1';
const ADMIN_DATETIME_AUTOFILL_KEY = 'vaxlink_administered_datetime_autofill_v1';
const REASON_CONSENT_AUTOFILL_KEY = 'vaxlink_reason_consent_autofill_v1';

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
  // Channel badge: only the alpha channel shows it. The manifest name is the
  // channel discriminator — "VaxLink Alpha" in git/unpacked and in alpha zips,
  // "VaxLink" stamped by scripts/package-extension.sh for prod uploads.
  const alphaBadge = document.getElementById('alphaBadge');
  if (alphaBadge && /alpha/i.test(chrome.runtime.getManifest().name || '')) {
    alphaBadge.hidden = false;
  }

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
  analyticsLabelInput = document.getElementById('analyticsLabelInput');
  settingsToggleBtn = document.getElementById('settingsToggleBtn');
  settingsPanel = document.getElementById('settingsPanel');
  analyticsToggleBtn = document.getElementById('analyticsToggleBtn');
  analyticsPanel = document.getElementById('analyticsPanel');
  mainWorkflowPanel = document.getElementById('mainWorkflowPanel');
  saveAnalyticsLabelBtn = document.getElementById('saveAnalyticsLabelBtn');
  exportTodayAnalyticsBtn = document.getElementById('exportTodayAnalyticsBtn');
  exportAllAnalyticsBtn = document.getElementById('exportAllAnalyticsBtn');
  resetAnalyticsBtn = document.getElementById('resetAnalyticsBtn');
  adminDateTimeAutofillToggle = document.getElementById(
    'adminDateTimeAutofillToggle'
  );
  scannerSettingsFrame = document.getElementById('scannerSettingsFrame');
  scannerSettingsFrame?.addEventListener('load', () => {
    const content = scannerSettingsFrame.contentDocument?.querySelector('main');
    if (!content) return;
    // Keep Settings on the popup's scrollbar as scanner connection text changes.
    new ResizeObserver(() => {
      const height = content.getBoundingClientRect().height;
      if (height > 0)
        scannerSettingsFrame.style.height = `${Math.ceil(height)}px`;
    }).observe(content);
  });
  scannerSetupPrompt = document.getElementById('scannerSetupPrompt');
  scannerConnectionNote = document.getElementById('scannerConnectionNote');
  reasonConsentAutofillToggle = document.getElementById(
    'reasonConsentAutofillToggle'
  );
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
  await loadAdminDateTimeAutofillSetting();
  await loadReasonConsentAutofillSetting();
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
      if (section) section.open = true;
      void setPopupPanel('settings');
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
  if (adminDateTimeAutofillToggle) {
    adminDateTimeAutofillToggle.addEventListener('change', () => {
      void setAdminDateTimeAutofillSetting(
        !!adminDateTimeAutofillToggle.checked
      );
    });
  }
  document
    .getElementById('checkPanoramaBtn')
    ?.addEventListener('click', async () => {
      const button = document.getElementById('checkPanoramaBtn');
      const result = document.getElementById('panoramaCheckResult');
      if (!Number.isSafeInteger(settingsTabId) || settingsTabId < 0) {
        result.textContent =
          'Select the Panorama tab to check, then reopen Settings in VaxLink.';
        return;
      }
      setButtonBusy(button, true, 'Checking…');
      try {
        const response = await sendRuntimeMessage({
          action: 'getWorkstationHealth',
          tabId: settingsTabId
        });
        result.textContent = describePanoramaIntegration(
          response?.success ? response.chart : null
        );
      } catch {
        result.textContent = describePanoramaIntegration(null);
      } finally {
        setButtonBusy(button, false);
      }
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
  if (reasonConsentAutofillToggle) {
    reasonConsentAutofillToggle.addEventListener('change', () => {
      void setReasonConsentAutofillSetting(
        !!reasonConsentAutofillToggle.checked
      );
    });
  }

  if (autoFillBtn) {
    autoFillBtn.addEventListener('click', async () => {
      if (!parsedData) {
        writeOutput(
          'Scan a barcode first. Parsing runs automatically.',
          'error'
        );
        return;
      }

      logAnalyticsEvent('autofill_attempt', {
        workflow: activeMode,
        source: 'popup_button',
        vaccineLabel:
          parsedData.tradename ||
          parsedData.generic_name ||
          parsedData.name ||
          parsedData.lot ||
          '',
        manufacturer: parsedData.manufacturer || '',
        expiryFlag:
          parsedData.expiry_flag ||
          getExpiryStatus(parsedData.inventory_expiry || parsedData.expiry).flag
      });
      try {
        const response = await sendAutoFillToActiveTab(parsedData);
        if (response && response.pending) {
          logAnalyticsEvent('autofill_result', {
            workflow: activeMode,
            source: 'popup_button',
            success: false,
            pending: true,
            vaccineLabel:
              parsedData.tradename ||
              parsedData.generic_name ||
              parsedData.name ||
              parsedData.lot ||
              '',
            manufacturer: parsedData.manufacturer || '',
            expiryFlag:
              parsedData.expiry_flag ||
              getExpiryStatus(parsedData.inventory_expiry || parsedData.expiry)
                .flag
          });
          writeOutput(
            'Choose Publicly Funded or Non-Publicly Funded on the chart to continue.',
            'info'
          );
          return;
        }
        logAnalyticsEvent('autofill_result', {
          workflow: activeMode,
          source: 'popup_button',
          success: true,
          vaccineLabel:
            parsedData.tradename ||
            parsedData.generic_name ||
            parsedData.name ||
            parsedData.lot ||
            '',
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
          vaccineLabel:
            parsedData.tradename ||
            parsedData.generic_name ||
            parsedData.name ||
            parsedData.lot ||
            '',
          manufacturer: parsedData.manufacturer || ''
        });
        writeOutput(error.message || 'Could not auto-fill fields', 'error');
      }
    });
  }

  if (clearMultipleBtn) {
    clearMultipleBtn.addEventListener('click', async () => {
      await multipleInjectManager.clear();
      logAnalyticsEvent('queue_cleared', {
        workflow: 'multiple',
        queue: 'multiple',
        source: 'popup_button'
      });
      writeOutput('Multiple Immunizations queue cleared.', 'info');
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
      if (nvcStatusDiv) nvcStatusDiv.textContent = 'NVC is refreshing.';

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

  if (saveAnalyticsLabelBtn) {
    saveAnalyticsLabelBtn.addEventListener('click', async () => {
      try {
        const store = await getLocalAnalyticsStore();
        store.deviceLabel = String(analyticsLabelInput?.value || '')
          .trim()
          .slice(0, 80);
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

  if (exportAllAnalyticsBtn) {
    exportAllAnalyticsBtn.addEventListener('click', async () => {
      await exportAnalyticsJson('pilot');
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
      writeOutput('Inventory queue cleared.', 'info');
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
    applyScannerStatus(request.status, 'live');
    return false;
  }
  if (
    request?.action === 'scannerDaemon.scanEcho' &&
    request.response?.success === false
  ) {
    scannerCaptureError = true;
    renderScannerStatusUi();
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
      applyScannerStatus(response.status, response.source);
      return;
    }
  } catch (_) {
    // Leave the last known UI in place if the daemon status is temporarily unavailable.
  }
  renderScannerStatusUi();
}

function loadScannerSettings() {
  // The explicit support check keeps the chart selected when Settings opened.
  // Opening Settings does not probe or change the form.
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    settingsTabId = chrome.runtime.lastError ? null : (tabs?.[0]?.id ?? null);
  });
  if (scannerSettingsFrame && !scannerSettingsFrame.getAttribute('src')) {
    scannerSettingsFrame.setAttribute(
      'src',
      chrome.runtime.getURL('scanner-setup.html')
    );
  }
  const manifest = chrome.runtime.getManifest();
  const info = document.getElementById('extensionInfo');
  if (info)
    info.textContent = `${manifest.name} · ${manifest.version_name || manifest.version}`;
}

function applyScannerStatus(status, source = 'cached') {
  scannerStatusSource = source;
  scannerStatusSnapshot = normalizeScannerStatusSnapshot(status);
  renderScannerStatusUi();
}

function renderScannerStatusUi() {
  const descriptor = buildScannerStatusDescriptor(scannerStatusSnapshot);
  const state = document.getElementById('scannerSettingsState');
  if (state)
    state.textContent = scannerCaptureError
      ? 'Scan needs review'
      : getScannerConnectionLabel(scannerStatusSnapshot, scannerStatusSource);

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
  if (panel === 'settings' && settingsPanel?.hidden) loadScannerSettings();
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
    applyAdminDateTimeAutofillSetting(
      normalizeAdminDateTimeAutofillSetting(stored)
    );
  } catch (_) {
    applyAdminDateTimeAutofillSetting(true);
  }
}

async function setAdminDateTimeAutofillSetting(enabled) {
  applyAdminDateTimeAutofillSetting(enabled);
  try {
    await setLocalStorage({
      [ADMIN_DATETIME_AUTOFILL_KEY]: adminDateTimeAutofillEnabled
    });
    writeOutput(
      adminDateTimeAutofillEnabled
        ? 'Date Administered auto-fill is enabled.'
        : 'Date Administered auto-fill is disabled.',
      'info'
    );
  } catch (error) {
    writeOutput(
      error.message || 'Could not update Date Administered auto-fill setting.',
      'error'
    );
  }
}

function normalizeReasonConsentAutofillSetting(stored) {
  return !(stored && stored[REASON_CONSENT_AUTOFILL_KEY] === false);
}

function applyReasonConsentAutofillSetting(enabled) {
  reasonConsentAutofillEnabled = !!enabled;
  if (reasonConsentAutofillToggle) {
    reasonConsentAutofillToggle.checked = reasonConsentAutofillEnabled;
  }
}

async function loadReasonConsentAutofillSetting() {
  try {
    const stored = await getLocalStorage([REASON_CONSENT_AUTOFILL_KEY]);
    applyReasonConsentAutofillSetting(
      normalizeReasonConsentAutofillSetting(stored)
    );
  } catch (_) {
    applyReasonConsentAutofillSetting(true);
  }
}

async function setReasonConsentAutofillSetting(enabled) {
  applyReasonConsentAutofillSetting(enabled);
  try {
    await setLocalStorage({
      [REASON_CONSENT_AUTOFILL_KEY]: reasonConsentAutofillEnabled
    });
    writeOutput(
      reasonConsentAutofillEnabled
        ? 'Reason for Immunization and Consent auto-fill is enabled.'
        : 'Reason for Immunization and Consent auto-fill is disabled.',
      'info'
    );
  } catch (error) {
    writeOutput(
      error.message || 'Could not update Reason/Consent auto-fill setting.',
      'error'
    );
  }
}

function logAnalyticsEvent(eventType, payload = {}) {
  void recordLocalAnalyticsEvent(eventType, payload)
    .then(() => loadAnalyticsSummary())
    .catch(() => undefined);
  chrome.runtime.sendMessage(
    { action: 'logAnalyticsEvent', eventType, payload },
    () => {
      void chrome.runtime.lastError;
    }
  );
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
      analyticsSummaryDiv.textContent =
        'Local activity is unavailable on this device.';
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
  const todayExpiryWarnings =
    (today.expiry?.expired || 0) + (today.expiry?.expiringSoon || 0);

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

  const deviceLabel = document.getElementById('activityDeviceLabel');
  if (deviceLabel)
    deviceLabel.textContent = summary.deviceLabel
      ? `On this device · ${summary.deviceLabel}`
      : 'On this device';
  const metadata = document.getElementById('deviceMetadata');
  if (metadata)
    metadata.textContent = `Device ID: ${summary.deviceId || 'Unavailable'}\nTracking began: ${formatAnalyticsDate(summary.firstSeenAt)}\nTracked days: ${formatAnalyticsNumber(summary.daysTracked)}`;
  analyticsSummaryDiv.innerHTML = `
    <div class="activity-today">
      ${renderAnalyticsMetric('Scans today', todayScans)}
      ${renderAnalyticsMetric('Forms filled today', todayAutofills)}
    </div>
    <div class="activity-secondary">
      ${renderAnalyticsMetric('Inventory exports today', todayInventoryExports)}
      ${renderAnalyticsMetric('Expiry warnings today', todayExpiryWarnings)}
    </div>
    <details class="activity-section">
      <summary>Pilot activity <small>Since tracking began</small></summary>
      <p class="settings-hint">Scans and form fills are counted separately. One scan may support several fills.</p>
      <div class="activity-secondary">
        ${renderAnalyticsMetric('Captured scans', pilotScans)}
        ${renderAnalyticsMetric('Forms filled', pilotAutofills)}
        ${renderAnalyticsMetric('Inventory exports', pilotExports)}
      </div>
    </details>
    <details class="activity-section">
      <summary>Technical details</summary>
      <div class="activity-secondary">
        ${renderAnalyticsMetric('Scanner captures today', todayLiveScans)}
        ${renderAnalyticsMetric('Popup entries today', todayPopupParses)}
        ${renderAnalyticsMetric('Multiple saves today', todayMultipleSaved)}
        ${renderAnalyticsMetric('Queue to chart, pilot total', pilotQueueUses)}
        ${renderAnalyticsMetric('Tracked days', summary.daysTracked)}
      </div>
    </details>
  `;
}

function formatAnalyticsDate(value) {
  const date = new Date(value || '');
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString()
    : 'Unavailable';
}

function renderAnalyticsMetric(label, value) {
  return `
    <div class="activity-metric">
      <span>${escapeAnalyticsHtml(label)}</span>
      <strong class="activity-metric-value">${formatAnalyticsNumber(value)}</strong>
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

async function getLocalAnalyticsStore() {
  const stored = await getLocalStorage([ANALYTICS_STORAGE_KEY]);
  return normalizeAnalyticsStore(stored[ANALYTICS_STORAGE_KEY]);
}

async function setLocalAnalyticsStore(store) {
  await setLocalStorage({
    [ANALYTICS_STORAGE_KEY]: normalizeAnalyticsStore(store)
  });
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
      single: {
        liveScans: 0,
        popupParses: 0,
        queueSaved: 0,
        queueUsed: 0,
        autofillSuccess: 0,
        autofillFailure: 0
      },
      multiple: {
        liveScans: 0,
        popupParses: 0,
        queueSaved: 0,
        queueUsed: 0,
        autofillSuccess: 0,
        autofillFailure: 0
      },
      inventory: {
        liveScans: 0,
        popupParses: 0,
        queueSaved: 0,
        queueUsed: 0,
        autofillSuccess: 0,
        autofillFailure: 0
      }
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
  const normalized =
    store && typeof store === 'object' ? store : createEmptyAnalyticsStore();
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

function analyticsDayKey(value = new Date()) {
  const date = new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function buildLocalAnalyticsEvent(eventType, payload = {}) {
  const ts = new Date().toISOString();
  return {
    eventType,
    ts,
    day: analyticsDayKey(ts),
    workflow: normalizeAnalyticsWorkflow(payload.workflow),
    queue: payload.queue ? normalizeAnalyticsQueue(payload.queue) : '',
    source: String(payload.source || '')
      .trim()
      .slice(0, 40),
    success: !!payload.success,
    count: safeAnalyticsCount(payload.count, 1),
    rows: safeAnalyticsCount(payload.rows, 0),
    queueSizeAfter: safeAnalyticsCount(payload.queueSizeAfter, 0),
    expiryFlag: payload.expiryFlag || '',
    vaccineLabel: String(payload.vaccineLabel || '')
      .trim()
      .slice(0, 60),
    manufacturer: String(payload.manufacturer || '')
      .trim()
      .slice(0, 60)
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
        day.queues.maxInventoryDepth = Math.max(
          day.queues.maxInventoryDepth,
          event.queueSizeAfter || 0
        );
        day.workflows.inventory.queueSaved += count;
      } else {
        day.queues.multipleSaved += count;
        day.queues.maxMultipleDepth = Math.max(
          day.queues.maxMultipleDepth,
          event.queueSizeAfter || 0
        );
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
  const todayKey = analyticsDayKey();
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
  const todayKey = analyticsDayKey();
  const selectedKeys = Object.keys(normalized.days)
    .sort()
    .filter((key) => (scope === 'today' ? key === todayKey : true));
  const days = Object.fromEntries(
    selectedKeys.map((key) => [key, normalized.days[key]])
  );
  return {
    exportedAt: new Date().toISOString(),
    scope,
    deviceId: normalized.deviceId,
    deviceLabel: normalized.deviceLabel || '',
    firstSeenAt: normalized.firstSeenAt || null,
    lastEventAt: normalized.lastEventAt || null,
    daysTracked: selectedKeys.length,
    days,
    rollup: aggregateAnalyticsDaysLocal(
      selectedKeys.map((key) => normalized.days[key])
    )
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
    rollup.workflows.single.popupParses +=
      day.workflows?.single?.popupParses || 0;
    rollup.workflows.multiple.liveScans +=
      day.workflows?.multiple?.liveScans || 0;
    rollup.workflows.multiple.popupParses +=
      day.workflows?.multiple?.popupParses || 0;
    rollup.workflows.inventory.liveScans +=
      day.workflows?.inventory?.liveScans || 0;
    rollup.workflows.inventory.popupParses +=
      day.workflows?.inventory?.popupParses || 0;
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
  const totalDoses =
    Number.isFinite(Number(record.total_doses)) &&
    Number(record.total_doses) > 0
      ? Number(record.total_doses)
      : '';
  const remainingDoses =
    Number.isFinite(Number(record.remaining_doses)) &&
    Number(record.remaining_doses) > 0
      ? Number(record.remaining_doses)
      : Number.isFinite(totalDoses)
        ? totalDoses
        : '';
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
    total_doses: totalDoses,
    remaining_doses: remainingDoses,
    dose_tracking: record.dose_tracking || 'manual',
    lookup_error: record.lookup_error || '',
    name:
      record.name || record.generic_name || record.tradename || record.din || ''
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
      if (nvcStatusDiv)
        nvcStatusDiv.textContent =
          'NVC status could not be checked. Try Refresh NVC Data.';
      return;
    }
    renderNVCStatus(status, nvcStatusDiv);
    if (status?.state === 'refreshing') setTimeout(loadNVCStatus, 1000);
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

async function lookupVaccineInfo(lot, gtin) {
  const lotKey = String(lot || '')
    .trim()
    .toLowerCase();
  if (!lotKey) {
    return { error: 'No lot number provided' };
  }
  const message = { action: 'lookupVaccineInfo', lot };
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
    const baseData = parseInputData(rawBarcode);
    if (!baseData.scanned_at) {
      baseData.scanned_at = new Date().toISOString();
    }
    const enriched = await enrichParsedData(baseData);
    const record = buildQueueRecord(enriched, rawBarcode);
    await multipleInjectManager.add(record);
    clearQueueSaveFailure(noticeVersion);
    logAnalyticsEvent('queue_saved', {
      workflow: 'multiple',
      queue: 'multiple',
      source: 'popup_manual_entry',
      count: 1,
      queueSizeAfter: multipleInjectManager.count,
      vaccineLabel:
        enriched.tradename ||
        enriched.generic_name ||
        enriched.name ||
        enriched.lot ||
        '',
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
        `✓ Added to Multiple Immunizations queue: ${label}`,
        'success'
      );
    }
  } catch (error) {
    showQueueSaveFailure(
      `Multiple Immunizations save not confirmed: ${error.message}. Check the queue before retrying.`
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
        const enriched = await enrichParsedData(baseData);
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
        vaccineLabel:
          lastRecord?.tradename ||
          lastRecord?.generic_name ||
          lastRecord?.name ||
          lastRecord?.lot ||
          '',
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
      `Inventory save not confirmed: ${error.message}. Check the queue before retrying.`
    );
  } finally {
    inventoryAddInFlight = false;
    setButtonBusy(addBatchBtn, false);
    if (inventoryEntryToggleBtn) inventoryEntryToggleBtn.disabled = false;
    if (cancelInventoryEntryBtn) cancelInventoryEntryBtn.disabled = false;
    if (closeEntry) setInventoryEntryOpen(false);
  }
}

async function handleUseMultipleInjectRecord(record) {
  const data = buildAutofillPayloadFromQueueRecord(record);
  if (!data) {
    writeOutput('Saved vaccine could not be loaded.', 'error');
    return;
  }
  data._vaxlinkQueueContext = {
    storageKey: MULTIPLE_INJECT_QUEUE_KEY,
    recordId: record.id,
    workflow: 'multiple',
    queue: 'multiple',
    source: 'queue'
  };

  parsedData = data;
  writeOutput(
    buildParsedOutputMarkup(data),
    outputTypeForExpiry(getExpiryStatus(data.inventory_expiry || data.expiry))
  );

  try {
    logAnalyticsEvent('autofill_attempt', {
      workflow: 'multiple',
      source: 'queue',
      vaccineLabel:
        record.tradename ||
        record.generic_name ||
        record.name ||
        record.lot ||
        '',
      manufacturer: record.manufacturer || '',
      expiryFlag:
        record.expiry_flag ||
        getExpiryStatus(record.inventory_expiry || record.barcode_expiry).flag
    });
    const response = await sendAutoFillToActiveTab(data);
    if (response && response.pending) {
      logAnalyticsEvent('autofill_result', {
        workflow: 'multiple',
        source: 'queue',
        success: false,
        pending: true,
        vaccineLabel:
          record.tradename ||
          record.generic_name ||
          record.name ||
          record.lot ||
          '',
        manufacturer: record.manufacturer || '',
        expiryFlag:
          record.expiry_flag ||
          getExpiryStatus(record.inventory_expiry || record.barcode_expiry).flag
      });
      writeOutput(
        'Choose Publicly Funded or Non-Publicly Funded on the chart to continue. The queue item will update after the lot is resolved.',
        'info'
      );
      return;
    }
    const remainingDoses = getQueueRemainingDoses(record, null);
    const nextRecord = await multipleInjectManager.consumeById(record.id);
    if (nextRecord) {
      multipleInjectManager.setActiveUse(nextRecord.id);
    } else {
      multipleInjectManager.setActiveUse('');
    }
    const updatedRemaining =
      remainingDoses === null
        ? null
        : nextRecord
          ? getQueueRemainingDoses(nextRecord, 1)
          : 0;
    logAnalyticsEvent('queue_used', {
      workflow: 'multiple',
      queue: 'multiple',
      source: 'queue',
      count: 1,
      queueSizeAfter: multipleInjectManager.count,
      vaccineLabel:
        record.tradename ||
        record.generic_name ||
        record.name ||
        record.lot ||
        '',
      manufacturer: record.manufacturer || '',
      expiryFlag:
        record.expiry_flag ||
        getExpiryStatus(record.inventory_expiry || record.barcode_expiry).flag
    });
    logAnalyticsEvent('autofill_result', {
      workflow: 'multiple',
      source: 'queue',
      success: true,
      vaccineLabel:
        record.tradename ||
        record.generic_name ||
        record.name ||
        record.lot ||
        '',
      manufacturer: record.manufacturer || '',
      expiryFlag:
        record.expiry_flag ||
        getExpiryStatus(record.inventory_expiry || record.barcode_expiry).flag
    });
    const label =
      record.tradename ||
      record.generic_name ||
      record.name ||
      record.lot ||
      'Saved vaccine';
    const dosesMessage =
      updatedRemaining !== null &&
      updatedRemaining > 0 &&
      updatedRemaining !== 1
        ? ` ${updatedRemaining} dose(s) remaining in this vial.`
        : '';
    writeOutput(
      record.lookup_error
        ? `Barcode fields filled. ${record.lookup_error}. Verify vaccine details on the chart.`
        : `${label} auto-filled from Multiple Immunizations queue.${dosesMessage}`,
      record.lookup_error ? 'warning' : 'success'
    );
  } catch (error) {
    logAnalyticsEvent('autofill_result', {
      workflow: 'multiple',
      source: 'queue',
      success: false,
      vaccineLabel:
        record.tradename ||
        record.generic_name ||
        record.name ||
        record.lot ||
        '',
      manufacturer: record.manufacturer || ''
    });
    writeOutput(error.message || 'Could not auto-fill fields', 'error');
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
    merged.tradename = vaccineInfo.tradename || merged.tradename || null;
    merged.generic_name =
      vaccineInfo.generic_name || merged.generic_name || null;
    merged.disease = vaccineInfo.disease || merged.disease || null;
    merged.antigen = vaccineInfo.antigen || merged.antigen || null;
    merged.manufacturer =
      vaccineInfo.manufacturer || merged.manufacturer || null;
    merged.nvc_lot_expiry =
      vaccineInfo.lot_expiry || merged.nvc_lot_expiry || null;
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
  const expirySource = baseData.expiry
    ? 'barcode'
    : vaccineInfo?.lot_expiry
      ? 'nvc'
      : 'none';
  if (lookupAttempted) {
    logAnalyticsEvent(
      vaccineInfo && !vaccineInfo.error ? 'lookup_success' : 'lookup_error',
      {
        workflow: activeMode,
        source: 'popup_lookup',
        vaccineLabel:
          vaccineInfo?.tradename ||
          vaccineInfo?.generic_name ||
          baseData.lot ||
          baseData.gtin ||
          '',
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
      url.pathname.toLowerCase().includes('/recordimms/')
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
  const unsupported = () =>
    callback({
      success: false,
      error: 'Open a supported Panorama immunization page.'
    });
  if (!(await canFillPanoramaTab(tabId))) return unsupported();
  chrome.tabs.sendMessage(
    tabId,
    { action: 'autoFill', data },
    { frameId: 0 },
    async (response) => {
      if (!chrome.runtime.lastError) return callback(response);
      const message = chrome.runtime.lastError.message || '';
      if (!message.includes('Receiving end does not exist')) {
        callback({ success: false, error: `Message send failed: ${message}` });
        return;
      }
      // Injection requires a current URL; a handshake cannot authorize injection.
      const tab = await getTabForFill(tabId);
      if (!tab?.url || !isSupportedPanoramaUrl(tab.url)) return unsupported();
      chrome.scripting.executeScript(
        {
          target: { tabId, frameIds: [0] },
          func: (expectedUrl) => {
            const url = new URL(location.href);
            return (
              location.href === expectedUrl &&
              url.protocol === 'https:' &&
              [
                'www.panorama.prod.ehealthontario.ca',
                'panorama.prod.ehealthontario.ca',
                'trpanoramadhir.prod.ehealthontario.ca'
              ].includes(url.hostname) &&
              url.pathname.toLowerCase().includes('/recordimms/')
            );
          },
          args: [tab.url]
        },
        (results) => {
          const documentId = results?.[0]?.documentId;
          if (
            chrome.runtime.lastError ||
            results?.[0]?.result !== true ||
            !documentId
          )
            return unsupported();
          chrome.scripting.executeScript(
            {
              target: { tabId, documentIds: [documentId] },
              files: [
                'build-info.js',
                'panorama-agent-rules.js',
                'shared/gs1-parser.js',
                'shared/expiry-date.js',
                'content.js'
              ]
            },
            () => {
              if (chrome.runtime.lastError) {
                callback({
                  success: false,
                  error: `Script injection failed: ${chrome.runtime.lastError.message}`
                });
                return;
              }
              chrome.tabs.sendMessage(
                tabId,
                { action: 'autoFill', data },
                { documentId },
                callback
              );
            }
          );
        }
      );
    }
  );
}

function handleAutoFillResponse(response) {
  if (chrome.runtime.lastError) {
    writeOutput(
      `Auto-fill failed: ${chrome.runtime.lastError.message}`,
      'error'
    );
    return;
  }

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
