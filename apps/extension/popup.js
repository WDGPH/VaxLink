let autoFillBtn;
let refreshNvcBtn;
let addCurrentBtn;
let addBatchBtn;
let exportCsvBtn;
let clearInventoryBtn;
let scannedInput;
let nvcStatusDiv;
let outputDiv;
let inventorySummaryDiv;
let inventoryListDiv;
let parsedData = null;
let activeParseRequestId = 0;
let inventoryBatch = [];
const lotLookupCache = new Map();
const HANDS_FREE_SCAN_KEY = 'hands_free_scan_autofill_enabled';
const INVENTORY_BATCH_KEY = 'inventory_scan_batch_v1';
const INVENTORY_CSV_COLUMNS = [
  'scan_index',
  'scanned_at',
  'name',
  'tradename',
  'generic_name',
  'disease',
  'antigen',
  'manufacturer',
  'gtin',
  'lot',
  'serial',
  'barcode_expiry',
  'inventory_expiry',
  'nvc_lot_expiry',
  'expiry_flag',
  'expiry_days_remaining',
  'expiry_source',
  'route',
  'strength',
  'dose_value',
  'dose_unit',
  'din',
  'drug_code',
  'lookup_error',
  'raw_barcode'
];

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  autoFillBtn = document.getElementById('autoFillBtn');
  refreshNvcBtn = document.getElementById('refreshNvcBtn');
  addCurrentBtn = document.getElementById('addCurrentBtn');
  addBatchBtn = document.getElementById('addBatchBtn');
  exportCsvBtn = document.getElementById('exportCsvBtn');
  clearInventoryBtn = document.getElementById('clearInventoryBtn');
  scannedInput = document.getElementById('scannedData');
  nvcStatusDiv = document.getElementById('nvcStatus');
  outputDiv = document.getElementById('output');
  inventorySummaryDiv = document.getElementById('inventorySummary');
  inventoryListDiv = document.getElementById('inventoryList');
  initHandsFreeToggle();
  loadInventoryBatch();

  if (scannedInput) {
    scannedInput.addEventListener('input', () => {
      queueAutoParse();
    });

    scannedInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addPreviewScanToInventory();
      }
    });
  }
  
  if (autoFillBtn) {
    autoFillBtn.addEventListener('click', () => {
      if (!parsedData) {
        showOutput('Scan a barcode first. Parsing runs automatically.', 'error');
        return;
      }
      
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        console.log('tabs.query returned:', tabs);
        if (!tabs.length) {
          showOutput('No active tab found', 'error');
          return;
        }
        const tabId = tabs[0].id;
        const tabUrl = tabs[0].url;
        console.log('Sending to tab - ID:', tabId, 'URL:', tabUrl);
        sendAutoFillMessage(tabId, parsedData);
      });
    });
  }

  if (refreshNvcBtn) {
    refreshNvcBtn.addEventListener('click', () => {
      refreshNvcBtn.disabled = true;
      showOutput('Refreshing NVC bundle...', 'info');

      chrome.runtime.sendMessage({ action: 'refreshNVCBundle' }, (response) => {
        refreshNvcBtn.disabled = false;
        if (chrome.runtime.lastError) {
          showOutput('NVC refresh failed: ' + chrome.runtime.lastError.message, 'error');
          return;
        }

        if (!response || !response.success) {
          showOutput('NVC refresh failed: ' + (response?.error || 'Unknown error'), 'error');
          return;
        }

        const count = response.entryCount ?? 'unknown';
        showOutput(`NVC update successful (${count} entries).`, 'success');
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
      exportInventoryCsv();
    });
  }

  if (clearInventoryBtn) {
    clearInventoryBtn.addEventListener('click', () => {
      clearInventoryBatch();
    });
  }

  loadNVCStatus();
});

