import './shared/workflow.js';
import './shared/vaccine-label.js';
import { initializeScannerSettings } from './scanner-settings.js';
import {
  ScanQueueManager,
  buildQueueRecord,
  downloadScanCsv,
  INVENTORY_BATCH_KEY,
  MULTIPLE_INJECT_QUEUE_KEY
} from './popup-inventory.js';
import {
  getExpiryStatus,
  parseGS1Barcode,
  parseInputData
} from './popup-parser.js';
import {
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

const carrySupportPage = globalThis.location?.hash === '#carry-support';
let refreshNvcBtn;
let addBatchBtn;
let exportCsvBtn;
let clearInventoryBtn;
let clearMultipleBtn;
let immunizationModeBtn;
let inventoryModeBtn;
let multipleModeSection;
let inventoryModeSection;
let nvcStatusDiv;
let nvcStatusTimer;
let refreshRecentActivity;
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
let inventoryAddInFlight = false;
let multipleAddInFlight = false;
let queueSaveNoticeVersion = 0;
let multipleInjectManager;
let inventoryManager;
let activeMode = 'immunization';
let scannerStatusSnapshot = normalizeScannerStatusSnapshot(null);
let scannerCaptureError = false;
const HELD_SCANS_KEY = 'vaxlink_pending_scan_inbox_v1';
const heldScans = new Map();
const selectedHeldScans = new Set();
let heldScanRefresh = 0;
let heldScanActionBusy = false;
const RECENT_CHART_LOTS_KEY = 'vaxlink_recent_chart_lots_v1';
const SKIPPED_DOSE_HISTORY_KEY = 'vaxlink_skipped_dose_history_v1';

const {
  WORKFLOW_MODE_KEY,
  LEGACY_POPUP_MODE_KEY,
  SINGLE_SCAN_AUTOFILL_KEY,
  GRID_SCAN_AUTOFILL_KEY,
  GRID_DETAIL_AUTOFILL_KEY,
  normalizeWorkflowMode
} = globalThis.VaxLinkWorkflow;
const SETTINGS_PANEL_OPEN_KEY = 'vaxlink_settings_panel_open_v1';
const LEGACY_ADMIN_DATETIME_AUTOFILL_KEY =
  'vaxlink_administered_datetime_autofill_v1';
const ADMIN_DATE_AUTOFILL_KEY = 'vaxlink_administered_date_autofill_v1';
const ADMIN_TIME_AUTOFILL_KEY = 'vaxlink_administered_time_autofill_v1';
const LEGACY_REASON_CONSENT_AUTOFILL_KEY = 'vaxlink_reason_consent_autofill_v1';
const REASON_AUTOFILL_KEY = 'vaxlink_reason_autofill_v1';
const CONSENT_AUTOFILL_KEY = 'vaxlink_consent_autofill_v1';
const AUTO_RESOLVE_FUNDING_KEY = 'vaxlink_auto_resolve_funding_v1';

document.addEventListener('DOMContentLoaded', async () => {
  const version = document.getElementById('extensionVersion');
  const manifest = chrome.runtime.getManifest();
  if (version)
    version.textContent = `v${manifest.version_name || manifest.version}`;

  if (carrySupportPage) {
    settingsPanel = document.getElementById('settingsPanel');
    mainWorkflowPanel = document.getElementById('mainWorkflowPanel');
    for (const section of settingsPanel.children)
      section.hidden = section.id !== 'recentActivitySettings';
    refreshRecentActivity = setupRecentActivityControls();
    applyPopupPanel('settings');
    document.getElementById('recentActivitySettingsTitle')?.focus();
    document
      .getElementById('closePanelBtn')
      .addEventListener('click', () => globalThis.close());
    return;
  }

  refreshNvcBtn = document.getElementById('refreshNvcBtn');
  addBatchBtn = document.getElementById('addBatchBtn');
  exportCsvBtn = document.getElementById('exportCsvBtn');
  clearInventoryBtn = document.getElementById('clearInventoryBtn');
  clearMultipleBtn = document.getElementById('clearMultipleBtn');
  immunizationModeBtn = document.getElementById('immunizationModeBtn');
  inventoryModeBtn = document.getElementById('inventoryModeBtn');
  multipleModeSection = document.getElementById('multipleModeSection');
  inventoryModeSection = document.getElementById('inventoryModeSection');
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
  const moveToInventory = document.getElementById('moveToInventoryBtn');
  const moveToImmunization = document.getElementById('moveToImmunizationBtn');
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
    transferButton: moveToInventory,
    onCount: renderMultipleModeCount,
    onUseRecord: handleUseMultipleInjectRecord,
    onNotice: (message) => writeOutput(escapeHtml(message), 'error'),
    showUseAction: true,
    useButtonLabel: 'Use',
    emptySummary: 'Scan a vaccine barcode or choose Add to tray.',
    emptyMessage: ''
  });

  inventoryManager = new ScanQueueManager({
    storageKey: INVENTORY_BATCH_KEY,
    summaryEl: document.getElementById('inventorySummary'),
    listEl: document.getElementById('inventoryList'),
    clearButton: clearInventoryBtn,
    transferButton: moveToImmunization,
    onCount: renderInventoryCount,
    exportButton: exportCsvBtn,
    onNotice: (message) => writeOutput(escapeHtml(message), 'error'),
    emptySummary: 'Scan a vaccine barcode or choose Add to tray.',
    emptyMessage: '',
    exportFilenamePrefix: 'vaxlink-inventory'
  });

  await Promise.all([multipleInjectManager.load(), inventoryManager.load()]);
  bindTrayTransfer(moveToInventory, multipleInjectManager, 'Inventory');
  bindTrayTransfer(moveToImmunization, inventoryManager, 'Immunization');
  await loadWorkflowMode();
  refreshRecentActivity = setupRecentActivityControls();
  await loadSettingsPanelState();
  await loadAutofillSettings();
  await loadAnalyticsSummary();
  await loadScannerStatus();
  logAnalyticsEvent('popup_open', { workflow: activeMode, source: 'popup' });
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  chrome.storage.onChanged.addListener(handlePopupStorageChanged);

  for (const id of ['immunizationTrayMenu', 'inventoryTrayMenu']) {
    const menu = document.getElementById(id);
    if (!menu) continue;
    const summary = menu.querySelector('summary');
    menu.addEventListener('click', (event) => {
      if (event.target.closest('button')) {
        if (menu.contains(document.activeElement)) summary.focus();
        menu.open = false;
      }
    });
    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menu.open) {
        event.preventDefault();
        menu.open = false;
        summary.focus();
      }
    });
  }

  if (immunizationModeBtn) {
    immunizationModeBtn.addEventListener('click', () =>
      setActiveMode('immunization')
    );
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
        activeMode === 'immunization'
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

  for (const [id, key] of [
    ['singleScanAutofillToggle', SINGLE_SCAN_AUTOFILL_KEY],
    ['gridScanAutofillToggle', GRID_SCAN_AUTOFILL_KEY],
    ['gridDetailAutofillToggle', GRID_DETAIL_AUTOFILL_KEY]
  ]) {
    const toggle = document.getElementById(id);
    toggle?.addEventListener(
      'change',
      () => void setAutofillSetting(key, toggle.checked)
    );
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
      clearTimeout(nvcStatusTimer);
      setButtonBusy(refreshNvcBtn, true, 'Checking…');
      chrome.runtime.sendMessage({ action: 'refreshNVCBundle' }, (response) => {
        setButtonBusy(refreshNvcBtn, false);
        const failed = chrome.runtime.lastError;
        loadNVCStatus(
          failed
            ? 'Could not recheck the catalogue. Try again.'
            : formatNVCRefreshMessage(response),
          !failed && response?.success === true
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
  bindHeldScannerActions();
  void renderHeldScannerScans();
  void loadRecentChartLots();
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
  const refresh = ++heldScanRefresh;
  try {
    const result = await sendRuntimeMessage({ action: 'getHeldScannerScans' });
    if (refresh !== heldScanRefresh || !result?.success) return;
    host.hidden = !result.scans.length;
    document.getElementById('heldScannerScanCount').textContent =
      `Scans to review (${result.scans.length})`;
    list.replaceChildren();
    heldScans.clear();
    const legacyOccurrences = new Map();
    for (const scan of result.scans) {
      let key = scan.captureId;
      if (!key) {
        const snapshot = JSON.stringify(scan);
        const occurrence = (legacyOccurrences.get(snapshot) || 0) + 1;
        legacyOccurrences.set(snapshot, occurrence);
        key = `${occurrence}:${snapshot}`;
      }
      heldScans.set(key, scan);
      const row = document.createElement('li');
      const label = document.createElement('div');
      const title = document.createElement('strong');
      let lot;
      try {
        lot = parseGS1Barcode(scan.rawText).lot;
      } catch {
        // A held capture may contain a partial barcode.
      }
      title.textContent = lot ? `Lot ${lot}` : 'Scanner capture';
      const captured = new Date(scan.capturedAt);
      const time =
        scan.capturedAt && Number.isFinite(captured.getTime())
          ? `Received ${captured.toLocaleString(undefined, {
              dateStyle: 'short',
              timeStyle: 'medium'
            })}`
          : 'Time unknown';
      const reason =
        {
          unknown_agent: 'Agent unknown',
          stale_chart: 'Chart needs refresh',
          inactive_chart: 'Chart unavailable',
          lock_unavailable: 'Lock check unavailable',
          lock_unknown: 'Lock state unknown',
          expired: 'Expired vaccine',
          missing_lot: 'No lot number',
          parse_error: 'Unrecognized barcode',
          check_chart: 'Delivery unconfirmed',
          checking_chart: 'Awaiting verification'
        }[scan.reviewState] ||
        (scan.lock_session_id ? 'Captured while locked' : '');
      label.append(title, [time, reason].filter(Boolean).join(' · '));

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedHeldScans.has(key);
      checkbox.setAttribute(
        'aria-label',
        `Select ${title.textContent}, ${time}`
      );
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedHeldScans.add(key);
        else selectedHeldScans.delete(key);
        updateHeldScannerControls();
      });
      const barcode = document.createElement('input');
      barcode.readOnly = true;
      barcode.hidden = true;
      barcode.value = scan.rawText || '';
      barcode.setAttribute('aria-label', 'Full held barcode');
      const menu = document.createElement('details');
      menu.className = 'tray-menu';
      const summary = document.createElement('summary');
      summary.textContent = '⋯';
      summary.setAttribute(
        'aria-label',
        `Actions for ${title.textContent}, ${time}`
      );
      const options = document.createElement('div');
      options.className = 'tray-menu-options';
      const show = document.createElement('button');
      show.textContent = 'Show full barcode';
      function showBarcode() {
        barcode.hidden = false;
        show.textContent = 'Hide full barcode';
        menu.open = false;
        barcode.focus();
        barcode.select();
      }
      show.addEventListener('click', () => {
        if (barcode.hidden) return showBarcode();
        barcode.hidden = true;
        show.textContent = 'Show full barcode';
        menu.open = false;
        summary.focus();
      });
      menu.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          menu.open = false;
          summary.focus();
        }
      });
      const discard = document.createElement('button');
      discard.textContent = 'Discard scan';
      discard.addEventListener('click', () => {
        menu.open = false;
        summary.focus();
        void runHeldScannerAction('clear', [scan]);
      });
      options.append(show, discard);
      menu.append(summary, options);
      row.append(checkbox, label, menu, barcode);
      list.append(row);
    }
    for (const key of selectedHeldScans)
      if (!heldScans.has(key)) selectedHeldScans.delete(key);
    updateHeldScannerControls();
  } catch (error) {
    writeOutput(escapeHtml(error.message), 'error');
  }
}

