import './shared/nvc-lot-report.js';
import './shared/tray-doses.js';
import { buildLegacyQueueRecord } from './queue-record.js';
import { escapeHtml } from './popup-ui.js';

export const MULTIPLE_INJECT_QUEUE_KEY = 'multiple_inject_queue_v1';
export const INVENTORY_BATCH_KEY = 'inventory_scan_batch_v1';

const {
  getTrayRemainingDoses,
  getTrayDoseFields,
  canPinTrayDose,
  defaultChartDose
} = globalThis.VaxLinkTrayDoses;

const CSV_COLUMNS = [
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
  'total_doses',
  'remaining_doses',
  'din',
  'drug_code',
  'lookup_error',
  'raw_barcode'
];

function normalizeDoseCount(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function getTotalDoseCount(row) {
  return normalizeDoseCount(row && row.total_doses, null);
}

function formatDoseSummary(row) {
  if (row.dose_tracking === 'retained') return 'Pinned for reuse';
  const remaining = getTrayRemainingDoses(row);
  if (remaining === null) {
    // No dose count known — vial is treated as unlimited (multi-dose)
    return 'multi-dose';
  }
  const total = getTotalDoseCount(row);
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return '';
  }
  if (total && total > 1) {
    const clampedRemaining = remaining > total ? total : remaining;
    return `${clampedRemaining}/${total} dose(s) remaining`;
  }
  return `${remaining} dose(s) remaining`;
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

function mutateQueue(storageKey, operation, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'mutateQueue', storageKey, operation, payload },
      (response) => {
        if (chrome.runtime.lastError || !response?.success) {
          reject(
            new Error(
              chrome.runtime.lastError?.message ||
                response?.error ||
                'Tray update failed'
            )
          );
        } else {
          resolve(response);
        }
      }
    );
  });
}

export class ScanQueueManager {
  constructor({
    storageKey,
    summaryEl,
    listEl,
    clearButton,
    exportButton = null,
    onUseRecord = null,
    onNotice = () => {},
    showUseAction = false,
    useButtonLabel = 'Use for Chart',
    emptySummary = 'No saved scans yet.',
    emptyMessage = 'No saved scans yet.',
    summaryBuilder = defaultSummaryBuilder,
    exportFilenamePrefix = 'vaxlink-queue'
  }) {
    this.storageKey = storageKey;
    this.summaryEl = summaryEl;
    this.listEl = listEl;
    this.clearButton = clearButton;
    this.exportButton = exportButton;
    this.onUseRecord = typeof onUseRecord === 'function' ? onUseRecord : null;
    this.showUseAction = !!showUseAction;
    this.onNotice = onNotice;
    this.useButtonLabel = useButtonLabel;
    this.emptySummary = emptySummary;
    this.emptyMessage = emptyMessage;
    this.summaryBuilder =
      typeof summaryBuilder === 'function'
        ? summaryBuilder
        : defaultSummaryBuilder;
    this.exportFilenamePrefix = exportFilenamePrefix;
    this.rows = [];
    this.activeUseId = '';
    this.handleStorageChanged = this.handleStorageChanged.bind(this);
    chrome.storage.onChanged.addListener(this.handleStorageChanged);
  }

  async load() {
    const stored = await getLocalStorage([this.storageKey]);
    const rows =
      stored && Array.isArray(stored[this.storageKey])
        ? stored[this.storageKey]
        : [];
    this.rows = rows.filter((row) => row && typeof row === 'object');
    this.render();
  }

  async mutateRows(operation, payload = {}) {
    const result = await mutateQueue(this.storageKey, operation, payload);
    this.rows = result.rows;
    this.render();
    return result.record;
  }

  async add(record, { confirmExpired } = {}) {
    await this.mutateRows('add', { records: [record], confirmExpired });
  }

  async addMany(records) {
    await this.mutateRows('add', { records });
  }

  async clear() {
    this.activeUseId = '';
    await this.mutateRows('clear');
  }

