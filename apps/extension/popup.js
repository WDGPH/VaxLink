import { InventoryBatchManager, buildInventoryRecord } from './popup-inventory.js';
import { getExpiryStatus, outputTypeForExpiry, parseInputData } from './popup-parser.js';
import {
  buildParsedOutputMarkup,
  initHandsFreeToggle,
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
let injectModeBtn;
let inventoryModeBtn;
let injectModeSection;
let inventoryModeSection;
let scannedInput;
let nvcStatusDiv;
let outputDiv;
let modeHelper;
let scanStateTitle;
let scanStateSubtitle;
let parsedData = null;
let activeParseRequestId = 0;
let autoParseTimer = null;
let inventoryManager;
let activeMode = 'inject';

const lotLookupCache = new Map();
const POPUP_MODE_KEY = 'vaxlink_popup_mode_v1';
const MODE_CONFIG = {
  inject: {
    title: 'Inject mode',
    subtitle: 'Single-scan workflow for preview and chart auto-fill.',
    helper: 'Scan or paste a barcode to decode it, review the parsed vaccine details, and inject into the active CHR tab.'
  },
  inventory: {
    title: 'Inventory mode',
    subtitle: 'Batch workflow for tray capture and CSV export.',
    helper: 'Scan one vaccine per line. Press Enter to add the current scan, or paste multiple lines and add them to the inventory tray in one batch.'
  }
};

document.addEventListener('DOMContentLoaded', async () => {
  autoFillBtn = document.getElementById('autoFillBtn');
  refreshNvcBtn = document.getElementById('refreshNvcBtn');
  addCurrentBtn = document.getElementById('addCurrentBtn');
  addBatchBtn = document.getElementById('addBatchBtn');
  exportCsvBtn = document.getElementById('exportCsvBtn');
  clearInventoryBtn = document.getElementById('clearInventoryBtn');
  injectModeBtn = document.getElementById('injectModeBtn');
  inventoryModeBtn = document.getElementById('inventoryModeBtn');
  injectModeSection = document.getElementById('injectModeSection');
  inventoryModeSection = document.getElementById('inventoryModeSection');
  scannedInput = document.getElementById('scannedData');
  nvcStatusDiv = document.getElementById('nvcStatus');
  outputDiv = document.getElementById('output');
  modeHelper = document.getElementById('modeHelper');
  scanStateTitle = document.getElementById('scanStateTitle');
  scanStateSubtitle = document.getElementById('scanStateSubtitle');

  inventoryManager = new InventoryBatchManager({
    summaryEl: document.getElementById('inventorySummary'),
    listEl: document.getElementById('inventoryList'),
    exportButton: exportCsvBtn,
    clearButton: clearInventoryBtn
  });

  initHandsFreeToggle(outputDiv, writeOutput);
  await inventoryManager.load();
  await loadPopupMode();

  if (scannedInput) {
    scannedInput.addEventListener('input', () => {
      queueAutoParse();
    });

    scannedInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (activeMode === 'inventory') {
          addPreviewScanToInventory();
        } else {
          queueAutoParse(true);
        }
      }
    });
  }

  if (injectModeBtn) {
    injectModeBtn.addEventListener('click', () => {
      setActiveMode('inject');
    });
  }

  if (inventoryModeBtn) {
    inventoryModeBtn.addEventListener('click', () => {
      setActiveMode('inventory');
    });
  }

  if (autoFillBtn) {
    autoFillBtn.addEventListener('click', () => {
      if (!parsedData) {
        writeOutput('Scan a barcode first. Parsing runs automatically.', 'error');
        return;
      }

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs.length) {
          writeOutput('No active tab found', 'error');
          return;
        }
        sendAutoFillMessage(tabs[0].id, parsedData);
      });
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

async function loadPopupMode() {
  try {
    const stored = await chrome.storage.local.get([POPUP_MODE_KEY]);
    const mode = stored && stored[POPUP_MODE_KEY] === 'inventory' ? 'inventory' : 'inject';
    await setActiveMode(mode, { persist: false });
  } catch (_) {
    await setActiveMode('inject', { persist: false });
  }
}

async function setActiveMode(mode, options = {}) {
  activeMode = mode === 'inventory' ? 'inventory' : 'inject';
  const config = MODE_CONFIG[activeMode];

  if (injectModeBtn) {
    injectModeBtn.classList.toggle('active', activeMode === 'inject');
    injectModeBtn.setAttribute('aria-selected', activeMode === 'inject' ? 'true' : 'false');
  }

  if (inventoryModeBtn) {
    inventoryModeBtn.classList.toggle('active', activeMode === 'inventory');
    inventoryModeBtn.setAttribute('aria-selected', activeMode === 'inventory' ? 'true' : 'false');
  }

  if (injectModeSection) {
    injectModeSection.hidden = activeMode !== 'inject';
  }

  if (inventoryModeSection) {
    inventoryModeSection.hidden = activeMode !== 'inventory';
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
    await chrome.storage.local.set({ [POPUP_MODE_KEY]: activeMode });
  }
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
    writeOutput('Scan a barcode first, then add it to the inventory tray.', 'error');
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
    await inventoryManager.add(buildInventoryRecord(enriched, rawBarcode));
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
        records.push(buildInventoryRecord(enriched, rawBarcode));
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
        : `Added ${addedCount} scan(s) to the inventory tray.`;
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

function sendAutoFillMessage(tabId, data) {
  chrome.tabs.sendMessage(tabId, { action: 'autoFill', data }, (response) => {
    if (chrome.runtime.lastError) {
      const message = chrome.runtime.lastError.message || '';

      if (message.includes('Receiving end does not exist')) {
        chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => {
          if (chrome.runtime.lastError) {
            writeOutput(`Message failed and script injection failed: ${chrome.runtime.lastError.message}`, 'error');
            return;
          }
          chrome.tabs.sendMessage(tabId, { action: 'autoFill', data }, handleAutoFillResponse);
        });
        return;
      }

      writeOutput(`Message send failed: ${message}`, 'error');
      return;
    }

    handleAutoFillResponse(response);
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
