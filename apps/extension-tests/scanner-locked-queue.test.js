import assert from 'node:assert/strict';
import test from 'node:test';

import { createBackgroundHarness } from './helpers/clinic-sim.js';

const EMPTY_BUNDLE = { resourceType: 'Bundle', entry: [] };
const MULTIPLE_KEY = 'multiple_inject_queue_v1';
const PENDING_KEY = 'vaxlink_pending_scan_inbox_v1';

function makeScan(capturedAt) {
  return {
    type: 'vaxlink.scan',
    rawText: '01001234567890121727123110LOCKLOT1',
    source: 'web-serial',
    capturedAt
  };
}

test('scans captured while Windows is locked are preserved in Multiple Inject', async () => {
  const harness = createBackgroundHarness(EMPTY_BUNDLE, {
    idleState: 'locked',
    storage: { vaxlink_workflow_mode_v1: 'multiple' },
    tabs: [{
      id: 44,
      windowId: 9,
      active: true,
      currentWindow: true,
      url: 'https://www.panorama.prod.ehealthontario.ca/phsdsm/ImmsWeb/pages/recordImms/recordImms.xhtml'
    }]
  });

  const first = await harness.sendMessage({
    action: 'scannerScanCaptured',
    scan: makeScan('2026-07-28T12:00:00.000Z')
  });
  const second = await harness.sendMessage({
    action: 'scannerScanCaptured',
    scan: makeScan('2026-07-28T12:00:01.000Z')
  });

  assert.equal(first.success, true);
  assert.equal(first.locked, true);
  assert.equal(first.pinnedTabId, 44);
  assert.equal(second.queueSizeAfter, 2, 'two deliberate identical scans must both survive lock capture');

  const rows = harness.storageData.get(MULTIPLE_KEY);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].captured_while_locked, true);
  assert.equal(rows[0].lock_session_tab_id, 44);
  assert.equal(rows[0].lock_session_id, rows[1].lock_session_id);
  assert.equal(harness.getBadgeText(), '2');
});

test('scans captured while Windows is locked in Single mode wait for unlock', async () => {
  const harness = createBackgroundHarness(EMPTY_BUNDLE, {
    idleState: 'locked',
    storage: { vaxlink_workflow_mode_v1: 'single' },
    tabs: [{
      id: 44,
      windowId: 9,
      active: true,
      currentWindow: true,
      url: 'https://www.panorama.prod.ehealthontario.ca/phsdsm/ImmsWeb/pages/recordImms/recordImms.xhtml'
    }]
  });

  const response = await harness.sendMessage({
    action: 'scannerScanCaptured',
    scan: makeScan('2026-07-28T12:05:00.000Z')
  });

  assert.equal(response.success, true);
  assert.equal(response.locked, true);
  assert.equal(response.workflow, 'single');
  assert.equal(response.pendingCount, 1);
  assert.equal(harness.storageData.get(MULTIPLE_KEY), undefined);
  assert.equal(harness.storageData.get(PENDING_KEY).length, 1);
  assert.equal(harness.storageData.get(PENDING_KEY)[0].pending_workflow, 'single');
});

test('pending locked Single scans are replayed to the pinned chart after unlock', async () => {
  const harness = createBackgroundHarness(EMPTY_BUNDLE, {
    idleState: 'locked',
    storage: { vaxlink_workflow_mode_v1: 'single' },
    tabs: [{
      id: 44,
      windowId: 9,
      active: true,
      currentWindow: true,
      url: 'https://www.panorama.prod.ehealthontario.ca/phsdsm/ImmsWeb/pages/recordImms/recordImms.xhtml'
    }],
    tabResponse: { accepted: true, success: true }
  });

  await harness.sendMessage({ action: 'scannerScanCaptured', scan: makeScan('2026-07-28T12:06:00.000Z') });
  harness.setIdleState('active');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(harness.tabMessages.length, 1);
  assert.equal(harness.tabMessages[0].tabId, 44);
  assert.equal(harness.storageData.get(PENDING_KEY).length, 0);
});

test('an unlocked scan is not mislabeled as a locked queue record', async () => {
  const harness = createBackgroundHarness(EMPTY_BUNDLE, { idleState: 'active' });
  const response = await harness.sendMessage({
    action: 'scannerScanCaptured',
    scan: makeScan('2026-07-28T12:10:00.000Z')
  });

  assert.equal(response.success, true);
  assert.equal(response.locked, undefined);
  assert.equal(harness.storageData.get(MULTIPLE_KEY), undefined);
});

test('unlocked Multiple mode queues in background before contacting an open chart', async () => {
  const harness = createBackgroundHarness(EMPTY_BUNDLE, {
    idleState: 'active',
    storage: { vaxlink_workflow_mode_v1: 'multiple' },
    tabs: [{
      id: 44,
      active: true,
      currentWindow: true,
      url: 'https://www.panorama.prod.ehealthontario.ca/phsdsm/ImmsWeb/pages/recordImms/recordImms.xhtml'
    }],
    tabResponse: { accepted: true, success: true }
  });

  const response = await harness.sendMessage({
    action: 'scannerScanCaptured',
    scan: makeScan('2026-07-28T12:15:00.000Z')
  });

  assert.equal(response.success, true);
  assert.equal(response.queuedToWorkflow, true);
  assert.equal(response.workflow, 'multiple');
  assert.equal(harness.storageData.get(MULTIPLE_KEY).length, 1);
  assert.equal(harness.tabMessages.length, 0);
});

test('a rapid locked scanner burst cannot lose queue rows to storage races', async () => {
  const harness = createBackgroundHarness(EMPTY_BUNDLE, {
    idleState: 'locked',
    storage: { vaxlink_workflow_mode_v1: 'multiple' }
  });
  const scans = Array.from({ length: 20 }, (_, index) => harness.sendMessage({
    action: 'scannerScanCaptured',
    scan: {
      ...makeScan(`2026-07-28T12:20:${String(index).padStart(2, '0')}.000Z`),
      rawText: `01001234567890121727123110BURST${String(index).padStart(2, '0')}`
    }
  }));

  const responses = await Promise.all(scans);
  assert.equal(responses.every((response) => response.success && response.locked), true);
  const rows = harness.storageData.get(MULTIPLE_KEY);
  assert.equal(rows.length, 20);
  assert.equal(new Set(rows.map((row) => row.lock_session_id)).size, 1);
  assert.equal(harness.getBadgeText(), '20');
});
