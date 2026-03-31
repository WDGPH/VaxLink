import { getExpiryStatus, parseInputData } from './popup-parser.js';
import { buildQueueRecord } from './popup-inventory.js';

const INVENTORY_BATCH_KEY = 'inventory_scan_batch_v1';
const INVENTORY_LEDGER_KEY = 'inventory_txn_ledger_v1';
const COLD_CHAIN_INCIDENTS_KEY = 'inventory_cold_chain_incidents_v1';
const RECON_SIGNOFFS_KEY = 'inventory_reconciliation_signoffs_v1';
const DO_NOT_USE_LOTS_KEY = 'inventory_do_not_use_lots_v1';
const ULTRA_FAST_SCANNER_KEY = 'inventory_ultrafast_scanner_v1';
const SCANNER_BEEPS_KEY = 'inventory_scanner_beeps_v1';

const summaryEl = document.getElementById('summary');
const tableHostEl = document.getElementById('tableHost');
const reconHostEl = document.getElementById('reconHost');
const ledgerHostEl = document.getElementById('ledgerHost');
const fefoHostEl = document.getElementById('fefoHost');
const doNotUseHostEl = document.getElementById('doNotUseHost');
const statusEl = document.getElementById('status');
const refreshBtn = document.getElementById('refreshBtn');
const receiveBtn = document.getElementById('receiveBtn');
const receiveInput = document.getElementById('receiveInput');
const ultraFastToggle = document.getElementById('ultraFastToggle');
const scannerBeepsToggle = document.getElementById('scannerBeepsToggle');
const scanLiveIndicator = document.getElementById('scanLiveIndicator');
const exportBtn = document.getElementById('exportBtn');
const exportPackageBtn = document.getElementById('exportPackageBtn');
const exportJsonBtn = document.getElementById('exportJsonBtn');
const clearBtn = document.getElementById('clearBtn');
const signoffReconBtn = document.getElementById('signoffReconBtn');
const exportHandoffBtn = document.getElementById('exportHandoffBtn');
const saveWastageBtn = document.getElementById('saveWastageBtn');
const wastageLotInput = document.getElementById('wastageLotInput');
const wastageQtyInput = document.getElementById('wastageQtyInput');
const wastageReasonSelect = document.getElementById('wastageReasonSelect');
const wastageNoteInput = document.getElementById('wastageNoteInput');
const saveIncidentBtn = document.getElementById('saveIncidentBtn');
const incidentLotInput = document.getElementById('incidentLotInput');
const incidentMinTempInput = document.getElementById('incidentMinTempInput');
const incidentMaxTempInput = document.getElementById('incidentMaxTempInput');
const incidentStartInput = document.getElementById('incidentStartInput');
const incidentEndInput = document.getElementById('incidentEndInput');
const incidentOutcomeSelect = document.getElementById('incidentOutcomeSelect');
const incidentNoteInput = document.getElementById('incidentNoteInput');
const doNotUseLotInput = document.getElementById('doNotUseLotInput');
const doNotUseReasonInput = document.getElementById('doNotUseReasonInput');
const markDoNotUseBtn = document.getElementById('markDoNotUseBtn');
const clearDoNotUseBtn = document.getElementById('clearDoNotUseBtn');

let rows = [];
let ledger = [];
let incidents = [];
let reconSignoffs = [];
let doNotUseLots = {};
let ultraFastScannerEnabled = true;
let scannerBeepsEnabled = true;
let audioContext = null;
const physicalCounts = new Map();

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

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function nowIso() {
  return new Date().toISOString();
}

function getAudioContext() {
  if (audioContext) return audioContext;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  audioContext = new Ctx();
  return audioContext;
}

function playTone(frequency, durationMs, gain = 0.05, type = 'sine') {
  if (!scannerBeepsEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    void ctx.resume();
  }
  const oscillator = ctx.createOscillator();
  const gainNode = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  gainNode.gain.value = gain;
  oscillator.connect(gainNode);
  gainNode.connect(ctx.destination);
  oscillator.start();
  oscillator.stop(ctx.currentTime + durationMs / 1000);
}

function playSuccessBeeps() {
  playTone(920, 70, 0.04, 'triangle');
  setTimeout(() => playTone(1180, 80, 0.04, 'triangle'), 80);
}

function playErrorBeep() {
  playTone(280, 180, 0.05, 'sawtooth');
}

