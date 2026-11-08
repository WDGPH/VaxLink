import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

const key = 'vaxlink_pending_scan_inbox_v1';
const url =
  'https://www.panorama.prod.ehealthontario.ca/phsdsm/ImmsWeb/pages/recordImms/recordImms.xhtml';
const tab = { id: 4, active: true, currentWindow: true, url };
const context = { document: 'document-a', form: 'form-a' };
const popup = {
  id: 'vaxlink-test',
  url: 'chrome-extension://vaxlink-test/popup.html'
};
const chart = { id: 'vaxlink-test', frameId: 0, url, tab };
const scan = {
  rawText: '01001234567890121727123110LOCKLOT1',
  source: 'web-serial'
};
const handshake = {
  supported: true,
  ready: true,
  context,
  operationId: 'operation-a',
  operationVerified: true
};
const capture = (h) => h.sendMessage({ action: 'scannerScanCaptured', scan });

test('single scan is persisted before delivery and removed only by matching applied event', async () => {
  let harness;
  harness = createBackgroundHarness(makeTestNvcBundle(), {
    tabs: [tab],
    tabResponse(_id, message) {
      if (message.action === 'getPanoramaIntegration') return handshake;
      const row = harness.storageData.get(key)[0];
      assert.equal(row.deliveryState, 'dispatching');
      assert.equal(message.scanId, row.scanId);
      return { accepted: true };
    }
  });
  const result = await capture(harness);
  assert.equal(result.persisted, true);
  assert.equal(result.accepted, true);
  const row = harness.storageData.get(key)[0];
  assert.equal(row.deliveryState, 'accepted');
  assert.equal(
    (
      await harness.sendMessage(
        {
          action: 'scannerFillApplied',
          scanId: row.scanId,
          context: { ...context, form: 'other' }
        },
        chart
      )
    ).removed,
    false
  );
  assert.equal(harness.storageData.get(key).length, 1);
  assert.equal(
    (
      await harness.sendMessage(
        { action: 'scannerFillApplied', scanId: row.scanId, context },
        chart
      )
    ).removed,
    true
  );
  assert.equal(harness.storageData.get(key).length, 0);
});

test('not ready or changed context holds scans and never routes to another tab', async () => {
  let current = null;
  const other = { ...tab, id: 5, active: false };
  const h = createBackgroundHarness(makeTestNvcBundle(), {
    tabs: [tab, other],
    tabResponse(_id, message) {
      if (message.action === 'getPanoramaIntegration')
        return current || { supported: true, ready: false };
      return { accepted: true };
    }
  });
  const result = await capture(h);
  assert.equal(result.held, true);
  assert.equal(
    h.tabMessages.some(
      ({ message }) => message.action === 'vaxlinkScanCaptured'
    ),
    false
  );
  current = handshake;
  await h.sendMessage({ action: 'getPendingScannerScanStatus' }, chart);
  assert.equal(
    h.tabMessages.some(
      ({ message }) => message.action === 'vaxlinkScanCaptured'
    ),
    false
  );
  assert.equal(h.storageData.get(key).length, 1);
  assert.ok(h.tabMessages.every(({ tabId }) => tabId === 4));
});

test('failed persistence never delivers; uncertain dispatched work does not replay', async () => {
  const fail = createBackgroundHarness(makeTestNvcBundle(), {
    tabs: [tab],
    tabResponse: handshake,
    failStorageSet: (values) => key in values
  });
  assert.equal((await capture(fail)).success, false);
  assert.equal(
    fail.tabMessages.some(
      ({ message }) => message.action === 'vaxlinkScanCaptured'
    ),
    false
  );
  const rows = [
    {
      ...scan,
      scanId: 'uncertain',
      tabId: 4,
      context,
      deliveryState: 'dispatching'
    }
  ];
  const restarted = createBackgroundHarness(makeTestNvcBundle(), {
    tabs: [tab],
    storage: { [key]: rows },
    tabResponse: handshake
  });
  await restarted.sendMessage({ action: 'getPendingScannerScanStatus' }, chart);
  assert.equal(restarted.tabMessages.length, 0);
  assert.equal(restarted.storageData.get(key).length, 1);
});

