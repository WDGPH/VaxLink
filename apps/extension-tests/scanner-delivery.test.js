import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';
import { LONG_RANGE_PROFILE_ID } from '../extension/scanner/scanner-daemon-shared.js';

const inbox = 'vaxlink_pending_scan_inbox_v1';
const workflowKey = 'vaxlink_workflow_mode_v1';
const immunizationTray = 'multiple_inject_queue_v1';
const inventoryTray = 'inventory_scan_batch_v1';
const tab = {
  id: 44,
  active: true,
  url: 'https://panorama.prod.ehealthontario.ca/phsdsm/ImmsWeb/pages/recordImms/recordImms.xhtml'
};
const popup = {
  id: 'vaxlink-test',
  url: 'chrome-extension://vaxlink-test/popup.html'
};
const row = (rawText) => ({
  rawText,
  source: 'web-serial',
  capturedAt: '2026-07-28T12:00:00.000Z'
});
const capture = (h, rawText) => h.captureScannerScan(row(rawText));
const captureLongRange = (h, rawText, capturedAt = row(rawText).capturedAt) =>
  h.captureScannerScan({
    ...row(rawText),
    capturedAt,
    device: { profileId: LONG_RANGE_PROFILE_ID }
  });
const options = (extra = {}) => ({
  tabs: [tab],
  storage: { vaxlink_workflow_mode_v1: 'single' },
  tabResponse: {
    supported: true,
    contextToken: 'document-1',
    accepted: true,
    success: true,
    status: 'missing_lot'
  },
  ...extra
});
const harness = (extra) =>
  createBackgroundHarness(makeTestNvcBundle(), options(extra));

function gate() {
  let release;
  let start;
  return {
    started: new Promise((resolve) => {
      start = resolve;
    }),
    hold(resume) {
      release = resume;
      start();
    },
    release() {
      release();
    }
  };
}

test('single capture is saved before delivery and binds delivery to the captured context', async () => {
  const save = gate();
  let held = false;
  const h = harness({
    delayStorageSet(values, resume) {
      if (inbox in values && !held) {
        held = true;
        save.hold(resume);
        return true;
      }
      return false;
    }
  });
  const result = capture(h, 'first');
  await save.started;
  assert.equal(
    h.tabMessages.some(
      ({ message }) => message.action === 'vaxlinkScanCaptured'
    ),
    false
  );
  save.release();
  await result;
  assert.deepEqual(
    h.tabMessages.map(({ message }) => message.action),
    ['getPanoramaIntegration', 'vaxlinkScanCaptured']
  );
  assert.equal(h.tabMessages[1].tabId, tab.id);
  assert.equal(h.tabMessages[1].message.contextToken, 'document-1');
  assert.ok(h.tabMessages[1].message.scannerRoute.startBy > Date.now());
  assert.equal(h.storageData.get(inbox).length, 0);
});

test('unacknowledged chart attempts retain their scan', async () => {
  for (const tabResponse of [
    { supported: true, contextToken: 'document-1', success: true },
    { supported: true, contextToken: 'document-1', accepted: true }
  ]) {
    const h = harness({ tabResponse });
    await capture(h, 'held');
    assert.equal(h.storageData.get(inbox)[0].rawText, 'held');
  }
});

test('disabled, unidentified and unready forms save to the Immunization tray', async () => {
  for (const overrides of [
    { tabs: [] },
    { storage: { vaxlink_single_scan_autofill_v1: false } },
    { tabResponse: { supported: false } },
    {
      tabResponse: {
        supported: true,
        contextToken: 'document-1',
        formContext: { kind: 'provider_single', ready: false }
      }
    }
  ]) {
    const h = harness(overrides);
    const result = await capture(h, '(10)TESTLOT');
    assert.equal(result.workflow, 'immunization');
    assert.equal(result.queuedToWorkflow, true);
    assert.equal(h.storageData.get('multiple_inject_queue_v1').length, 1);
    assert.equal(h.storageData.has(inbox), false);
    assert.ok(
      h.tabMessages.every(
        ({ message }) => message.action !== 'vaxlinkScanCaptured'
      )
    );
  }
});

