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

export function renderNVCStatus(status, container, message) {
  if (!container || !status) return;
  const details = container.ownerDocument?.getElementById(
    'nvcCatalogueDetails'
  );
  if (details) {
    const published = new Date(status.releaseDate || '');
    const publication = Number.isFinite(published.getTime())
      ? published.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'UTC'
        })
      : '';
    details.textContent = [
      status.releaseVersion ? `Version ${status.releaseVersion}` : '',
      publication
    ]
      .filter(Boolean)
      .join(' · ');
    details.hidden = !details.textContent;
  }
  const health = message || describeNVCHealth(status);
  container.textContent = health;
  container.hidden = !health;
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