test('recovery retries idempotently after inbox removal fails', async () => {
  let failRemoval = true;
  const row = {
    ...scan,
    scanId: 'abc',
    tabId: 4,
    context,
    deliveryState: 'accepted'
  };
  const h = createBackgroundHarness(makeTestNvcBundle(), {
    storage: { [key]: [row] },
    failStorageSet(values) {
      if (key in values && values[key].length === 0 && failRemoval) {
        failRemoval = false;
        return true;
      }
      return false;
    }
  });
  assert.equal(
    (await h.sendMessage({ action: 'recoverPendingScannerScans' }, chart))
      .success,
    false
  );
  assert.equal(
    (await h.sendMessage({ action: 'recoverPendingScannerScans' }, popup))
      .success,
    false
  );
  assert.equal(h.storageData.get('multiple_inject_queue_v1').length, 1);
  assert.equal(
    h.storageData.get('multiple_inject_queue_v1')[0].requires_review,
    true
  );
  assert.equal(
    (await h.sendMessage({ action: 'recoverPendingScannerScans' }, popup))
      .success,
    true
  );
  assert.equal(h.storageData.get('multiple_inject_queue_v1').length, 1);
  assert.equal(h.storageData.get(key).length, 0);
});

test('same-tab form change holds the scan and rejects stale applied reports', async () => {
  let calls = 0;
  const h = createBackgroundHarness(makeTestNvcBundle(), {
    tabs: [tab],
    tabResponse(_id, message) {
      if (message.action === 'getPanoramaIntegration') {
        calls++;
        return {
          supported: true,
          ready: true,
          context: calls === 1 ? context : { ...context, form: 'new-form' }
        };
      }
      return { accepted: true };
    }
  });
  const result = await capture(h);
  assert.equal(result.held, true);
  assert.equal(
    h.tabMessages.some(
      ({ message }) => message.action === 'vaxlinkScanCaptured'
    ),
    false
  );
  const row = h.storageData.get(key)[0];
  assert.equal(
    (
      await h.sendMessage(
        { action: 'scannerFillApplied', scanId: row.scanId, context },
        chart
      )
    ).removed,
    false
  );
  assert.equal(h.storageData.get(key).length, 1);
});

test('acknowledged scanner command is removed without reporting form application', async () => {
  const h = createBackgroundHarness(makeTestNvcBundle(), {
    tabs: [tab],
    tabResponse(_id, message) {
      return message.action === 'getPanoramaIntegration'
        ? handshake
        : { accepted: true, command_handled: true };
    }
  });
  const result = await h.sendMessage({
    action: 'scannerScanCaptured',
    scan: { rawText: 'command', source: 'web-serial' }
  });
  assert.equal(result.command_handled, true);
  assert.equal(result.accepted, true);
  assert.equal(h.storageData.get(key).length, 0);
});

test('unparseable pending scan can be recovered for deliberate review', async () => {
  const rawText = 'not-a-gs1-scan';
  const h = createBackgroundHarness(makeTestNvcBundle(), {
    storage: { [key]: [{ rawText, scanId: 'bad', deliveryState: 'held' }] }
  });
  const result = await h.sendMessage(
    { action: 'recoverPendingScannerScans' },
    popup
  );
  assert.equal(result.success, true);
  const row = h.storageData.get('multiple_inject_queue_v1')[0];
  assert.equal(row.raw_barcode, rawText);
  assert.equal(row.requires_review, true);
  assert.equal(row.lookup_error, 'Barcode could not be parsed');
  assert.equal(h.tabMessages.length, 0);
});

test('capture error acknowledgement restores the queue badge', async () => {
  const h = createBackgroundHarness(makeTestNvcBundle(), {
    storage: {
      vaxlink_scanner_capture_error_v1: true,
      multiple_inject_queue_v1: [{ id: '1' }]
    }
  });
  assert.equal(
    (await h.sendMessage({ action: 'acknowledgeScannerCaptureError' }, popup))
      .success,
    true
  );
  assert.equal(h.storageData.get('vaxlink_scanner_capture_error_v1'), false);
  assert.equal(h.getBadgeText(), '1');
});

test('queue consumption and concurrent append preserve both mutations', async () => {
  let release;
  let started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const queue = 'multiple_inject_queue_v1';
  const h = createBackgroundHarness(makeTestNvcBundle(), {
    tabs: [tab],
    tabResponse: handshake,
    storage: { [queue]: [{ id: 'first', remaining_doses: 2 }] },
    delayStorageSet(values, continuation) {
      if (!(queue in values) || release) return false;
      release = continuation;
      started();
      return true;
    }
  });
  const consume = h.sendMessage(
    {
      action: 'consumeQueueRecord',
      recordId: 'first',
      expectedContext: context,
      operationId: 'operation-a'
    },
    chart
  );
  await waiting;
  const append = h.sendMessage({
    action: 'appendQueueRecord',
    storageKey: queue,
    record: { id: 'second' }
  });
  release();
  assert.equal((await consume).success, true);
  assert.equal((await append).success, true);
  assert.deepEqual(
    Array.from(h.storageData.get(queue), (row) => [
      row.id,
      row.remaining_doses
    ]),
    [
      ['first', 1],
      ['second', undefined]
    ]
  );
});

