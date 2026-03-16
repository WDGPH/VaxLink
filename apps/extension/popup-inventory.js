import { escapeHtml } from './popup-ui.js';

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

export class InventoryBatchManager {
  constructor({ summaryEl, listEl, exportButton, clearButton }) {
    this.summaryEl = summaryEl;
    this.listEl = listEl;
    this.exportButton = exportButton;
    this.clearButton = clearButton;
    this.rows = [];
  }

  async load() {
    const stored = await chrome.storage.local.get([INVENTORY_BATCH_KEY]);
    const rows = stored && Array.isArray(stored[INVENTORY_BATCH_KEY])
      ? stored[INVENTORY_BATCH_KEY]
      : [];
    this.rows = rows.filter((row) => row && typeof row === 'object');
    this.render();
  }

  async add(record) {
    this.rows.push(record);
    await this.persist();
    this.render();
  }

  async addMany(records) {
    this.rows.push(...records);
    await this.persist();
    this.render();
  }

  async clear() {
    this.rows = [];
    await this.persist();
    this.render();
  }

  async remove(id) {
    this.rows = this.rows.filter((row) => row.id !== id);
    await this.persist();
    this.render();
  }

  get count() {
    return this.rows.length;
  }

  hasItems() {
    return this.rows.length > 0;
  }

  latest() {
    return this.rows.length ? this.rows[this.rows.length - 1] : null;
  }

  exportCsv() {
    if (!this.rows.length) {
      return null;
    }

    const csvRows = [
      INVENTORY_CSV_COLUMNS.join(','),
      ...this.rows.map((row, index) => INVENTORY_CSV_COLUMNS.map((column) => {
        if (column === 'scan_index') {
          return csvEscape(index + 1);
        }
        return csvEscape(row[column]);
      }).join(','))
    ];

    const blob = new Blob([csvRows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const filename = `vaxlink-inventory-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
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
      this.summaryEl.textContent = 'No scans queued for export.';
      this.listEl.innerHTML = '<div class="inventory-empty">Scan vaccines into the tray, then export when ready.</div>';
      this.updateControls();
      return;
    }

    const expiredCount = this.rows.filter((row) => row.expiry_flag === 'expired').length;
    const expiringCount = this.rows.filter((row) => row.expiry_flag === 'expiring_soon').length;
    let summary = `${this.rows.length} scan(s) ready for CSV export.`;
    if (expiredCount || expiringCount) {
      summary += ` ${expiredCount} expired, ${expiringCount} expiring soon.`;
    }
    this.summaryEl.textContent = summary;

    this.listEl.innerHTML = this.rows
      .map((row, index) => {
        const title = escapeHtml(row.tradename || row.generic_name || row.name || row.lot || `Scan ${index + 1}`);
        const lot = escapeHtml(row.lot || 'N/A');
        const expiry = escapeHtml(row.inventory_expiry || row.barcode_expiry || 'N/A');
        const manufacturer = escapeHtml(row.manufacturer || 'N/A');
        const status = escapeHtml(formatInventoryStatus(row));
        const scannedAt = escapeHtml(formatInventoryTimestamp(row.scanned_at));
        const id = escapeHtml(row.id || '');
        return `
          <div class="inventory-item">
            <div class="inventory-item-top">
              <div>
                <div class="inventory-item-title">${title}</div>
                <div class="inventory-item-meta">Lot ${lot} | ${scannedAt}</div>
              </div>
              <button class="inventory-remove" type="button" data-remove-id="${id}">Remove</button>
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

    this.listEl.querySelectorAll('[data-remove-id]').forEach((button) => {
      button.addEventListener('click', () => {
        this.remove(button.getAttribute('data-remove-id'));
      });
    });

    this.updateControls();
  }

  async persist() {
    await chrome.storage.local.set({ [INVENTORY_BATCH_KEY]: this.rows });
  }

  updateControls() {
    const hasItems = this.rows.length > 0;
    if (this.exportButton) this.exportButton.disabled = !hasItems;
    if (this.clearButton) this.clearButton.disabled = !hasItems;
  }
}

export function buildInventoryRecord(data, rawBarcode) {
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
  return `"${text.replace(/"/g, '""')}"`;
}