test('a grid receives only the new saved row when automatic grid entry is enabled', async () => {
  for (const enabled of [false, true]) {
    const key = 'multiple_inject_queue_v1';
    const h = harness({
      storage: {
        [key]: [{ id: 'older', lot: 'OLDLOT' }],
        vaxlink_grid_scan_autofill_v1: enabled
      },
      tabResponse: {
        supported: true,
        contextToken: 'grid-document',
        formContext: { kind: 'multiple_grid', ready: true },
        status: 'grid_added'
      }
    });
    const result = await capture(h, '(10)TESTLOT');
    const rows = h.storageData.get(key);
    const writes = h.tabMessages.filter(
      ({ message }) => message.action === 'vaxlinkGridScanCaptured'
    );
    assert.equal(rows.length, 2);
    assert.equal(result.queuedToWorkflow, true);
    assert.equal(result.routed, enabled);
    assert.equal(writes.length, Number(enabled));
    if (enabled) assert.equal(writes[0].message.recordId, rows[1].id);
  }
});

test('long-range frames bypass ready Single and Multiple forms and keep repeated scans in receipt order', async () => {
  for (const kind of ['provider_single', 'multiple_grid']) {
    const h = harness({
      tabResponse: {
        supported: true,
        contextToken: 'ready-chart',
        formContext: { kind, ready: true }
      }
    });
    const results = await Promise.all([
      captureLongRange(h, '10TESTLOT'),
      captureLongRange(h, '10TESTLOT'),
      // A clock change must not reorder frames in an upload.
      captureLongRange(h, '10OTHER', '2026-07-28T11:59:59.000Z')
    ]);
    assert.ok(results.every((result) => result.queuedToWorkflow));
    const rows = h.storageData.get(immunizationTray);
    assert.deepEqual(
      Array.from(rows, ({ lot }) => lot),
      ['TESTLOT', 'TESTLOT', 'OTHER']
    );
    assert.equal(new Set(Array.from(rows, ({ id }) => id)).size, 3);
    assert.equal(rows[2].scanned_at, '2026-07-28T11:59:59.000Z');
    assert.deepEqual(h.tabMessages, []);
  }
});

test('workflow commands select the following frames while earlier tray writes wait', async () => {
  const save = gate();
  let blocked = false;
  const h = harness({
    tabs: [],
    delayStorageSet(values, resume) {
      if (blocked || !(immunizationTray in values)) return false;
      blocked = true;
      save.hold(resume);
      return true;
    }
  });
  const first = captureLongRange(h, '10BEFORE');
  await save.started;
  const earlier = captureLongRange(h, '10EARLIER');
  const inventory = captureLongRange(h, ' VaxLink: INVENTORY ');
  const middle = captureLongRange(h, '10BETWEEN');
  const immunization = capture(h, 'VAXLINK:MULTIPLE');
  const ignored = captureLongRange(h, 'VAXLINK:UNKNOWN');
  const last = captureLongRange(h, '10AFTER');
  try {
    assert.equal((await inventory).workflow, 'inventory');
    assert.equal((await immunization).workflow, 'immunization');
    assert.equal((await ignored).commandHandled, true);
    assert.equal(h.storageData.get(workflowKey), 'immunization');
  } finally {
    save.release();
  }
  await Promise.all([first, earlier, middle, last]);
  assert.deepEqual(
    Array.from(h.storageData.get(immunizationTray), ({ lot }) => lot),
    ['BEFORE', 'EARLIER', 'AFTER']
  );
  assert.deepEqual(
    Array.from(h.storageData.get(inventoryTray), ({ lot }) => lot),
    ['BETWEEN']
  );
  assert.equal(h.storageData.has(inbox), false);
});

