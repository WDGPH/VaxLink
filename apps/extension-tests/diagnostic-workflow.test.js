import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';
const control = {
  id: 'vaxlink-test',
  url: 'chrome-extension://vaxlink-test/popup.html'
};
const content = {
  id: 'vaxlink-test',
  url: 'https://inputhealth.com/chart',
  frameId: 0,
  documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  tab: { id: 42, url: 'https://inputhealth.com/chart' }
};
const scan = {
  rawText: '10TESTLOT',
  source: 'web-serial',
  capturedAt: '2026-11-07T12:00:00.000Z'
};
const capture = (harness, extra = {}) =>
  harness.sendMessage({
    action: 'scannerScanCaptured',
    scan: { ...scan, ...extra }
  });
const start = (harness) =>
  harness.sendMessage({ action: 'diagnostics.start' }, control);
const stop = (harness, sessionId) =>
  harness.sendMessage({ action: 'diagnostics.stop', sessionId }, control);

test('recording keeps distinct attempt identities without changing queue duplicate suppression', async () => {
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    storage: { vaxlink_workflow_mode_v1: 'multiple' }
  });
  const recording = await start(harness);
  const observed = harness.waitForDiagnostic((value) =>
    value?.events?.some(
      (event) => event.code === 'queue' && event.reason === 'duplicate'
    )
  );
  assert.equal((await capture(harness)).queuedToWorkflow, true);
  assert.equal((await capture(harness)).duplicate_ignored, true);
  const session = await observed;
  const outcomes = Array.from(session.events).filter(
    (event) =>
      event.code === 'queue' && ['queued', 'skipped'].includes(event.outcome)
  );
  assert.equal(outcomes.length, 2);
  assert.notEqual(outcomes[0].operationId, outcomes[1].operationId);
  const rows = harness.storageData.get('multiple_inject_queue_v1');
  assert.equal(rows.length, 1);
  assert.equal(Object.hasOwn(rows[0], 'diagnosticLink'), false);
  assert.equal(JSON.stringify(session).includes('TESTLOT'), false);
  const contextId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  assert.equal(
    (
      await harness.sendMessage(
        { action: 'diagnostics.join', context: 'content', contextId },
        content
      )
    ).success,
    true
  );
  const parent = await harness.sendMessage(
    {
      action: 'diagnostics.queueParent',
      context: 'content',
      contextId,
      sessionId: recording.session.id,
      recordId: rows[0].id
    },
    content
  );
  assert.equal(parent.parentOperationId, outcomes[0].operationId);
  assert.equal(
    (await harness.sendMessage({ action: 'diagnostics.read' }, content))
      .success,
    false
  );
  await stop(harness, recording.session.id);
});

test('failed session storage never changes a clinical queue save into failure', async () => {
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    storage: { vaxlink_workflow_mode_v1: 'multiple' },
    failSessionSet: () => true
  });
  assert.equal((await start(harness)).success, false);
  assert.equal((await capture(harness)).queuedToWorkflow, true);
  assert.equal(harness.storageData.get('multiple_inject_queue_v1').length, 1);
});

test('pending replay uses partial history when capture timestamps collide and never persists trace links', async () => {
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    tabResponse: { accepted: true }
  });
  const recording = await start(harness);
  await capture(harness);
  await capture(harness);
  const pending = harness.storageData.get('vaxlink_pending_scan_inbox_v1');
  assert.equal(pending.length, 2);
  assert.equal(
    pending.some((row) => Object.hasOwn(row, 'diagnosticLink')),
    false
  );
  assert.equal(
    (await harness.sendMessage({ action: 'drainPendingScannerScans' }, content))
      .drained,
    2
  );
  const delivered = harness.tabMessages.filter(
    ({ message }) => message.action === 'vaxlinkScanCaptured'
  );
  assert.equal(delivered.length, 2);
  assert.notEqual(
    delivered[0].message.scan.diagnosticLink.operationId,
    delivered[1].message.scan.diagnosticLink.operationId
  );
  assert.equal(
    delivered.every(
      ({ message }) => !message.scan.diagnosticLink.parentOperationId
    ),
    true
  );
  await capture(harness, { capturedAt: 'SYNTHETIC-PATIENT-MARKER' });
  assert.equal(
    JSON.stringify(Object.fromEntries(harness.sessionData)).includes(
      'SYNTHETIC-PATIENT-MARKER'
    ),
    false
  );
  await stop(harness, recording.session.id);
});
