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
      id: 'vaxlink-test',
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
  const request = (action) =>
    new Promise((resolve) => {
      runtimeListeners[0]({ target: 'scannerDaemon', action }, {}, resolve);
    });
  const statusRequest = request('scannerDaemon.getStatus');
  const query = worker.messages.at(-1);
  assert.equal(query.type, 'getStatus');
  worker.emit('message', {
    type: 'reply',
    requestId: query.requestId,
    status: { state: 'connected' }
  });
  assert.equal((await statusRequest).status.state, 'connected');

  worker.listeners.get('error')({ message: 'Worker stopped' });
  assert.equal((await request('scannerDaemon.getStatus')).success, false);
  assert.equal(workers.length, 1, 'status must not restart a stopped worker');

  const connectRequest = {
    target: 'scannerDaemon',
    action: 'scannerDaemon.connectGranted',
    profileId: 'zebra-ds8178-usb-cdc',
    preferredPortInfo: { usbVendorId: 0x05e0 },
    trigger: 'test'
  };
  let connectResponse = null;
  runtimeListeners[0](connectRequest, {}, (response) => {
    connectResponse = response;
  });
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

  let stopResponse;
  const stopRequest = request('scannerDaemon.disconnect').then((response) => {
    stopResponse = response;
  });
  const stop = connectedWorker.messages.at(-1);
  assert.equal(stop.type, 'disconnect');
  connectedWorker.emit('message', { type: 'scan', scan: { rawText: 'late' } });
  await Promise.resolve();
  assert.equal(stopResponse, undefined);
  assert.equal(
    runtimeMessages.filter(
      (message) => message.action === 'scannerScanCaptured'
    ).length,
    1
  );
  connectedWorker.emit('message', {
    type: 'reply',
    requestId: stop.requestId,
    status: { state: 'disabled' }
  });
  await stopRequest;
  assert.equal(stopResponse.status.state, 'disabled');
  runtimeListeners[0](connectRequest, {}, () => {});

  connectedWorker.emit('message', {
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
  connectedWorker.listeners.get('error')({
    message: 'Worker stopped after selection failure'
  });
  globalThis.setTimeout = originalTimer;
  assert.equal(restartScheduled, false);
  assert.equal(workers.length, previousWorkers);
  runtimeListeners[0](connectRequest, {}, () => {});
  assert.equal(workers.length, previousWorkers + 1);
  assert.equal(workers.at(-1).messages.at(-1).type, 'connectGranted');

  const liveProfile = 'zebra-ds8178-ssi-live';
  runtimeListeners[0](
    { ...connectRequest, profileId: liveProfile },
    {},
    () => {}
  );
  const liveWorker = workers.at(-1);
  liveWorker.emit('message', {
    type: 'status',
    status: { state: 'connected', profileId: liveProfile }
  });
  const feedbackToken = 'capture-a';
  liveWorker.emit('message', {
    type: 'scan',
    scan: { rawText: 'LIVE' },
    feedbackToken
  });
  await new Promise(setImmediate);
  const capture = runtimeMessages.find(
    (message) => message.scan?.rawText === 'LIVE'
  );
  assert.equal(capture.feedbackToken, feedbackToken);
  const feedback = {
    target: 'scannerDaemon',
    action: 'scannerDaemon.feedback',
    result: 'works',
    feedbackToken
  };
  const sender = {
    id: 'vaxlink-test',
    url: 'chrome-extension://vaxlink-test/background.js'
  };
  const send = (message, from) =>
    new Promise((resolve) => runtimeListeners[0](message, from, resolve));
  const priorMessages = liveWorker.messages.length;
  assert.equal(
    (
      await send(feedback, {
        ...sender,
        url: 'chrome-extension://vaxlink-test/popup.html'
      })
    ).success,
    false
  );
  assert.equal(
    (await send({ ...feedback, result: 'arbitrary' }, sender)).success,
    false
  );
  assert.equal(liveWorker.messages.length, priorMessages);
  assert.equal((await send(feedback, sender)).success, true);
  assert.deepEqual(liveWorker.messages.at(-1), {
    type: 'feedback',
    result: 'works',
    feedbackToken
  });
  assert.ok(
    !runtimeMessages.find(
      (message) =>
        message.action === 'scannerDaemon.scanEcho' && message.feedbackToken
    )
  );

  await new Promise((resolve) => queueMicrotask(resolve));
  delete globalThis.Worker;
  delete globalThis.chrome;
});
