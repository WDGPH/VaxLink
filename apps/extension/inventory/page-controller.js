import {
  LEGACY_INVENTORY_BATCH_KEY,
  SCANNER_BEEPS_KEY,
  ULTRA_FAST_SCANNER_KEY
} from './constants.js';
import { createInventoryAudio } from './audio.js';
import {
  buildAdvancedJsonPayload,
  buildHolidayMonitoringReportFile,
  buildInventoryCsvText,
  buildOpsPackageFiles,
  buildShipmentComparisonFile,
  buildShiftHandoffFile,
  downloadTextFile
} from './exports.js';
import { buildLegacyRowSignature, buildLegacyInventoryRows } from './model.js';
import { createInventoryRenderer } from './render.js';
import { parseInventoryLines } from './receive.js';
import { createInventoryRepository } from './repository.js';
import {
  getLocalStorage,
  removeLocalStorage,
  sendRuntimeMessage,
  setLocalStorage
} from './runtime.js';

const ACTIVE_TAB_STORAGE_KEY = 'vaxlink_inventory_active_tab_v1';

function getElements() {
  return {
    tabButtons: Array.from(document.querySelectorAll('[data-tab-btn]')),
    tabPanels: Array.from(document.querySelectorAll('[data-tab-panel], .tab-panel')),
    summaryEl: document.getElementById('summary'),
    tableHostEl: document.getElementById('tableHost'),
    reconHostEl: document.getElementById('reconHost'),
    ledgerHostEl: document.getElementById('ledgerHost'),
    fefoHostEl: document.getElementById('fefoHost'),
    doNotUseHostEl: document.getElementById('doNotUseHost'),
    statusEl: document.getElementById('status'),
    refreshBtn: document.getElementById('refreshBtn'),
    receiveBtn: document.getElementById('receiveBtn'),
    receiveInput: document.getElementById('receiveInput'),
    receiveSessionLabelInput: document.getElementById('receiveSessionLabelInput'),
    ultraFastToggle: document.getElementById('ultraFastToggle'),
    scannerBeepsToggle: document.getElementById('scannerBeepsToggle'),
    scanLiveIndicatorEl: document.getElementById('scanLiveIndicator'),
    exportBtn: document.getElementById('exportBtn'),
    exportPackageBtn: document.getElementById('exportPackageBtn'),
    exportJsonBtn: document.getElementById('exportJsonBtn'),
    clearBtn: document.getElementById('clearBtn'),
    signoffReconBtn: document.getElementById('signoffReconBtn'),
    exportHandoffBtn: document.getElementById('exportHandoffBtn'),
    saveWastageBtn: document.getElementById('saveWastageBtn'),
    wastageLotInput: document.getElementById('wastageLotInput'),
    wastageQtyInput: document.getElementById('wastageQtyInput'),
    wastageReasonSelect: document.getElementById('wastageReasonSelect'),
    wastageNoteInput: document.getElementById('wastageNoteInput'),
    saveIncidentBtn: document.getElementById('saveIncidentBtn'),
    incidentLotInput: document.getElementById('incidentLotInput'),
    incidentMinTempInput: document.getElementById('incidentMinTempInput'),
    incidentMaxTempInput: document.getElementById('incidentMaxTempInput'),
    incidentStartInput: document.getElementById('incidentStartInput'),
    incidentEndInput: document.getElementById('incidentEndInput'),
    incidentOutcomeSelect: document.getElementById('incidentOutcomeSelect'),
    incidentNoteInput: document.getElementById('incidentNoteInput'),
    doNotUseLotInput: document.getElementById('doNotUseLotInput'),
    doNotUseReasonInput: document.getElementById('doNotUseReasonInput'),
    markDoNotUseBtn: document.getElementById('markDoNotUseBtn'),
    clearDoNotUseBtn: document.getElementById('clearDoNotUseBtn'),
    shipmentCompareLabelInput: document.getElementById('shipmentCompareLabelInput'),
    shipmentCompareSignedByInput: document.getElementById('shipmentCompareSignedByInput'),
    shipmentCompareNoteInput: document.getElementById('shipmentCompareNoteInput'),
    shipmentCompareInput: document.getElementById('shipmentCompareInput'),
    shipmentCompareTargetEl: document.getElementById('shipmentCompareTarget'),
    shipmentCompareHostEl: document.getElementById('shipmentCompareHost'),
    buildShipmentCompareBtn: document.getElementById('buildShipmentCompareBtn'),
    saveShipmentCompareSignoffBtn: document.getElementById('saveShipmentCompareSignoffBtn'),
    exportShipmentCompareBtn: document.getElementById('exportShipmentCompareBtn'),
    monitoringProviderInput: document.getElementById('monitoringProviderInput'),
    monitoringLocationInput: document.getElementById('monitoringLocationInput'),
    monitoringCustodyInput: document.getElementById('monitoringCustodyInput'),
    monitoringDropoffDateInput: document.getElementById('monitoringDropoffDateInput'),
    monitoringReturnDateInput: document.getElementById('monitoringReturnDateInput'),
    monitoringIntakeByInput: document.getElementById('monitoringIntakeByInput'),
    monitoringNoteInput: document.getElementById('monitoringNoteInput'),
    monitoringItemsInput: document.getElementById('monitoringItemsInput'),
    monitoringSummaryEl: document.getElementById('monitoringSummary'),
    monitoringHostEl: document.getElementById('monitoringHost'),
    createMonitoringCaseBtn: document.getElementById('createMonitoringCaseBtn'),
    exportMonitoringBtn: document.getElementById('exportMonitoringBtn')
  };
}