test('long-range rejections stay visible in held scans and expired stock stays flagged in Inventory', async () => {
  const h = harness({ tabs: [] });
  const expiredBarcode = '1720010110EXPIRED';
  const charts = await captureLongRange(h, expiredBarcode);
  assert.equal(charts.response?.status, 'expired');
  assert.equal(h.storageData.has(immunizationTray), false);

  await captureLongRange(h, 'VAXLINK:INVENTORY');
  const garbage = await captureLongRange(h, 'not a vaccine barcode');
  const noLot = await captureLongRange(h, '0100123456789012');
  const inventory = await captureLongRange(h, expiredBarcode);
  assert.equal(garbage.response?.status, 'parse_error');
  assert.equal(noLot.response?.status, 'missing_lot');
  assert.equal(inventory.queuedToWorkflow, true);
  assert.equal(h.storageData.get(inventoryTray)[0].expiry_flag, 'expired');
  assert.deepEqual(
    Array.from(h.storageData.get(inbox), ({ reviewState }) => reviewState),
    ['expired', 'parse_error', 'missing_lot']
  );
});

test('long-range scans keep locked Inventory rows and held Immunization captures distinct', async () => {
  const h = harness({ idleState: 'locked' });
  await captureLongRange(h, '10IMMLOT');
  await captureLongRange(h, 'VAXLINK:INVENTORY');
  await captureLongRange(h, '10INVLOT');
  assert.equal(h.storageData.has(immunizationTray), false);
  const held = h.storageData.get(inbox)[0];
  const saved = h.storageData.get(inventoryTray)[0];
  assert.equal(held.pending_workflow, 'immunization');
  assert.equal(held.captured_while_locked, true);
  assert.equal(saved.captured_while_locked, true);
  assert.equal(saved.lock_session_id, held.lock_session_id);
});

test('held scans are not replayed on startup, unlock, or a drain request', async () => {
  const h = harness({
    idleState: 'locked',
    storage: { vaxlink_workflow_mode_v1: 'single', [inbox]: [row('old')] }
  });
  h.startup();
  h.setIdleState('active');
  await h.sendMessage(
    { action: 'drainPendingScannerScans' },
    { id: 'vaxlink-test', tab, frameId: 0, url: tab.url }
  );
  assert.equal(h.tabMessages.length, 0);
  assert.equal(h.storageData.get(inbox)[0].rawText, 'old');
});

test('a delayed delivery does not block capture and only its own row is removed', async () => {
  const delivery = gate();
  let held = false;
  const h = harness({
    delayTabMessage(_id, message, resume) {
      if (message.action === 'vaxlinkScanCaptured' && !held) {
        held = true;
        delivery.hold(resume);
        return true;
      }
      return false;
    }
  });
  const first = capture(h, 'first');
  await delivery.started;
  await capture(h, 'second');
  const pending = h.storageData.get(inbox);
  assert.deepEqual(
    Array.from(pending, (item) => item.rawText),
    ['first']
  );
  assert.ok(pending[0].captureId);
  delivery.release();
  await first;
  assert.equal(h.storageData.get(inbox).length, 0);
});

test('failed removal after acknowledgement retains the captured scan', async () => {
  const h = harness({
    failStorageSet: (values) =>
      Array.isArray(values[inbox]) && values[inbox].length === 0
  });
  await capture(h, 'held');
  assert.equal(h.storageData.get(inbox)[0].rawText, 'held');
});

test('only the popup can inspect or discard a held scan', async () => {
  const h = harness({ tabs: [], idleState: 'unknown' });
  await capture(h, 'held');
  const listed = await h.sendMessage({ action: 'getHeldScannerScans' }, popup);
  assert.equal(listed.success, true);
  assert.equal(listed.scans[0].rawText, 'held');
  const request = { action: 'discardHeldScannerScan', scan: listed.scans[0] };
  const untrusted = { id: 'vaxlink-test', tab, url: tab.url };
  assert.notEqual(
    (await h.sendMessage({ action: 'getHeldScannerScans' }, untrusted))
      ?.success,
    true
  );
  assert.notEqual((await h.sendMessage(request, untrusted))?.success, true);
  assert.equal(h.storageData.get(inbox).length, 1);
  assert.equal((await h.sendMessage(request, popup)).success, true);
  assert.equal(h.storageData.get(inbox).length, 0);
});

