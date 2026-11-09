// The background returns categories only. Never render values supplied by a chart.
export function describeWorkstationHealth(snapshot) {
  const scanner = snapshot?.scanner || {};
  const nvc = snapshot?.nvc || {};
  const chart = snapshot?.chart || {};
  const scannerStates = {
    connected:
      'Scanner is connected. A connection does not confirm a barcode was read.',
    disconnected: 'Scanner is not connected. Open Scanner Setup to connect it.',
    unconfigured: 'No scanner is configured. Open Scanner Setup to select one.',
    unknown: 'Scanner connection is unknown. Open Scanner Setup to check it.'
  };
  const captureSources = {
    live: 'Current scanner session',
    cached: 'Cached observation',
    none: 'No capture observed',
    unknown: 'Capture observation unavailable'
  };
  const nvcStates = {
    ready: 'NVC is available and its last check is current.',
    degraded:
      'NVC is available from a previous download, but its freshness is degraded.',
    unavailable: 'NVC is unavailable. Barcode details can still be captured.',
    unknown: 'NVC status is unavailable.'
  };
  const chartStates = {
    ready: 'Panorama integration is ready in the selected tab.',
    stale:
      'The selected Panorama tab has an older extension. Reload it when safe to do so.',
    not_ready:
      'Panorama integration is present but still initializing. Check again shortly.',
    missing:
      'Panorama integration was not found in the selected tab. Open a supported Panorama page and check again.',
    unknown: 'Panorama integration could not be checked in the selected tab.'
  };
  const pick = (values, key) =>
    Object.hasOwn(values, key) ? values[key] : values.unknown;
  let capture = pick(captureSources, scanner.captureSource);
  if (scanner.captureSource === 'live' || scanner.captureSource === 'cached') {
    const date = new Date(scanner.lastCaptureAt || '');
    capture += Number.isFinite(date.getTime())
      ? `: ${date.toLocaleString()}`
      : ': time unavailable';
  }
  return {
    scanner: pick(scannerStates, scanner.state),
    capture,
    nvc: pick(nvcStates, nvc.state),
    chart: pick(chartStates, chart.state)
  };
}

export async function loadWorkstationHealth(tabId) {
  if (!Number.isSafeInteger(tabId) || tabId < 0)
    return describeWorkstationHealth(null);
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'getWorkstationHealth',
      tabId
    });
    return describeWorkstationHealth(response?.success ? response : null);
  } catch {
    return describeWorkstationHealth(null);
  }
}

if (typeof document !== 'undefined') {
  const tabIdText = new URLSearchParams(location.search).get('tab');
  const tabId =
    tabIdText !== null && /^\d+$/.test(tabIdText) ? Number(tabIdText) : NaN;
  const check = async () => {
    const result = await loadWorkstationHealth(tabId);
    for (const [name, value] of Object.entries(result)) {
      document.getElementById(name).textContent = value;
    }
  };
  document.getElementById('check').addEventListener('click', check);
  void check();
}
