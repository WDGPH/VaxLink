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
let parsedData = null;
let activeParseRequestId = 0;
let autoParseTimer = null;
let multipleInjectManager;
let inventoryManager;
let activeMode = 'single';

const lotLookupCache = new Map();
const WORKFLOW_MODE_KEY = 'vaxlink_workflow_mode_v1';
const LEGACY_POPUP_MODE_KEY = 'vaxlink_popup_mode_v1';
const LEGACY_REMOTE_MODE_KEY = 'hands_free_scan_mode_v1';
const LEGACY_HANDS_FREE_KEY = 'hands_free_scan_autofill_enabled';

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

  if (autoFillBtn) {
    autoFillBtn.addEventListener('click', async () => {
      if (!parsedData) {
        writeOutput('Scan a barcode first. Parsing runs automatically.', 'error');
        return;
      }

      try {
        await sendAutoFillToActiveTab(parsedData);
        writeOutput('Chart auto-filled', 'success');
      } catch (error) {
        writeOutput(error.message || 'Could not auto-fill fields', 'error');
      }
    });
  }

  if (clearMultipleBtn) {
    clearMultipleBtn.addEventListener('click', async () => {
      await multipleInjectManager.clear();
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
      writeOutput(`CSV export started for ${inventoryManager.count} scan(s).`, 'success');
    });
  }

  if (clearInventoryBtn) {
    clearInventoryBtn.addEventListener('click', async () => {
      await inventoryManager.clear();
      writeOutput('Inventory tray cleared.', 'info');
    });
  }

  loadNVCStatus();
});

function writeOutput(message, type = 'info') {
  showOutput(outputDiv, message, type);
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

async function loadWorkflowMode() {
  try {
    const stored = await chrome.storage.local.get([
      WORKFLOW_MODE_KEY,
      LEGACY_POPUP_MODE_KEY,
      LEGACY_REMOTE_MODE_KEY,
      LEGACY_HANDS_FREE_KEY
    ]);
    await setActiveMode(normalizeWorkflowMode(stored), { persist: false });
  } catch (_) {
    await setActiveMode('single', { persist: false });
  }
}

async function setActiveMode(mode, options = {}) {
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
    await chrome.storage.local.set({ [WORKFLOW_MODE_KEY]: activeMode });
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
      await displayParsedData(parsedData, parseRequestId);
    } catch (error) {
      parsedData = null;
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

async function sendAutoFillToActiveTab(data) {
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

      sendAutoFillMessage(tabs[0].id, data, (response) => {
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

async function lookupVaccineInfo(lot) {
  const lotKey = String(lot || '').trim().toLowerCase();
  if (!lotKey) {
    return { error: 'No lot number provided' };
  }
  if (lotLookupCache.has(lotKey)) {
    return lotLookupCache.get(lotKey);
  }
  const response = await sendRuntimeMessage({ action: 'lookupVaccineInfo', lot });
  lotLookupCache.set(lotKey, response);
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
    }
    setPendingScanLines([]);
    parsedData = lastRecord;

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
  writeOutput(
    buildParsedOutputMarkup(data),
    outputTypeForExpiry(getExpiryStatus(data.inventory_expiry || data.expiry))
  );

  try {
    await sendAutoFillToActiveTab(data);
    multipleInjectManager.setActiveUse(record.id);
    const label = record.tradename || record.generic_name || record.name || record.lot || 'Saved vaccine';
    writeOutput(`${label} auto-filled from Multiple Inject queue.`, 'success');
  } catch (error) {
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

  if (baseData.lot) {
    try {
      vaccineInfo = await lookupVaccineInfo(baseData.lot);
    } catch (error) {
      vaccineInfo = { error: error.message || 'Lookup failed' };
    }
  }

  if ((!vaccineInfo || vaccineInfo.error) && baseData.gtin && baseData.gtin !== baseData.lot) {
    try {
      vaccineInfo = await lookupVaccineInfo(baseData.gtin);
    } catch (error) {
      vaccineInfo = { error: error.message || 'Lookup failed' };
    }
  }

  const chosenExpiry = baseData.expiry || vaccineInfo?.lot_expiry || null;
  const expiryStatus = getExpiryStatus(chosenExpiry);
  const expirySource = baseData.expiry ? 'barcode' : (vaccineInfo?.lot_expiry ? 'nvc' : 'none');
  return mergeVaccineInfoIntoParsedData(baseData, vaccineInfo, expiryStatus, expirySource);
}

async function displayParsedData(data, parseRequestId) {
  const previewExpiryStatus = getExpiryStatus(data.expiry);
  writeOutput(
    buildParsedOutputMarkup(data, { loading: !!(data.lot || data.gtin) }),
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
  chrome.tabs.sendMessage(tabId, { action: 'autoFill', data }, (response) => {
    if (chrome.runtime.lastError) {
      const message = chrome.runtime.lastError.message || '';

      if (message.includes('Receiving end does not exist')) {
        chrome.scripting.executeScript({ target: { tabId }, files: ['panorama-agent-rules.js', 'content.js'] }, () => {
          if (chrome.runtime.lastError) {
            callback({ success: false, error: `Message failed and script injection failed: ${chrome.runtime.lastError.message}` });
            return;
          }
          chrome.tabs.sendMessage(tabId, { action: 'autoFill', data }, callback);
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
