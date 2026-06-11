(function initVaxLinkNativeScannerClient(globalScope) {
  const HOST_NAME = 'ca.wdgph.vaxlink_scanner_agent';
  const PROTOCOL_VERSION = 1;

  function sendNativeMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendNativeMessage(HOST_NAME, message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({
              ok: false,
              installed: false,
              error: chrome.runtime.lastError.message || 'Native scanner agent is not reachable'
            });
            return;
          }
          if (!response || typeof response !== 'object') {
            resolve({ ok: false, installed: true, error: 'Native scanner agent returned an empty response' });
            return;
          }
          resolve({ installed: true, ...response });
        });
      } catch (error) {
        resolve({ ok: false, installed: false, error: error?.message || 'Native scanner agent request failed' });
      }
    });
  }

  async function hello() {
    return sendNativeMessage({ type: 'hello', protocolVersion: PROTOCOL_VERSION });
  }

  async function getStatus() {
    const helloResult = await hello();
    if (!helloResult.ok) {
      return helloResult;
    }
    return sendNativeMessage({ type: 'status.get' });
  }

  async function pollScans(limit = 25) {
    return sendNativeMessage({ type: 'scan.poll', limit });
  }

  async function ack(ids) {
    return sendNativeMessage({ type: 'queue.ack', ids });
  }

  async function nack(ids, reason) {
    return sendNativeMessage({ type: 'queue.nack', ids, reason: reason || 'extension-rejected' });
  }

  globalScope.VaxLinkNativeScannerClient = {
    HOST_NAME,
    getStatus,
    pollScans,
    ack,
    nack
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
