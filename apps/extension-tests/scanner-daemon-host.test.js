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
    storage: { local: { get: async () => ({}) } },
    runtime: {
      id: 'vaxlink-test',
      getManifest: () => ({ name: 'VaxLink Alpha' }),
      lastError: null,
      getURL: (path) => `chrome-extension://vaxlink-test/${path}`,
      onMessage: { addListener: (listener) => runtimeListeners.push(listener) },
      sendMessage(message, callback) {
        runtimeMessages.push(message);
        if (message.action === 'scannerScanCaptured') {
          queueMicrotask(() =>
            callback?.({ success: true, locked: true, queueSizeAfter: 1 })
          );
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

  const messagesBeforeStatus = worker.messages.length;
  let statusResponse;
  runtimeListeners[0](
    { target: 'scannerDaemon', action: 'scannerDaemon.getStatus' },
    {},
    (response) => {
      statusResponse = response;
    }
  );
  assert.equal(statusResponse.success, true);
  assert.equal(worker.messages.length, messagesBeforeStatus);

  worker.listeners.get('error')({ message: 'Worker stopped' });
  runtimeListeners[0](
    { target: 'scannerDaemon', action: 'scannerDaemon.getStatus' },
    {},
    (response) => {
      statusResponse = response;
    }
  );
  assert.equal(statusResponse.status.state, 'error');
  assert.equal(workers.length, 1, 'status must not restart a stopped worker');

  const connectRequest = {
    target: 'scannerDaemon',
    action: 'scannerDaemon.connectGranted',
    profileId: 'zebra-ds8178-usb-cdc',
    preferredPortInfo: { usbVendorId: 0x05e0 },
    trigger: 'test'
  };
  let connectResponse = null;
  await new Promise((resolve) =>
    runtimeListeners[0](
      connectRequest,
      {
        id: 'vaxlink-test',
        url: 'chrome-extension://vaxlink-test/background.js'
      },
      (response) => {
        connectResponse = response;
        resolve();
      }
    )
  );
  assert.equal(connectResponse.success, true);
  const connectedWorker = workers.at(-1);
  assert.equal(connectedWorker.messages.at(-1).type, 'connectGranted');
  assert.equal(
    connectedWorker.messages.at(-1).profileId,
    'zebra-ds8178-usb-cdc'
  );

  connectedWorker.emit('message', {
    type: 'scan',
    scan: { rawText: '010012345678901210LOCKLOT1', source: 'web-serial' }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const captured = runtimeMessages.find(
    (message) => message.action === 'scannerScanCaptured'
  );
  const echo = runtimeMessages.find(
    (message) => message.action === 'scannerDaemon.scanEcho'
  );
  assert.equal(captured.scan.rawText, '010012345678901210LOCKLOT1');
  assert.equal(echo.response.locked, true);

  const backgroundSender = {
    id: 'vaxlink-test',
    url: 'chrome-extension://vaxlink-test/background.js'
  };
  const rejectedSender = await new Promise((resolve) =>
    runtimeListeners[0](
      connectRequest,
      {
        id: 'vaxlink-test',
        url: 'chrome-extension://vaxlink-test/scanner-setup.html',
        tab: { id: 1 }
      },
      resolve
    )
  );
  assert.equal(rejectedSender.accepted, false);
  globalThis.chrome.storage.local.get = async () => ({
    vaxlink_scanner_test_lease_v1: { token: 'held' }
  });
  const blockedByLease = await new Promise((resolve) =>
    runtimeListeners[0](connectRequest, backgroundSender, resolve)
  );
  assert.equal(blockedByLease.accepted, false);
  globalThis.chrome.storage.local.get = async () => ({});

  let timeoutCallback;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => {
    timeoutCallback = callback;
    return 99;
  };
  const timeoutResponse = new Promise((resolve) =>
    runtimeListeners[0](
      { target: 'scannerDaemon', action: 'scannerDaemon.disconnect' },
      {},
      resolve
    )
  );
  timeoutCallback();
  assert.equal((await timeoutResponse).released, false);
  globalThis.setTimeout = realSetTimeout;

  await new Promise((resolve) =>
    runtimeListeners[0](
      connectRequest,
      {
        id: 'vaxlink-test',
        url: 'chrome-extension://vaxlink-test/background.js'
      },
      resolve
    )
  );
  const crashResponse = new Promise((resolve) =>
    runtimeListeners[0](
      { target: 'scannerDaemon', action: 'scannerDaemon.disconnect' },
      {},
      resolve
    )
  );
  connectedWorker.listeners.get('error')({
    message: 'Worker stopped during disconnect'
  });
  assert.equal((await crashResponse).released, false);

  await new Promise((resolve) =>
    runtimeListeners[0](connectRequest, backgroundSender, resolve)
  );
  const selectionWorker = workers.at(-1);
  selectionWorker.emit('message', {
    type: 'status',
    status: { state: 'error', selectionRequired: true }
  });
  const previousWorkers = workers.length;
  let restartScheduled = false;
  const originalTimer = globalThis.setTimeout;
  globalThis.setTimeout = () => {
    restartScheduled = true;
    return 1;
  };
  selectionWorker.listeners.get('error')({
    message: 'Worker stopped after selection failure'
  });
  globalThis.setTimeout = originalTimer;
  assert.equal(restartScheduled, false);
  assert.equal(workers.length, previousWorkers);
  await new Promise((resolve) =>
    runtimeListeners[0](connectRequest, backgroundSender, resolve)
  );
  assert.equal(workers.length, previousWorkers + 1);
  assert.equal(workers.at(-1).messages.at(-1).type, 'connectGranted');
  await new Promise((resolve) => queueMicrotask(resolve));

  delete globalThis.Worker;
  delete globalThis.chrome;
});