function updateScanIndicator() {
  if (!scanLiveIndicator) return;
  if (ultraFastScannerEnabled) {
    scanLiveIndicator.textContent = 'Ultra-fast mode ON: scanner Enter key receives instantly.';
  } else {
    scanLiveIndicator.textContent = 'Ultra-fast mode OFF: collect lines, then click Receive.';
  }
}

async function persistScannerSettings() {
  await setLocalStorage({
    [ULTRA_FAST_SCANNER_KEY]: ultraFastScannerEnabled,
    [SCANNER_BEEPS_KEY]: scannerBeepsEnabled
  });
}

function renderStatus(message, type = 'info') {
  statusEl.textContent = message;
  statusEl.style.color = type === 'error' ? '#97272c' : '#5f7488';
}

function formatDateTime(value) {
  if (!value) return 'N/A';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

function buildSummary(records) {
  const expired = records.filter((r) => r.expiry_flag === 'expired').length;
  const expiring = records.filter((r) => r.expiry_flag === 'expiring_soon').length;
  const flagged = records.filter((r) => doNotUseLots[String(r.lot || '').toLowerCase()]).length;
  return `${records.length} item(s) in local inventory. ${expired} expired, ${expiring} expiring soon, ${flagged} do-not-use flagged.`;
}

function normalizeDoseCount(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeLotKey(value) {
  return String(value || '').trim().toLowerCase();
}

function isLikelyLotOnlyInput(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/\s/.test(text)) return false;
  if (text.includes('=') || text.startsWith('{') || text.startsWith('01') || text.startsWith('(01)')) {
    return false;
  }
  return /^[A-Za-z0-9._/-]{4,24}$/.test(text);
}

function buildLotOnlyParsedData(lotValue) {
  return {
    lot: String(lotValue || '').trim(),
    gtin: '',
    expiry: '',
    serial: '',
    scanned_at: nowIso()
  };
}

function getInventoryGroups(records) {
  const groups = new Map();
  records.forEach((record) => {
    const vaccine = record.tradename || record.generic_name || record.name || 'Unknown';
    const lot = record.lot || 'N/A';
    const key = `${vaccine}||${lot}`;
    if (!groups.has(key)) {
      groups.set(key, { vaccine, lot, expected: 0, rows: 0 });
    }
    const group = groups.get(key);
    group.expected += normalizeDoseCount(record.remaining_doses || record.total_doses);
    group.rows += 1;
  });
  return groups;
}

function buildReconSnapshot(records) {
  const groups = getInventoryGroups(records);
  return [...groups.entries()].map(([key, group]) => {
    const physical = Number.parseInt(String(physicalCounts.get(key) ?? ''), 10);
    const variance = Number.isFinite(physical) ? physical - group.expected : null;
    return {
      key,
      vaccine: group.vaccine,
      lot: group.lot,
      entries: group.rows,
      expected_doses: group.expected,
      physical_count: Number.isFinite(physical) ? physical : null,
      variance
    };
  });
}

function addLedgerEntry(entry) {
  ledger.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: nowIso(),
    ...entry
  });
  if (ledger.length > 2000) {
    ledger = ledger.slice(0, 2000);
  }
}

function renderLedger() {
  if (!ledgerHostEl) return;
  if (!ledger.length) {
    ledgerHostEl.innerHTML = '<div class="empty">No transactions yet.</div>';
    return;
  }
  const markup = ledger.slice(0, 120).map((entry) => `
    <tr>
      <td>${formatDateTime(entry.ts)}</td>
      <td>${entry.type || 'event'}</td>
      <td>${entry.lot || 'N/A'}</td>
      <td>${entry.vaccine || 'N/A'}</td>
      <td>${entry.qty ?? ''}</td>
      <td>${entry.note || ''}</td>
    </tr>
  `).join('');
  ledgerHostEl.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Type</th>
          <th>Lot</th>
          <th>Vaccine</th>
          <th>Qty</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>${markup}</tbody>
    </table>
  `;
}

function renderFefo(records) {
  if (!fefoHostEl) return;
  if (!records.length) {
    fefoHostEl.innerHTML = '<div class="empty">No inventory for FEFO prioritization yet.</div>';
    return;
  }
  const fefoRows = [...records]
    .sort((a, b) => {
      const da = String(a.inventory_expiry || a.barcode_expiry || '9999-12-31');
      const db = String(b.inventory_expiry || b.barcode_expiry || '9999-12-31');
      return da.localeCompare(db);
    })
    .slice(0, 8)
    .map((record) => {
      const lotKey = normalizeLotKey(record.lot);
      const flagged = !!doNotUseLots[lotKey];
      return `
        <tr>
          <td>${record.tradename || record.generic_name || record.name || 'N/A'}</td>
          <td>${record.lot || 'N/A'}</td>
          <td>${record.inventory_expiry || record.barcode_expiry || 'N/A'}</td>
          <td>${record.remaining_doses || record.total_doses || 'N/A'}</td>
          <td>${flagged ? `<span class="chip">Do Not Use</span>` : '<span class="chip">Use First</span>'}</td>
        </tr>
      `;
    }).join('');
  fefoHostEl.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Vaccine</th>
          <th>Lot</th>
          <th>Expiry</th>
          <th>Doses</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>${fefoRows}</tbody>
    </table>
  `;
}

