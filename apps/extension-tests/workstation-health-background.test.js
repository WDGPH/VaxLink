import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

const tab = {
  id: 7,
  active: true,
  url: 'https://www.panorama.prod.ehealthontario.ca/phsdsm/ImmsWeb/pages/recordImms/recordImms.xhtml'
};
const identity = {
  version: '1.1.5',
  versionName: '1.2.0-alpha',
  name: 'VaxLink Alpha',
  fingerprint: null
};

test('health reads categories without connecting, filling, or writing storage', async () => {
  const writes = [];
  let startupFinished;
  const startup = new Promise((resolve) => {
    startupFinished = resolve;
  });
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    tabs: [tab],
    tabResponse: {
      supported: true,
      ready: true,
      initialized: { listener: true, settings: true },
      buildAtLoad: identity
    },
    failStorageSet: (values) => {
      writes.push(Object.keys(values));
      if ('vaxlink_scanner_lock_state_v1' in values) startupFinished();
      return false;
    }
  });
  // Let independent service-worker startup finish before measuring the request.
  await harness.sendMessage({ action: 'getNVCUpdateStatus' });
  await startup;
  writes.length = 0;
  const before = harness.offscreenCreations.length;
  const result = await harness.sendMessage({
    action: 'getWorkstationHealth',
    tabId: tab.id
  });
  assert.equal(result.success, true);
  assert.equal(result.chart.state, 'ready');
  assert.equal(result.nvc.state, 'ready');
  assert.equal(result.scanner.state, 'unconfigured');
  assert.equal(harness.offscreenCreations.length, before);
  assert.deepEqual(writes, []);
  assert.deepEqual(
    harness.tabMessages.map(({ message }) => message.action),
    ['getPanoramaIntegration']
  );
});

test('health distinguishes stale and not-ready content', async () => {
  for (const [response, expected] of [
    [
      {
        supported: true,
        ready: true,
        buildAtLoad: { ...identity, version: 'old' }
      },
      'stale'
    ],
    [
      {
        supported: true,
        ready: false,
        buildAtLoad: identity,
        initialized: { listener: true, settings: false }
      },
      'not_ready'
    ],
    [{ supported: false }, 'missing']
  ]) {
    const harness = createBackgroundHarness(makeTestNvcBundle(), {
      tabs: [tab],
      tabResponse: response
    });
    const result = await harness.sendMessage({
      action: 'getWorkstationHealth',
      tabId: tab.id
    });
    assert.equal(result.chart.state, expected);
  }
});

test('missing packaged page identity is unknown', async () => {
  for (const buildAtLoad of [undefined, { ...identity, fingerprint: null }]) {
    const harness = createBackgroundHarness(makeTestNvcBundle(), {
      buildId: 'packaged-build',
      tabs: [tab],
      tabResponse: {
        supported: true,
        ready: true,
        initialized: { listener: true, settings: true },
        buildAtLoad
      }
    });
    const result = await harness.sendMessage({
      action: 'getWorkstationHealth',
      tabId: tab.id
    });
    assert.equal(result.chart.state, 'unknown');
  }
});

test('unresponsive daemon status times out without blocking other health categories', async () => {
  let fireTimeout;
  let observed;
  const started = new Promise((resolve) => {
    observed = resolve;
  });
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    storage: {
      vaxlink_serial_scanner_profile_v1: 'zebra-ds8178-usb-cdc',
      vaxlink_scanner_status_snapshot_v1: {
        state: 'connected',
        profileId: 'zebra-ds8178-usb-cdc',
        lastCaptureAt: '2026-07-28T12:00:00.000Z'
      }
    },
    tabs: [tab],
    tabResponse: {
      supported: true,
      ready: true,
      initialized: { listener: true, settings: true },
      buildAtLoad: identity
    },
    runtimeSendMessage(message, callback) {
      if (message.action === 'scannerDaemon.getStatus') {
        observed();
        return;
      }
      queueMicrotask(() => callback?.(null));
    },
    setTimeout(callback, ms) {
      if (ms === 1000 && !fireTimeout) {
        fireTimeout = callback;
        return 1;
      }
      return setTimeout(callback, ms);
    }
  });
  await harness.sendMessage({ action: 'scannerDaemon.ensure' });
  const pendingHealth = harness.sendMessage({
    action: 'getWorkstationHealth',
    tabId: tab.id
  });
  await started;
  fireTimeout();
  const result = await pendingHealth;
  assert.equal(result.scanner.state, 'unknown');
  assert.equal(result.scanner.captureSource, 'cached');
  assert.equal(result.nvc.state, 'ready');
  assert.equal(result.chart.state, 'ready');
});
