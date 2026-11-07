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