function renderDoNotUseLots() {
  if (!doNotUseHostEl) return;
  const entries = Object.entries(doNotUseLots || {});
  if (!entries.length) {
    doNotUseHostEl.textContent = 'No lots currently quarantined.';
    return;
  }
  doNotUseHostEl.textContent = `Quarantined lots: ${entries.map(([lot, data]) => `${lot.toUpperCase()} (${data.reason || 'no reason'})`).join(' | ')}`;
}

function renderReconciliation(records) {
  if (!reconHostEl) {
    return;
  }
  if (!records.length) {
    reconHostEl.innerHTML = '<div class="empty">No records available for reconciliation yet.</div>';
    return;
  }

  const groups = getInventoryGroups(records);

  const markup = [...groups.entries()].map(([key, group]) => {
    const physical = Number.parseInt(String(physicalCounts.get(key) ?? ''), 10);
    const variance = Number.isFinite(physical) ? (physical - group.expected) : null;
    const varianceClass = variance === null
      ? ''
      : variance === 0
        ? 'variance-ok'
        : Math.abs(variance) <= 2
          ? 'variance-warn'
          : 'variance-bad';
    const varianceLabel = variance === null ? 'Pending count' : (variance > 0 ? `+${variance}` : String(variance));
    return `
      <tr>
        <td>${group.vaccine}</td>
        <td>${group.lot}</td>
        <td>${group.rows}</td>
        <td>${group.expected}</td>
        <td><input type="number" min="0" data-recon-key="${encodeURIComponent(key)}" value="${Number.isFinite(physical) ? physical : ''}" placeholder="0"></td>
        <td class="${varianceClass}">${varianceLabel}</td>
      </tr>
    `;
  }).join('');

  reconHostEl.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Vaccine</th>
          <th>Lot</th>
          <th>Entries</th>
          <th>Expected Doses</th>
          <th>Physical Count</th>
          <th>Variance</th>
        </tr>
      </thead>
      <tbody>${markup}</tbody>
    </table>
  `;

  reconHostEl.querySelectorAll('[data-recon-key]').forEach((input) => {
    input.addEventListener('input', () => {
      const encoded = input.getAttribute('data-recon-key');
      const key = decodeURIComponent(encoded || '');
      const value = String(input.value || '').trim();
      if (!value) {
        physicalCounts.delete(key);
      } else {
        physicalCounts.set(key, value);
      }
      renderReconciliation(rows);
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

async function enrichParsedData(baseData) {
  let lookup = null;
  if (baseData.lot) {
    lookup = await sendRuntimeMessage({
      action: 'lookupVaccineInfo',
      lot: baseData.lot,
      gtin: baseData.gtin || ''
    });
  }
  const chosenExpiry = baseData.expiry || lookup?.lot_expiry || '';
  const expiryStatus = getExpiryStatus(chosenExpiry);
  const resolvedName =
    baseData.name ||
    lookup?.generic_name ||
    lookup?.tradename ||
    baseData.lot ||
    '';
  return {
    ...baseData,
    name: resolvedName,
    tradename: lookup?.tradename || baseData.tradename || '',
    generic_name: lookup?.generic_name || baseData.generic_name || '',
    disease: lookup?.disease || baseData.disease || '',
    antigen: lookup?.antigen || baseData.antigen || '',
    manufacturer: lookup?.manufacturer || baseData.manufacturer || '',
    nvc_lot_expiry: lookup?.lot_expiry || '',
    inventory_expiry: chosenExpiry,
    expiry_flag: expiryStatus.flag,
    expiry_days_remaining: expiryStatus.daysRemaining,
    expiry_source: baseData.expiry ? 'barcode' : (lookup?.lot_expiry ? 'nvc' : 'none'),
    route: lookup?.route || '',
    strength: lookup?.strength || '',
    dose_value: lookup?.dose_value || '',
    dose_unit: lookup?.dose_unit || '',
    din: lookup?.din || '',
    drug_code: lookup?.din || '',
    lookup_error: lookup?.error || ''
  };
}

function renderTable(records) {
  summaryEl.textContent = buildSummary(records);
  renderReconciliation(records);
  renderLedger();
  renderFefo(records);
  renderDoNotUseLots();
  if (!records.length) {
    tableHostEl.innerHTML = '<div class="empty">No inventory records found. Add scans from the extension popup in Inventory mode.</div>';
    exportBtn.disabled = true;
    clearBtn.disabled = true;
    return;
  }

  exportBtn.disabled = false;
  clearBtn.disabled = false;

  const rowsMarkup = records.map((record, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${record.tradename || record.generic_name || record.name || 'N/A'}</td>
      <td>${record.lot || 'N/A'}</td>
      <td>${record.inventory_expiry || record.barcode_expiry || 'N/A'}</td>
      <td>
        <span class="chip">${record.expiry_flag || 'unknown'}</span>
        ${doNotUseLots[normalizeLotKey(record.lot)] ? '<span class="chip">Do Not Use</span>' : ''}
      </td>
      <td>${record.manufacturer || 'N/A'}</td>
      <td>${record.remaining_doses || record.total_doses || 'N/A'}</td>
      <td>${formatDateTime(record.scanned_at)}</td>
    </tr>
  `).join('');

  tableHostEl.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Vaccine</th>
          <th>Lot</th>
          <th>Expiry</th>
          <th>Status</th>
          <th>Manufacturer</th>
          <th>Doses</th>
          <th>Scanned At</th>
        </tr>
      </thead>
      <tbody>${rowsMarkup}</tbody>
    </table>
  `;
}

async function loadInventory() {
  try {
    const stored = await getLocalStorage([
      INVENTORY_BATCH_KEY,
      INVENTORY_LEDGER_KEY,
      COLD_CHAIN_INCIDENTS_KEY,
      RECON_SIGNOFFS_KEY,
      DO_NOT_USE_LOTS_KEY,
      ULTRA_FAST_SCANNER_KEY,
      SCANNER_BEEPS_KEY
    ]);
    rows = Array.isArray(stored[INVENTORY_BATCH_KEY]) ? stored[INVENTORY_BATCH_KEY] : [];
    ledger = Array.isArray(stored[INVENTORY_LEDGER_KEY]) ? stored[INVENTORY_LEDGER_KEY] : [];
    incidents = Array.isArray(stored[COLD_CHAIN_INCIDENTS_KEY]) ? stored[COLD_CHAIN_INCIDENTS_KEY] : [];
    reconSignoffs = Array.isArray(stored[RECON_SIGNOFFS_KEY]) ? stored[RECON_SIGNOFFS_KEY] : [];
    doNotUseLots = stored[DO_NOT_USE_LOTS_KEY] && typeof stored[DO_NOT_USE_LOTS_KEY] === 'object'
      ? stored[DO_NOT_USE_LOTS_KEY]
      : {};
    ultraFastScannerEnabled = stored[ULTRA_FAST_SCANNER_KEY] !== false;
    scannerBeepsEnabled = stored[SCANNER_BEEPS_KEY] !== false;
    if (ultraFastToggle) ultraFastToggle.checked = ultraFastScannerEnabled;
    if (scannerBeepsToggle) scannerBeepsToggle.checked = scannerBeepsEnabled;
    updateScanIndicator();
    renderTable(rows);
    renderStatus(`Loaded ${rows.length} inventory record(s), ${ledger.length} transaction(s).`);
    if (receiveInput && ultraFastScannerEnabled) {
      receiveInput.focus();
    }
  } catch (error) {
    renderStatus(error.message || 'Could not load inventory.', 'error');
  }
}

async function receiveStockFromLines(lines, options = {}) {
  if (!lines.length) {
    renderStatus('Scan or paste at least one barcode line first.', 'error');
    playErrorBeep();
    return;
  }

  receiveBtn.disabled = true;
  const newRecords = [];
  let failed = 0;
  for (const line of lines) {
    try {
      let parsed;
      try {
        parsed = parseInputData(line);
      } catch (parseError) {
        if (!isLikelyLotOnlyInput(line)) {
          throw parseError;
        }
        // Allow lot-only manual receiving to support NVC enrichment workflows.
        parsed = buildLotOnlyParsedData(line);
      }
      const enriched = await enrichParsedData({
        ...parsed,
        scanned_at: new Date().toISOString()
      });
      newRecords.push(buildQueueRecord(enriched, line));
    } catch (_) {
      failed += 1;
    }
  }

  rows = [...rows, ...newRecords];
  newRecords.forEach((record) => {
    addLedgerEntry({
      type: 'receive_stock',
      lot: record.lot || '',
      vaccine: record.tradename || record.generic_name || record.name || '',
      qty: normalizeDoseCount(record.remaining_doses || record.total_doses),
      note: `Source=barcode; expiry=${record.inventory_expiry || 'N/A'}`
    });
  });
  await setLocalStorage({
    [INVENTORY_BATCH_KEY]: rows,
    [INVENTORY_LEDGER_KEY]: ledger
  });
  renderTable(rows);
  if (!options.keepInput && receiveInput) {
    receiveInput.value = '';
  }
  receiveBtn.disabled = false;

  if (newRecords.length) {
    renderStatus(`Received ${newRecords.length} stock item(s). ${failed ? `${failed} failed.` : ''}`.trim());
    playSuccessBeeps();
    if (receiveInput && ultraFastScannerEnabled) {
      receiveInput.focus();
    }
  } else {
    renderStatus('No stock records were added. Check barcode format.', 'error');
    playErrorBeep();
  }
}

async function receiveStockFromInput() {
  const raw = String(receiveInput?.value || '');
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  await receiveStockFromLines(lines);
}

async function consumeDosesByLot(lot, qty) {
  const targetLot = String(lot || '').trim().toLowerCase();
  let remaining = Number.parseInt(String(qty || 0), 10);
  if (!targetLot || !Number.isFinite(remaining) || remaining <= 0) {
    return 0;
  }
  const sorted = [...rows].sort((a, b) => {
    const ea = String(a.inventory_expiry || a.barcode_expiry || '9999-12-31');
    const eb = String(b.inventory_expiry || b.barcode_expiry || '9999-12-31');
    return ea.localeCompare(eb);
  });

  for (const record of sorted) {
    if (remaining <= 0) break;
    if (String(record.lot || '').trim().toLowerCase() !== targetLot) continue;
    const available = normalizeDoseCount(record.remaining_doses || record.total_doses);
    const used = Math.min(available, remaining);
    const next = available - used;
    record.remaining_doses = next > 0 ? next : 0;
    remaining -= used;
  }

  rows = sorted.filter((record) => normalizeDoseCount(record.remaining_doses || 0) > 0);
  return Number.parseInt(String(qty), 10) - remaining;
}

async function recordWastage() {
  const lot = String(wastageLotInput?.value || '').trim();
  const qty = Number.parseInt(String(wastageQtyInput?.value || ''), 10);
  const reason = String(wastageReasonSelect?.value || 'other');
  const note = String(wastageNoteInput?.value || '').trim();
  if (!lot || !Number.isFinite(qty) || qty <= 0) {
    renderStatus('Enter lot and valid wastage quantity.', 'error');
    playErrorBeep();
    return;
  }
  const consumed = await consumeDosesByLot(lot, qty);
  addLedgerEntry({
    type: 'wastage',
    lot,
    qty: consumed || qty,
    note: `reason=${reason}${note ? `; ${note}` : ''}`
  });
  await setLocalStorage({
    [INVENTORY_BATCH_KEY]: rows,
    [INVENTORY_LEDGER_KEY]: ledger
  });
  renderTable(rows);
  renderStatus(`Wastage recorded for lot ${lot}: ${consumed || qty} dose(s).`);
  playSuccessBeeps();
}

async function recordIncident() {
  const lot = String(incidentLotInput?.value || '').trim();
  const minTemp = String(incidentMinTempInput?.value || '').trim();
  const maxTemp = String(incidentMaxTempInput?.value || '').trim();
  const startedAt = String(incidentStartInput?.value || '').trim();
  const endedAt = String(incidentEndInput?.value || '').trim();
  const outcome = String(incidentOutcomeSelect?.value || 'quarantine');
  const note = String(incidentNoteInput?.value || '').trim();
  if (!minTemp && !maxTemp && !lot) {
    renderStatus('Add at least lot or temperature range for incident logging.', 'error');
    playErrorBeep();
    return;
  }
  const incident = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: nowIso(),
    lot,
    minTemp,
    maxTemp,
    startedAt,
    endedAt,
    outcome,
    note
  };
  incidents.unshift(incident);
  if (incidents.length > 1000) incidents = incidents.slice(0, 1000);
  addLedgerEntry({
    type: 'cold_chain_incident',
    lot,
    note: `outcome=${outcome}; min=${minTemp || 'N/A'}; max=${maxTemp || 'N/A'}${note ? `; ${note}` : ''}`
  });
  await setLocalStorage({
    [COLD_CHAIN_INCIDENTS_KEY]: incidents,
    [INVENTORY_LEDGER_KEY]: ledger
  });
  if (outcome === 'discarded' && lot) {
    const lotQty = rows
      .filter((row) => String(row.lot || '').trim().toLowerCase() === lot.toLowerCase())
      .reduce((total, row) => total + normalizeDoseCount(row.remaining_doses || row.total_doses), 0);
    if (lotQty > 0) {
      const consumed = await consumeDosesByLot(lot, lotQty);
      addLedgerEntry({
        type: 'wastage',
        lot,
        qty: consumed,
        note: 'reason=cold_chain_excursion_discard'
      });
      await setLocalStorage({
        [INVENTORY_BATCH_KEY]: rows,
        [INVENTORY_LEDGER_KEY]: ledger
      });
    }
  }
  if (outcome === 'quarantine' && lot) {
    const key = normalizeLotKey(lot);
    doNotUseLots[key] = { reason: 'cold_chain_incident', ts: nowIso() };
    addLedgerEntry({ type: 'lot_quarantined', lot, note: 'auto from cold chain incident' });
    await setLocalStorage({
      [DO_NOT_USE_LOTS_KEY]: doNotUseLots,
      [INVENTORY_LEDGER_KEY]: ledger
    });
  }
  renderTable(rows);
  renderStatus(`Incident logged${lot ? ` for lot ${lot}` : ''}.`);
  playSuccessBeeps();
}

async function saveReconciliationSignoff() {
  const snapshot = buildReconSnapshot(rows);
  const signoff = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: nowIso(),
    summary: {
      total_groups: snapshot.length,
      matched_groups: snapshot.filter((item) => item.variance === 0).length,
      unresolved_groups: snapshot.filter((item) => item.variance !== 0 && item.variance !== null).length,
      pending_groups: snapshot.filter((item) => item.variance === null).length
    },
    rows: snapshot
  };
  reconSignoffs.unshift(signoff);
  if (reconSignoffs.length > 500) reconSignoffs = reconSignoffs.slice(0, 500);
  addLedgerEntry({
    type: 'reconciliation_signoff',
    qty: signoff.summary.total_groups,
    note: `matched=${signoff.summary.matched_groups}; unresolved=${signoff.summary.unresolved_groups}; pending=${signoff.summary.pending_groups}`
  });
  await setLocalStorage({
    [RECON_SIGNOFFS_KEY]: reconSignoffs,
    [INVENTORY_LEDGER_KEY]: ledger
  });
  renderTable(rows);
  renderStatus('Reconciliation sign-off saved locally.');
  playSuccessBeeps();
}

function exportCsv() {
  if (!rows.length) {
    renderStatus('No inventory records to export.', 'error');
    return;
  }
  const columns = [
    'scan_index',
    'scanned_at',
    'name',
    'tradename',
    'generic_name',
    'manufacturer',
    'gtin',
    'lot',
    'inventory_expiry',
    'expiry_flag',
    'remaining_doses',
    'total_doses',
    'din',
    'raw_barcode'
  ];

  const csvRows = [columns.join(',')];
  rows.forEach((row, index) => {
    csvRows.push(columns.map((column) => {
      if (column === 'scan_index') return csvEscape(index + 1);
      return csvEscape(row[column]);
    }).join(','));
  });

  const blob = new Blob([csvRows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const filename = `vaxlink-inventory-manager-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  renderStatus(`CSV export started: ${filename}`);
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

