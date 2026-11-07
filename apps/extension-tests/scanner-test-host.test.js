import assert from 'node:assert/strict';
import test from 'node:test';
import { createScannerTestHost } from '../extension/diagnostics/scanner-test-host.js';

test('only the owning Setup tab can control an acknowledged isolated session', async () => {
  globalThis.chrome = {
    runtime: { id: 'ext', getURL: (path) => `chrome-extension://ext/${path}` }
  };
  const sent = [];
  const broadcasts = [];
  let reconnectStopped = false;
  const worker = {
    postMessage(message) {
      sent.push(message);
    }
  };
  const host = createScannerTestHost({
    getWorker: () => worker,
    isConnected: () => true,
    stopReconnect: () => {
      reconnectStopped = true;
    },
    broadcast: (message) => broadcasts.push(message)
  });
  const setup = 'chrome-extension://ext/scanner-setup.html';
  const sender = { id: 'ext', url: setup, tab: { id: 7, url: setup } };
  const invoke = (action, who) =>
    new Promise((resolve) => {
      host.handleMessage(
        { action: `diagnostics.test.${action}` },
        who,
        resolve
      );
    });
  assert.equal(
    (
      await invoke('start', {
        ...sender,
        tab: { id: 7, url: 'https://clinical.example/' }
      })
    ).success,
    false
  );
  const starting = invoke('start', sender);
  assert.equal(sent[0].type, 'startTest');
  assert.match(sent[0].sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(
    (await invoke('stop', { ...sender, tab: { id: 8, url: setup } })).success,
    false
  );
  host.onWorkerMessage({
    type: 'testState',
    requestId: sent[0].requestId,
    success: true,
    state: 'active',
    sessionId: sent[0].sessionId
  });
  assert.equal((await starting).state, 'active');
  host.onWorkerMessage({
    type: 'testObservation',
    sessionId: sent[0].sessionId,
    kind: 'frame',
    hasLot: true,
    rawText: 'private',
    completionReason: 'terminator'
  });
  assert.equal(JSON.stringify(broadcasts).includes('private'), false);
  const stopping = invoke('stop', sender);
  assert.equal(sent.at(-1).type, 'stopTest');
  host.onWorkerMessage({
    type: 'testState',
    requestId: sent.at(-1).requestId,
    success: true,
    state: 'stopped'
  });
  assert.equal((await stopping).state, 'stopped');
  assert.equal(reconnectStopped, false);
  delete globalThis.chrome;
});

test('worker error during a test disables reconnect', async () => {
  globalThis.chrome = {
    runtime: { id: 'ext', getURL: (path) => `chrome-extension://ext/${path}` }
  };
  const sent = [];
  let stopped = false;
  const host = createScannerTestHost({
    getWorker: () => ({ postMessage: (message) => sent.push(message) }),
    isConnected: () => true,
    stopReconnect: () => {
      stopped = true;
    },
    broadcast: () => {}
  });
  const url = 'chrome-extension://ext/scanner-setup.html';
  const result = new Promise((resolve) =>
    host.handleMessage(
      { action: 'diagnostics.test.start' },
      { id: 'ext', url, tab: { id: 1, url } },
      resolve
    )
  );
  host.onWorkerError();
  assert.equal((await result).success, false);
  assert.equal(stopped, true);
  delete globalThis.chrome;
});

test('terminated worker reports a safe failure without leaving a pending request', async () => {
  globalThis.chrome = {
    runtime: { id: 'ext', getURL: (path) => `chrome-extension://ext/${path}` }
  };
  let stopped = false;
  const host = createScannerTestHost({
    getWorker: () => ({
      postMessage() {
        throw new Error('terminated');
      }
    }),
    isConnected: () => true,
    stopReconnect: () => {
      stopped = true;
    },
    broadcast() {}
  });
  const url = 'chrome-extension://ext/scanner-setup.html';
  const result = await new Promise((resolve) =>
    host.handleMessage(
      { action: 'diagnostics.test.start' },
      { id: 'ext', url, tab: { id: 1, url } },
      resolve
    )
  );
  assert.equal(result.success, false);
  assert.equal(stopped, true);
  delete globalThis.chrome;
});