function updateHeldScannerControls() {
  const selectAll = document.getElementById('selectHeldScans');
  const count = selectedHeldScans.size;
  selectAll.checked = count > 0 && count === heldScans.size;
  selectAll.indeterminate = count > 0 && count < heldScans.size;
  selectAll.disabled = heldScanActionBusy;
  document.getElementById('moveHeldScansBtn').disabled =
    heldScanActionBusy || !count;
  document.getElementById('exportHeldScansBtn').disabled =
    heldScanActionBusy || !count;
  document.getElementById('clearHeldScansBtn').disabled = heldScanActionBusy;
}

function bindHeldScannerActions() {
  const selectAll = document.getElementById('selectHeldScans');
  if (!selectAll) return;
  selectAll.addEventListener('change', () => {
    selectedHeldScans.clear();
    if (selectAll.checked)
      for (const key of heldScans.keys()) selectedHeldScans.add(key);
    for (const checkbox of document.querySelectorAll(
      '#heldScannerScanList input[type="checkbox"]'
    ))
      checkbox.checked = selectAll.checked;
    updateHeldScannerControls();
  });
  for (const operation of ['move', 'export', 'clear']) {
    document
      .getElementById(`${operation}HeldScansBtn`)
      .addEventListener('click', () => {
        const scans = [...heldScans]
          .filter(
            ([key]) => operation === 'clear' || selectedHeldScans.has(key)
          )
          .map(([, scan]) => scan);
        void runHeldScannerAction(operation, scans, operation !== 'export');
      });
  }
}