function exportOpsPackage() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const clinicalSummaryRows = buildClinicalSummaryRows();
  const handoff = buildHandoffData();
  const files = [
    { filename: `vaxlink-clinical-summary-${ts}.csv`, content: buildCsv(['vaccine', 'lot', 'expiry', 'expected_doses', 'physical_count', 'variance', 'do_not_use'], clinicalSummaryRows) },
    { filename: `vaxlink-wastage-${ts}.csv`, content: buildCsv(['ts', 'lot', 'qty', 'note'], ledger.filter((entry) => entry.type === 'wastage')) },
    { filename: `vaxlink-cold-chain-${ts}.csv`, content: buildCsv(['ts', 'lot', 'minTemp', 'maxTemp', 'startedAt', 'endedAt', 'outcome', 'note'], incidents) },
    { filename: `vaxlink-reconciliation-signoffs-${ts}.csv`, content: buildCsv(['ts', 'total_groups', 'matched_groups', 'unresolved_groups', 'pending_groups'], reconSignoffs.map((r) => ({ ts: r.ts, ...r.summary }))) },
    { filename: `vaxlink-shift-handoff-${ts}.csv`, content: buildCsv(['generated_at', 'period_start', 'period_end', 'receives', 'wastage_events', 'cold_chain_incidents', 'reconciliations', 'inventory_rows'], [handoff]) }
  ];
  files.forEach((file) => downloadTextFile(file.filename, file.content, 'text/csv;charset=utf-8'));
  renderStatus(`Clinical CSV pack export started (${files.length} files).`);
}

