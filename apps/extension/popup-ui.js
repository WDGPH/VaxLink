export function describeNVCHealth(status) {
  if (status.state === 'refreshing') {
    return status.usable
      ? 'Checking for updates. You can still use the previous catalogue.'
      : 'Loading the catalogue.';
  }
  if (!status.usable)
    return 'The catalogue is unavailable. You can still capture barcodes.';
  if (status.freshnessDegraded)
    return 'The update check failed. You can still use the previous catalogue.';
  return '';
}

export function formatNVCRefreshMessage(status) {
  if (!status?.success)
    return status?.usable
      ? 'Could not check for updates. You can still use the previous catalogue.'
      : 'Could not check for updates. The catalogue is unavailable.';
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
  const checked = container.ownerDocument?.getElementById('nvcLastCheck');
  if (checked) {
    const time = Date.parse(status.lastCheckAt || '');
    checked.textContent = Number.isFinite(time)
      ? `Last successful check ${new Date(time).toLocaleString()}`
      : 'No successful check recorded';
  }
  const health = describeNVCHealth(status);
  container.textContent = health;
  container.hidden = !health;
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

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function showOutput(outputDiv, message, type = 'info') {
  if (!outputDiv) return;
  outputDiv.innerHTML = message;
  outputDiv.style.display = 'block';
  outputDiv.className = `output ${type}`;
}
