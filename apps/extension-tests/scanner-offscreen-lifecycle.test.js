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

test('status inspection does not create a scanner daemon', async () => {
  const writes = [];
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    storage: {
      vaxlink_scanner_daemon_enabled_v1: true,
      vaxlink_serial_scanner_profile_v1: 'zebra-ds8178-usb-cdc',
      vaxlink_scanner_status_snapshot_v1: {
        state: 'connected',
        lastCaptureAt: '2026-07-28T12:00:00.000Z'
      }
    },
    failStorageSet(values) {
      writes.push(...Object.keys(values));
      return false;
    }
  });
  const result = await harness.sendMessage({
    action: 'scannerDaemon.getStatus'
  });
  assert.equal(result.source, 'cached');
  assert.equal(result.status.lastKnownCaptureAt, '2026-07-28T12:00:00.000Z');
  assert.equal(harness.offscreenCreations.length, 0);
  assert.deepEqual(
    writes.filter((key) => key.startsWith('vaxlink_scanner_')),
    []
  );
});

test('new worker capture counts are kept separate from historical capture times', async () => {
  const key = 'vaxlink_scanner_status_snapshot_v1';
  const old = '2026-07-28T12:00:00.000Z';
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    storage: {
      [key]: { state: 'connected', captureCount: 4, lastCaptureAt: old }
    }
  });
  const result = await harness.sendMessage({
    target: 'scannerDaemonBackground',
    action: 'scannerDaemon.statusUpdate',
    status: { state: 'connected', captureCount: 0, lastCaptureAt: '' }
  });
  assert.equal(result.success, true);
  assert.equal(result.status.captureCount, 0);
  assert.equal(result.status.lastCaptureAt, '');
  assert.equal(result.status.lastKnownCaptureAt, old);
  const status = await harness.sendMessage({
    action: 'scannerDaemon.getStatus'
  });
  assert.equal(status.status.captureCount, 0);
  assert.equal(status.status.lastCaptureAt, '');
  assert.equal(status.status.lastKnownCaptureAt, old);
  assert.equal(status.captureSource, 'cached');
});

test('selection-required status disables autostart and survives a background restart', async () => {
  const key = 'vaxlink_scanner_status_snapshot_v1';
  const enabled = 'vaxlink_scanner_daemon_enabled_v1';
  const first = createBackgroundHarness(makeTestNvcBundle(), {
    storage: { [enabled]: false }
  });
  const update = await first.sendMessage({
    target: 'scannerDaemonBackground',
    action: 'scannerDaemon.statusUpdate',
    status: { state: 'error', selectionRequired: true }
  });
  assert.equal(update.success, true);
  assert.equal(first.storageData.get(enabled), false);
  assert.equal(first.storageData.get(key).selectionRequired, true);
  const restarted = createBackgroundHarness(makeTestNvcBundle(), {
    storage: {
      [enabled]: true,
      vaxlink_serial_scanner_profile_v1: 'generic-usb-cdc',
      [key]: first.storageData.get(key)
    }
  });
  await restarted.sendMessage({ action: 'scannerDaemon.getStatus' });
  assert.equal(restarted.offscreenCreations.length, 0);
  const selected = await restarted.sendMessage({
    action: 'scannerDaemon.connectGranted',
    profileId: 'generic-usb-cdc',
    enableAutostart: true,
    trigger: 'setup_permission_granted'
  });
  assert.equal(selected.success, true);
  assert.equal(restarted.offscreenCreations.length, 1);
});

for (const event of ['startup', 'install']) {
  test(`${event} initializes scanner capture and lock state`, async () => {
    let reportLock;
    let reportCreate;
    const created = new Promise((resolve) => {
      reportCreate = resolve;
    });
    const lockWritten = new Promise((resolve) => {
      reportLock = resolve;
    });
    const harness = createBackgroundHarness(makeTestNvcBundle(), {
      storage: {
        vaxlink_scanner_daemon_enabled_v1: true,
        vaxlink_serial_scanner_profile_v1: 'generic-usb-cdc'
      },
      onOffscreenCreate: reportCreate,
      failStorageSet(values) {
        if ('vaxlink_scanner_lock_state_v1' in values) reportLock();
        return false;
      }
    });
    harness[event]();
    await Promise.all([lockWritten, created]);
    assert.equal(harness.offscreenCreations.length, 1);
    assert.equal(
      harness.storageData.get('vaxlink_scanner_lock_state_v1'),
      'active'
    );
  });
}