function confirmHeldScannerAction(operation, count) {
  const dialog = document.getElementById('heldScannerDialog');
  const clear = operation === 'clear';
  const scans = `${count} ${count === 1 ? 'scan' : 'scans'}`;
  document.getElementById('heldScannerDialogTitle').textContent = clear
    ? `Clear ${scans}?`
    : `Move ${scans} to a tray?`;
  document.getElementById('heldScannerDialogMessage').textContent = clear
    ? 'VaxLink will remove these scans from the review list.'
    : 'Check the original chart first if a scan may have filled it. Expired vaccines moved to Immunization are for reference only.';
  for (const button of dialog.querySelectorAll(
    'button[value]:not([value="cancel"])'
  ))
    button.hidden = clear !== (button.value === 'clear');
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue), {
      once: true
    });
    dialog.showModal();
  });
}

async function runHeldScannerAction(operation, scans, confirm = false) {
  if (!scans.length || heldScanActionBusy) return;
  const notice = document.getElementById('heldScannerNotice');
  heldScanActionBusy = true;
  try {
    const choice = confirm
      ? await confirmHeldScannerAction(operation, scans.length)
      : '';
    if (confirm && (!choice || choice === 'cancel')) return;
    updateHeldScannerControls();
    notice.textContent = '';
    const result = await sendRuntimeMessage({
      action: 'actOnHeldScannerScans',
      operation,
      scans,
      destination: operation === 'move' ? choice : undefined
    });
    if (!result?.success) throw new Error(result?.error || 'Try again.');
    let message;
    if (operation === 'export') {
      downloadScanCsv(result.records, 'vaxlink-scans-to-review');
      message = `CSV download started for ${scans.length} ${scans.length === 1 ? 'scan' : 'scans'}.`;
    } else {
      const count = result.count;
      const quantity = `${count} ${count === 1 ? 'scan' : 'scans'}`;
      if (operation === 'clear') message = `Cleared ${quantity}.`;
      else {
        const tray = choice === 'inventory' ? 'Inventory' : 'Immunization';
        const remaining = scans.length - count;
        message = count ? `Moved ${quantity} to ${tray}. ` : '';
        if (remaining)
          message += `${remaining} could not be moved. Scans need a readable lot and must finish any chart verification.`;
        message = message.trimEnd();
      }
      await renderHeldScannerScans();
    }
    if (document.getElementById('heldScannerScans').hidden)
      writeOutput(message, 'info');
    else notice.textContent = message;
  } catch (error) {
    notice.textContent = `Could not ${operation} scans. ${error.message}`;
  } finally {
    heldScanActionBusy = false;
    updateHeldScannerControls();
  }
}