  async remove(id) {
    if (this.activeUseId === id) this.activeUseId = '';
    await this.mutateRows('remove', { id });
  }

  async updateById(id, patch) {
    const targetId = String(id || '');
    if (!targetId || !patch || typeof patch !== 'object') return null;
    return this.mutateRows('update', { id: targetId, patch });
  }

  async setDoseCounts(
    id,
    value,
    expected = getTrayDoseFields(this.getById(id))
  ) {
    const text = String(value).trim();
    const quantity = Number(text);
    if (
      !/^\d+$/.test(text) ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1
    ) {
      throw new Error('Enter a whole number of doses greater than zero.');
    }
    return this.mutateRows('setDoseCount', { id, quantity, expected });
  }

  async consumeById(id) {
    const targetId = String(id || '');
    if (!targetId) {
      return null;
    }
    if (!this.getById(targetId)) {
      return null;
    }

    const result = await this.mutateRows('consume', { id: targetId });
    const removed = !this.getById(targetId);

    if (removed && this.activeUseId === targetId) {
      this.activeUseId = '';
      this.render();
    }
    return result;
  }

  get count() {
    return this.rows.length;
  }

  getById(id) {
    return this.rows.find((row) => row && row.id === id) || null;
  }

  setActiveUse(id) {
    this.activeUseId = id || '';
    this.render();
  }

  exportCsv() {
    if (!this.rows.length) {
      return null;
    }

    const csvRows = [
      CSV_COLUMNS.join(','),
      ...this.rows.map((row, index) =>
        CSV_COLUMNS.map((column) => {
          if (column === 'scan_index') {
            return csvEscape(index + 1);
          }
          return csvEscape(row[column]);
        }).join(',')
      )
    ];

    const blob = new Blob([csvRows.join('\r\n')], {
      type: 'text/csv;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const filename = `${this.exportFilenamePrefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return filename;
  }

  render() {
    if (!this.summaryEl || !this.listEl) return;

    const editing = this.listEl.querySelector?.('.inventory-quantity:focus');
    if (editing) editing.onblur = null;
    if (editing && editing.value !== editing.defaultValue) {
      const editedRow = this.getById(editing.dataset.setDosesId);
      if (
        !editedRow ||
        editing.dataset.doseFields !== getTrayDoseFields(editedRow)
      ) {
        this.onNotice('The saved dose changed. Check the tray and try again.');
      }
    }
    if (!this.rows.length) {
      this.summaryEl.textContent = this.emptySummary;
      this.listEl.innerHTML = this.emptyMessage
        ? `<div class="inventory-empty">${escapeHtml(this.emptyMessage)}</div>`
        : '';
      this.updateControls();
      return;
    }

    this.summaryEl.textContent = this.summaryBuilder(this.rows);

    this.listEl.innerHTML = this.rows
      .map((row, index) =>
        buildQueueItemMarkup(row, index, {
          isActive: row.id && row.id === this.activeUseId,
          showUseAction: this.showUseAction,
          useButtonLabel: this.useButtonLabel
        })
      )
      .join('');

    this.listEl.querySelectorAll('[data-remove-id]').forEach((button) => {
      button.addEventListener('click', () => {
        this.remove(button.getAttribute('data-remove-id'));
      });
    });

    if (this.showUseAction && this.onUseRecord) {
      this.listEl.querySelectorAll('[data-use-id]').forEach((button) => {
        button.addEventListener('click', async () => {
          const id = button.getAttribute('data-use-id');
          const row = this.getById(id);
          if (!row) {
            return;
          }
          this.activeUseId = id || '';
          this.render();
          await this.onUseRecord(row);
        });
      });
    }
    for (const button of this.listEl.querySelectorAll('[data-pin-dose-id]')) {
      button.addEventListener('click', async () => {
        const row = this.getById(button.dataset.pinDoseId);
        if (!row) return;
        try {
          await this.mutateRows('setDosePinned', {
            id: row.id,
            pinned: row.dose_tracking !== 'retained',
            expected: getTrayDoseFields(row)
          });
        } catch (error) {
          this.onNotice(error.message);
        }
      });
    }
    for (const input of this.listEl.querySelectorAll('[data-set-doses-id]')) {
      const { setDosesId: id, doseFields: expected } = input.dataset;
      input.onblur = async () => {
        if (input.value === input.defaultValue) return;
        try {
          await this.setDoseCounts(id, input.value, expected);
        } catch (error) {
          input.value = input.defaultValue;
          this.onNotice(error.message);
        }
      };
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== 'Escape') return;
        event.preventDefault();
        if (event.key === 'Escape') input.value = input.defaultValue;
        input.blur();
      });
      if (
        editing?.dataset.setDosesId === id &&
        editing.dataset.doseFields === expected
      ) {
        input.value = editing.value;
        input.focus({ preventScroll: true });
        input.setSelectionRange(editing.selectionStart, editing.selectionEnd);
      }
    }

