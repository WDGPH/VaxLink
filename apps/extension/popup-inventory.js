import { buildLegacyQueueRecord } from './queue-record.js';
import { escapeHtml } from './popup-ui.js';

export const MULTIPLE_INJECT_QUEUE_KEY = 'multiple_inject_queue_v1';
export const INVENTORY_BATCH_KEY = 'inventory_scan_batch_v1';

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

function getRemainingDoseCount(row, fallback = 1) {
  const remaining = normalizeDoseCount(row && row.remaining_doses, null);
  if (remaining !== null) {
    return remaining;
  }
  const total = normalizeDoseCount(row && row.total_doses, null);
  return total !== null ? total : fallback;
}

function getTotalDoseCount(row) {
  return normalizeDoseCount(row && row.total_doses, null);
}

function formatDoseSummary(row) {
  const remaining = getRemainingDoseCount(row, null);
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

export class ScanQueueManager {
  constructor({
    storageKey,
    summaryEl,
    listEl,
    clearButton,
    exportButton = null,
    onUseRecord = null,
    showUseAction = false,
    useButtonLabel = 'Use for Chart',
    onMoveRecord = null,
    showMoveAction = false,
    moveButtonLabel = 'Move',
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
    this.useButtonLabel = useButtonLabel;
    this.onMoveRecord = typeof onMoveRecord === 'function' ? onMoveRecord : null;
    this.showMoveAction = !!showMoveAction;
    this.moveButtonLabel = moveButtonLabel;
    this.emptySummary = emptySummary;
    this.emptyMessage = emptyMessage;
    this.summaryBuilder = typeof summaryBuilder === 'function' ? summaryBuilder : defaultSummaryBuilder;
    this.exportFilenamePrefix = exportFilenamePrefix;
    this.rows = [];
    this.activeUseId = '';
    this.handleStorageChanged = this.handleStorageChanged.bind(this);
    chrome.storage.onChanged.addListener(this.handleStorageChanged);
  }

  async load() {
    const stored = await getLocalStorage([this.storageKey]);
    const rows = stored && Array.isArray(stored[this.storageKey]) ? stored[this.storageKey] : [];
    this.rows = rows.filter((row) => row && typeof row === 'object');
    this.render();
  }

  // Every mutation re-reads storage first: the background worker appends
  // hands-free scans to the same key while the popup is open, and a mutation
  // computed from a stale in-memory copy would silently clobber them.
  async mutateRows(mutator) {
    const stored = await getLocalStorage([this.storageKey]);
    const current = (stored && Array.isArray(stored[this.storageKey]) ? stored[this.storageKey] : [])
      .filter((row) => row && typeof row === 'object');
    const next = mutator(current);
    this.rows = Array.isArray(next) ? next.filter((row) => row && typeof row === 'object') : [];
    await this.persist();
    this.render();
  }

  async add(record) {
    await this.mutateRows((rows) => [...rows, record]);
  }

  async addMany(records) {
    await this.mutateRows((rows) => [...rows, ...records]);
  }

  async clear() {
    this.activeUseId = '';
    await this.mutateRows(() => []);
  }

  async remove(id) {
    if (this.activeUseId === id) {
      this.activeUseId = '';
    }
    await this.mutateRows((rows) => rows.filter((row) => row.id !== id));
  }

  async replaceRows(rows) {
    const sanitized = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
    await this.mutateRows(() => sanitized);
  }

  async updateById(id, patch) {
    const targetId = String(id || '');
    if (!targetId || !patch || typeof patch !== 'object') {
      return null;
    }
    let updated = null;
    await this.mutateRows((rows) => rows.map((row) => {
      if (!row || row.id !== targetId) return row;
      updated = { ...row, ...patch };
      return updated;
    }));
    return updated;
  }

  async setDoseCounts(id, totalDoses) {
    const targetId = String(id || '');
    const total = normalizeDoseCount(totalDoses, null);
    if (!targetId || total === null) {
      return null;
    }

    const row = this.getById(targetId);
    if (!row) {
      return null;
    }

    const remaining = total;
    return this.updateById(targetId, {
      total_doses: total,
      remaining_doses: remaining,
      dose_tracking: 'manual'
    });
  }

  async consumeById(id) {
    const targetId = String(id || '');
    if (!targetId) {
      return null;
    }
    if (!this.getById(targetId)) {
      return null;
    }

    // Decide remove-vs-decrement from the FRESH stored row inside the mutator:
    // another context (queue drain, second tab) may have decremented this vial
    // since our last sync, and a stale base would resurrect a consumed dose.
    let result = null;
    let removed = false;
    await this.mutateRows((rows) => {
      const next = [];
      for (const item of rows) {
        if (!item || item.id !== targetId) {
          next.push(item);
          continue;
        }
        const remaining = getRemainingDoseCount(item, null);
        if (remaining === null) {
          // Unknown dose count — vial is unlimited; keep record alive unchanged
          result = item;
          next.push(item);
        } else if (remaining <= 1) {
          // Last dose consumed — drop the row.
          removed = true;
        } else {
          const total = getTotalDoseCount(item) || remaining;
          result = {
            ...item,
            total_doses: total,
            remaining_doses: remaining - 1,
            dose_tracking: 'manual'
          };
          next.push(result);
        }
      }
      return next;
    });

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
      ...this.rows.map((row, index) => CSV_COLUMNS.map((column) => {
        if (column === 'scan_index') {
          return csvEscape(index + 1);
        }
        return csvEscape(row[column]);
      }).join(','))
    ];

    const blob = new Blob([csvRows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
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

    if (!this.rows.length) {
      this.summaryEl.textContent = this.emptySummary;
      this.listEl.innerHTML = `<div class="inventory-empty">${escapeHtml(this.emptyMessage)}</div>`;
      this.updateControls();
      return;
    }

    this.summaryEl.textContent = this.summaryBuilder(this.rows);

    this.listEl.innerHTML = this.rows
      .map((row, index) => buildQueueItemMarkup(row, index, {
        isActive: row.id && row.id === this.activeUseId,
        showUseAction: this.showUseAction,
        useButtonLabel: this.useButtonLabel,
        showMoveAction: this.showMoveAction,
        moveButtonLabel: this.moveButtonLabel
      }))
      .join('');

    this.listEl.querySelectorAll('[data-remove-id]').forEach((button) => {
      button.addEventListener('click', () => {
        this.remove(button.getAttribute('data-remove-id'));
      });
    });

    if (this.showMoveAction && this.onMoveRecord) {
      this.listEl.querySelectorAll('[data-move-id]').forEach((button) => {
        button.addEventListener('click', async () => {
          const id = button.getAttribute('data-move-id');
          const row = this.getById(id);
          if (!row) {
            return;
          }
          await this.onMoveRecord(row);
        });
      });
    }

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
    this.listEl.querySelectorAll('[data-set-doses-id]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.getAttribute('data-set-doses-id');
        const row = this.getById(id);
        if (!row) {
          return;
        }
        const promptLabel = row.tradename || row.generic_name || row.name || row.lot || 'this vial';
        const currentValue = getRemainingDoseCount(row, 1);
        const nextValue = window.prompt(
          `Set remaining doses for ${promptLabel}.`,
          String(currentValue || '')
        );
        if (nextValue === null) {
          return;
        }

        const nextDoseTotal = normalizeDoseCount(nextValue, null);
        if (nextDoseTotal === null) {
          return;
        }

        await this.setDoseCounts(id, nextDoseTotal);
      });
    });

    this.updateControls();
  }

  async persist() {
    await setLocalStorage({ [this.storageKey]: this.rows });
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
    if (this.activeUseId && !this.rows.some((row) => row.id === this.activeUseId)) {
      this.activeUseId = '';
    }
    this.render();
  }
}