async function loadRecentChartLots() {
  const [recent, skipped] = await Promise.allSettled([
    chrome.storage.session?.get(RECENT_CHART_LOTS_KEY),
    getLocalStorage([SKIPPED_DOSE_HISTORY_KEY])
  ]);
  renderRecentChartLots(
    recent.value?.[RECENT_CHART_LOTS_KEY],
    skipped.value?.[SKIPPED_DOSE_HISTORY_KEY]
  );
}

function renderRecentChartLots(history, skippedHistory) {
  const recent = Array.isArray(history) ? history : [];
  const skipped = Array.isArray(skippedHistory) ? skippedHistory : [];
  for (const mode of ['immunization', 'inventory']) {
    const list = document.getElementById(`${mode}RecentChartLots`);
    if (!list) continue;
    const rows = [
      ...(mode === 'immunization'
        ? skipped.map((row) => ({ row, restore: true }))
        : []),
      ...recent.map((row) => ({ row, restore: false }))
    ];
    if (!rows.length) {
      const empty = document.createElement('li');
      empty.textContent = 'No recent scans.';
      list.replaceChildren(empty);
      continue;
    }
    list.replaceChildren(
      ...rows.map(({ row, restore }) => {
        const item = document.createElement('li');
        const label = document.createElement('div');
        const name = row.tradename || row.generic_name || row.name;
        const title = document.createElement('strong');
        title.textContent = name;
        const expiry =
          row.inventory_expiry || row.barcode_expiry || row.nvc_lot_expiry;
        const details = document.createElement('div');
        details.textContent = `Lot ${row.lot} · ${expiry ? `Expiry ${expiry}` : 'Expiry unknown'}${restore ? ' · Removed from tray' : ''}`;
        label.append(title, details);
        const add = document.createElement('button');
        add.type = 'button';
        add.textContent = restore ? 'Restore' : 'Add again';
        add.setAttribute(
          'aria-label',
          restore
            ? `Restore ${name}, lot ${row.lot}`
            : `Add ${name}, lot ${row.lot} again`
        );
        add.addEventListener('click', () => {
          if (restore) void restoreSkippedDose(row, add);
          else void addRecentChartLot(row, mode);
        });
        item.append(label, add);
        return item;
      })
    );
  }
}

