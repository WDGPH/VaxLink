import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

const EMPTY_BUNDLE = makeTestNvcBundle();
const MULTIPLE_KEY = 'multiple_inject_queue_v1';
const INVENTORY_KEY = 'inventory_scan_batch_v1';
const PENDING_KEY = 'vaxlink_pending_scan_inbox_v1';

function makeScan(capturedAt) {
  return {
    type: 'vaxlink.scan',
    rawText: '01001234567890121727123110LOCKLOT1',
    source: 'web-serial',
    capturedAt
  };
}

test('locked captures from a saved Multiple preference are held once per barcode', async () => {
  const harness = createBackgroundHarness(EMPTY_BUNDLE, {
    idleState: 'locked',
    storage: { vaxlink_workflow_mode_v1: 'multiple' },
    tabs: [
      {
        id: 44,
        windowId: 9,
        active: true,
        currentWindow: true,
        url: 'https://www.panorama.prod.ehealthontario.ca/phsdsm/ImmsWeb/pages/recordImms/recordImms.xhtml'
      }
    ]
  });

  const first = await harness.captureScannerScan(
    makeScan('2026-07-28T12:00:00.000Z')
  );
  const second = await harness.captureScannerScan(
    makeScan('2026-07-28T12:00:01.000Z')
  );

  assert.equal(first.success, true);
  assert.equal(first.locked, true);
  assert.equal(first.pinnedTabId, 44);
  assert.equal(
    second.pendingCount,
    2,
    'two deliberate identical scans must both survive lock capture'
  );

  const rows = harness.storageData.get(PENDING_KEY);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].captured_while_locked, true);
  assert.equal(rows[0].lock_session_tab_id, 44);
  assert.equal(rows[0].lock_session_id, rows[1].lock_session_id);
  assert.equal(harness.storageData.has(MULTIPLE_KEY), false);
});

test('scans captured while Windows is locked in Single mode remain held', async () => {
  const harness = createBackgroundHarness(EMPTY_BUNDLE, {
    idleState: 'locked',
    storage: { vaxlink_workflow_mode_v1: 'single' },
    tabs: [
      {
        id: 44,
        windowId: 9,
        active: true,
        currentWindow: true,
        url: 'https://www.panorama.prod.ehealthontario.ca/phsdsm/ImmsWeb/pages/recordImms/recordImms.xhtml'
      }
    ]
  });

  const response = await harness.captureScannerScan(
    makeScan('2026-07-28T12:05:00.000Z')
  );

  assert.equal(response.success, true);
  assert.equal(response.locked, true);
  assert.equal(response.workflow, 'immunization');
  assert.equal(response.pendingCount, 1);
  assert.equal(harness.storageData.get(MULTIPLE_KEY), undefined);
  assert.equal(harness.storageData.get(PENDING_KEY).length, 1);
  assert.equal(
    harness.storageData.get(PENDING_KEY)[0].pending_workflow,
    'immunization'
  );
});

test('an unlocked scan is not mislabeled as a locked queue record', async () => {
  const harness = createBackgroundHarness(EMPTY_BUNDLE, {
    idleState: 'active'
  });
  const response = await harness.captureScannerScan(
    makeScan('2026-07-28T12:10:00.000Z')
  );

  assert.equal(response.success, true);
  assert.equal(response.locked, undefined);
  assert.equal(
    harness.storageData.get(MULTIPLE_KEY)[0].captured_while_locked,
    undefined
  );
});

test('an upgraded Multiple preference goes to the tray unless there is a confirmed chart', async () => {
  const harness = createBackgroundHarness(EMPTY_BUNDLE, {
    idleState: 'active',
    storage: { vaxlink_workflow_mode_v1: 'multiple' },
    tabs: [
      {
        id: 44,
        active: true,
        currentWindow: true,
        url: 'https://www.panorama.prod.ehealthontario.ca/phsdsm/ImmsWeb/pages/recordImms/recordImms.xhtml'
      }
    ],
    tabResponse: { accepted: true, success: true }
  });

  const response = await harness.captureScannerScan(
    makeScan('2026-07-28T12:15:00.000Z')
  );

  assert.equal(response.success, true);
  assert.equal(response.queuedToWorkflow, true);
  assert.equal(response.workflow, 'immunization');
  assert.equal(harness.storageData.get(MULTIPLE_KEY).length, 1);
  assert.equal(
    harness.tabMessages.some(
      ({ message }) => message.action === 'vaxlinkScanCaptured'
    ),
    false
  );
});