function exportAdvancedJson() {
  const payload = {
    exported_at: nowIso(),
    inventory_rows: rows,
    ledger,
    cold_chain_incidents: incidents,
    reconciliation_signoffs: reconSignoffs,
    do_not_use_lots: doNotUseLots
  };
  const filename = `vaxlink-ops-package-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  downloadTextFile(filename, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
  renderStatus(`Advanced JSON export started: ${filename}`);
}

function buildCsv(columns, sourceRows) {
  const lines = [columns.join(',')];
  (sourceRows || []).forEach((row) => {
    lines.push(columns.map((column) => csvEscape(row && row[column])).join(','));
  });
  return lines.join('\r\n');
}

function buildClinicalSummaryRows() {
  return buildReconSnapshot(rows).map((item) => ({
    vaccine: item.vaccine,
    lot: item.lot,
    expiry: rows.find((r) => normalizeLotKey(r.lot) === normalizeLotKey(item.lot))?.inventory_expiry || '',
    expected_doses: item.expected_doses,
    physical_count: item.physical_count ?? '',
    variance: item.variance ?? '',
    do_not_use: doNotUseLots[normalizeLotKey(item.lot)] ? 'Y' : ''
  }));
}

function buildHandoffData() {
  const now = new Date();
  const windowStart = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  const recent = ledger.filter((entry) => {
    const ts = new Date(entry.ts || 0).getTime();
    return ts >= windowStart.getTime();
  });
  return {
    generated_at: nowIso(),
    period_start: windowStart.toISOString(),
    period_end: now.toISOString(),
    receives: recent.filter((entry) => entry.type === 'receive_stock').length,
    wastage_events: recent.filter((entry) => entry.type === 'wastage').length,
    cold_chain_incidents: recent.filter((entry) => entry.type === 'cold_chain_incident').length,
    reconciliations: recent.filter((entry) => entry.type === 'reconciliation_signoff').length,
    inventory_rows: rows.length
  };
}

async function setDoNotUseLot(flagged) {
  const lot = String(doNotUseLotInput?.value || '').trim();
  if (!lot) {
    renderStatus('Enter a lot number for do-not-use update.', 'error');
    playErrorBeep();
    return;
  }
  const key = normalizeLotKey(lot);
  if (flagged) {
    const reason = String(doNotUseReasonInput?.value || '').trim() || 'manual';
    doNotUseLots[key] = { reason, ts: nowIso() };
    addLedgerEntry({ type: 'lot_quarantined', lot, note: reason });
  } else {
    delete doNotUseLots[key];
    addLedgerEntry({ type: 'lot_unquarantined', lot, note: 'manual clear' });
  }
  await setLocalStorage({
    [DO_NOT_USE_LOTS_KEY]: doNotUseLots,
    [INVENTORY_LEDGER_KEY]: ledger
  });
  renderTable(rows);
  renderStatus(`${lot} ${flagged ? 'marked as Do Not Use' : 'removed from Do Not Use'}.`);
  playSuccessBeeps();
}

function exportShiftHandoff() {
  const handoff = buildHandoffData();
  const filename = `vaxlink-shift-handoff-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  const csv = buildCsv(
    ['generated_at', 'period_start', 'period_end', 'receives', 'wastage_events', 'cold_chain_incidents', 'reconciliations', 'inventory_rows'],
    [handoff]
  );
  downloadTextFile(filename, csv, 'text/csv;charset=utf-8');
  renderStatus(`Shift handoff export started: ${filename}`);
}