async function restoreSkippedDose(row, button) {
  button.disabled = true;
  try {
    const response = await sendRuntimeMessage({
      action: 'mutateQueue',
      operation: 'restore_skipped_dose',
      storageKey: MULTIPLE_INJECT_QUEUE_KEY,
      payload: { id: row.id }
    });
    if (!response?.success)
      throw new Error(response?.error || 'Could not restore this scan.');
    writeOutput('Scan restored to the Immunization tray.', 'success');
  } catch (error) {
    writeOutput(escapeHtml(error.message), 'error');
  } finally {
    button.disabled = false;
    void loadRecentChartLots();
  }
}

async function addRecentChartLot(row, mode) {
  const dialog = document.getElementById('recentChartLotDialog');
  if (dialog.open) return;
  const inventory = mode === 'inventory';
  const destination = inventory ? 'Inventory' : 'Immunization';
  const expired =
    !inventory && globalThis.VaxLinkExpiryDate.isExpiredVaccine(row);
  const reference = expired
    ? ' It will be saved for reference. VaxLink will block chart entry.'
    : '';
  document.getElementById('recentChartLotMessage').textContent =
    `Add ${row.tradename || row.generic_name || row.name}, lot ${row.lot}, to the ${destination} tray?${reference}`;
  dialog.returnValue = '';
  const confirmed = await new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => resolve(dialog.returnValue === 'add'),
      { once: true }
    );
    dialog.showModal();
  });
  if (!confirmed) return;
  try {
    const response = await sendRuntimeMessage({
      action: 'mutateQueue',
      operation: 'add_from_history',
      storageKey: inventory ? INVENTORY_BATCH_KEY : MULTIPLE_INJECT_QUEUE_KEY,
      payload: { id: row.id, confirmed, confirmExpired: expired }
    });
    if (!response?.success)
      throw new Error(response?.error || 'Could not add the recent lot.');
    if (!response.alreadyInTray)
      logAnalyticsEvent('queue_saved', {
        workflow: mode,
        queue: inventory ? 'inventory' : 'multiple',
        source: 'popup',
        queueSizeAfter: response.rows?.length || 0
      });
    writeOutput(
      response.alreadyInTray
        ? `This lot is already in the ${destination} tray.`
        : `Lot added to ${destination}.`,
      response.alreadyInTray ? 'info' : 'success'
    );
  } catch (error) {
    writeOutput(escapeHtml(error.message), 'error');
  }
}

function handlePopupStorageChanged(changes, area) {
  if (
    (area === 'session' && RECENT_CHART_LOTS_KEY in changes) ||
    (area === 'local' && SKIPPED_DOSE_HISTORY_KEY in changes)
  )
    void loadRecentChartLots();
  if (area === 'local' && AUTO_RESOLVE_FUNDING_KEY in changes)
    void loadAutofillSettings();
  if (area === 'local' && HELD_SCANS_KEY in changes)
    void renderHeldScannerScans();
}

function renderInventoryCount(count) {
  if (inventoryQueueCount) inventoryQueueCount.textContent = String(count);
}

