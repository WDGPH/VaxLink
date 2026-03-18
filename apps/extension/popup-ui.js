import { buildExpiryBanner, getExpiryStatus } from './popup-parser.js';

export const HANDS_FREE_SCAN_KEY = 'hands_free_scan_autofill_enabled';
export const HANDS_FREE_SCAN_MODE_KEY = 'hands_free_scan_mode_v1';

function normalizeHandsFreeMode(stored) {
  const mode = stored && stored[HANDS_FREE_SCAN_MODE_KEY];
  if (mode === 'autofill' || mode === 'tray') {
    return mode;
  }
  return stored && stored[HANDS_FREE_SCAN_KEY] ? 'autofill' : 'off';
}

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

export function initHandsFreeToggle(outputDiv, showOutput) {
  if (!outputDiv || document.getElementById('handsFreeScanModeSelect')) return;

  const section = document.createElement('div');
  section.style.margin = '8px 0 10px';
  section.style.padding = '8px 10px';
  section.style.border = '1px solid #d9e2ec';
  section.style.borderRadius = '8px';
  section.style.background = '#f8fafc';

  const label = document.createElement('label');
  label.style.display = 'block';
  label.style.fontSize = '12px';
  label.style.color = '#1f2937';
  label.style.marginBottom = '6px';
  label.textContent = 'Remote Scan Mode';

  const select = document.createElement('select');
  select.id = 'handsFreeScanModeSelect';
  select.style.width = '100%';
  select.style.border = '1px solid #cbd5e1';
  select.style.borderRadius = '8px';
  select.style.padding = '8px 10px';
  select.style.fontSize = '12px';
  select.style.background = '#fff';
  select.innerHTML = [
    '<option value="off">Off</option>',
    '<option value="autofill">Auto-fill chart on scan</option>',
    '<option value="tray">Save each scan to tray</option>'
  ].join('');

  const textWrap = document.createElement('span');
  textWrap.textContent = 'Choose what a scanner does when barcodes are read on the live chart page.';
  section.appendChild(label);
  section.appendChild(select);
  section.appendChild(textWrap);
  textWrap.style.display = 'block';
  textWrap.style.marginTop = '6px';
  textWrap.style.fontSize = '11px';
  textWrap.style.color = '#475569';

  const hint = document.createElement('div');
  hint.style.fontSize = '11px';
  hint.style.color = '#475569';
  hint.style.marginTop = '6px';
  section.appendChild(hint);

  outputDiv.parentNode.insertBefore(section, outputDiv);

  const renderHint = (mode) => {
    if (mode === 'autofill') {
      hint.textContent = 'Scans on Panorama or InputHealth fill the current chart immediately without opening the popup.';
      return;
    }
    if (mode === 'tray') {
      hint.textContent = 'Scans on Panorama or InputHealth are saved into the inventory tray automatically, so clinicians can scan several vaccines with no extra clicks.';
      return;
    }
    hint.textContent = 'Scanner input is ignored by the hands-free listener until you turn a mode on.';
  };

  chrome.storage.local.get([HANDS_FREE_SCAN_KEY, HANDS_FREE_SCAN_MODE_KEY], (stored) => {
    const mode = normalizeHandsFreeMode(stored);
    select.value = mode;
    renderHint(mode);
  });

  select.addEventListener('change', () => {
    const mode = select.value === 'autofill' || select.value === 'tray' ? select.value : 'off';
    chrome.storage.local.set({
      [HANDS_FREE_SCAN_MODE_KEY]: mode,
      [HANDS_FREE_SCAN_KEY]: mode === 'autofill'
    }, () => {
      if (chrome.runtime.lastError) {
        showOutput(`Could not update remote scan mode: ${chrome.runtime.lastError.message}`, 'error');
        return;
      }
      renderHint(mode);
      showOutput(
        mode === 'off'
          ? 'Remote scan mode disabled'
          : mode === 'tray'
            ? 'Remote scan mode set to save each scan into the tray'
            : 'Remote scan mode set to auto-fill the chart',
        'info'
      );
    });
  });
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
