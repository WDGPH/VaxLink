import { buildExpiryBanner, getExpiryStatus } from './popup-parser.js';

function formatNVCCheckDate(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

export function describeNVCHealth(status) {
  if (status.state === 'refreshing') {
    return status.usable
      ? 'NVC is refreshing. Cached catalogue remains available.'
      : 'NVC is loading.';
  }
  if (!status.usable)
    return 'NVC catalogue is unavailable. Barcode details can still be captured.';
  if (status.freshnessDegraded)
    return 'NVC refresh failed. Previously downloaded catalogue remains available.';
  return '';
}

export function formatNVCRefreshMessage(status) {
  if (!status?.success)
    return status?.usable
      ? 'Unable to refresh NVC. Previously downloaded catalogue remains available.'
      : 'Unable to refresh NVC. No usable catalogue is available.';
  const count = Number(status.lotCount || 0).toLocaleString();
  const codes = status.lotCount === 1 ? 'lot code' : 'lot codes';
  if (status.firstRefresh)
    return `NVC catalogue loaded successfully — ${count} distinct ${codes}.`;
  if (status.unchanged) return 'NVC catalogue checked — no changes detected.';
  if (status.addedLotCount > 0) {
    return `NVC catalogue updated — ${status.addedLotCount.toLocaleString()} new lot codes; ${count} total.`;
  }
  return 'NVC catalogue updated — no new lot codes.';
}

export function renderNVCStatus(status, container) {
  if (!container || !status) return;
  const state = getNVCStatusLabel(status);
  const stateSummary =
    container.ownerDocument?.getElementById('nvcSettingsState');
  const versionSummary =
    container.ownerDocument?.getElementById('nvcSettingsVersion');
  if (stateSummary) stateSummary.textContent = state;
  const publication =
    status.releaseDate && !Number.isNaN(Date.parse(status.releaseDate))
      ? new Date(status.releaseDate).toLocaleDateString('en-CA', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          timeZone: 'UTC'
        })
      : 'Unavailable';
  if (versionSummary) {
    versionSummary.textContent = [
      status.releaseVersion
        ? `Version ${status.releaseVersion}`
        : 'Version unavailable',
      publication !== 'Unavailable' ? publication : ''
    ]
      .filter(Boolean)
      .join(' · ');
  }
  const health = describeNVCHealth(status);
  container.innerHTML = `
    <div class="nvc-status-version">${escapeHtml(status.releaseVersion ? `v${status.releaseVersion}` : 'NVC version unavailable')}</div>
    <dl class="nvc-status-release">
      <div><dt>Published:</dt><dd>${escapeHtml(publication)}</dd></div>
      <div><dt>Last checked:</dt><dd>${escapeHtml(formatNVCCheckDate(status.lastCheckAt))}</dd></div>
    </dl>
    ${health ? `<p class="nvc-status-health">${escapeHtml(health)}</p>` : ''}`;
}

export function getNVCStatusLabel(status, now = Date.now()) {
  if (!status?.usable)
    return status?.state === 'refreshing' ? 'Checking' : 'Unavailable';
  if (status.state === 'refreshing') return 'Ready · checking';
  if (status.freshnessDegraded || status.lastError)
    return 'Ready · check failed';
  const age = now - Date.parse(status.lastCheckAt || '');
  const interval = (status.autoSyncIntervalMinutes || 1440) * 60000;
  return Number.isFinite(age) && age >= 0 && age < interval
    ? 'Up to date'
    : 'Ready · check due';
}

export function setButtonBusy(button, busy, busyText) {
  if (!button) return;
  if (!button.dataset.defaultLabel) {
    button.dataset.defaultLabel = button.textContent;
  }
  button.disabled = busy;
  button.classList.toggle('button-busy', busy);
  button.textContent =
    busy && busyText ? busyText : button.dataset.defaultLabel;
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
  const inventoryExpiry =
    data.inventory_expiry || data.expiry || data.nvc_lot_expiry || null;
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
        buildResultRow(
          'Dose',
          displayValue(
            [data.dose_value, data.dose_unit].filter(Boolean).join(' ')
          )
        ),
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