function renderMultipleModeCount(count) {
  const normalized = Math.max(0, Number.parseInt(count, 10) || 0);
  if (multipleQueueCount) multipleQueueCount.textContent = String(normalized);
  if (immunizationModeBtn)
    immunizationModeBtn.textContent =
      normalized > 0 ? `Immunization (${normalized})` : 'Immunization';
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
  const title = carrySupportPage
    ? 'Report an autofill issue'
    : panel === 'settings'
      ? 'Settings'
      : 'Local Activity';
  if (workflowHeader) workflowHeader.hidden = panel !== 'workflow';
  if (panelHeader) panelHeader.hidden = panel === 'workflow';
  if (panelTitle) panelTitle.textContent = title;
  closeButton?.setAttribute('aria-label', `Close ${title}`);
  closeButton?.setAttribute('title', `Close ${title}`);
  if (panel === 'settings') {
    if (!carrySupportPage) initializeScannerSettings();
    void refreshRecentActivity?.();
  }
  if (settingsPanel) {
    settingsPanel.hidden = panel !== 'settings';
  }
  if (mainWorkflowPanel) mainWorkflowPanel.hidden = panel !== 'workflow';
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
      document.getElementById('singleScanAutofillToggle'),
      SINGLE_SCAN_AUTOFILL_KEY
    ],
    [document.getElementById('gridScanAutofillToggle'), GRID_SCAN_AUTOFILL_KEY],
    [
      document.getElementById('gridDetailAutofillToggle'),
      GRID_DETAIL_AUTOFILL_KEY
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
  const metrics = (day) => {
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
      'Autofills verified': day.autofill?.success || 0,
      'Inventory exports': day.exports?.inventoryCount || 0,
      'Expiry notices shown': day.expiry?.noticesShown ?? '—',
      'Scanner captures': scannerCaptures,
      'Manual entries': manualEntries,
      'Immunization tray adds': day.queues?.multipleSaved || 0,
      'Doses used from tray': day.queues?.multipleUsed || 0,
      'Grid autofills attempted': day.chartResume?.chart_carry_attempt || 0,
      'Grid autofills verified': day.chartResume?.chart_carry_completed || 0,
      'Used from tray after a chart check failed':
        day.chartResume?.chart_carry_manual_use || 0,
      'Locked batches resumed': day.chartResume?.locked_batch_resumed || 0,
      'Batch resumes interrupted':
        day.chartResume?.locked_batch_interrupted || 0
    };
  };
  const todayMetrics = metrics(summary.today || {});
  const allMetrics = metrics(summary.rollup || {});
  const renderRow = (label) => `
    <tr><th scope="row">${escapeHtml(label)}</th><td>${formatAnalyticsNumber(todayMetrics[label])}</td><td>${formatAnalyticsNumber(allMetrics[label])}</td></tr>
  `;
  const groups = [
    [
      'Scanning',
      ['Scans', 'Scanner captures', 'Manual entries', 'Expiry notices shown']
    ],
    [
      'Charting',
      [
        'Autofills verified',
        'Doses used from tray',
        'Grid autofills attempted',
        'Grid autofills verified',
        'Used from tray after a chart check failed',
        'Locked batches resumed',
        'Batch resumes interrupted'
      ]
    ],
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
      <thead><tr><td></td><th scope="col">Today</th><th scope="col">All time</th></tr></thead>
      ${groups
        .map(
          ([title, labels]) => `
        <tbody aria-label="${escapeHtml(title)}">
          <tr class="activity-group"><th scope="rowgroup" colspan="3">${escapeHtml(title)}</th></tr>
          ${labels.map(renderRow).join('')}
        </tbody>
      `
        )
        .join('')}
    </table>
  `;
}

function formatAnalyticsNumber(value) {
  if (typeof value === 'string') return value;
  const num = Number(value) || 0;
  return num.toLocaleString();
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

function setupRecentActivityControls() {
  const section = document.getElementById('recentActivitySettings');
  if (!section) return;
  const toggle = document.getElementById('recentActivityToggle');
  const status = document.getElementById('recentActivityStatus');
  const notice = document.getElementById('recentActivityNotice');
  const exportButton = document.getElementById('exportRecentActivityBtn');
  const emailButton = document.getElementById('emailRecentActivityBtn');
  const emailLink = document.getElementById('openSupportEmailLink');
  const filename = 'vaxlink-debug-details.json';
  const subject = carrySupportPage
    ? 'VaxLink autofill issue'
    : 'VaxLink troubleshooting details';
  const body = [
    carrySupportPage
      ? 'VaxLink did not fill the expected vaccine details.'
      : 'I need help with VaxLink.',
    '',
    'I downloaded the Debug log from VaxLink Settings.',
    `[Attach ${filename} from Downloads before sending.]`,
    '',
    'Describe what happened here.'
  ].join('\r\n');
  emailLink.href = `mailto:innovation@wdgpublichealth.ca?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  let snapshot = null;
  let busy = false;
  let requestNumber = 0;

  function render(message) {
    if (!busy) toggle.checked = snapshot?.enabled === true;
    toggle.disabled = busy || !snapshot;
    exportButton.disabled = busy || !snapshot?.retained;
    emailButton.disabled = exportButton.disabled;
    const retained = snapshot?.retained ?? 0;
    status.textContent = snapshot
      ? `${retained.toLocaleString()} ${retained === 1 ? 'event' : 'events'}`
      : '';
    const overwritten = snapshot?.overwritten ?? 0;
    notice.textContent =
      message ||
      (overwritten
        ? `${overwritten.toLocaleString()} older ${overwritten === 1 ? 'event was' : 'events were'} removed to make room.`
        : carrySupportPage && !retained
          ? snapshot?.enabled
            ? 'Recording is on. Reproduce the issue on a training chart.'
            : 'Turn on troubleshooting before reproducing the issue on a training chart.'
          : carrySupportPage
            ? 'Review the downloaded details, then attach them to the email draft.'
            : '');
  }

  async function request(
    action = 'getRecentActivity',
    payload = {},
    email = false
  ) {
    if (busy) return;
    const number = ++requestNumber;
    if (action !== 'getRecentActivity') {
      busy = true;
      render();
    }
    let message;
    try {
      const result = await sendRuntimeMessage({ action, ...payload });
      if (number !== requestNumber) return;
      if (!result?.success) throw new Error();
      snapshot = result;
      if (action === 'exportRecentActivity') {
        const { format, build, settingsAtExport, retained, overwritten, rows } =
          result;
        if (!retained) {
          message = 'There are no troubleshooting details to share.';
          return;
        }
        const log = JSON.stringify(
          { format, build, settingsAtExport, retained, overwritten, rows },
          null,
          2
        );
        downloadTextFile(filename, log, 'application/json;charset=utf-8');
        if (email) {
          message = `Attach ${filename} from Downloads after reviewing it.`;
          emailLink.hidden = false;
          emailLink.click();
        }
      }
    } catch (_) {
      message = 'Could not access troubleshooting details. Try again.';
    } finally {
      if (number === requestNumber) {
        busy = false;
        render(message);
      }
    }
  }

  section.hidden = false;
  toggle.addEventListener(
    'change',
    () => void request('setRecentActivity', { enabled: toggle.checked })
  );
  exportButton.addEventListener(
    'click',
    () => void request('exportRecentActivity')
  );
  emailButton.addEventListener(
    'click',
    () => void request('exportRecentActivity', {}, true)
  );
  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      area === 'session' &&
      changes.vaxlink_recent_activity_v1 &&
      !settingsPanel?.hidden
    )
      void request();
  });
  return request;
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

