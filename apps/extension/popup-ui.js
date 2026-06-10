import { buildExpiryBanner, getExpiryStatus } from './popup-parser.js';

export function formatDateTime(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function renderNVCStatus(status, container) {
  if (!container || !status) return;
  const updated = formatDateTime(status.updatedAt);
  const checked = formatDateTime(status.lastCheckAt);
  const intervalHours = Math.round((status.autoSyncIntervalMinutes || 0) / 60);
  container.textContent = `Last bundle update: ${updated} | Last check: ${checked} | Auto-check: every ${intervalHours}h`;
}

export function setButtonBusy(button, busy, busyText) {
  if (!button) return;
  if (!button.dataset.defaultLabel) {
    button.dataset.defaultLabel = button.textContent;
  }
  button.disabled = busy;
  button.classList.toggle('button-busy', busy);
  button.textContent = busy && busyText ? busyText : button.dataset.defaultLabel;
}

export function getLoadingMarkup(text) {
  return `<div class="lookup-loading"><span class="inline-spinner" aria-hidden="true"></span><span>${text}</span></div>`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function displayValue(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  return raw ? escapeHtml(raw) : '<span class="muted">N/A</span>';
}

function buildResultRow(label, value) {
  return `
    <div class="result-row">
      <div class="result-label">${escapeHtml(label)}</div>
      <div class="result-value">${value}</div>
    </div>
  `;
}

export function buildParsedOutputMarkup(data, options = {}) {
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

export function showOutput(outputDiv, message, type = 'info') {
  if (!outputDiv) return;
  outputDiv.innerHTML = message;
  outputDiv.style.display = 'block';
  outputDiv.className = `output ${type}`;
}