// Adds to the destination before removing from the source: if the remove
// step fails partway (e.g. a storage error), the record survives as a
// duplicate in both queues rather than vanishing from both.
export async function moveQueueRecord(sourceManager, destManager, id) {
  const targetId = String(id || '');
  if (!targetId) {
    return null;
  }
  const record = sourceManager.getById(targetId);
  if (!record) {
    return null;
  }
  await destManager.add(record);
  await sourceManager.remove(targetId);
  return record;
}

export function buildQueueRecord(data, rawBarcode) {
  return buildLegacyQueueRecord({
    ...data,
    total_doses: normalizeDoseCount(data.total_doses, null),
    remaining_doses:
      normalizeDoseCount(
        data.remaining_doses,
        normalizeDoseCount(data.total_doses, null)
      )
  }, rawBarcode);
}

export function buildMultipleInjectSummary(rows) {
  const count = rows.length;
  const lockedCount = rows.filter((row) => row.captured_while_locked === true).length;
  const expiredCount = rows.filter((row) => row.expiry_flag === 'expired').length;
  const expiringCount = rows.filter((row) => row.expiry_flag === 'expiring_soon').length;
  const doseTotal = rows.reduce((total, row) => {
    const remaining = getRemainingDoseCount(row, 0);
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
  const expiredCount = rows.filter((row) => row.expiry_flag === 'expired').length;
  const expiringCount = rows.filter((row) => row.expiry_flag === 'expiring_soon').length;
  const doseTotal = rows.reduce((total, row) => {
    const remaining = getRemainingDoseCount(row, 0);
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
  const title = escapeHtml(row.tradename || row.generic_name || row.name || row.lot || `Scan ${index + 1}`);
  const lot = escapeHtml(row.lot || 'N/A');
  const expiry = escapeHtml(row.inventory_expiry || row.barcode_expiry || 'N/A');
  const manufacturer = escapeHtml(row.manufacturer || 'N/A');
  const status = escapeHtml(formatInventoryStatus(row));
  const scannedAt = escapeHtml(formatInventoryTimestamp(row.scanned_at));
  const id = escapeHtml(row.id || '');
  const doseText = formatDoseSummary(row);
  const useActionMarkup = options.showUseAction
    ? `<button class="inventory-use" type="button" data-use-id="${id}">${escapeHtml(options.useButtonLabel)}</button>`
    : '';
  const moveActionMarkup = options.showMoveAction
    ? `<button class="inventory-move" type="button" data-move-id="${id}">${escapeHtml(options.moveButtonLabel)}</button>`
    : '';
  const setDoseActionMarkup = `<button class="inventory-dose-set" type="button" data-set-doses-id="${id}">Set doses</button>`;

  return `
    <div class="inventory-item${options.isActive ? ' active' : ''}">
      <div class="inventory-item-top">
        <div>
          <div class="inventory-item-title">${title}</div>
          <div class="inventory-item-meta">Lot ${lot} | ${scannedAt}</div>
        </div>
        <div class="inventory-item-actions">
          ${useActionMarkup}
          ${moveActionMarkup}
          ${setDoseActionMarkup}
          <button class="inventory-remove" type="button" data-remove-id="${id}">Remove</button>
        </div>
      </div>
      <div class="inventory-item-grid">
        <span class="inventory-chip">Expiry ${expiry}</span>
        <span class="inventory-chip">Status ${status}</span>
        <span class="inventory-chip">Mfr ${manufacturer}</span>
        ${doseText ? `<span class="inventory-chip">${escapeHtml(doseText)}</span>` : ''}
      </div>
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
  const guarded = /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)
    ? `'${text}`
    : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}