async function loadWorkflowMode() {
  try {
    const stored = await getLocalStorage([
      WORKFLOW_MODE_KEY,
      LEGACY_POPUP_MODE_KEY
    ]);
    await setActiveMode(normalizeWorkflowMode(stored), {
      persist: false,
      track: false
    });
  } catch (_) {
    await setActiveMode('immunization', { persist: false, track: false });
  }
}

async function setActiveMode(mode, options = {}) {
  const previousMode = activeMode;
  activeMode = mode === 'inventory' ? 'inventory' : 'immunization';
  toggleModeButton(immunizationModeBtn, activeMode === 'immunization');
  toggleModeButton(inventoryModeBtn, activeMode === 'inventory');
  if (multipleModeSection)
    multipleModeSection.hidden = activeMode !== 'immunization';
  if (inventoryModeSection)
    inventoryModeSection.hidden = activeMode !== 'inventory';
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

function loadNVCStatus(message, confirmed = false) {
  chrome.runtime.sendMessage({ action: 'getNVCUpdateStatus' }, (status) => {
    if (chrome.runtime.lastError || !status) {
      if (nvcStatusDiv) {
        nvcStatusDiv.hidden = false;
        nvcStatusDiv.textContent =
          'NVC status could not be checked. Try Recheck.';
      }
      return;
    }
    renderNVCStatus(status, nvcStatusDiv, message);
    clearTimeout(nvcStatusTimer);
    if (status.state === 'refreshing' || confirmed)
      nvcStatusTimer = setTimeout(loadNVCStatus, confirmed ? 6000 : 1000);
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

function setTrayEntryOpen(panel, toggle, input, open) {
  if (!panel || !toggle) return;
  panel.hidden = !open;
  toggle.textContent = open ? 'Close barcode entry' : 'Add to tray';
  toggle.setAttribute('aria-expanded', String(open));
  if (open) input?.focus();
  else {
    const menuTrigger = toggle.closest?.('details')?.querySelector('summary');
    (menuTrigger || toggle).focus();
  }
}

function setInventoryEntryOpen(open) {
  setTrayEntryOpen(
    inventoryEntryPanel,
    inventoryEntryToggleBtn,
    inventoryBarcodeInput,
    open
  );
}

function setQueueEntryOpen(open) {
  setTrayEntryOpen(
    queueEntryPanel,
    queueEntryToggleBtn,
    queueBarcodeInput,
    open
  );
}

function bindTrayTransfer(button, source, destination) {
  button?.addEventListener('click', async () => {
    const rows = source.getSelectedRows();
    if (!rows.length || button.dataset.moving) return;
    button.dataset.moving = 'true';
    try {
      const expired =
        destination === 'Immunization' &&
        rows.some(globalThis.VaxLinkExpiryDate.isExpiredVaccine);
      if (
        expired &&
        !(await confirmExpiredTrayAdd(
          'Expired lots move for reference. VaxLink will block chart entry.'
        ))
      )
        return;
      const count = await source.transfer(
        rows.map(({ id }) => id),
        expired
      );
      writeOutput(`Moved ${count} scans to ${destination}.`, 'success');
    } catch (error) {
      writeOutput(escapeHtml(error.message), 'error');
    } finally {
      delete button.dataset.moving;
    }
  });
}

function confirmExpiredTrayAdd(message) {
  const dialog = document.getElementById('expiredTrayDialog');
  if (dialog.open) return Promise.resolve(false);
  document.getElementById('expiredTrayMessage').textContent = message;
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
    if (
      expired &&
      !(await confirmExpiredTrayAdd(
        `Lot ${record.lot} has expired. You can save it for reference. VaxLink will block chart entry.`
      ))
    )
      return;
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

function recordPopupTrayUse(result) {
  void sendRuntimeMessage({ action: 'recordPopupTrayUse', result }).catch(
    () => {}
  );
}

async function handleUseMultipleInjectRecord(record) {
  if (trayUseInFlight || activeMode !== 'immunization') return;
  if (globalThis.VaxLinkExpiryDate.blocksChartUse(record)) return;
  trayUseInFlight = true;
  let outcome = 'blocked';
  recordPopupTrayUse('selected');
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
    if (!chart?.supported)
      throw new Error(
        'Open a supported Panorama immunization page. If it’s already open, refresh it and try again.'
      );
    if (!chart?.ready || !chart.formContext?.ready || !chart.contextToken) {
      throw new Error(
        'Open a supported Panorama form that is ready for entry.'
      );
    }
    outcome = 'error';
    const result = await chrome.tabs.sendMessage(
      tab.id,
      {
        action: 'useTrayVaccine',
        recordId: record.id,
        contextToken: chart.contextToken
      },
      { frameId: 0 }
    );
    outcome = 'blocked';
    if (result?.status === 'expired') return;
    if (!result?.success && !result?.pending)
      throw new Error(result?.error || 'Check the chart before trying again.');

    if (result.status === 'grid_added') {
      outcome = 'grid_added';
      writeOutput(
        result.carryToDetails
          ? 'Added to the grid. Check that Enter Details opens the matching step.'
          : 'Added to the grid. The vaccine stays in the tray for Enter Details.',
        'success'
      );
      return;
    }
    outcome = result.pending ? 'pending' : 'applied';
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
    recordPopupTrayUse(outcome);
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
