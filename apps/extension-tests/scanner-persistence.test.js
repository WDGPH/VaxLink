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
  harness.captureScannerScan(scan(rawText));

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
  await harness.appendQueueRecord('multiple_inject_queue_v1', {
    id: 'queue-1'
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

test('unreadable and lotless captures never enter the Immunization tray', async () => {
  for (const idleState of ['active', 'locked']) {
    const harness = createBackgroundHarness(null, {
      idleState,
      storage: { vaxlink_workflow_mode_v1: 'multiple' }
    });
    const scans = ['036000291452', '(01)00036000291452', 'not a barcode'];
    for (const barcode of scans) {
      const response = await captured(harness, barcode);
      assert.equal(
        response.response?.status,
        barcode === 'not a barcode' ? 'parse_error' : 'missing_lot'
      );
      assert.equal(response.queuedToWorkflow, false);
    }
    assert.equal(harness.storageData.has('multiple_inject_queue_v1'), false);
    assert.deepEqual(
      Array.from(
        harness.storageData.get(pending) || [],
        ({ rawText }) => rawText
      ),
      idleState === 'locked' ? scans : []
    );
  }
});

test('an expired scanner capture stays out of Immunization but Inventory can retain the stock', async () => {
  const expired = '01001234567890121700010110TRAINING';
  for (const idleState of ['active', 'locked']) {
    const harness = createBackgroundHarness(null, {
      idleState,
      storage: { vaxlink_workflow_mode_v1: 'multiple' }
    });
    const rejected = await captured(harness, expired);
    assert.equal(rejected.response?.status, 'expired');
    assert.equal(rejected.queuedToWorkflow, false);
    assert.equal(harness.storageData.has('multiple_inject_queue_v1'), false);
    assert.equal(
      harness.storageData.get(pending)?.[0].rawText,
      idleState === 'locked' ? expired : undefined
    );
    if (idleState === 'locked') continue;
    harness.storageData.set('vaxlink_workflow_mode_v1', 'inventory');
    assert.equal((await captured(harness, expired)).queued, true);
    const [stock] = harness.storageData.get('inventory_scan_batch_v1');
    assert.equal(stock.expiry_flag, 'expired');
    assert.equal(stock.raw_barcode, expired);
  }
});
