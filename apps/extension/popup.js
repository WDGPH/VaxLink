import './shared/workflow.js';
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
import { getExpiryStatus, parseInputData } from './popup-parser.js';
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
let unlockReviewRead = 0;
const SCANNER_LOCK_SESSION_KEY = 'vaxlink_scanner_lock_session_v1';
const REVIEWED_LOCK_SESSION_KEY = 'vaxlink_reviewed_lock_id';
const HELD_SCANS_KEY = 'vaxlink_pending_scan_inbox_v1';
const RECENT_CHART_LOTS_KEY = 'vaxlink_recent_chart_lots_v1';

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
  const name = document.getElementById('extensionName');
  if (name) name.textContent = manifest.name;
  if (version)
    version.textContent = `v${manifest.version_name || manifest.version}`;

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
    emptyMessage: '',
    summaryBuilder: buildMultipleInjectSummary
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
    summaryBuilder: buildInventorySummary,
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

  document
    .getElementById('dismissUnlockReview')
    ?.addEventListener('click', async () => {
      const sessionId =
        document.getElementById('unlockReview')?.dataset.session;
      if (!sessionId) return;
      try {
        await setLocalStorage({ [REVIEWED_LOCK_SESSION_KEY]: sessionId });
      } catch (error) {
        writeOutput(
          error.message || 'Could not dismiss the lock summary.',
          'error'
        );
      }
    });
  loadNVCStatus();
  void renderHeldScannerScans();
  void loadUnlockReview();
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
      const review = document.createElement('p');
      review.textContent =
        {
          unknown_agent: 'Agent could not be identified. Verify the vaccine.',
          stale_chart:
            'Refresh the original chart after checking unsaved work.',
          inactive_chart: 'Check the original chart before entering this scan.',
          lock_unavailable: 'VaxLink could not check the workstation lock.',
          lock_unknown: 'The workstation lock status was unknown.'
        }[scan.reviewState] ||
        'Check the original chart before entering this scan.';

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
      row.append(label, review, barcode, discard);
      list.append(row);
    }
  } catch (error) {
    writeOutput(error.message, 'error');
  }
}

async function loadUnlockReview() {
  const panel = document.getElementById('unlockReview');
  if (!panel) return;
  const read = ++unlockReviewRead;
  try {
    const stored = await getLocalStorage([
      SCANNER_LOCK_SESSION_KEY,
      REVIEWED_LOCK_SESSION_KEY,
      HELD_SCANS_KEY,
      INVENTORY_BATCH_KEY
    ]);
    if (read !== unlockReviewRead) return;
    const session = stored[SCANNER_LOCK_SESSION_KEY];
    const count = (rows) =>
      Array.isArray(rows)
        ? rows.filter((row) => row.lock_session_id === session?.id).length
        : 0;
    const held = count(stored[HELD_SCANS_KEY]);
    const inventory = count(stored[INVENTORY_BATCH_KEY]);
    panel.hidden =
      !session?.id ||
      session.state !== 'active' ||
      session.id === stored[REVIEWED_LOCK_SESSION_KEY] ||
      (!held && !inventory && !session.interrupted);
    if (panel.hidden) return;
    panel.dataset.session = session.id;
    document.getElementById('unlockReviewText').textContent =
      `${held} in Held scanner scans · ${inventory} in the Inventory tray`;
    document.getElementById('unlockInterruption').hidden = !session.interrupted;
  } catch (error) {
    if (read === unlockReviewRead)
      writeOutput(error.message || 'Could not read the lock summary.', 'error');
  }
}

async function loadRecentChartLots() {
  try {
    const stored = await chrome.storage.session.get(RECENT_CHART_LOTS_KEY);
    renderRecentChartLots(stored[RECENT_CHART_LOTS_KEY]);
  } catch (_) {
    renderRecentChartLots([]);
  }
}

