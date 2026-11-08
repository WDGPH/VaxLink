import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

const key = 'vaxlink_scanner_test_lease_v1';
const sender = {
  id: 'vaxlink-test',
  frameId: 0,
  tab: { id: 9 },
  url: 'chrome-extension://vaxlink-test/diagnostics/scanner-test.html'
};
const command = (h, action, details = {}, from = sender) =>
  h.sendMessage({ action, ...details }, from);
const profile = { vaxlink_serial_scanner_profile_v1: 'zebra-ds8178-usb-cdc' };

test('test lease authenticates owner and pauses capture without creating a daemon', async () => {
  const h = createBackgroundHarness(makeTestNvcBundle(), {
    tabs: [sender.tab],
    storage: profile
  });
  assert.equal(
    (
      await command(
        h,
        'scannerTest.acquire',
        {},
        { ...sender, url: 'https://example.org/' }
      )
    ).success,
    false
  );
  const result = await command(h, 'scannerTest.acquire');
  assert.equal(result.success, true);
  assert.equal(result.released, true);
  assert.equal(h.offscreenCreations.length, 0);
  assert.equal(h.storageData.get('vaxlink_scanner_daemon_enabled_v1'), false);
  assert.equal(
    (await command(h, 'scannerDaemon.enableAutostart')).success,
    false
  );
  assert.equal(
    (await command(h, 'scannerDaemon.connectGranted')).success,
    false
  );
  assert.equal(
    (await command(h, 'scannerTest.release', { lease: 'wrong' })).success,
    false
  );
  assert.equal(
    (await command(h, 'scannerTest.release', { lease: result.lease })).success,
    true
  );
  assert.equal(h.storageData.get(key), null);
  assert.equal(h.storageData.get('vaxlink_scanner_daemon_enabled_v1'), false);
});

test('persisted lease blocks startup; only explicit reconnect may clear a missing owner', async () => {
  const h = createBackgroundHarness(makeTestNvcBundle(), {
    runtimeSendMessage(_message, callback) {
      queueMicrotask(() => callback?.({ success: true }));
    },
    storage: {
      ...profile,
      [key]: { token: 'held', tabId: 9 },
      vaxlink_scanner_daemon_enabled_v1: true
    }
  });
  const enable = await command(h, 'scannerDaemon.enableAutostart');
  assert.equal(enable.success, false);
  assert.equal(h.offscreenCreations.length, 0);
  const connect = await command(h, 'scannerDaemon.connectGranted');
  assert.equal(connect.success, true);
  assert.equal(h.storageData.get(key), null);
});

test('failed daemon release keeps ownership and capture paused', async () => {
  const h = createBackgroundHarness(makeTestNvcBundle(), {
    tabs: [sender.tab],
    storage: profile,
    runtimeSendMessage(_message, callback) {
      queueMicrotask(() => callback?.({ success: false, released: false }));
    }
  });
  await command(h, 'scannerDaemon.ensure');
  const result = await command(h, 'scannerTest.acquire');
  assert.equal(result.success, false);
  assert.equal(h.storageData.get(key).tabId, 9);
  assert.equal(h.storageData.get('vaxlink_scanner_daemon_enabled_v1'), false);
  assert.equal(
    (await command(h, 'scannerDaemon.connectGranted')).success,
    false
  );
});

test('concurrent acquire blocks reconnect until scanner ownership is resolved', async () => {
  let resume;
  let started;
  const saving = new Promise((resolve) => {
    started = resolve;
  });
  const h = createBackgroundHarness(makeTestNvcBundle(), {
    tabs: [sender.tab],
    storage: profile,
    delayStorageSet(values, continuation) {
      if (!(key in values) || resume) return false;
      resume = continuation;
      started();
      return true;
    }
  });
  const acquire = command(h, 'scannerTest.acquire');
  await saving;
  const connect = command(h, 'scannerDaemon.connectGranted');
  resume();
  assert.equal((await acquire).success, true);
  assert.equal((await connect).success, false);
  assert.equal(h.offscreenCreations.length, 0);
});

test('unknown owner state keeps the scanner paused', async () => {
  const h = createBackgroundHarness(makeTestNvcBundle(), {
    storage: { ...profile, [key]: { token: 'held', tabId: 9 } },
    getTab(_tabId, callback, chrome) {
      queueMicrotask(() => {
        chrome.runtime.lastError = { message: 'Permission error' };
        callback();
        chrome.runtime.lastError = null;
      });
    }
  });
  assert.equal(
    (await command(h, 'scannerDaemon.connectGranted')).success,
    false
  );
  assert.equal(h.storageData.get(key).token, 'held');
  assert.equal(h.offscreenCreations.length, 0);
});

test('missing daemon release acknowledgement leaves capture paused without blocking commands', async () => {
  let expire;
  let releaseRequested;
  const started = new Promise((resolve) => {
    releaseRequested = resolve;
  });
  const h = createBackgroundHarness(makeTestNvcBundle(), {
    tabs: [sender.tab],
    storage: profile,
    runtimeSendMessage(message, callback) {
      if (message.action === 'scannerDaemon.disconnect') {
        releaseRequested();
        return;
      }
      queueMicrotask(() => callback?.({ success: true }));
    },
    setTimeout(callback, ms) {
      if (ms === 6000) {
        expire = callback;
        return 1;
      }
      return setTimeout(callback, ms);
    }
  });
  await command(h, 'scannerDaemon.ensure');
  const acquisition = command(h, 'scannerTest.acquire');
  await started;
  const reconnect = command(h, 'scannerDaemon.connectGranted');
  expire();
  assert.equal((await acquisition).success, false);
  assert.equal((await reconnect).success, false);
  assert.equal(h.storageData.get(key).tabId, sender.tab.id);
  assert.equal(h.storageData.get('vaxlink_scanner_daemon_enabled_v1'), false);
});

test('an unconfirmed daemon disconnect is not reported as released', async () => {
  const h = createBackgroundHarness(makeTestNvcBundle(), {
    storage: profile,
    runtimeSendMessage(_message, callback) {
      queueMicrotask(() => callback?.({ success: false, released: false }));
    }
  });
  const result = await command(h, 'scannerDaemon.disconnect');
  assert.equal(result.success, false);
  assert.match(result.error, /release was not confirmed/);
  assert.equal(h.storageData.get('vaxlink_scanner_daemon_enabled_v1'), false);
});
