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
    { id: 'vaxlink-test', tab, frameId: 0, url: tab.url }
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

test('normal GS1 scans reach capacity at 250 and reject the next without loss', async () => {
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    idleState: 'locked',
    storage: { vaxlink_workflow_mode_v1: 'single' }
  });
  for (let i = 0; i < 250; i++)
    assert.equal(
      (await captured(harness, `01099990000000081727123110TEST${i}`)).success,
      true
    );
  assert.equal(harness.storageData.get(pending).length, 250);
  assert.equal(
    (await captured(harness, '01099990000000081727123110TEST251')).success,
    false
  );
  assert.equal(harness.storageData.get(pending).length, 250);
});

test('failed inbox removal after delivery retains the scan', async () => {
  const tab = {
    id: 44,
    url: 'https://panorama.prod.ehealthontario.ca/phsdsm/ImmsWeb/pages/recordImms/recordImms.xhtml'
  };
  const row = scan('01099990000000081727123110TEST');
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    idleState: 'locked',
    storage: { [pending]: [row] },
    tabs: [tab],
    tabResponse: { success: true },
    failStorageSet: (values) =>
      Array.isArray(values[pending]) && values[pending].length === 0
  });
  const result = await harness.sendMessage(
    { action: 'drainPendingScannerScans' },
    { id: 'vaxlink-test', tab, frameId: 0, url: tab.url }
  );
  assert.equal(result.success, false);
  assert.equal(harness.tabMessages.length, 1);
  assert.equal(harness.storageData.get(pending).length, 1);
});

test('warning badge survives queue updates and failed acknowledgement', async () => {
  let failAck = true;
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    idleState: 'locked',
    storage: { vaxlink_workflow_mode_v1: 'single' },
    failStorageSet: (values) =>
      values.vaxlink_scanner_capture_error_v1 === false && failAck
  });
  assert.equal(
    (await captured(harness, 'x'.repeat(1024 * 1024))).success,
    false
  );
  assert.equal(harness.getBadgeText(), '!');
  await harness.sendMessage({
    action: 'appendQueueRecord',
    storageKey: 'multiple_inject_queue_v1',
    record: { id: 'queue-1' }
  });
  assert.equal(harness.getBadgeText(), '!');
  const sender = {
    id: 'vaxlink-test',
    url: 'chrome-extension://vaxlink-test/popup.html'
  };
  assert.equal(
    (
      await harness.sendMessage(
        { action: 'acknowledgeScannerCaptureError' },
        sender
      )
    ).success,
    false
  );
  assert.equal(harness.getBadgeText(), '!');
  failAck = false;
  assert.equal(
    (
      await harness.sendMessage(
        { action: 'acknowledgeScannerCaptureError' },
        sender
      )
    ).success,
    true
  );
  assert.equal(harness.getBadgeText(), '1');
});

test('a new capture failure during acknowledgement keeps the warning', async () => {
  let release;
  let started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    idleState: 'locked',
    storage: { vaxlink_workflow_mode_v1: 'single' },
    delayStorageSet(values, resume) {
      if (values.vaxlink_scanner_capture_error_v1 !== false || release)
        return false;
      release = resume;
      started();
      return true;
    }
  });
  await captured(harness, 'x'.repeat(1024 * 1024));
  const sender = {
    id: 'vaxlink-test',
    url: 'chrome-extension://vaxlink-test/popup.html'
  };
  const ack = harness.sendMessage(
    { action: 'acknowledgeScannerCaptureError' },
    sender
  );
  await waiting;
  await captured(harness, 'x'.repeat(1024 * 1024));
  release();
  const result = await ack;
  assert.equal(result.captureError, true);
  assert.equal(harness.getBadgeText(), '!');
  const status = await harness.sendMessage({
    action: 'scannerDaemon.getStatus'
  });
  assert.equal(status.captureError, true);
});