function renderRecentChartLots(history) {
  const recent = Array.isArray(history) ? history : [];
  for (const mode of ['immunization', 'inventory']) {
    const list = document.getElementById(`${mode}RecentChartLots`);
    if (!list) continue;
    if (!recent.length) {
      const empty = document.createElement('li');
      empty.textContent = 'No recent scans.';
      list.replaceChildren(empty);
      continue;
    }
    list.replaceChildren(
      ...recent.map((row) => {
        const item = document.createElement('li');
        const label = document.createElement('div');
        const name = row.tradename || row.generic_name || row.name;
        const title = document.createElement('strong');
        title.textContent = name;
        const expiry =
          row.inventory_expiry || row.barcode_expiry || row.nvc_lot_expiry;
        const details = document.createElement('div');
        details.textContent = `Lot ${row.lot} · ${expiry ? `Expiry ${expiry}` : 'Expiry unknown'}`;
        label.append(title, details);
        const add = document.createElement('button');
        add.type = 'button';
        add.textContent = 'Add again';
        add.setAttribute('aria-label', `Add ${name}, lot ${row.lot} again`);
        add.addEventListener('click', () => void addRecentChartLot(row, mode));
        item.append(label, add);
        return item;
      })
    );
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
  if (area === 'session' && RECENT_CHART_LOTS_KEY in changes)
    renderRecentChartLots(changes[RECENT_CHART_LOTS_KEY]?.newValue);
  if (area === 'local' && AUTO_RESOLVE_FUNDING_KEY in changes)
    void loadAutofillSettings();
  if (
    area === 'local' &&
    [
      SCANNER_LOCK_SESSION_KEY,
      REVIEWED_LOCK_SESSION_KEY,
      HELD_SCANS_KEY,
      INVENTORY_BATCH_KEY
    ].some((key) => key in changes)
  )
    void loadUnlockReview();
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
  const title = panel === 'settings' ? 'Settings' : 'Local Activity';
  if (workflowHeader) workflowHeader.hidden = panel !== 'workflow';
  if (panelHeader) panelHeader.hidden = panel === 'workflow';
  if (panelTitle) panelTitle.textContent = title;
  closeButton?.setAttribute('aria-label', `Close ${title}`);
  closeButton?.setAttribute('title', `Close ${title}`);
  if (panel === 'settings') {
    initializeScannerSettings();
    void refreshRecentActivity?.();
  }
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
      <thead><tr><td></td><th scope="col">Today</th><th scope="col">All time</th></tr></thead>
      ${groups
        .map(
          ([title, labels]) => `
        <tbody aria-label="${escapeAnalyticsHtml(title)}">
          <tr class="activity-group"><th scope="rowgroup" colspan="3">${escapeAnalyticsHtml(title)}</th></tr>
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

function setupRecentActivityControls() {
  const section = document.getElementById('recentActivitySettings');
  if (!section) return;
  const toggle = document.getElementById('recentActivityToggle');
  const status = document.getElementById('recentActivityStatus');
  const notice = document.getElementById('recentActivityNotice');
  const exportButton = document.getElementById('exportRecentActivityBtn');
  let snapshot = null;
  let busy = false;
  let requestNumber = 0;

  function render(message) {
    if (!busy) toggle.checked = snapshot?.enabled === true;
    toggle.disabled = busy || !snapshot;
    exportButton.disabled = busy || !snapshot?.retained;
    const retained = snapshot?.retained ?? 0;
    status.textContent = snapshot
      ? `${retained.toLocaleString()} ${retained === 1 ? 'event' : 'events'}`
      : '';
    const overwritten = snapshot?.overwritten ?? 0;
    notice.textContent =
      message ||
      (overwritten
        ? `${overwritten.toLocaleString()} older ${overwritten === 1 ? 'event was' : 'events were'} removed to make room.`
        : '');
  }

  async function request(action = 'getRecentActivity', payload = {}) {
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
        downloadTextFile(
          'vaxlink-debug-details.json',
          JSON.stringify(
            { format, build, settingsAtExport, retained, overwritten, rows },
            null,
            2
          ),
          'application/json;charset=utf-8'
        );
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

async function handleUseMultipleInjectRecord(record) {
  if (trayUseInFlight || activeMode !== 'immunization') return;
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
    if (!chart?.supported)
      throw new Error(
        'Open a supported Panorama immunization page. If it’s already open, refresh it and try again.'
      );
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

    if (result.status === 'grid_added') {
      writeOutput(
        result.carryToDetails
          ? 'Added to the grid. Check that Enter Details opens the matching step.'
          : 'Added to the grid. The vaccine stays in the tray for Enter Details.',
        'success'
      );
      return;
    }
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
