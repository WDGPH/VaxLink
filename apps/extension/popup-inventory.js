import './shared/nvc-lot-report.js';
import './shared/tray-doses.js';
import { buildLegacyQueueRecord } from './queue-record.js';
import { getExpiryStatus, parseDateToLocal } from './popup-parser.js';
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
    transferButton = null,
    onCount = () => {},
    exportButton = null,
    onUseRecord = null,
    onNotice = () => {},
    showUseAction = false,
    useButtonLabel = 'Use for Chart',
    emptySummary = 'No saved scans yet.',
    emptyMessage = 'No saved scans yet.',
    exportFilenamePrefix = 'vaxlink-queue'
  }) {
    this.storageKey = storageKey;
    this.summaryEl = summaryEl;
    this.listEl = listEl;
    this.clearButton = clearButton;
    this.transferButton = transferButton;
    this.onCount = onCount;
    this.exportButton = exportButton;
    this.onUseRecord = typeof onUseRecord === 'function' ? onUseRecord : null;
    this.showUseAction = !!showUseAction;
    this.onNotice = onNotice;
    this.useButtonLabel = useButtonLabel;
    this.emptySummary = emptySummary;
    this.emptyMessage = emptyMessage;
    this.exportFilenamePrefix = exportFilenamePrefix;
    this.rows = [];
    this.selectedIds = new Set();
    this.draggedId = '';
    this.rowRevision = 0;
    this.activeUseId = '';
    this.handleStorageChanged = this.handleStorageChanged.bind(this);
    chrome.storage.onChanged.addListener(this.handleStorageChanged);
  }

  async load() {
    const revision = this.rowRevision;
    const stored = await getLocalStorage([this.storageKey]);
    if (revision === this.rowRevision) this.setRows(stored?.[this.storageKey]);
  }

  setRows(rows) {
    this.rowRevision += 1;
    this.rows = Array.isArray(rows)
      ? rows.filter((row) => row && typeof row === 'object')
      : [];
    for (const id of this.selectedIds)
      if (!this.getById(id)) this.selectedIds.delete(id);
    if (this.activeUseId && !this.getById(this.activeUseId))
      this.activeUseId = '';
    this.render();
  }

  async mutate(operation, payload) {
    const revision = this.rowRevision;
    const result = await mutateQueue(this.storageKey, operation, payload);
    // A later capture can already be visible when a mutation reply arrives.
    if (revision === this.rowRevision) this.setRows(result.rows);
    return result;
  }

  async mutateRows(operation, payload = {}) {
    return (await this.mutate(operation, payload)).record;
  }

  getSelectedRows() {
    return this.rows.filter(({ id }) => this.selectedIds.has(id));
  }

  async transfer(ids, confirmExpired) {
    return (await this.mutate('transfer', { ids, confirmExpired })).moved;
  }

  async reorder(id, targetId, after) {
    await this.mutateRows('reorder', { id, targetId, after });
    // Restore the keyboard handle if the list was replaced by the save.
    [...(this.listEl?.querySelectorAll('[data-reorder-id]') || [])]
      .find((handle) => handle.dataset.reorderId === id)
      ?.focus({ preventScroll: true });
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
      this.summaryEl.hidden = false;
      this.summaryEl.textContent = this.emptySummary;
      this.listEl.innerHTML = this.emptyMessage
        ? `<div class="inventory-empty">${escapeHtml(this.emptyMessage)}</div>`
        : '';
      this.updateControls();
      return;
    }

    this.summaryEl.hidden = true;

    const headings = `<div class="inventory-list-heading" aria-hidden="true"><span>Vaccine</span><span>Qty</span></div>`;
    this.listEl.innerHTML =
      headings +
      this.rows
        .map((row, index) =>
          buildQueueItemMarkup(row, index, {
            isActive: row.id && row.id === this.activeUseId,
            selected: this.selectedIds.has(row.id),
            showUseAction: this.showUseAction,
            useButtonLabel: this.useButtonLabel
          })
        )
        .join('');

    this.listEl.querySelectorAll('[data-remove-id]').forEach((button) => {
      button.addEventListener('click', () => {
        void this.remove(button.getAttribute('data-remove-id')).catch((error) =>
          this.onNotice(error.message)
        );
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

    for (const input of this.listEl.querySelectorAll('[data-select-id]')) {
      input.addEventListener('change', () => {
        const id = input.dataset.selectId;
        if (input.checked) this.selectedIds.add(id);
        else this.selectedIds.delete(id);
        this.updateControls();
      });
    }
    for (const handle of this.listEl.querySelectorAll('[data-reorder-id]')) {
      const id = handle.dataset.reorderId;
      handle.addEventListener('dragstart', (event) => {
        this.draggedId = id;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', id);
      });
      handle.addEventListener('dragend', () => {
        this.draggedId = '';
      });
      handle.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        const after = event.key === 'ArrowDown';
        const index = this.rows.findIndex((row) => row.id === id);
        const target = this.rows[index + (after ? 1 : -1)];
        if (index >= 0 && target?.id)
          void this.reorder(id, target.id, after).catch((error) =>
            this.onNotice(error.message)
          );
      });
    }
    for (const item of this.listEl.querySelectorAll('[data-tray-row-id]')) {
      item.addEventListener('dragover', (event) => {
        if (this.draggedId && this.draggedId !== item.dataset.trayRowId)
          event.preventDefault();
      });
      item.addEventListener('drop', (event) => {
        const id = this.draggedId;
        this.draggedId = '';
        const target = item.dataset.trayRowId;
        if (!id || id === target) return;
        event.preventDefault();
        const bounds = item.getBoundingClientRect();
        const after = event.clientY > bounds.top + bounds.height / 2;
        void this.reorder(id, target, after).catch((error) =>
          this.onNotice(error.message)
        );
      });
    }

    this.updateControls();
  }

  updateControls() {
    const hasItems = this.rows.length > 0;
    this.onCount(this.rows.length);
    if (this.transferButton)
      this.transferButton.disabled = this.selectedIds.size === 0;
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
    this.setRows(changes[this.storageKey]?.newValue);
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

function buildQueueItemMarkup(row, index, options) {
  const title = escapeHtml(
    row.tradename ||
      row.generic_name ||
      row.name ||
      row.lot ||
      `Scan ${index + 1}`
  );
  const lot = escapeHtml(row.lot || 'Unknown');
  const expiredDate = options.showUseAction
    ? globalThis.VaxLinkExpiryDate.expiredVaccineDate(row)
    : null;
  const expiry =
    expiredDate ||
    row.inventory_expiry ||
    row.barcode_expiry ||
    row.nvc_lot_expiry;
  const date = parseDateToLocal(expiry);
  const { flag } = getExpiryStatus(expiry);
  const expired = flag === 'expired' || row.expiry_flag === 'expired';
  const tone = expired ? 'expired' : flag;
  let expiryText = expired ? 'Expired · Date unknown' : 'Expiry unknown';
  if (date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    expiryText = `${expired ? 'Expired' : 'Expires'} ${date.getFullYear()}-${month}-${day}`;
  }
  const description = escapeHtml(
    [row.manufacturer, formatInventoryTimestamp(row.scanned_at)]
      .filter(Boolean)
      .join(' · ')
  );
  const id = escapeHtml(row.id || '');
  const reportUrl = globalThis.VaxLinkNvcLotReport.makeDraft(row);
  const lookupMessage = reportUrl
    ? 'Lot missing from the catalogue'
    : row.lookup_error;
  const held =
    Array.isArray(row.dose_reservations) && row.dose_reservations.length > 0;
  const useActionMarkup =
    options.showUseAction && !globalThis.VaxLinkExpiryDate.blocksChartUse(row)
      ? `<button class="inventory-use" type="button" data-use-id="${id}" aria-label="Use ${title}, lot ${lot}, for chart">${escapeHtml(options.useButtonLabel)}</button>`
      : '';
  const pinned = row.dose_tracking === 'retained';
  const quantity = getTrayRemainingDoses(row) ?? '';
  const pinMarkup =
    useActionMarkup && canPinTrayDose(row)
      ? `<button class="tray-tool tray-pin" type="button" data-pin-dose-id="${id}" aria-pressed="${pinned}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${title}, lot ${lot}" title="${pinned ? 'Unpin' : 'Pin for reuse'}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m16 3 5 5-3 1-3 4v4l-3 1-6-6 1-3h4l4-3 1-3ZM9 15l-6 6"/></svg></button>`
      : '';

  return `
    <div class="inventory-item ${tone}${options.isActive ? ' active' : ''}" data-tray-row-id="${id}">
      ${
        id
          ? `<input type="checkbox" data-select-id="${id}" aria-label="Select ${title}, lot ${lot}" ${options.selected ? 'checked' : ''}>
        <button class="tray-tool tray-drag" type="button" draggable="true" data-reorder-id="${id}" aria-label="Reorder ${title}, lot ${lot}. Drag or press up or down." title="Drag or use the up and down arrow keys"></button>`
          : '<span></span><span></span>'
      }
      <div class="inventory-item-details" title="${description}">
        <div class="inventory-item-title">${title}</div>
        <div class="inventory-item-meta">Lot ${lot} · <span class="inventory-item-expiry"${tone === 'expiring_soon' ? ' title="Expiring soon"' : ''}>${escapeHtml(expiryText)}</span></div>
      </div>
      <input class="inventory-quantity" type="text" inputmode="numeric" value="${quantity}" placeholder="${pinned ? '∞' : '—'}" data-set-doses-id="${id}" data-dose-fields="${escapeHtml(getTrayDoseFields(row))}" aria-label="Remaining doses for ${title}, lot ${lot}" title="Press Enter to save or Escape to cancel">
      <div class="inventory-item-actions">
        ${useActionMarkup}
        ${pinMarkup}
        <button class="tray-tool tray-remove" type="button" data-remove-id="${id}" aria-label="Remove ${title}, lot ${lot}" title="Remove">×</button>
      </div>
      ${row.reference_only ? '<div class="inventory-lot-report">Reference only</div>' : ''}
      ${held ? `<div class="inventory-lot-report">${row.dose_reservations.some((dose) => dose.review) ? 'Check original chart' : 'Reserved on chart'}</div>` : ''}
      ${lookupMessage ? `<div class="inventory-lot-report"><span>${escapeHtml(lookupMessage)}</span>${reportUrl ? `<a href="${escapeHtml(reportUrl)}">Email lot report</a>` : ''}</div>` : ''}
    </div>
  `;
}

function formatInventoryTimestamp(value) {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
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
