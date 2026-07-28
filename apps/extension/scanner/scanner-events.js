export const SCAN_EVENT_TYPE = 'vaxlink.scan';

export function makeScanEvent({ rawText, source, device, rawBytesHex = '', capturedAt = null } = {}) {
  return {
    type: SCAN_EVENT_TYPE,
    rawText: String(rawText || ''),
    source: source || 'unknown',
    device: device || null,
    rawBytesHex: String(rawBytesHex || ''),
    capturedAt: capturedAt || new Date().toISOString()
  };
}

export function normalizeScanEvent(scan) {
  const normalized = makeScanEvent(scan || {});
  if (!normalized.rawText.trim()) {
    throw new Error('Scan event missing raw text');
  }
  return normalized;
}
