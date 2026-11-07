import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

const PENDING = 'vaxlink_pending_scan_inbox_v1';
const MULTIPLE = 'multiple_inject_queue_v1';
const scan = (index = 0) => ({
  rawText: `10SYNTHETIC${index}`,
  source: 'web-serial',
  capturedAt: '2026-11-07T12:00:00.000Z'
});
const capture = (harness, index) =>
  harness.sendMessage({ action: 'scannerScanCaptured', scan: scan(index) });
const chart = {
  id: 22,
  url: 'https://trpanoramadhir.prod.ehealthontario.ca/recordImms/detail'
};
const sender = { id: 'vaxlink-test', frameId: 0, url: chart.url, tab: chart };
const drain = (harness) =>
  harness.sendMessage({ action: 'drainPendingScannerScans' }, sender);
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('concurrent Single captures retain every row beyond the old 25-scan limit', async () => {
  const harness = createBackgroundHarness(makeTestNvcBundle());
  const replies = await Promise.all(
    Array.from({ length: 30 }, (_, i) => capture(harness, i))
  );
  assert.equal(
    replies.every((reply) => reply.success),
    true
  );
  assert.equal(harness.storageData.get(PENDING).length, 30);
  assert.equal(
    new Set(harness.storageData.get(PENDING).map((row) => row.rawText)).size,
    30
  );
  assert.equal(harness.storageData.get(PENDING)[0].rawText, scan(0).rawText);
});

test('a capture during a drain cannot be overwritten by its final inbox write', async () => {
  const entered = deferred();
  const delivery = deferred();
  const tabs = [chart];
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    tabs,
    storage: { [PENDING]: [scan(0)] },
    tabResponse: () => {
      entered.resolve();
      return delivery.promise;
    }
  });
  const draining = drain(harness);
  await entered.promise;
  tabs.length = 0;
  const capturing = capture(harness, 1);
  delivery.resolve({ accepted: true });
  assert.equal((await draining).drained, 1);
  assert.equal((await capturing).success, true);
  assert.deepEqual(
    Array.from(harness.storageData.get(PENDING), (row) => row.rawText),
    [scan(1).rawText]
  );
});

test('failed inbox writes do not poison the serialization chain and concurrent drains cannot replay a row', async () => {
  let fail = true;
  const tabs = [];
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    tabs,
    failStorageSet: (values) => Object.hasOwn(values, PENDING) && fail,
    tabResponse: { accepted: true }
  });
  assert.equal((await capture(harness, 0)).success, false);
  fail = false;
  assert.equal((await capture(harness, 1)).success, true);
  tabs.push(chart);
  const results = await Promise.all([drain(harness), drain(harness)]);
  assert.equal(
    results.reduce((sum, reply) => sum + reply.drained, 0),
    1
  );
  assert.equal(harness.tabMessages.length, 1);
});

test('analytics failure cannot change a durable queue save into a routing failure', async () => {
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    storage: { vaxlink_workflow_mode_v1: 'multiple' },
    failStorageSet: (values) => Object.hasOwn(values, 'vaxlink_analytics_v1')
  });
  const reply = await capture(harness, 0);
  assert.equal(reply.success, true);
  assert.equal(reply.queuedToWorkflow, true);
  assert.equal(harness.storageData.get(MULTIPLE).length, 1);
});

test('a suppressed duplicate reports its actual outcome and is not counted as another saved queue row', async () => {
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    storage: { vaxlink_workflow_mode_v1: 'multiple' }
  });
  await capture(harness, 0);
  const reply = await capture(harness, 0);
  assert.equal(reply.success, true);
  assert.equal(reply.duplicate_ignored, true);
  assert.equal(reply.queued, false);
  assert.equal(reply.queuedToWorkflow, false);
  assert.equal(harness.storageData.get(MULTIPLE).length, 1);
  const events = harness.storageData.get('vaxlink_analytics_v1').recentEvents;
  assert.equal(
    events.filter((event) => event.eventType === 'queue_saved').length,
    1
  );
});

test('a failed post-delivery inbox write reports failure and leaves an uncertain replay', async () => {
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    tabs: [chart],
    storage: { [PENDING]: [scan(0)] },
    tabResponse: { accepted: true },
    failStorageSet: (values) => Object.hasOwn(values, PENDING)
  });
  const reply = await drain(harness);
  assert.equal(reply.success, false);
  assert.equal(harness.tabMessages.length, 1);
  assert.equal(harness.storageData.get(PENDING).length, 1);
});
