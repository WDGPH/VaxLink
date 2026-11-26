import assert from 'node:assert/strict';
import test from 'node:test';
import { LONG_RANGE_PROFILE_ID } from '../extension/scanner/scanner-daemon-shared.js';

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

test('locked captures from a saved Multiple preference each go straight to the tray', async () => {
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
    second.queueSizeAfter,
    2,
    'two deliberate identical scans must both survive lock capture'
  );

  const rows = harness.storageData.get(MULTIPLE_KEY);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].captured_while_locked, true);
  assert.equal(rows[0].lock_session_tab_id, 44);
  assert.equal(rows[0].lock_session_id, rows[1].lock_session_id);
  assert.equal(harness.storageData.has(PENDING_KEY), false);
});

test('scans captured while Windows is locked in Single mode go to the tray', async () => {
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
  assert.equal(response.queueSizeAfter, 1);
  assert.equal(harness.storageData.has(PENDING_KEY), false);
  assert.equal(harness.storageData.get(MULTIPLE_KEY)[0].remaining_doses, 1);
  assert.equal(
    harness.tabMessages.some(
      ({ message }) => message.action === 'vaxlinkScanCaptured'
    ),
    false
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

test('a rapid locked scanner burst cannot lose tray rows to storage races', async () => {
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
  const rows = harness.storageData.get(MULTIPLE_KEY);
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
  ['immunization', MULTIPLE_KEY],
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

function resumeFixture(kind = 'multiple_grid', extra = {}) {
  const tab = {
    id: 44,
    windowId: 9,
    active: true,
    url: 'https://www.panorama.prod.ehealthontario.ca/ImmsWeb/pages/recordImms/chart'
  };
  const anchor = '9d57447b-9d52-45cc-ac31-fcf702201787';
  const reply = {
    anchor,
    kind,
    ready: true,
    buildAtLoad: {
      name: 'VaxLink Alpha',
      version: '1.1.5',
      versionName: '1.2.0-alpha'
    }
  };
  const worker = createBackgroundHarness(makeTestNvcBundle('LOCKLOT1'), {
    tabs: [tab],
    tabResponse: reply,
    ...extra
  });
  const sender = {
    id: 'vaxlink-test',
    tab,
    url: tab.url,
    frameId: 0,
    documentId: 'original-document'
  };
  return {
    worker,
    reply,
    sender,
    capture: (data = {}) =>
      worker.captureScannerScan({ ...makeScan(), ...data }),
    offer: (capacity = 3, from = sender) =>
      worker.sendMessage(
        { action: 'getLockedScanResume', anchor, kind, capacity },
        from
      ),
    claim: ({ sessionId, captureId }, from = sender) =>
      worker.sendMessage(
        {
          action: 'resumeLockedScan',
          anchor,
          kind,
          sessionId,
          captureId,
          token: crypto.randomUUID()
        },
        from
      )
  };
}

test('three locked grid captures hand off individually, even with identical barcodes and duplicate claims', async () => {
  const { worker, sender, capture, offer, claim } = resumeFixture();
  await offer();
  worker.setIdleState('locked');
  await Promise.all([capture(), capture(), capture()]);
  const ids = Array.from(worker.storageData.get(MULTIPLE_KEY), (row) => row.id);
  assert.equal(new Set(ids).size, 3);
  worker.setIdleState('active');
  const first = await offer(2);
  assert.equal(first.count, 2);
  assert.equal(first.captureId, ids[0]);
  assert.equal(
    (await claim(first, { ...sender, documentId: 'replacement' })).success,
    false
  );
  const results = await Promise.all([claim(first), claim(first)]);
  assert.equal(results.filter(({ success }) => success).length, 1);
  const accepted = [results.find(({ success }) => success)];
  accepted.push(await claim(await offer()), await claim(await offer()));
  assert.deepEqual(
    accepted.map((entry) => entry.recordId),
    ids
  );
  const tray = worker.storageData.get(MULTIPLE_KEY);
  for (const [index, record] of tray.entries()) {
    assert.equal(record.dose_reservations[0].token, accepted[index].token);
    assert.equal(record.dose_reservations[0].documentId, sender.documentId);
    assert.equal(record.remaining_doses, 1);
  }
  assert.equal(worker.storageData.has(PENDING_KEY), false);
  assert.equal((await offer()).count, 0);
});

test('ordinary Use and Resume cannot reserve the same locked dose', async () => {
  const { worker, sender, capture, offer, claim } = resumeFixture();
  await offer();
  worker.setIdleState('locked');
  await capture();
  worker.setIdleState('active');
  const selection = await offer();
  const token = crypto.randomUUID();
  const mutation = {
    action: 'mutateQueue',
    storageKey: MULTIPLE_KEY,
    payload: { id: selection.captureId, token }
  };
  const [use, resumed] = await Promise.all([
    worker.sendMessage({ ...mutation, operation: 'reserve_dose' }, sender),
    claim(selection)
  ]);
  assert.equal(Number(use.success) + Number(resumed.success), 1);
  const stop = await worker.sendMessage(
    {
      ...mutation,
      operation: 'stop_dose',
      payload: {
        ...mutation.payload,
        token: resumed.token || token,
        written: false
      }
    },
    sender
  );
  assert.equal(stop.success, true);
  assert.equal((await offer()).count, 0);
  const [dose] = worker.storageData.get(MULTIPLE_KEY);
  assert.equal(dose.remaining_doses, 1);
  assert.equal(dose.dose_reservations, undefined);
});

test('a Single offer waits for a locked second capture when unlock overtakes its write', async () => {
  let finishSecond;
  let started;
  const secondStarted = new Promise((resolve) => (started = resolve));
  const { worker, capture, offer } = resumeFixture('provider_single', {
    delayStorageSet(values, resume) {
      if (values[MULTIPLE_KEY]?.length !== 2 || finishSecond) return false;
      finishSecond = resume;
      started();
      return true;
    }
  });
  await offer();
  worker.setIdleState('locked');
  await capture();
  const second = capture();
  await secondStarted;
  worker.setIdleState('active');
  const afterUnlock = offer();
  finishSecond();
  await second;
  assert.equal((await afterUnlock).count, 0);
  assert.equal(worker.storageData.get(MULTIPLE_KEY).length, 2);
  assert.equal(worker.storageData.has(PENDING_KEY), false);
});

test('Resume leaves the tray dose available if saving its reservation fails', async () => {
  let failHandoff = true;
  const { worker, sender, capture, offer, claim } = resumeFixture(
    'provider_single',
    {
      failStorageSet: (values) =>
        failHandoff &&
        values[MULTIPLE_KEY]?.some((row) => row.dose_reservations)
    }
  );
  await offer(1);
  worker.setIdleState('locked');
  await capture();
  worker.setIdleState('active');
  const selection = await offer(1);
  assert.equal(selection.count, 1);
  assert.equal((await claim(selection)).success, false);
  assert.equal(worker.storageData.get(MULTIPLE_KEY).length, 1);
  assert.equal(
    worker.storageData.get(MULTIPLE_KEY)[0].dose_reservations,
    undefined
  );
  failHandoff = false;
  const moved = await claim(selection);
  assert.equal(moved.recordId, selection.captureId);
  assert.equal((await claim(selection)).success, false);
  const mutation = {
    action: 'mutateQueue',
    storageKey: MULTIPLE_KEY,
    payload: { id: moved.recordId, token: moved.token }
  };
  assert.equal(
    (
      await worker.sendMessage(
        {
          ...mutation,
          operation: 'stop_dose',
          payload: { ...mutation.payload, written: false }
        },
        sender
      )
    ).success,
    true
  );
  assert.equal((await offer(1)).count, 0);
  const adoption = await worker.sendMessage(
    {
      ...mutation,
      operation: 'reserve_dose',
      payload: { ...mutation.payload, requireReservation: true }
    },
    sender
  );
  assert.equal(adoption.success, false);
  assert.equal(
    worker.storageData.get(MULTIPLE_KEY)[0].dose_reservations,
    undefined
  );
});

test('an unfocused chart can supply a lock witness only after recent focus loss', async () => {
  for (const elapsed of [10, 60000]) {
    const sessionStorage = new Map();
    const { sender, offer } = resumeFixture('provider_single', {
      sessionStorage
    });
    await offer();
    const key = 'vaxlink_scanner_resume_witness_v1';
    sessionStorage.get(key).blurredAt = Date.now() - elapsed;
    let focused = false;
    const locked = resumeFixture('provider_single', {
      sessionStorage,
      windows: {
        async getLastFocused() {
          return { focused, tabs: [sender.tab] };
        }
      }
    });
    locked.worker.setIdleState('locked');
    await locked.capture();
    focused = true;
    locked.worker.setIdleState('active');
    assert.equal((await locked.offer()).count, elapsed < 5000 ? 1 : 0);
  }
});

test('a captured barcode without a lot remains available for review', async () => {
  const { worker, capture, offer } = resumeFixture('provider_single');
  await offer();
  worker.setIdleState('locked');
  await capture({ rawText: '0100123456789012' });
  worker.setIdleState('active');
  assert.equal((await offer()).count, 0);
  assert.equal(
    worker.storageData.get(PENDING_KEY)[0].reviewState,
    'missing_lot'
  );
  assert.equal(worker.storageData.has(MULTIPLE_KEY), false);
});

test('no Resume is offered without pre-lock evidence, after a form change, or after interruption', async () => {
  for (const scenario of [
    'no_witness',
    'changed_form',
    'interrupted',
    'long_range',
    'capture_failure'
  ]) {
    const { worker, reply, capture, offer } = resumeFixture('provider_single', {
      storage: { [STATUS_KEY]: { state: 'connected' } },
      failStorageSet: (values) =>
        scenario === 'capture_failure' && values[MULTIPLE_KEY]?.length === 2
    });
    if (scenario !== 'no_witness') await offer();
    worker.setIdleState('locked');
    await capture(
      scenario === 'long_range'
        ? { device: { profileId: LONG_RANGE_PROFILE_ID } }
        : {}
    );
    if (scenario === 'changed_form')
      reply.anchor = '91591bb4-6fd7-4edb-9b83-e70b0e107345';
    if (scenario === 'capture_failure')
      assert.equal((await capture()).success, false);
    if (scenario === 'interrupted') {
      await worker.sendMessage({
        target: 'scannerDaemonBackground',
        action: 'scannerDaemon.statusUpdate',
        status: { state: 'recovering' }
      });
    }
    worker.setIdleState('active');
    assert.equal((await offer()).count, 0, scenario);
    assert.equal(worker.storageData.get(MULTIPLE_KEY).length, 1, scenario);
    assert.equal(worker.storageData.has(PENDING_KEY), false, scenario);
  }
});