async function clearInventory() {
  const confirmed = window.confirm('Clear all local inventory records?');
  if (!confirmed) return;
  try {
    rows = [];
    addLedgerEntry({ type: 'inventory_cleared', note: 'manual clear from inventory manager' });
    await setLocalStorage({
      [INVENTORY_BATCH_KEY]: [],
      [INVENTORY_LEDGER_KEY]: ledger
    });
    renderTable(rows);
    renderStatus('Inventory cleared.');
  } catch (error) {
    renderStatus(error.message || 'Could not clear inventory.', 'error');
  }
}

refreshBtn.addEventListener('click', () => {
  void loadInventory();
});
receiveBtn.addEventListener('click', () => {
  void receiveStockFromInput();
});
if (receiveInput) {
  receiveInput.addEventListener('keydown', (event) => {
    if (!ultraFastScannerEnabled) return;
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const value = String(receiveInput.value || '').trim();
    if (!value) return;
    receiveInput.value = '';
    void receiveStockFromLines([value], { keepInput: true });
  });
}
if (ultraFastToggle) {
  ultraFastToggle.addEventListener('change', () => {
    ultraFastScannerEnabled = !!ultraFastToggle.checked;
    updateScanIndicator();
    if (receiveInput && ultraFastScannerEnabled) {
      receiveInput.focus();
    }
    void persistScannerSettings();
  });
}
if (scannerBeepsToggle) {
  scannerBeepsToggle.addEventListener('change', () => {
    scannerBeepsEnabled = !!scannerBeepsToggle.checked;
    void persistScannerSettings();
  });
}
saveWastageBtn.addEventListener('click', () => {
  void recordWastage();
});
saveIncidentBtn.addEventListener('click', () => {
  void recordIncident();
});
signoffReconBtn.addEventListener('click', () => {
  void saveReconciliationSignoff();
});
exportPackageBtn.addEventListener('click', exportOpsPackage);
exportJsonBtn.addEventListener('click', exportAdvancedJson);
exportHandoffBtn.addEventListener('click', exportShiftHandoff);
markDoNotUseBtn.addEventListener('click', () => {
  void setDoNotUseLot(true);
});
clearDoNotUseBtn.addEventListener('click', () => {
  void setDoNotUseLot(false);
});