    this.updateControls();
  }

  updateControls() {
    const hasItems = this.rows.length > 0;
    if (this.exportButton) {
      this.exportButton.disabled = !hasItems;
    }
    if (this.clearButton) {
      this.clearButton.disabled = !hasItems;
    }
  }

  handleStorageChanged(changes, area) {
    if (area !== 'local' || !(this.storageKey in changes)) {
      return;
    }
    const nextRows = Array.isArray(changes[this.storageKey]?.newValue)
      ? changes[this.storageKey].newValue
      : [];
    this.rows = nextRows.filter((row) => row && typeof row === 'object');
    if (
      this.activeUseId &&
      !this.rows.some((row) => row.id === this.activeUseId)
    ) {
      this.activeUseId = '';
    }
    this.render();
  }
}

export function buildQueueRecord(data, rawBarcode, { chartDose = false } = {}) {
  if (chartDose) data = defaultChartDose(data);
  return buildLegacyQueueRecord(
    {
      ...data,
      total_doses: normalizeDoseCount(data.total_doses, null),
      remaining_doses: normalizeDoseCount(
        data.remaining_doses,
        normalizeDoseCount(data.total_doses, null)
      )
    },
    rawBarcode
  );
}

export function buildMultipleInjectSummary(rows) {
  const count = rows.length;
  const lockedCount = rows.filter(
    (row) => row.captured_while_locked === true
  ).length;
  const expiredCount = rows.filter(
    (row) => row.expiry_flag === 'expired'
  ).length;
  const expiringCount = rows.filter(
    (row) => row.expiry_flag === 'expiring_soon'
  ).length;
  const doseTotal = rows.reduce((total, row) => {
    const remaining = getTrayRemainingDoses(row) ?? 0;
    return total + (Number.isFinite(remaining) ? remaining : 0);
  }, 0);
  let summary = `${count} vaccine(s) saved for later chart fill.`;
  if (lockedCount > 0) {
    summary += ` ${lockedCount} captured while the workstation was locked.`;
  }
  if (doseTotal > 0) {
    summary += ` ${doseTotal} dose(s) remaining across all vials.`;
  }
  if (expiredCount || expiringCount) {
    summary += ` ${expiredCount} expired, ${expiringCount} expiring soon.`;
  }
  return summary;
}

export function buildInventorySummary(rows) {
  const count = rows.length;
  const expiredCount = rows.filter(
    (row) => row.expiry_flag === 'expired'
  ).length;
  const expiringCount = rows.filter(
    (row) => row.expiry_flag === 'expiring_soon'
  ).length;
  const doseTotal = rows.reduce((total, row) => {
    const remaining = getTrayRemainingDoses(row) ?? 0;
    return total + (Number.isFinite(remaining) ? remaining : 0);
  }, 0);
  let summary = `${count} scan(s) ready for inventory export.`;
  if (doseTotal > 0) {
    summary += ` ${doseTotal} dose(s) remaining across all vials.`;
  }
  if (expiredCount || expiringCount) {
    summary += ` ${expiredCount} expired, ${expiringCount} expiring soon.`;
  }
  return summary;
}