function createEmptyState() {
  return {
    items: [],
    ledger: [],
    incidents: [],
    reconSignoffs: [],
    lotFlags: [],
    lotFlagsMap: {},
    shipmentComparisons: [],
    monitoringCases: []
  };
}

export async function startInventoryManagerPage() {
  const elements = getElements();
  const renderer = createInventoryRenderer(elements);
  const audio = createInventoryAudio();
  const repository = createInventoryRepository({
    getLocalStorage,
    setLocalStorage,
    removeLocalStorage
  });

  let state = createEmptyState();
  let ultraFastScannerEnabled = true;
  let scannerBeepsEnabled = true;
  let ignoreLegacyBatchChanges = false;
  let taskQueue = Promise.resolve();
  const physicalCounts = new Map();

  function getTabButtonId(button, index) {
    if (!button.id) {
      button.id = `inventory-tab-${index + 1}`;
    }
    return button.id;
  }

  function getAvailableTabTarget(targetId) {
    const normalizedTargetId = String(targetId || '').trim();
    if (normalizedTargetId) {
      const matchingPanel = elements.tabPanels.find((panel) => panel.id === normalizedTargetId);
      if (matchingPanel) {
        return normalizedTargetId;
      }
    }
    const firstButton = elements.tabButtons[0];
    return firstButton ? String(firstButton.dataset.tabTarget || '').trim() : '';
  }

  function setActiveTab(targetId, options = {}) {
    const resolvedTargetId = getAvailableTabTarget(targetId);
    elements.tabButtons.forEach((button, index) => {
      const buttonTargetId = String(button.dataset.tabTarget || '').trim();
      const isActive = buttonTargetId === resolvedTargetId;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
      button.tabIndex = isActive ? 0 : -1;
      if (options.focus && isActive) {
        button.focus();
      }
      const panel = elements.tabPanels.find((entry) => entry.id === buttonTargetId);
      if (panel) {
        panel.hidden = !isActive;
        panel.setAttribute('aria-labelledby', getTabButtonId(button, index));
      }
    });
    if (options.persist !== false && resolvedTargetId) {
      window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, resolvedTargetId);
    }
  }

  function renderState() {
    renderer.render(state, {
      physicalCounts,
      onPhysicalCountChange: handlePhysicalCountChange,
      onReturnMonitoringCase: (caseId) => {
        void queueTask(() => handleReturnMonitoringCase(caseId));
      }
    });
  }

  function focusReceiveInputIfNeeded() {
    if (elements.receiveInput && ultraFastScannerEnabled) {
      elements.receiveInput.focus();
    }
  }

  function handlePhysicalCountChange(key, value) {
    if (!value) {
      physicalCounts.delete(key);
    } else {
      physicalCounts.set(key, value);
    }
    renderState();
  }

  function applyState(nextState) {
    state = nextState;
    renderState();
  }

  function queueTask(task) {
    taskQueue = taskQueue.then(task, task);
    return taskQueue;
  }

  async function persistScannerSettings() {
    await setLocalStorage({
      [ULTRA_FAST_SCANNER_KEY]: ultraFastScannerEnabled,
      [SCANNER_BEEPS_KEY]: scannerBeepsEnabled
    });
  }

  async function loadScannerSettings() {
    const stored = await getLocalStorage([ULTRA_FAST_SCANNER_KEY, SCANNER_BEEPS_KEY]);
    ultraFastScannerEnabled = stored[ULTRA_FAST_SCANNER_KEY] !== false;
    scannerBeepsEnabled = stored[SCANNER_BEEPS_KEY] !== false;
    elements.ultraFastToggle.checked = ultraFastScannerEnabled;
    elements.scannerBeepsToggle.checked = scannerBeepsEnabled;
    audio.setEnabled(scannerBeepsEnabled);
    renderer.updateScanIndicator(ultraFastScannerEnabled);
  }

  function beginInternalLegacySyncWindow() {
    ignoreLegacyBatchChanges = true;
    window.setTimeout(() => {
      ignoreLegacyBatchChanges = false;
    }, 0);
  }

  async function refreshState() {
    state = await repository.loadState();
    applyState(state);
    renderer.renderStatus(
      `Loaded ${state.items.length} inventory record(s), ${state.ledger.length} transaction(s).`
    );
    focusReceiveInputIfNeeded();
  }

  async function handleReceive(lines, options = {}) {
    if (!lines.length) {
      renderer.renderStatus('Scan or paste at least one barcode line first.', 'error');
      audio.playErrorBeep();
      return;
    }

    elements.receiveBtn.disabled = true;
    try {
      const { records, failed } = await parseInventoryLines(lines, sendRuntimeMessage);
      if (!records.length) {
        renderer.renderStatus('No stock records were added. Check barcode or line format.', 'error');
        audio.playErrorBeep();
        return;
      }

      beginInternalLegacySyncWindow();
      state = await repository.receiveInventoryRows(records, {
        receiveSessionLabel: String(elements.receiveSessionLabelInput.value || '').trim()
      });
      applyState(state);
      if (!options.keepInput) {
        elements.receiveInput.value = '';
      }
      renderer.renderStatus(
        `Received ${records.length} stock item(s). ${failed ? `${failed} failed.` : ''}`.trim()
      );
      audio.playSuccessBeeps();
      focusReceiveInputIfNeeded();
    } catch (error) {
      renderer.renderStatus(error.message || 'Could not receive stock.', 'error');
      audio.playErrorBeep();
    } finally {
      elements.receiveBtn.disabled = false;
    }
  }

  async function handleCreateShipmentComparison() {
    const label = String(elements.shipmentCompareLabelInput.value || '').trim();
    const signedBy = String(elements.shipmentCompareSignedByInput.value || '').trim();
    const note = String(elements.shipmentCompareNoteInput.value || '').trim();
    const lines = String(elements.shipmentCompareInput.value || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length) {
      renderer.renderStatus('Paste expected shipment lines before creating a comparison.', 'error');
      audio.playErrorBeep();
      return;
    }

    try {
      const { records, failed } = await parseInventoryLines(lines, sendRuntimeMessage);
      if (!records.length) {
        renderer.renderStatus('Could not parse any expected shipment lines.', 'error');
        audio.playErrorBeep();
        return;
      }
      state = await repository.createShipmentComparison({
        shipmentLabel: label,
        expectedEntries: records,
        signedBy,
        note
      });
      applyState(state);
      renderer.renderStatus(
        `Shipment comparison saved with ${records.length} expected line(s). ${failed ? `${failed} failed to parse.` : ''}`.trim()
      );
      audio.playSuccessBeeps();
    } catch (error) {
      renderer.renderStatus(error.message || 'Could not create shipment comparison.', 'error');
      audio.playErrorBeep();
    }
  }

  async function handleSignShipmentComparison() {
    const comparison = state.shipmentComparisons[0];
    if (!comparison) {
      renderer.renderStatus('Create a shipment comparison before saving sign-off.', 'error');
      audio.playErrorBeep();
      return;
    }

    const signedBy = String(elements.shipmentCompareSignedByInput.value || '').trim();
    const note = String(elements.shipmentCompareNoteInput.value || '').trim();
    if (!signedBy) {
      renderer.renderStatus('Enter who reviewed the shipment comparison.', 'error');
      audio.playErrorBeep();
      return;
    }

    try {
      state = await repository.signShipmentComparison({
        comparisonId: comparison.id,
        signedBy,
        note
      });
      applyState(state);
      renderer.renderStatus('Shipment comparison sign-off saved locally.');
      audio.playSuccessBeeps();
    } catch (error) {
      renderer.renderStatus(error.message || 'Could not save shipment comparison sign-off.', 'error');
      audio.playErrorBeep();
    }
  }

  async function handleCreateMonitoringCase() {
    const providerName = String(elements.monitoringProviderInput.value || '').trim();
    const storageLocation = String(elements.monitoringLocationInput.value || '').trim();
    const custodyContact = String(elements.monitoringCustodyInput.value || '').trim();
    const dropoffDate = String(elements.monitoringDropoffDateInput.value || '').trim();
    const expectedReturnDate = String(elements.monitoringReturnDateInput.value || '').trim();
    const intakeBy = String(elements.monitoringIntakeByInput.value || '').trim();
    const note = String(elements.monitoringNoteInput.value || '').trim();
    const lines = String(elements.monitoringItemsInput.value || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (!providerName) {
      renderer.renderStatus('Enter the provider profile or clinic name for holiday monitoring.', 'error');
      audio.playErrorBeep();
      return;
    }
    if (!lines.length) {
      renderer.renderStatus('Scan or paste monitored vaccine lines before creating a holiday monitoring case.', 'error');
      audio.playErrorBeep();
      return;
    }

    try {
      const { records, failed } = await parseInventoryLines(lines, sendRuntimeMessage);
      if (!records.length) {
        renderer.renderStatus('Could not parse any holiday monitoring lines.', 'error');
        audio.playErrorBeep();
        return;
      }
      state = await repository.createMonitoringCase({
        providerName,
        storageLocation,
        custodyContact,
        dropoffDate,
        expectedReturnDate,
        intakeBy,
        note,
        items: records
      });
      applyState(state);
      elements.monitoringItemsInput.value = '';
      renderer.renderStatus(
        `Holiday monitoring case created for ${providerName}. ${records.length} item(s) captured.${failed ? ` ${failed} line(s) failed.` : ''}`
      );
      audio.playSuccessBeeps();
    } catch (error) {
      renderer.renderStatus(error.message || 'Could not create holiday monitoring case.', 'error');
      audio.playErrorBeep();
    }
  }

  async function handleReturnMonitoringCase(caseId) {
    const caseRecord = state.monitoringCases.find((entry) => entry.id === caseId);
    if (!caseRecord) {
      renderer.renderStatus('Could not find the selected monitoring case.', 'error');
      audio.playErrorBeep();
      return;
    }

    const returnedBy = window.prompt(
      `Mark holiday monitoring case for ${caseRecord.provider_name} as returned. Who completed the return?`,
      ''
    );
    if (returnedBy === null) {
      return;
    }
    const trimmedReturnedBy = String(returnedBy || '').trim();
    if (!trimmedReturnedBy) {
      renderer.renderStatus('Enter who completed the return workflow.', 'error');
      audio.playErrorBeep();
      return;
    }

    const returnNote = window.prompt(
      'Optional return note for this holiday monitoring case.',
      caseRecord.return_note || ''
    );

    try {
      state = await repository.returnMonitoringCase({
        caseId,
        returnedBy: trimmedReturnedBy,
        returnNote: returnNote === null ? '' : returnNote
      });
      applyState(state);
      renderer.renderStatus(`Holiday monitoring case for ${caseRecord.provider_name} marked as returned.`);
      audio.playSuccessBeeps();
    } catch (error) {
      renderer.renderStatus(error.message || 'Could not mark the holiday monitoring case as returned.', 'error');
      audio.playErrorBeep();
    }
  }

  async function handleWastage() {
    const lot = String(elements.wastageLotInput.value || '').trim();
    const qty = Number.parseInt(String(elements.wastageQtyInput.value || ''), 10);
    const reason = String(elements.wastageReasonSelect.value || 'other');
    const note = String(elements.wastageNoteInput.value || '').trim();

    if (!lot || !Number.isFinite(qty) || qty <= 0) {
      renderer.renderStatus('Enter lot and valid wastage quantity.', 'error');
      audio.playErrorBeep();
      return;
    }

    try {
      beginInternalLegacySyncWindow();
      const result = await repository.recordWastage({ lot, qty, reason, note });
      state = result.state;
      applyState(state);
      renderer.renderStatus(`Wastage recorded for lot ${lot}: ${result.consumed} dose(s).`);
      audio.playSuccessBeeps();
    } catch (error) {
      renderer.renderStatus(error.message || 'Could not record wastage.', 'error');
      audio.playErrorBeep();
    }
  }

  async function handleIncident() {
    const lot = String(elements.incidentLotInput.value || '').trim();
    const minTemp = String(elements.incidentMinTempInput.value || '').trim();
    const maxTemp = String(elements.incidentMaxTempInput.value || '').trim();
    const startedAt = String(elements.incidentStartInput.value || '').trim();
    const endedAt = String(elements.incidentEndInput.value || '').trim();
    const outcome = String(elements.incidentOutcomeSelect.value || 'quarantine');
    const note = String(elements.incidentNoteInput.value || '').trim();

    if (!minTemp && !maxTemp && !lot) {
      renderer.renderStatus('Add at least lot or temperature range for incident logging.', 'error');
      audio.playErrorBeep();
      return;
    }

    try {
      beginInternalLegacySyncWindow();
      state = await repository.recordIncident({
        lot,
        minTemp,
        maxTemp,
        startedAt,
        endedAt,
        outcome,
        note
      });
      applyState(state);
      renderer.renderStatus(`Incident logged${lot ? ` for lot ${lot}` : ''}.`);
      audio.playSuccessBeeps();
    } catch (error) {
      renderer.renderStatus(error.message || 'Could not record incident.', 'error');
      audio.playErrorBeep();
    }
  }

  async function handleSaveSignoff() {
    try {
      state = await repository.saveReconciliationSignoff(physicalCounts);
      applyState(state);
      renderer.renderStatus('Reconciliation sign-off saved locally.');
      audio.playSuccessBeeps();
    } catch (error) {
      renderer.renderStatus(error.message || 'Could not save reconciliation sign-off.', 'error');
      audio.playErrorBeep();
    }
  }

  async function handleSetDoNotUse(flagged) {
    const lot = String(elements.doNotUseLotInput.value || '').trim();
    if (!lot) {
      renderer.renderStatus('Enter a lot number for do-not-use update.', 'error');
      audio.playErrorBeep();
      return;
    }

    try {
      state = await repository.setDoNotUseLot({
        lot,
        flagged,
        reason: String(elements.doNotUseReasonInput.value || '').trim() || 'manual'
      });
      applyState(state);
      renderer.renderStatus(`${lot} ${flagged ? 'marked as Do Not Use' : 'removed from Do Not Use'}.`);
      audio.playSuccessBeeps();
    } catch (error) {
      renderer.renderStatus(error.message || 'Could not update do-not-use lot.', 'error');
      audio.playErrorBeep();
    }
  }

  async function handleClearInventory() {
    if (!window.confirm('Clear all local inventory records?')) {
      return;
    }

    try {
      beginInternalLegacySyncWindow();
      state = await repository.clearInventory();
      applyState(state);
      renderer.renderStatus('Inventory cleared.');
    } catch (error) {
      renderer.renderStatus(error.message || 'Could not clear inventory.', 'error');
    }
  }

  function exportInventoryCsv() {
    if (!state.items.length) {
      renderer.renderStatus('No inventory records to export.', 'error');
      return;
    }
    const filename = `vaxlink-inventory-manager-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    downloadTextFile(filename, buildInventoryCsvText(state.items), 'text/csv;charset=utf-8');
    renderer.renderStatus(`CSV export started: ${filename}`);
  }

  function exportOpsPackage() {
    const files = buildOpsPackageFiles(state, physicalCounts);
    files.forEach((file) => downloadTextFile(file.filename, file.content, file.mimeType));
    renderer.renderStatus(`Clinical CSV pack export started (${files.length} files).`);
  }

  function exportCurrentShipmentComparison() {
    const comparison = state.shipmentComparisons[0];
    if (!comparison) {
      renderer.renderStatus('Create a shipment comparison before exporting the report.', 'error');
      return;
    }
    const file = buildShipmentComparisonFile(comparison);
    downloadTextFile(file.filename, file.content, file.mimeType);
    renderer.renderStatus(`Shipment comparison export started: ${file.filename}`);
  }

  function exportMonitoringReport() {
    if (!state.monitoringCases.length) {
      renderer.renderStatus('No holiday monitoring cases to export.', 'error');
      return;
    }
    const file = buildHolidayMonitoringReportFile(state.monitoringCases);
    downloadTextFile(file.filename, file.content, file.mimeType);
    renderer.renderStatus(`Holiday monitoring report export started: ${file.filename}`);
  }

  function exportAdvancedJson() {
    const filename = `vaxlink-ops-package-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    downloadTextFile(
      filename,
      JSON.stringify(buildAdvancedJsonPayload(state), null, 2),
      'application/json;charset=utf-8'
    );
    renderer.renderStatus(`Advanced JSON export started: ${filename}`);
  }

  function exportShiftHandoff() {
    const file = buildShiftHandoffFile(state);
    downloadTextFile(file.filename, file.content, file.mimeType);
    renderer.renderStatus(`Shift handoff export started: ${file.filename}`);
  }

  elements.refreshBtn.addEventListener('click', () => {
    void queueTask(refreshState);
  });
  elements.tabButtons.forEach((button, index) => {
    getTabButtonId(button, index);
    button.addEventListener('click', () => {
      setActiveTab(button.dataset.tabTarget, { persist: true, focus: false });
    });
    button.addEventListener('keydown', (event) => {
      const navigationKeys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];
      if (!navigationKeys.includes(event.key)) {
        return;
      }
      event.preventDefault();
      let nextIndex = index;
      if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = elements.tabButtons.length - 1;
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        nextIndex = (index + 1) % elements.tabButtons.length;
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        nextIndex = (index - 1 + elements.tabButtons.length) % elements.tabButtons.length;
      }
      setActiveTab(elements.tabButtons[nextIndex].dataset.tabTarget, { persist: true, focus: true });
    });
  });
  elements.receiveBtn.addEventListener('click', () => {
    const lines = String(elements.receiveInput.value || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    void queueTask(() => handleReceive(lines));
  });
  elements.receiveInput.addEventListener('keydown', (event) => {
    if (!ultraFastScannerEnabled || event.key !== 'Enter') {
      return;
    }
    event.preventDefault();
    const value = String(elements.receiveInput.value || '').trim();
    if (!value) return;
    elements.receiveInput.value = '';
    void queueTask(() => handleReceive([value], { keepInput: true }));
  });
  elements.ultraFastToggle.addEventListener('change', () => {
    ultraFastScannerEnabled = !!elements.ultraFastToggle.checked;
    renderer.updateScanIndicator(ultraFastScannerEnabled);
    focusReceiveInputIfNeeded();
    void persistScannerSettings();
  });
  elements.scannerBeepsToggle.addEventListener('change', () => {
    scannerBeepsEnabled = !!elements.scannerBeepsToggle.checked;
    audio.setEnabled(scannerBeepsEnabled);
    void persistScannerSettings();
  });
  elements.buildShipmentCompareBtn.addEventListener('click', () => {
    void queueTask(handleCreateShipmentComparison);
  });
  elements.saveShipmentCompareSignoffBtn.addEventListener('click', () => {
    void queueTask(handleSignShipmentComparison);
  });
  elements.exportShipmentCompareBtn.addEventListener('click', exportCurrentShipmentComparison);
  elements.createMonitoringCaseBtn.addEventListener('click', () => {
    void queueTask(handleCreateMonitoringCase);
  });
  elements.exportMonitoringBtn.addEventListener('click', exportMonitoringReport);
  elements.saveWastageBtn.addEventListener('click', () => {
    void queueTask(handleWastage);
  });
  elements.saveIncidentBtn.addEventListener('click', () => {
    void queueTask(handleIncident);
  });
  elements.signoffReconBtn.addEventListener('click', () => {
    void queueTask(handleSaveSignoff);
  });
  elements.exportBtn.addEventListener('click', exportInventoryCsv);
  elements.exportPackageBtn.addEventListener('click', exportOpsPackage);
  elements.exportJsonBtn.addEventListener('click', exportAdvancedJson);
  elements.exportHandoffBtn.addEventListener('click', exportShiftHandoff);
  elements.markDoNotUseBtn.addEventListener('click', () => {
    void queueTask(() => handleSetDoNotUse(true));
  });
  elements.clearDoNotUseBtn.addEventListener('click', () => {
    void queueTask(() => handleSetDoNotUse(false));
  });
  elements.clearBtn.addEventListener('click', () => {
    void queueTask(handleClearInventory);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (ULTRA_FAST_SCANNER_KEY in changes) {
      ultraFastScannerEnabled = changes[ULTRA_FAST_SCANNER_KEY].newValue !== false;
      elements.ultraFastToggle.checked = ultraFastScannerEnabled;
      renderer.updateScanIndicator(ultraFastScannerEnabled);
    }
    if (SCANNER_BEEPS_KEY in changes) {
      scannerBeepsEnabled = changes[SCANNER_BEEPS_KEY].newValue !== false;
      elements.scannerBeepsToggle.checked = scannerBeepsEnabled;
      audio.setEnabled(scannerBeepsEnabled);
    }
    if (!(LEGACY_INVENTORY_BATCH_KEY in changes)) {
      return;
    }
    if (ignoreLegacyBatchChanges) {
      return;
    }
    const incomingRows = Array.isArray(changes[LEGACY_INVENTORY_BATCH_KEY].newValue)
      ? changes[LEGACY_INVENTORY_BATCH_KEY].newValue
      : [];
    const currentSignature = buildLegacyRowSignature(buildLegacyInventoryRows(state.items));
    const incomingSignature = buildLegacyRowSignature(incomingRows);
    if (currentSignature === incomingSignature) {
      return;
    }

    void queueTask(async () => {
      state = await repository.syncFromLegacyRows(incomingRows);
      applyState(state);
      renderer.renderStatus(
        `Inventory data updated: ${state.items.length} record(s), ${state.ledger.length} transaction(s).`
      );
    });
  });

  await loadScannerSettings();
  setActiveTab(window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY), { persist: false });
  await refreshState();
}
