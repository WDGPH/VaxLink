import assert from 'node:assert/strict';
import test from 'node:test';

test('offscreen daemon starts its worker, forwards connect, and echoes routed scans', async () => {
  const runtimeListeners = [];
  const runtimeMessages = [];
  const workers = [];

  class FakeWorker {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.listeners = new Map();
      this.messages = [];
      workers.push(this);
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    postMessage(message) {
      this.messages.push(message);
    }

    emit(type, data) {
      this.listeners.get(type)?.({ data });
    }
  }

  globalThis.Worker = FakeWorker;
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (path) => `chrome-extension://vaxlink-test/${path}`,
      onMessage: { addListener: (listener) => runtimeListeners.push(listener) },
      sendMessage(message, callback) {
        runtimeMessages.push(message);
        if (message.action === 'scannerScanCaptured') {
          queueMicrotask(() => callback?.({ success: true, locked: true, queueSizeAfter: 1 }));
          return;
        }
        queueMicrotask(() => callback?.({ success: true }));
      }
    }
  };

  await import(`../extension/scanner-daemon.js?test=${Date.now()}`);
  assert.equal(workers.length, 1);
  const worker = workers[0];
  assert.equal(worker.options.type, 'module');
  assert.match(worker.url, /scanner-daemon-worker\.js$/);
  assert.deepEqual(worker.messages[0], { type: 'getStatus' });

  const connectRequest = {
    target: 'scannerDaemon',
    action: 'scannerDaemon.connectGranted',
    profileId: 'zebra-ds8178-usb-cdc',
    preferredPortInfo: { usbVendorId: 0x05e0 },
    trigger: 'test'
  };
  let connectResponse = null;
  runtimeListeners[0](connectRequest, {}, (response) => { connectResponse = response; });
  assert.equal(connectResponse.success, true);
  assert.equal(worker.messages.at(-1).type, 'connectGranted');
  assert.equal(worker.messages.at(-1).profileId, 'zebra-ds8178-usb-cdc');

  worker.emit('message', {
    type: 'scan',
    scan: { rawText: '010012345678901210LOCKLOT1', source: 'web-serial' }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const captured = runtimeMessages.find((message) => message.action === 'scannerScanCaptured');
  const echo = runtimeMessages.find((message) => message.action === 'scannerDaemon.scanEcho');
  assert.equal(captured.scan.rawText, '010012345678901210LOCKLOT1');
  assert.equal(echo.response.locked, true);

  delete globalThis.Worker;
  delete globalThis.chrome;
});