let autoParseTimer = null;
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
    } catch (e) {
      parsedData = null;
      showOutput(`Error parsing barcode: ${e.message}`, 'error');
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

function formatDateTime(value) {
  if (!value) return 'Never';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function renderNVCStatus(status) {
  if (!nvcStatusDiv || !status) return;
  const updated = formatDateTime(status.updatedAt);
  const checked = formatDateTime(status.lastCheckAt);
  const intervalHours = Math.round((status.autoSyncIntervalMinutes || 0) / 60);
  nvcStatusDiv.textContent = `Last bundle update: ${updated} | Last check: ${checked} | Auto-check: every ${intervalHours}h`;
}

function loadNVCStatus() {
  chrome.runtime.sendMessage({ action: 'getNVCUpdateStatus' }, (status) => {
    if (chrome.runtime.lastError || !status) {
      return;
    }
    renderNVCStatus(status);
  });
}

function loadInventoryBatch() {
  chrome.storage.local.get([INVENTORY_BATCH_KEY], (stored) => {
    const rows = stored && Array.isArray(stored[INVENTORY_BATCH_KEY])
      ? stored[INVENTORY_BATCH_KEY]
      : [];
    inventoryBatch = rows.filter((row) => row && typeof row === 'object');
    renderInventoryBatch();
  });
}

function persistInventoryBatch() {
  chrome.storage.local.set({ [INVENTORY_BATCH_KEY]: inventoryBatch }, () => {
    if (chrome.runtime.lastError) {
      console.warn('Could not persist inventory batch:', chrome.runtime.lastError.message);
    }
  });
}

function renderInventoryBatch() {
  if (!inventorySummaryDiv || !inventoryListDiv) return;

  if (!inventoryBatch.length) {
    inventorySummaryDiv.textContent = 'No scans queued for export.';
    inventoryListDiv.innerHTML = '<div class="inventory-empty">Scan vaccines into the tray, then export when ready.</div>';
    updateInventoryControls();
    return;
  }

  const expiredCount = inventoryBatch.filter((row) => row.expiry_flag === 'expired').length;
  const expiringCount = inventoryBatch.filter((row) => row.expiry_flag === 'expiring_soon').length;
  let summary = `${inventoryBatch.length} scan(s) ready for CSV export.`;
  if (expiredCount || expiringCount) {
    summary += ` ${expiredCount} expired, ${expiringCount} expiring soon.`;
  }
  inventorySummaryDiv.textContent = summary;

  inventoryListDiv.innerHTML = inventoryBatch
    .map((row, index) => {
      const title = escapeHtml(row.tradename || row.generic_name || row.name || row.lot || `Scan ${index + 1}`);
      const lot = escapeHtml(row.lot || 'N/A');
      const expiry = escapeHtml(row.inventory_expiry || row.barcode_expiry || 'N/A');
      const manufacturer = escapeHtml(row.manufacturer || 'N/A');
      const status = escapeHtml(formatInventoryStatus(row));
      const scannedAt = escapeHtml(formatInventoryTimestamp(row.scanned_at));
      return `
        <div class="inventory-item">
          <div class="inventory-item-top">
            <div>
              <div class="inventory-item-title">${title}</div>
              <div class="inventory-item-meta">Lot ${lot} | ${scannedAt}</div>
            </div>
            <button class="inventory-remove" type="button" data-remove-id="${escapeHtml(row.id || '')}">Remove</button>
          </div>
          <div class="inventory-item-grid">
            <span class="inventory-chip">Expiry ${expiry}</span>
            <span class="inventory-chip">Status ${status}</span>
            <span class="inventory-chip">Mfr ${manufacturer}</span>
          </div>
        </div>
      `;
    })
    .join('');

  inventoryListDiv.querySelectorAll('[data-remove-id]').forEach((button) => {
    button.addEventListener('click', () => {
      removeInventoryItem(button.getAttribute('data-remove-id'));
    });
  });

  updateInventoryControls();
}

function updateInventoryControls() {
  const hasItems = inventoryBatch.length > 0;
  if (exportCsvBtn) exportCsvBtn.disabled = !hasItems;
  if (clearInventoryBtn) clearInventoryBtn.disabled = !hasItems;
}

function removeInventoryItem(id) {
  inventoryBatch = inventoryBatch.filter((row) => row.id !== id);
  persistInventoryBatch();
  renderInventoryBatch();
}

function formatInventoryTimestamp(value) {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatInventoryStatus(row) {
  const flag = row && row.expiry_flag ? row.expiry_flag : 'unknown';
  if (flag === 'expired') {
    return 'Expired';
  }
  if (flag === 'expiring_soon') {
    return 'Expiring soon';
  }
  if (flag === 'valid') {
    return 'Valid';
  }
  return 'Unknown';
}

function setButtonBusy(button, busy, busyText) {
  if (!button) return;
  if (!button.dataset.defaultLabel) {
    button.dataset.defaultLabel = button.textContent;
  }
  button.disabled = busy;
  button.classList.toggle('button-busy', busy);
  button.textContent = busy && busyText ? busyText : button.dataset.defaultLabel;
}

function initHandsFreeToggle() {
  if (!outputDiv || document.getElementById('handsFreeScanToggle')) return;

  const section = document.createElement('div');
  section.style.margin = '8px 0 10px';
  section.style.padding = '8px 10px';
  section.style.border = '1px solid #d9e2ec';
  section.style.borderRadius = '8px';
  section.style.background = '#f8fafc';

  const label = document.createElement('label');
  label.style.display = 'flex';
  label.style.alignItems = 'center';
  label.style.gap = '8px';
  label.style.fontSize = '12px';
  label.style.color = '#1f2937';
  label.style.cursor = 'pointer';

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.id = 'handsFreeScanToggle';

  const textWrap = document.createElement('span');
  textWrap.textContent = 'Hands-free scan mode (auto-fill on barcode scan)';

  label.appendChild(toggle);
  label.appendChild(textWrap);
  section.appendChild(label);

  const hint = document.createElement('div');
  hint.style.fontSize = '11px';
  hint.style.color = '#475569';
  hint.style.marginTop = '6px';
  hint.textContent = 'When enabled, scanning directly in Panorama or InputHealth can auto-fill without opening this popup.';
  section.appendChild(hint);

  outputDiv.parentNode.insertBefore(section, outputDiv);

  chrome.storage.local.get([HANDS_FREE_SCAN_KEY], (stored) => {
    toggle.checked = !!stored[HANDS_FREE_SCAN_KEY];
  });

  toggle.addEventListener('change', () => {
    const enabled = !!toggle.checked;
    chrome.storage.local.set({ [HANDS_FREE_SCAN_KEY]: enabled }, () => {
      if (chrome.runtime.lastError) {
        showOutput('Could not update hands-free scan mode: ' + chrome.runtime.lastError.message, 'error');
        return;
      }
      showOutput(
        enabled
          ? 'Hands-free scan mode enabled'
          : 'Hands-free scan mode disabled',
        'info'
      );
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

async function addPreviewScanToInventory() {
  const rawBarcode = getPreviewBarcodeValue();
  if (!rawBarcode) {
    showOutput('Scan a barcode first, then add it to the inventory tray.', 'error');
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
    inventoryBatch.push(buildInventoryRecord(enriched, rawBarcode));
    persistInventoryBatch();
    renderInventoryBatch();
    removeLastPendingScanLine();
    queueAutoParse(true);
    showOutput(buildParsedOutputMarkup(enriched), outputTypeForExpiry(getExpiryStatus(enriched.inventory_expiry)));
  } catch (error) {
    showOutput(`Could not add scan: ${error.message}`, 'error');
  } finally {
    if (requestId === activeParseRequestId) {
      setButtonBusy(addCurrentBtn, false);
    }
  }
}

async function addPendingScansToInventory() {
  const lines = getPendingScanLines();
  if (!lines.length) {
    showOutput('Paste or scan one barcode per line before running batch add.', 'error');
    return;
  }

  const requestId = ++activeParseRequestId;
  setButtonBusy(addBatchBtn, true, 'Adding...');
  let addedCount = 0;
  const errors = [];
  let lastRecord = null;

  try {
    for (let index = 0; index < lines.length; index += 1) {
      const rawBarcode = lines[index];
      try {
        const baseData = parseInputData(rawBarcode);
        const enriched = await enrichParsedData(baseData);
        inventoryBatch.push(buildInventoryRecord(enriched, rawBarcode));
        lastRecord = enriched;
        addedCount += 1;
      } catch (error) {
        errors.push(`Line ${index + 1}: ${error.message}`);
      }
    }

    if (requestId !== activeParseRequestId) {
      return;
    }

    persistInventoryBatch();
    renderInventoryBatch();
    setPendingScanLines([]);
    parsedData = lastRecord;

    if (addedCount) {
      const message = errors.length
        ? `Added ${addedCount} scan(s). ${errors.length} line(s) failed.`
        : `Added ${addedCount} scan(s) to the inventory tray.`;
      showOutput(message, errors.length ? 'warning' : 'success');
    } else {
      showOutput(errors.join('<br>') || 'No scans were added.', 'error');
    }
  } finally {
    if (requestId === activeParseRequestId) {
      setButtonBusy(addBatchBtn, false);
    }
  }
}

function clearInventoryBatch() {
  inventoryBatch = [];
  persistInventoryBatch();
  renderInventoryBatch();
  showOutput('Inventory tray cleared.', 'info');
}

function exportInventoryCsv() {
  if (!inventoryBatch.length) {
    showOutput('Add at least one scan before exporting CSV.', 'error');
    return;
  }

  const rows = [
    INVENTORY_CSV_COLUMNS.join(','),
    ...inventoryBatch.map((row, index) => INVENTORY_CSV_COLUMNS.map((column) => {
      if (column === 'scan_index') {
        return csvEscape(index + 1);
      }
      return csvEscape(row[column]);
    }).join(','))
  ];

  const blob = new Blob([rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const filename = `vaxlink-inventory-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  showOutput(`CSV export started for ${inventoryBatch.length} scan(s).`, 'success');
}

function getLoadingMarkup(text) {
  return `<div class="lookup-loading"><span class="inline-spinner" aria-hidden="true"></span><span>${text}</span></div>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function displayValue(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  return raw ? escapeHtml(raw) : '<span class="muted">N/A</span>';
}

function csvEscape(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function buildInventoryRecord(data, rawBarcode) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    scanned_at: new Date().toISOString(),
    raw_barcode: rawBarcode || '',
    name: data.name || '',
    tradename: data.tradename || '',
    generic_name: data.generic_name || '',
    disease: data.disease || '',
    antigen: data.antigen || '',
    manufacturer: data.manufacturer || '',
    gtin: data.gtin || '',
    lot: data.lot || '',
    serial: data.serial || '',
    barcode_expiry: data.expiry || '',
    inventory_expiry: data.inventory_expiry || data.expiry || data.nvc_lot_expiry || '',
    nvc_lot_expiry: data.nvc_lot_expiry || '',
    expiry_flag: data.expiry_flag || '',
    expiry_days_remaining: data.expiry_days_remaining ?? '',
    expiry_source: data.expiry_source || '',
    route: data.route || '',
    strength: data.strength || '',
    dose_value: data.dose_value || '',
    dose_unit: data.dose_unit || '',
    din: data.din || '',
    drug_code: data.drug_code || data.din || '',
    lookup_error: data.lookup_error || ''
  };
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

function buildResultRow(label, value) {
  return `
    <div class="result-row">
      <div class="result-label">${escapeHtml(label)}</div>
      <div class="result-value">${value}</div>
    </div>
  `;
}

function buildParsedOutputMarkup(data, options = {}) {
  const loading = !!options.loading;
  const inventoryExpiry = data.inventory_expiry || data.expiry || data.nvc_lot_expiry || null;
  const expiryStatus = getExpiryStatus(inventoryExpiry);
  const warningBanner = buildExpiryBanner(expiryStatus);

  let vaccineSectionContent = getLoadingMarkup('Looking up lot in NVC...');
  if (!loading) {
    if (data.lookup_error) {
      vaccineSectionContent = `<div class="result-value"><span class="status">${escapeHtml(data.lookup_error)}</span></div>`;
    } else {
      vaccineSectionContent = [
        buildResultRow('Trade Name', displayValue(data.tradename)),
        buildResultRow('Generic Name', displayValue(data.generic_name)),
        buildResultRow('Disease(s)', displayValue(data.disease)),
        buildResultRow('Antigen', displayValue(data.antigen)),
        buildResultRow('Manufacturer', displayValue(data.manufacturer)),
        buildResultRow('Route', displayValue(data.route)),
        buildResultRow('Strength', displayValue(data.strength)),
        buildResultRow('Dose', displayValue([data.dose_value, data.dose_unit].filter(Boolean).join(' '))),
        buildResultRow('DIN', displayValue(data.din)),
        buildResultRow('NVC Lot Expiry', displayValue(data.nvc_lot_expiry))
      ].join('');
    }
  }

  return `
    ${warningBanner}
    <div class="result-section">
      <div class="result-heading">Parsed Barcode Data</div>
      ${buildResultRow('GTIN', displayValue(data.gtin))}
      ${buildResultRow('Lot', displayValue(data.lot))}
      ${buildResultRow('Serial', displayValue(data.serial))}
      ${buildResultRow('Barcode Expiry', displayValue(data.expiry))}
      ${buildResultRow('Inventory Expiry', displayValue(inventoryExpiry))}
      ${buildResultRow('Expiry Flag', `<span class="status" style="color:${escapeHtml(expiryStatus.color)};">${escapeHtml(expiryStatus.label)}</span> <span class="muted">(${escapeHtml(data.expiry_source || 'none')})</span>`)}
    </div>
    <div class="result-section">
      <div class="result-heading">Vaccine Information from NVC</div>
      ${vaccineSectionContent}
    </div>
  `;
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

function sendAutoFillMessage(tabId, data) {
  chrome.tabs.sendMessage(tabId, { action: 'autoFill', data }, (response) => {
    console.log('sendMessage callback fired');
    console.log('response:', response);
    console.log('lastError:', chrome.runtime.lastError);

    if (chrome.runtime.lastError) {
      const message = chrome.runtime.lastError.message || '';
      console.error('chrome.runtime.lastError:', message);

      if (message.includes('Receiving end does not exist')) {
        chrome.scripting.executeScript(
          { target: { tabId }, files: ['content.js'] },
          () => {
            if (chrome.runtime.lastError) {
              showOutput('Message failed and script injection failed: ' + chrome.runtime.lastError.message, 'error');
              return;
            }
            chrome.tabs.sendMessage(tabId, { action: 'autoFill', data }, handleAutoFillResponse);
          }
        );
        return;
      }

      showOutput('Message send failed: ' + message, 'error');
      return;
    }

    handleAutoFillResponse(response);
  });
}

function handleAutoFillResponse(response) {
  if (chrome.runtime.lastError) {
    showOutput('Auto-fill failed: ' + chrome.runtime.lastError.message, 'error');
    return;
  }

  if (response && response.success) {
    showOutput('Chart auto-filled', 'success');
  } else if (response && response.error) {
    showOutput(response.error, 'error');
  } else {
    showOutput('Could not auto-fill fields', 'error');
  }
}

function parseInputData(rawInput) {
  const input = String(rawInput || '').trim();
  if (!input) {
    throw new Error('No input provided');
  }

  // Primary path: GS1 scan strings (01...).
  if (input.startsWith('01') || input.startsWith('(01)')) {
    return parseGS1Barcode(input);
  }

  const manual = parseManualTestInput(input);
  if (manual) {
    return manual;
  }

  // Fallback: try GS1 parser anyway for scanners that omit AI wrappers.
  return parseGS1Barcode(input);
}

function parseManualTestInput(input) {
  const normalized = String(input || '').trim();
  if (!normalized) return null;

  // JSON mode:
  // {"name":"MMR","lot":"0013AE","tradename":"MMR M-M-R II MC","expiry":"12/16/2013"}
  if (normalized.startsWith('{') && normalized.endsWith('}')) {
    const obj = JSON.parse(normalized);
    if (!obj || typeof obj !== 'object') {
      throw new Error('Manual JSON input must be an object');
    }
    const data = {
      gtin: obj.gtin || null,
      expiry: obj.expiry || null,
      lot: obj.lot || obj.lot_number || null,
      serial: obj.serial || null,
      name: obj.name || obj.agent || obj.generic_name || obj.tradename || null,
      tradename: obj.tradename || null,
      generic_name: obj.generic_name || null
    };
    if (!data.name && !data.lot && !data.tradename) {
      throw new Error('Manual JSON must include at least one of: name/agent, tradename, lot');
    }
    return data;
  }

  // Key-value mode:
  // agent=MMR;lot=0013AE;tradename=MMR M-M-R II MC
  if (/[=]/.test(normalized)) {
    const pairs = normalized.split(/[;\n]+/).map(part => part.trim()).filter(Boolean);
    const map = {};
    for (const pair of pairs) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = pair.slice(0, eqIdx).trim().toLowerCase();
      const value = pair.slice(eqIdx + 1).trim();
      if (key) map[key] = value;
    }

    if (Object.keys(map).length > 0) {
      const data = {
        gtin: map.gtin || null,
        expiry: map.expiry || null,
        lot: map.lot || map.lot_number || null,
        serial: map.serial || null,
        name: map.name || map.agent || map.generic_name || map.tradename || null,
        tradename: map.tradename || null,
        generic_name: map.generic_name || null
      };
      if (!data.name && !data.lot && !data.tradename) {
        throw new Error('Manual key-value input must include name/agent, tradename, or lot');
      }
      return data;
    }
  }

  return null;
}

function parseGS1Barcode(barcode) {
  const GS = String.fromCharCode(0x1d); // Group separator character
  let s = String(barcode || '')
    .trim()
    .replace(/[\t\r\n]/g, GS)
    .replace(/^\]C1/i, '')
    .replace(/\(/g, '')
    .replace(/\)/g, '')
    .replace(/[^\x20-\x7E\x1D]/g, '');

  if (!s.startsWith('01')) {
    const first01 = s.indexOf('01');
    if (first01 > 0) {
      s = s.substring(first01);
    }
  }
  
  console.log('Parsing barcode:', s, 'length:', s.length);
  
  const data = { gtin: null, expiry: null, lot: null, serial: null };
  
  // Parse GTIN (always first, 14 digits fixed after AI 01)
  if (!s.startsWith('01')) {
    throw new Error('Expected AI(01) at start');
  }
  
  data.gtin = s.substring(2, 16);
  let idx = 16;
  console.log('Parsed GTIN:', data.gtin, 'next idx:', idx);
  
  // Parse remaining AIs in order
  while (idx < s.length) {
    if (s.charAt(idx) === GS) {
      idx += 1;
      continue;
    }

    const currentAI = s.substring(idx, idx + 2);
    console.log('At idx', idx, 'found AI:', currentAI);
    
    if (currentAI === '17') {
      // Fixed length: 6 digits (YYMMDD)
      if (s.length < idx + 8) {
        throw new Error('AI(17) expiry date incomplete');
      }
      const yymmdd = s.substring(idx + 2, idx + 8);
      data.expiry = formatDate(yymmdd);
      console.log('Parsed expiry:', yymmdd, 'formatted:', data.expiry);
      idx += 8;
      
    } else if (currentAI === '10') {
      // Variable length: lot number
      idx += 2;
      let lotEnd = findNextAI(s, idx, GS, '10');
      if (lotEnd === -1) {
        lotEnd = s.length;
      }
      data.lot = s.substring(idx, lotEnd);
      console.log('Parsed lot from', idx, 'to', lotEnd, ':', data.lot);
      idx = lotEnd;
      
    } else if (currentAI === '21') {
      // Variable length: serial number
      idx += 2;
      let serialEnd = findNextAI(s, idx, GS, '21');
      if (serialEnd === -1) {
        serialEnd = s.length;
      }
      data.serial = s.substring(idx, serialEnd);
      console.log('Parsed serial from', idx, 'to', serialEnd, ':', data.serial);
      idx = serialEnd;
      
    } else {
      const nextKnownAI = findNextAI(s, idx, GS, null);
      if (nextKnownAI > idx) {
        idx = nextKnownAI;
        continue;
      }
      console.log('Unknown AI, breaking. idx:', idx, 'char:', currentAI);
      break;
    }
  }
  
  console.log('Final parsed data:', data);
  return data;
}

function findNextAI(s, startIdx, GS, currentVariableAI = null) {
  // Prefer GS-based boundaries when separators are present.
  if (GS && s.includes(GS) && s.substring(startIdx).includes(GS)) {
    const ais = ['17', '10', '21'];
    for (let i = startIdx; i < s.length - 1; i++) {
      const twoChar = s.substring(i, i + 2);
      if (ais.includes(twoChar) && i > 0 && s.charAt(i - 1) === GS) {
        return i;
      }
    }
  }

  // Fallback for scans without GS: detect likely AI boundaries by validating
  // that the remaining tail can still be parsed.
  const memo = new Map();
  return findNextAINoGS(s, startIdx, memo, currentVariableAI);
}

function isLikelyAIStart(s, idx) {
  if (idx < 0 || idx > s.length - 2) return false;
  const ai = s.substring(idx, idx + 2);
  if (ai === '17') {
    if (idx + 8 > s.length) return false;
    return /^\d{6}$/.test(s.substring(idx + 2, idx + 8));
  }
  return ai === '10' || ai === '21';
}

function canParseTailNoGS(s, idx, memo) {
  if (idx >= s.length) return true;
  if (memo.has(idx)) return memo.get(idx);

  let ok = false;
  const ai = s.substring(idx, idx + 2);
  if (ai === '17') {
    ok = idx + 8 <= s.length &&
      /^\d{6}$/.test(s.substring(idx + 2, idx + 8)) &&
      canParseTailNoGS(s, idx + 8, memo);
  } else if (ai === '10' || ai === '21') {
    const valueStart = idx + 2;
    if (valueStart < s.length) {
      const next = findNextAINoGS(s, valueStart, memo, ai);
      ok = next === -1 ? true : (next > valueStart && canParseTailNoGS(s, next, memo));
    }
  } else {
    ok = false;
  }

  memo.set(idx, ok);
  return ok;
}

function findNextAINoGS(s, startIdx, memo, currentVariableAI = null) {
  for (let i = startIdx + 1; i < s.length - 1; i++) {
    if (!isLikelyAIStart(s, i)) continue;
    const candidateAI = s.substring(i, i + 2);
    // In no-GS scans, avoid splitting a variable field on an embedded token
    // that matches the current variable AI (e.g. lot containing "10").
    if (currentVariableAI && candidateAI === currentVariableAI) continue;
    if (canParseTailNoGS(s, i, memo)) {
      return i;
    }
  }
  return -1;
}

function formatDate(yymmdd) {
  if (!yymmdd || yymmdd.length !== 6) {
    return null;
  }
  const yy = yymmdd.substring(0, 2);
  const mm = yymmdd.substring(2, 4);
  const dd = yymmdd.substring(4, 6);
  return `${mm}/${dd}/20${yy}`;
}

function parseDateToLocal(dateValue) {
  if (!dateValue) return null;
  const raw = String(dateValue).trim();
  if (!raw) return null;

  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const mm = Number(mdy[1]);
    const dd = Number(mdy[2]);
    const yyyy = Number(mdy[3]);
    return new Date(yyyy, mm - 1, dd);
  }

  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) {
    const yyyy = Number(ymd[1]);
    const mm = Number(ymd[2]);
    const dd = Number(ymd[3]);
    return new Date(yyyy, mm - 1, dd);
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function getExpiryStatus(dateValue) {
  const expiry = parseDateToLocal(dateValue);
  if (!expiry) {
    return {
      flag: 'unknown',
      label: 'Unknown',
      color: '#6b7280',
      daysRemaining: null
    };
  }

  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysRemaining = Math.floor((expiry.getTime() - todayMidnight.getTime()) / msPerDay);

  if (daysRemaining < 0) {
    return {
      flag: 'expired',
      label: `Expired (${Math.abs(daysRemaining)} day(s) ago)`,
      color: '#b91c1c',
      daysRemaining
    };
  }

  if (daysRemaining <= 30) {
    return {
      flag: 'expiring_soon',
      label: `Expiring soon (${daysRemaining} day(s) left)`,
      color: '#b45309',
      daysRemaining
    };
  }

  return {
    flag: 'valid',
    label: `Valid (${daysRemaining} day(s) left)`,
    color: '#166534',
    daysRemaining
  };
}

function buildExpiryBanner(status) {
  if (!status) return '';
  if (status.flag === 'expired') {
    return `<div class="expiry-banner expired">WARNING: Vaccine is expired. ${status.label}</div>`;
  }
  if (status.flag === 'expiring_soon') {
    return `<div class="expiry-banner expiring">ATTENTION: Vaccine expiry is near. ${status.label}</div>`;
  }
  return '';
}

function outputTypeForExpiry(status) {
  if (!status) return 'info';
  if (status.flag === 'expired') return 'error';
  if (status.flag === 'expiring_soon') return 'warning';
  return 'info';
}

async function displayParsedData(data, parseRequestId) {
  console.log('displayParsedData called with:', data);
  const previewExpiryStatus = getExpiryStatus(data.expiry);
  showOutput(buildParsedOutputMarkup(data, { loading: !!(data.lot || data.gtin) }), outputTypeForExpiry(previewExpiryStatus));

  try {
    const enriched = await enrichParsedData(data);
    if (parseRequestId !== activeParseRequestId) {
      return;
    }
    parsedData = enriched;
    showOutput(buildParsedOutputMarkup(enriched), outputTypeForExpiry(getExpiryStatus(enriched.inventory_expiry)));
  } catch (error) {
    if (parseRequestId !== activeParseRequestId) {
      return;
    }
    console.error('Lookup error:', error);
    showOutput(buildParsedOutputMarkup({
      ...data,
      lookup_error: error.message || 'Lookup failed',
      inventory_expiry: data.expiry || null,
      expiry_source: data.expiry ? 'barcode' : 'none'
    }), 'warning');
  }
}

function showOutput(message, type = 'info') {
  outputDiv.innerHTML = message;
  outputDiv.style.display = 'block';
  outputDiv.className = 'output ' + type;
}