test('a rapid locked scanner burst cannot lose held rows to storage races', async () => {
  const harness = createBackgroundHarness(EMPTY_BUNDLE, {
    idleState: 'locked',
    storage: { vaxlink_workflow_mode_v1: 'multiple' }
  });
  const scans = Array.from({ length: 20 }, (_, index) =>
    harness.captureScannerScan({
      ...makeScan(`2026-07-28T12:20:${String(index).padStart(2, '0')}.000Z`),
      rawText: `01001234567890121727123110BURST${String(index).padStart(2, '0')}`
    })
  );

  const responses = await Promise.all(scans);
  assert.equal(
    responses.every((response) => response.success && response.locked),
    true
  );
  const rows = harness.storageData.get(PENDING_KEY);
  assert.equal(rows.length, 20);
  assert.equal(new Set(rows.map((row) => row.lock_session_id)).size, 1);
});

test('Inventory captures stay in Inventory while the machine is locked', async () => {
  const harness = createBackgroundHarness(EMPTY_BUNDLE, {
    idleState: 'locked',
    storage: { vaxlink_workflow_mode_v1: 'inventory' }
  });
  const response = await harness.captureScannerScan(
    makeScan('2026-07-28T12:25:00.000Z')
  );
  assert.equal(response.locked, true);
  assert.equal(response.workflow, 'inventory');
  assert.equal(
    harness.storageData.get(INVENTORY_KEY)[0].captured_while_locked,
    true
  );
  assert.equal(harness.storageData.has(PENDING_KEY), false);
});

const LOCK_SESSION_KEY = 'vaxlink_scanner_lock_session_v1';
const STATUS_KEY = 'vaxlink_scanner_status_snapshot_v1';

function delayFirstLock() {
  let signal;
  const started = new Promise((resolve) => (signal = resolve));
  let delayed = false;
  return {
    started,
    delayStorageSet(values, resume) {
      if (delayed || values[LOCK_SESSION_KEY]?.state !== 'locked') return;
      delayed = true;
      signal(resume);
      return true;
    }
  };
}

for (const [workflow, storageKey] of [
  ['immunization', PENDING_KEY],
  ['inventory', INVENTORY_KEY]
]) {
  test(`${workflow} preserves repeated captures when unlock overtakes lock storage`, async () => {
    const lock = delayFirstLock();
    const harness = createBackgroundHarness(EMPTY_BUNDLE, {
      idleState: 'active',
      storage: { vaxlink_workflow_mode_v1: workflow },
      delayStorageSet: lock.delayStorageSet
    });
    harness.setIdleState('locked');
    const resume = await lock.started;
    const scans = [
      harness.captureScannerScan(makeScan('2026-07-28T12:25:00.000Z')),
      harness.captureScannerScan(makeScan('2026-07-28T12:25:01.000Z'))
    ];
    harness.setIdleState('active');
    resume();

    const responses = await Promise.all(scans);
    assert.ok(
      responses.every((response) => response.success && response.locked)
    );
    const session = harness.storageData.get(LOCK_SESSION_KEY);
    const rows = harness.storageData.get(storageKey);
    assert.equal(session.state, 'active');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.lock_session_id === session.id));
    assert.equal(
      harness.tabMessages.some(
        ({ message }) => message.action === 'vaxlinkScanCaptured'
      ),
      false
    );
  });
}

test('a reader interruption received while locked survives a delayed lock and unlock without captures', async () => {
  const lock = delayFirstLock();
  const harness = createBackgroundHarness(EMPTY_BUNDLE, {
    idleState: 'active',
    storage: { [STATUS_KEY]: { state: 'connected' } },
    delayStorageSet: lock.delayStorageSet
  });
  harness.setIdleState('locked');
  const resume = await lock.started;
  const status = harness.sendMessage({
    target: 'scannerDaemonBackground',
    action: 'scannerDaemon.statusUpdate',
    status: { state: 'recovering' }
  });
  harness.setIdleState('active');
  resume();

  assert.equal((await status).success, true);
  const session = harness.storageData.get(LOCK_SESSION_KEY);
  assert.equal(session.state, 'active');
  assert.equal(session.interrupted, true);
  assert.equal(harness.storageData.has(PENDING_KEY), false);
  assert.equal(harness.storageData.has(INVENTORY_KEY), false);
});
