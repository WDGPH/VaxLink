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
  fingerprint: 'packaged-build'
};

test('cold health inspection reads an old catalogue without reconnecting or refreshing', async () => {
  const writes = [];
  let downloads = 0;
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    buildId: identity.fingerprint,
    tabs: [tab],
    storage: {
      vaxlink_scanner_daemon_enabled_v1: true,
      vaxlink_serial_scanner_profile_v1: 'zebra-ds8178-usb-cdc',
      nvc_bundle_last_check_at: '2020-01-01T00:00:00.000Z'
    },
    fetch: async (url) => {
      if (String(url).startsWith('https://nvc-cnv.canada.ca/')) downloads++;
      throw new Error('No fetch needed for inspection');
    },
    tabResponse: {
      supported: true,
      ready: true,
      initialized: { listener: true, settings: true },
      buildAtLoad: identity
    },
    failStorageSet: (values) => {
      writes.push(Object.keys(values));
      return false;
    }
  });
  const result = await harness.sendMessage({
    action: 'getWorkstationHealth',
    tabId: tab.id
  });
  assert.equal(result.success, true);
  assert.equal(result.chart.state, 'ready');
  assert.equal(result.nvc.state, 'degraded');
  assert.equal(result.scanner.state, 'unknown');
  assert.equal(harness.offscreenCreations.length, 0);
  assert.equal(downloads, 0);
  assert.deepEqual(writes, []);
  assert.deepEqual(
    harness.tabMessages.map(({ message }) => message.action),
    ['getPanoramaIntegration']
  );
});

test('health distinguishes stale, not-ready and missing content', async () => {
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
    [
      {
        supported: true,
        buildAtLoad: { ...identity, fingerprint: 'older-build' }
      },
      'stale'
    ],
    [{ supported: true }, 'unknown'],
    [{ supported: false }, 'missing']
  ]) {
    const harness = createBackgroundHarness(makeTestNvcBundle(), {
      buildId: identity.fingerprint,
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

test('missing fingerprints cannot establish identity from matching unpacked version labels', async () => {
  for (const [buildId, fingerprint] of [
    [null, null],
    [null, identity.fingerprint],
    [identity.fingerprint, null]
  ]) {
    for (const version of [identity.version, 'old']) {
      const harness = createBackgroundHarness(makeTestNvcBundle(), {
        buildId,
        tabs: [tab],
        tabResponse: {
          supported: true,
          ready: true,
          initialized: { listener: true, settings: true },
          buildAtLoad: { ...identity, version, fingerprint }
        }
      });
      const result = await harness.sendMessage({
        action: 'getWorkstationHealth',
        tabId: tab.id
      });
      assert.equal(
        result.chart.state,
        version === identity.version ? 'unknown' : 'stale'
      );
    }
  }
});

test('unresponsive daemon status times out without blocking other health categories', async () => {
  let fireTimeout;
  let observed;
  const started = new Promise((resolve) => {
    observed = resolve;
  });
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    buildId: identity.fingerprint,
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
