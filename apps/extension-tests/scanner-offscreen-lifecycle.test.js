import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

test('background creates exactly one persistent WORKERS offscreen document', async () => {
  const harness = createBackgroundHarness(makeTestNvcBundle());

  const first = await harness.sendMessage({ action: 'scannerDaemon.ensure' });
  const second = await harness.sendMessage({ action: 'scannerDaemon.ensure' });

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(harness.offscreenCreations.length, 1);
  assert.deepEqual(Array.from(harness.offscreenCreations[0].reasons), [
    'WORKERS'
  ]);
  assert.match(
    harness.offscreenCreations[0].justification,
    /scanner connection active/i
  );
});

test('capture health survives background persistence, broadcast, and status reads', async () => {
  const harness = createBackgroundHarness(makeTestNvcBundle());
  const capture = {
    state: 'connected',
    captureCount: 7,
    lastCaptureAt: '2026-11-07T12:00:00Z'
  };
  const update = await harness.sendMessage({
    target: 'scannerDaemonBackground',
    action: 'scannerDaemon.statusUpdate',
    status: capture
  });
  assert.equal(update.status.captureCount, 7);
  assert.equal(update.status.lastCaptureAt, '2026-11-07T12:00:00.000Z');
  const persisted = harness.storageData.get(
    'vaxlink_scanner_status_snapshot_v1'
  );
  assert.equal(persisted.captureCount, 7);
  const reply = await harness.sendMessage({
    action: 'scannerDaemon.getStatus'
  });
  assert.equal(reply.status.captureCount, 7);
  assert.equal(reply.status.lastCaptureAt, persisted.lastCaptureAt);
});

test('status inspection never creates a daemon or requests a connection', async () => {
  const messages = [];
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    storage: {
      vaxlink_scanner_daemon_enabled_v1: false,
      vaxlink_serial_scanner_profile_v1: 'zebra-ds8178-usb-cdc'
    },
    runtimeResponse: (message) => {
      messages.push(message);
    }
  });
  const reply = await harness.sendMessage({
    action: 'scannerDaemon.getStatus'
  });
  assert.equal(reply.success, true);
  assert.equal(reply.observation.source, 'cached');
  assert.equal(reply.observation.ageMs, null);
  assert.equal(harness.offscreenCreations.length, 0);
  assert.equal(
    messages.some(
      (message) => message.action === 'scannerDaemon.connectGranted'
    ),
    false
  );
});

test('status inspection distinguishes an existing worker reply from cached status', async () => {
  const messages = [];
  const observedAt = new Date(Date.now() - 500).toISOString();
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    offscreenExists: true,
    runtimeResponse: (message) => {
      messages.push(message);
      return {
        success: true,
        status: { state: 'connected', captureCount: 3, observedAt },
        observation: { source: 'fresh' }
      };
    }
  });
  const reply = await harness.sendMessage({
    action: 'scannerDaemon.getStatus'
  });
  assert.equal(reply.observation.source, 'fresh');
  assert.ok(reply.observation.ageMs >= 500);
  assert.equal(reply.status.captureCount, 3);
  assert.equal(harness.offscreenCreations.length, 0);
  assert.deepEqual(
    messages.map((message) => message.action),
    ['scannerDaemon.getStatus']
  );
});

test('inspection does not repeat normal worker-startup reconnect work', async () => {
  let startupResolve;
  const startupRequested = new Promise((resolve) => {
    startupResolve = resolve;
  });
  const messages = [];
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    storage: {
      vaxlink_scanner_daemon_enabled_v1: true,
      vaxlink_serial_scanner_profile_v1: 'zebra-ds8178-usb-cdc'
    },
    runtimeResponse: (message) => {
      messages.push(message);
      if (message.action === 'scannerDaemon.connectGranted') startupResolve();
    }
  });
  await startupRequested;
  const creations = harness.offscreenCreations.length;
  messages.length = 0;
  const reply = await harness.sendMessage({
    action: 'scannerDaemon.getStatus'
  });
  assert.equal(reply.observation.source, 'cached');
  assert.equal(harness.offscreenCreations.length, creations);
  assert.deepEqual(
    messages.map((message) => message.action),
    ['scannerDaemon.getStatus']
  );
});

test('an unidentified explicit scanner selection cannot reuse saved device metadata', async () => {
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    storage: {
      vaxlink_serial_scanner_port_info_v1: {
        usbVendorId: 123,
        usbProductId: 456
      }
    }
  });
  const reply = await harness.sendMessage({
    action: 'scannerDaemon.connectGranted',
    profileId: 'generic-usb-cdc',
    preferredPortInfo: null
  });
  assert.equal(reply.success, false);
  assert.match(reply.error, /cannot be identified safely/);
  assert.equal(harness.offscreenCreations.length, 0);
});
