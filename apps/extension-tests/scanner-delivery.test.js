import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

const inbox = 'vaxlink_pending_scan_inbox_v1';
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
const capture = (h, rawText) =>
  h.sendMessage({ action: 'scannerScanCaptured', scan: row(rawText) });
const options = (extra = {}) => ({
  tabs: [tab],
  storage: { vaxlink_workflow_mode_v1: 'single' },
  tabResponse: {
    supported: true,
    contextToken: 'document-1',
    accepted: true,
    success: true
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
  assert.equal(h.storageData.get(inbox).length, 0);
});

test('unavailable, unsupported, or unacknowledged destinations retain scans', async () => {
  for (const extra of [
    { tabs: [] },
    { tabResponse: { supported: false } },
    {
      tabResponse: {
        supported: true,
        contextToken: 'document-1',
        success: true
      }
    },
    {
      tabResponse: {
        supported: true,
        contextToken: 'document-1',
        accepted: true
      }
    }
  ]) {
    const h = harness(extra);
    await capture(h, 'held');
    assert.equal(h.storageData.get(inbox).length, 1);
    assert.equal(h.storageData.get(inbox)[0].rawText, 'held');
    if (extra.tabResponse?.supported === false)
      assert.equal(h.tabMessages.length, 1);
  }
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
  const h = harness({ tabs: [] });
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

test('delivery stays pinned to the tab active at capture', async () => {
  const save = gate();
  let held = false;
  const tabs = [{ ...tab }, { ...tab, id: 45, active: false }];
  const h = harness({
    tabs,
    delayStorageSet(values, resume) {
      if (inbox in values && !held) {
        held = true;
        save.hold(resume);
        return true;
      }
      return false;
    }
  });
  const result = capture(h, 'pinned');
  await save.started;
  tabs[0].active = false;
  tabs[1].active = true;
  save.release();
  await result;
  assert.equal(
    h.tabMessages.find(
      ({ message }) => message.action === 'vaxlinkScanCaptured'
    ).tabId,
    44
  );
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

test('a same-tab chart change during workflow reads cannot select a new context', async () => {
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
        !keys.includes('vaxlink_workflow_mode_v1')
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