exportBtn.addEventListener('click', exportCsv);
clearBtn.addEventListener('click', () => {
  void clearInventory();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (INVENTORY_BATCH_KEY in changes) {
    rows = Array.isArray(changes[INVENTORY_BATCH_KEY].newValue) ? changes[INVENTORY_BATCH_KEY].newValue : [];
  }
  if (INVENTORY_LEDGER_KEY in changes) {
    ledger = Array.isArray(changes[INVENTORY_LEDGER_KEY].newValue) ? changes[INVENTORY_LEDGER_KEY].newValue : [];
  }
  if (COLD_CHAIN_INCIDENTS_KEY in changes) {
    incidents = Array.isArray(changes[COLD_CHAIN_INCIDENTS_KEY].newValue) ? changes[COLD_CHAIN_INCIDENTS_KEY].newValue : [];
  }
  if (RECON_SIGNOFFS_KEY in changes) {
    reconSignoffs = Array.isArray(changes[RECON_SIGNOFFS_KEY].newValue) ? changes[RECON_SIGNOFFS_KEY].newValue : [];
  }
  if (DO_NOT_USE_LOTS_KEY in changes) {
    doNotUseLots = changes[DO_NOT_USE_LOTS_KEY].newValue && typeof changes[DO_NOT_USE_LOTS_KEY].newValue === 'object'
      ? changes[DO_NOT_USE_LOTS_KEY].newValue
      : {};
  }
  renderTable(rows);
  renderStatus(`Inventory data updated: ${rows.length} record(s), ${ledger.length} transaction(s).`);
});

void loadInventory();