test('a timed-out delivery remains held even if its callback arrives late', async () => {
  const delivery = gate();
  let timeout;
  const h = harness({
    setTimeout(fn, ms, ...args) {
      if (ms === 10000) {
        timeout = () => fn(...args);
        return 1;
      }
      return setTimeout(fn, ms, ...args);
    },
    delayTabMessage(_id, message, resume) {
      if (message.action !== 'vaxlinkScanCaptured') return false;
      delivery.hold(resume);
      return true;
    }
  });
  const result = capture(h, 'uncertain');
  await delivery.started;
  timeout();
  await result;
  assert.equal(h.storageData.get(inbox)[0].rawText, 'uncertain');
  delivery.release();
  await Promise.resolve();
  assert.equal(h.storageData.get(inbox)[0].rawText, 'uncertain');
});

test('failed initial persistence never sends the scan', async () => {
  const h = harness({ failStorageSet: (values) => inbox in values });
  assert.equal((await capture(h, 'unsaved')).success, false);
  assert.equal(
    h.tabMessages.some(
      ({ message }) => message.action === 'vaxlinkScanCaptured'
    ),
    false
  );
});

test('delivery stays held when the original tab loses focus, even if staff return', async () => {
  for (const returnToOriginal of [false, true]) {
    const save = gate();
    let held = false;
    const tabs = [{ ...tab }, { ...tab, id: 45, active: false }];
    const h = harness({
      tabs,
      delayStorageSet(values, resume) {
        if (!(inbox in values) || held) return false;
        held = true;
        save.hold(resume);
        return true;
      }
    });
    const result = capture(h, 'pinned');
    await save.started;
    h.activateTab(45);
    if (returnToOriginal) h.activateTab(44);
    save.release();
    await result;
    assert.equal(h.tabMessages.length, 1);
    assert.equal(h.storageData.get(inbox)[0].intendedTabId, 44);
    assert.equal(h.storageData.get(inbox)[0].reviewState, 'inactive_chart');
  }
});

test('late acknowledgement cannot remove a newer identical capture', async () => {
  const delivery = gate();
  const tabs = [{ ...tab }];
  const h = harness({
    tabs,
    delayTabMessage(_id, message, resume) {
      if (message.action !== 'vaxlinkScanCaptured') return false;
      delivery.hold(resume);
      return true;
    }
  });
  const first = capture(h, 'same');
  await delivery.started;
  const old = h.storageData.get(inbox)[0];
  await h.sendMessage({ action: 'discardHeldScannerScan', scan: old }, popup);
  tabs[0].active = false;
  h.setIdleState('locked');
  await capture(h, 'same');
  const newer = h.storageData.get(inbox)[0];
  assert.notEqual(newer.captureId, old.captureId);
  delivery.release();
  await first;
  assert.equal(h.storageData.get(inbox)[0].captureId, newer.captureId);
});

test('discarding a legacy scan removes only one identical row', async () => {
  const legacy = row('legacy');
  const h = harness({
    tabs: [],
    storage: { [inbox]: [legacy, { ...legacy }] }
  });
  await h.sendMessage(
    { action: 'discardHeldScannerScan', scan: legacy },
    popup
  );
  assert.equal(h.storageData.get(inbox).length, 1);
});

test('a same-tab chart change during autofill setting reads cannot select a new context', async () => {
  const read = gate();
  let waiting = false;
  const response = {
    supported: true,
    contextToken: 'chart-A',
    accepted: true,
    success: true
  };
  const h = harness({
    tabResponse: response,
    delayStorageGet(keys, resume) {
      if (
        waiting ||
        !Array.isArray(keys) ||
        !keys.includes('vaxlink_single_scan_autofill_v1')
      )
        return false;
      waiting = true;
      read.hold(resume);
      return true;
    },
    delayTabMessage(_id, message) {
      if (message.action === 'vaxlinkScanCaptured') {
        response.accepted = message.contextToken === response.contextToken;
        response.success = response.accepted;
      }
      return false;
    }
  });
  const result = capture(h, 'chart-A scan');
  await read.started;
  response.contextToken = 'chart-B';
  read.release();
  await result;
  assert.equal(
    h.tabMessages.find(
      ({ message }) => message.action === 'vaxlinkScanCaptured'
    ).message.contextToken,
    'chart-A'
  );
  assert.equal(h.storageData.get(inbox)[0].rawText, 'chart-A scan');
});