function buildQueueItemMarkup(row, index, options) {
  const title = escapeHtml(
    row.tradename ||
      row.generic_name ||
      row.name ||
      row.lot ||
      `Scan ${index + 1}`
  );
  const lot = escapeHtml(row.lot || 'N/A');
  const expiry = escapeHtml(
    row.inventory_expiry || row.barcode_expiry || 'N/A'
  );
  const manufacturer = escapeHtml(row.manufacturer || 'N/A');
  const status = escapeHtml(formatInventoryStatus(row));
  const scannedAt = escapeHtml(formatInventoryTimestamp(row.scanned_at));
  const id = escapeHtml(row.id || '');
  const reportUrl = globalThis.VaxLinkNvcLotReport.makeDraft(row);
  const lookupMessage = reportUrl
    ? 'Lot missing from the catalogue'
    : row.lookup_error;
  const doseText = formatDoseSummary(row);
  const useActionMarkup =
    options.showUseAction && !globalThis.VaxLinkExpiryDate.blocksChartUse(row)
      ? `<button class="inventory-use" type="button" data-use-id="${id}">${escapeHtml(options.useButtonLabel)}</button>`
      : '';
  const pinned = row.dose_tracking === 'retained';
  const quantity = getTrayRemainingDoses(row) ?? '';
  const pinMarkup =
    useActionMarkup && canPinTrayDose(row)
      ? `<button class="inventory-dose-set" type="button" data-pin-dose-id="${id}" aria-pressed="${pinned}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${title}, lot ${lot}">${pinned ? 'Unpin' : 'Pin'}</button>`
      : '';

  return `
    <div class="inventory-item${options.isActive ? ' active' : ''}">
      <div class="inventory-item-top">
        <div>
          <div class="inventory-item-title">${title}</div>
          <div class="inventory-item-meta">Lot ${lot} | ${scannedAt}${row.reference_only ? ' | Reference only' : ''}</div>
        </div>
        <div class="inventory-item-actions">
          ${useActionMarkup}
          <input class="inventory-quantity" type="text" inputmode="numeric" value="${quantity}" placeholder="Qty" data-set-doses-id="${id}" data-dose-fields="${escapeHtml(getTrayDoseFields(row))}" aria-label="Remaining doses for ${title}, lot ${lot}" title="Press Enter to save or Escape to cancel">
          ${pinMarkup}
          <button class="inventory-remove" type="button" data-remove-id="${id}">Remove</button>
        </div>
      </div>
      <div class="inventory-item-grid">
        <span class="inventory-chip">Expiry ${expiry}</span>
        <span class="inventory-chip">Status ${status}</span>
        <span class="inventory-chip">Mfr ${manufacturer}</span>
        ${doseText ? `<span class="inventory-chip">${escapeHtml(doseText)}</span>` : ''}
      </div>
      ${lookupMessage ? `<div class="inventory-lot-report"><span>${escapeHtml(lookupMessage)}</span>${reportUrl ? `<a href="${escapeHtml(reportUrl)}">Email lot report</a>` : ''}</div>` : ''}
    </div>
  `;
}

function defaultSummaryBuilder(rows) {
  return `${rows.length} saved item(s).`;
}

function formatInventoryTimestamp(value) {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatInventoryStatus(row) {
  const flag = row && row.expiry_flag ? row.expiry_flag : 'unknown';
  if (flag === 'expired') return 'Expired';
  if (flag === 'expiring_soon') return 'Expiring soon';
  if (flag === 'valid') return 'Valid';
  return 'Unknown';
}

function csvEscape(value) {
  const text = value === undefined || value === null ? '' : String(value);
  // Neutralize spreadsheet formula injection: Excel/Sheets evaluate cells
  // starting with = + - @ even when quote-wrapped. Plain numbers (e.g. a
  // negative expiry_days_remaining) are exempt so they stay numeric.
  const guarded =
    /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)
      ? `'${text}`
      : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}
