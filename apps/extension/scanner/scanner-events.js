(function initVaxLinkScannerEvents(globalScope) {
  const VALID_SOURCES = new Set(['native-serial', 'web-serial', 'test']);
  const DEFAULT_SOURCE = 'native-serial';

  function asTrimmedString(value) {
    return String(value || '').trim();
  }

  function normalizeDevice(value) {
    if (!value || typeof value !== 'object') {
      return null;
    }
    const device = {};
    ['profileId', 'port', 'vendorId', 'productId'].forEach((key) => {
      if (value[key] !== undefined && value[key] !== null) {
        const text = asTrimmedString(value[key]);
        if (text) device[key] = text;
      }
    });
    return Object.keys(device).length ? device : null;
  }

  function normalizeCapturedAt(value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
  }

  function normalizeScanEvent(input) {
    const rawText = asTrimmedString(input && input.rawText);
    if (!rawText) {
      throw new Error('Scanner event rawText is required');
    }

    const requestedSource = asTrimmedString(input && input.source);
    const source = VALID_SOURCES.has(requestedSource) ? requestedSource : DEFAULT_SOURCE;
    const rawBytesHex = asTrimmedString(input && input.rawBytesHex);
    const nativeQueueId = asTrimmedString(input && (input.nativeQueueId || input.id));

    return {
      type: 'vaxlink.scan',
      rawText,
      source,
      device: normalizeDevice(input && input.device),
      rawBytesHex: rawBytesHex || null,
      capturedAt: normalizeCapturedAt(input && input.capturedAt),
      nativeQueueId: nativeQueueId || null
    };
  }

  globalScope.VaxLinkScannerEvents = {
    normalizeScanEvent
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