test('only the hidden scanner host can submit a physical capture', async () => {
  const h = harness();
  const host = {
    id: 'vaxlink-test',
    url: 'chrome-extension://vaxlink-test/scanner-daemon.html'
  };
  for (const sender of [
    popup,
    { id: host.id, frameId: 0, tab, url: tab.url },
    { ...host, id: 'another-extension' }
  ]) {
    const response = await h.sendMessage(
      { action: 'scannerScanCaptured', scan: row('10TESTLOT') },
      sender
    );
    assert.equal(response.success, false);
  }
  assert.deepEqual(h.tabMessages, []);
  assert.equal(h.storageData.has(inbox), false);
});

test('a pending response clears and adds recent history only when the matching chart verifies', async () => {
  const delivery = gate();
  const sessionStorage = new Map();
  const recent = 'vaxlink_recent_chart_lots_v1';
  const h = harness({
    sessionStorage,
    tabResponse: {
      supported: true,
      contextToken: 'document-1',
      accepted: true,
      pending: true
    },
    delayTabMessage(_id, message, resume) {
      if (message.action !== 'vaxlinkScanCaptured') return false;
      delivery.hold(resume);
      return true;
    }
  });
  const sender = {
    id: 'vaxlink-test',
    tab,
    frameId: 0,
    url: tab.url,
    documentId: 'original-document'
  };
  const captured = capture(h, 'pending');
  await delivery.started;
  const { scan, contextToken, scannerRoute } = h.tabMessages[1].message;
  const claim = { captureId: scan.captureId, contextToken, scannerRoute };
  assert.equal(
    (await h.sendMessage({ action: 'checkScannerChart', ...claim }, sender))
      .success,
    true
  );
  const verification = {
    action: 'verifyScannerChartFields',
    ...claim,
    verified: true,
    vaccine: {
      tradename: 'Sample vaccine',
      lot: 'LOT1',
      barcode_expiry: '2099-01-01',
      raw_barcode: 'private fixture'
    }
  };
  delivery.release();
  assert.equal((await captured).queued, true);
  assert.equal(h.storageData.get(inbox)[0].reviewState, 'checking_chart');
  for (const [request, from] of [
    [verification, { ...sender, documentId: 'replacement' }],
    [{ ...verification, contextToken: 'old' }, sender],
    [
      {
        ...verification,
        scannerRoute: { ...scannerRoute, epoch: 'old-worker' }
      },
      sender
    ],
    [verification, { ...sender, frameId: 1 }]
  ]) {
    assert.equal((await h.sendMessage(request, from)).success, false);
    assert.equal(h.storageData.get(inbox).length, 1);
    assert.equal(sessionStorage.has(recent), false);
  }
  const copies = await Promise.all([
    h.sendMessage(verification, sender),
    h.sendMessage(verification, sender)
  ]);
  assert.equal(copies.filter((result) => result.success).length, 1);
  assert.equal(h.storageData.get(inbox).length, 0);
  assert.equal(sessionStorage.get(recent).length, 1);
  assert.equal(sessionStorage.get(recent)[0].lot, 'LOT1');
  assert.equal('raw_barcode' in sessionStorage.get(recent)[0], false);
});

test('an unavailable or unknown lock check and a stale chart keep the original scan held', async () => {
  for (const [overrides, reason] of [
    [{ idleError: 'Idle service unavailable' }, 'lock_unavailable'],
    [{ idleState: 'unknown' }, 'lock_unknown'],
    [
      {
        tabResponse: {
          supported: true,
          contextToken: 'document-1',
          buildAtLoad: { version: 'old' }
        }
      },
      'stale_chart'
    ]
  ]) {
    const h = harness(overrides);
    await capture(h, 'held');
    assert.equal(h.storageData.get(inbox)[0].reviewState, reason);
    assert.equal(h.tabMessages.length, 1);
  }
});