for (const change of ['operation', 'fields']) {
  test(`queued consumption rejects changed ${change} on the same form`, async () => {
    const queue = 'multiple_inject_queue_v1';
    let release;
    let started;
    const waiting = new Promise((resolve) => {
      started = resolve;
    });
    let operationId = 'operation-a';
    let operationVerified = true;
    const h = createBackgroundHarness(makeTestNvcBundle(), {
      tabs: [tab],
      storage: { [queue]: [{ id: 'first', remaining_doses: 2 }] },
      tabResponse: () => ({ ...handshake, operationId, operationVerified }),
      delayStorageSet(values, continuation) {
        if (!(queue in values) || release) return false;
        release = continuation;
        started();
        return true;
      }
    });
    const append = h.sendMessage({
      action: 'appendQueueRecord',
      storageKey: queue,
      record: { id: 'second' }
    });
    await waiting;
    const consume = h.sendMessage(
      {
        action: 'consumeQueueRecord',
        recordId: 'first',
        expectedContext: context,
        operationId: 'operation-a'
      },
      chart
    );
    if (change === 'operation') operationId = 'operation-b';
    else operationVerified = false;
    release();
    assert.equal((await append).success, true);
    assert.equal((await consume).success, false);
    assert.equal(h.storageData.get(queue)[0].remaining_doses, 2);
  });
}

test('queue consumption rejects changed context and failed writes without losing rows', async () => {
  const queue = 'multiple_inject_queue_v1';
  const rows = [{ id: 'first', remaining_doses: 1 }];
  const changed = createBackgroundHarness(makeTestNvcBundle(), {
    tabs: [tab],
    storage: { [queue]: rows },
    tabResponse: {
      supported: true,
      ready: true,
      context: { ...context, form: 'other' },
      operationId: 'operation-a'
    }
  });
  assert.equal(
    (
      await changed.sendMessage(
        {
          action: 'consumeQueueRecord',
          recordId: 'first',
          expectedContext: context,
          operationId: 'operation-a'
        },
        chart
      )
    ).success,
    false
  );
  assert.equal(changed.storageData.get(queue).length, 1);
  const failing = createBackgroundHarness(makeTestNvcBundle(), {
    tabs: [tab],
    storage: { [queue]: rows },
    tabResponse: handshake,
    failStorageSet: (values) => queue in values
  });
  assert.equal(
    (
      await failing.sendMessage(
        {
          action: 'consumeQueueRecord',
          recordId: 'first',
          expectedContext: context,
          operationId: 'operation-a'
        },
        chart
      )
    ).success,
    false
  );
  assert.equal(failing.storageData.get(queue).length, 1);
});

test('a capture during initial dispatch cannot overwrite the pending inbox', async () => {
  let release;
  let started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const h = createBackgroundHarness(makeTestNvcBundle(), {
    tabs: [tab],
    tabResponse: (_id, message) =>
      message.action === 'getPanoramaIntegration'
        ? handshake
        : { accepted: true },
    delayTabMessage(_id, message, continuation) {
      if (message.action !== 'vaxlinkScanCaptured' || release) return false;
      release = continuation;
      started();
      return true;
    }
  });
  const first = capture(h);
  await waiting;
  const second = capture(h);
  release();
  assert.equal((await first).accepted, true);
  assert.equal((await second).accepted, true);
  assert.equal(h.storageData.get(key).length, 2);
});

test('verified duplicate acknowledgement removes the new pending scan', async () => {
  const h = createBackgroundHarness(makeTestNvcBundle(), {
    tabs: [tab],
    tabResponse(_id, message) {
      return message.action === 'getPanoramaIntegration'
        ? handshake
        : { accepted: true, duplicate_ignored: true };
    }
  });
  const result = await capture(h);
  assert.equal(result.duplicate_ignored, true);
  assert.equal(result.queued, false);
  assert.equal(result.held, false);
  assert.equal(h.storageData.get(key).length, 0);
});
