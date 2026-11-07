import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

const pending = 'vaxlink_pending_scan_inbox_v1';
const scan = (rawText) => ({
  rawText,
  source: 'web-serial',
  capturedAt: '2026-07-28T12:00:00.000Z'
});
const captured = (harness, rawText) =>
  harness.sendMessage({ action: 'scannerScanCaptured', scan: scan(rawText) });

test('concurrent pending writes are serialized, including delayed saves', async () => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    idleState: 'locked',
    storage: { vaxlink_workflow_mode_v1: 'single' },
    delayStorageSet(values, resume) {
      if (!(pending in values) || release) return false;
      release = resume;
      started();
      return true;
    }
  });
  const first = captured(harness, 'first');
  await startedPromise;
  const second = captured(harness, 'second');
  release();
  assert.equal((await first).success, true);
  assert.equal((await second).success, true);
  assert.deepEqual(
    Array.from(harness.storageData.get(pending), (row) => row.rawText),
    ['first', 'second']
  );
});

test('pending capacity and failed writes preserve existing records', async () => {
  const old = Array.from({ length: 250 }, (_, i) => scan(String(i)));
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    idleState: 'locked',
    storage: { vaxlink_workflow_mode_v1: 'single', [pending]: old }
  });
  const full = await captured(harness, 'new');
  assert.equal(full.success, false);
  assert.match(full.error, /full/i);
  assert.equal(harness.storageData.get(pending), old);
  const failing = createBackgroundHarness(makeTestNvcBundle(), {
    idleState: 'locked',
    storage: { vaxlink_workflow_mode_v1: 'single', [pending]: [scan('old')] },
    failStorageSet: (values) => pending in values
  });
  assert.equal((await captured(failing, 'new')).success, false);
  assert.equal(failing.storageData.get(pending).length, 1);
  const tooLarge = createBackgroundHarness(makeTestNvcBundle(), {
    idleState: 'locked',
    storage: { vaxlink_workflow_mode_v1: 'single' }
  });
  assert.equal(
    (await captured(tooLarge, 'x'.repeat(1024 * 1024))).success,
    false
  );
  assert.equal(tooLarge.storageData.has(pending), false);
});

test('analytics failure does not report a persisted scan as failed', async () => {
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    storage: { vaxlink_workflow_mode_v1: 'multiple' },
    failStorageSet: (values) => 'vaxlink_analytics_v1' in values
  });
  const response = await captured(
    harness,
    '01001234567890121727123110LOCKLOT1'
  );
  assert.equal(response.success, true);
  assert.equal(response.queued, true);
  assert.equal(harness.storageData.get('multiple_inject_queue_v1').length, 1);
});

test('enqueue waits for an in-progress drain', async () => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  const tab = {
    id: 44,
    url: 'https://www.panorama.prod.ehealthontario.ca/phsdsm/ImmsWeb/pages/recordImms/recordImms.xhtml'
  };
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    idleState: 'locked',
    storage: { vaxlink_workflow_mode_v1: 'single', [pending]: [scan('old')] },
    tabs: [tab],
    tabResponse: { success: true, accepted: true },
    delayTabMessage(_tabId, _message, resume) {
      release = resume;
      started();
      return true;
    }
  });
  const drain = harness.sendMessage(
    { action: 'drainPendingScannerScans' },
    { tab, frameId: 0, url: tab.url }
  );
  await startedPromise;
  const next = captured(harness, 'new');
  release();
  assert.equal((await drain).drained, 1);
  assert.equal((await next).success, true);
  assert.deepEqual(
    Array.from(harness.storageData.get(pending), (row) => row.rawText),
    ['new']
  );
});

test('duplicate queue capture is reported without another saved event', async () => {
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    storage: { vaxlink_workflow_mode_v1: 'multiple' }
  });
  const first = await captured(harness, '01001234567890121727123110LOCKLOT1');
  const second = await captured(harness, '01001234567890121727123110LOCKLOT1');
  assert.equal(first.queued, true);
  assert.equal(second.queued, false);
  assert.equal(second.duplicate_ignored, true);
  assert.equal(harness.storageData.get('multiple_inject_queue_v1').length, 1);
});
