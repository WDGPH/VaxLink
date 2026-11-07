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
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    storage: {
      vaxlink_scanner_daemon_enabled_v1: false,
      vaxlink_serial_scanner_profile_v1: 'zebra-ds8178-usb-cdc',
      vaxlink_scanner_status_snapshot_v1: {
        state: 'connected',
        lastCaptureAt: '2026-07-28T12:00:00.000Z'
      }
    }
  });
  const result = await harness.sendMessage({
    action: 'scannerDaemon.getStatus'
  });
  assert.equal(result.source, 'cached');
  assert.equal(result.status.lastCaptureAt, '2026-07-28T12:00:00.000Z');
  assert.equal(harness.offscreenCreations.length, 0);
});
