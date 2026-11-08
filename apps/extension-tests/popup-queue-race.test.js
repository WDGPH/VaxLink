/**
 * Popup/background write race on multiple_inject_queue_v1.
 *
 * The popup's ScanQueueManager keeps an in-memory copy of the queue and used
 * to persist the whole array from that copy. With the popup open during
 * hands-free scanning, a scan appended by the background worker between the
 * popup's last sync and its next mutation was silently clobbered (or a
 * removal resurrected rows). Mutations now use the serialized background writer.
 *
 * The chrome mock here deliberately does NOT fire onChanged, simulating the
 * stale-popup window where the sync hasn't arrived yet.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

const QUEUE_KEY = 'multiple_inject_queue_v1';
const popupSender = {
  id: 'vaxlink-test',
  url: 'chrome-extension://vaxlink-test/popup.html'
};

function installBrowserGlobals() {
  const harness = createBackgroundHarness(makeTestNvcBundle());
  const store = harness.storageData;
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message, cb) => {
        void harness.sendMessage(message, popupSender).then(cb);
      }
    },
    storage: {
      onChanged: { addListener() {} },
      local: {
        get(keys, cb) {
          const result = {};
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) if (store.has(k)) result[k] = store.get(k);
          cb(result);
        },
        set(values, cb) {
          for (const [k, v] of Object.entries(values)) store.set(k, v);
          cb();
        }
      }
    }
  };
  return store;
}

const store = installBrowserGlobals();
const { ScanQueueManager } = await import('../extension/popup-inventory.js');

function makeManager() {
  return new ScanQueueManager({
    storageKey: QUEUE_KEY,
    summaryEl: null,
    listEl: null,
    clearButton: null
  });
}

function row(id, extra = {}) {
  return { id, tradename: `Vaccine-${id}`, lot: `LOT-${id}`, ...extra };
}

test('a background append during a popup remove is not clobbered', async () => {
  store.set(QUEUE_KEY, [row('a'), row('b')]);
  const manager = makeManager();
  await manager.load();

  // Hands-free scan lands via the background worker; popup hasn't synced.
  store.set(QUEUE_KEY, [row('a'), row('b'), row('scan-c')]);

  await manager.remove('a');

  const stored = Array.from(store.get(QUEUE_KEY), (r) => r.id);
  assert.deepEqual(
    stored,
    ['b', 'scan-c'],
    'remove must keep the concurrently appended scan'
  );
});

test('a popup add does not resurrect rows removed elsewhere', async () => {
  store.set(QUEUE_KEY, [row('a'), row('b')]);
  const manager = makeManager();
  await manager.load();

  // Another context (HUD remove / queue drain) deleted row b.
  store.set(QUEUE_KEY, [row('a')]);

  await manager.add(row('popup-d'));

  const stored = Array.from(store.get(QUEUE_KEY), (r) => r.id);
  assert.deepEqual(
    stored,
    ['a', 'popup-d'],
    'add must not bring back the deleted row'
  );
});

test('updateById patches the freshest copy of the row', async () => {
  store.set(QUEUE_KEY, [row('a', { total_doses: 5, remaining_doses: 5 })]);
  const manager = makeManager();
  await manager.load();

  // Queue drain consumed a dose in another context.
  store.set(QUEUE_KEY, [row('a', { total_doses: 5, remaining_doses: 4 })]);

  const updated = await manager.updateById('a', { dose_tracking: 'manual' });
  assert.equal(
    updated.remaining_doses,
    4,
    'patch must apply on the stored row, not the stale copy'
  );
});

test('consumption uses the latest dose count and preserves concurrent appends', async () => {
  store.set(QUEUE_KEY, [row('vial', { total_doses: 10, remaining_doses: 10 })]);
  const manager = makeManager();
  await manager.load();

  // Another consumer used a dose and a scanner appended a row before this use.
  store.set(QUEUE_KEY, [
    row('vial', { total_doses: 10, remaining_doses: 9 }),
    row('scan-e')
  ]);
  const consumed = await manager.consumeById('vial');
  assert.equal(consumed.remaining_doses, 8);
  assert.equal(store.get(QUEUE_KEY)[0].remaining_doses, 8);
  assert.deepEqual(
    Array.from(store.get(QUEUE_KEY), (r) => r.id),
    ['vial', 'scan-e']
  );
});

test('consumeById removes the row when the FRESH count says last dose', async () => {
  store.set(QUEUE_KEY, [row('vial', { total_doses: 10, remaining_doses: 5 })]);
  const manager = makeManager();
  await manager.load();

  // Concurrent consumption drained it to the last dose.
  store.set(QUEUE_KEY, [row('vial', { total_doses: 10, remaining_doses: 1 })]);

  const consumed = await manager.consumeById('vial');
  assert.equal(consumed, null, 'last dose consumed — row must be removed');
  assert.deepEqual(store.get(QUEUE_KEY), []);
});

test('background append waits for an in-flight queue removal', async () => {
  let release;
  let started;
  const pending = new Promise((resolve) => {
    started = resolve;
  });
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    storage: { [QUEUE_KEY]: [row('a')] },
    delayStorageSet(values, resume) {
      if (!(QUEUE_KEY in values) || release) return false;
      release = resume;
      started();
      return true;
    }
  });
  const remove = harness.sendMessage(
    {
      action: 'mutateQueue',
      storageKey: QUEUE_KEY,
      operation: 'remove',
      payload: { id: 'a' }
    },
    popupSender
  );
  await pending;
  const append = harness.sendMessage({
    action: 'appendQueueRecord',
    storageKey: QUEUE_KEY,
    record: row('new')
  });
  release();
  assert.equal((await remove).success, true);
  assert.equal((await append).success, true);
  assert.deepEqual(
    Array.from(harness.storageData.get(QUEUE_KEY), (item) => item.id),
    ['new']
  );
});

test('consuming a duplicate ID changes only the first matching record', async () => {
  const first = row('duplicate', { lot: 'first', remaining_doses: 3 });
  const second = row('duplicate', { lot: 'second', remaining_doses: 1 });
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    storage: { [QUEUE_KEY]: [first, second] }
  });
  const result = await harness.sendMessage(
    {
      action: 'mutateQueue',
      storageKey: QUEUE_KEY,
      operation: 'consume',
      payload: { id: 'duplicate' }
    },
    popupSender
  );
  assert.equal(result.success, true);
  assert.equal(result.consumed.lot, 'first');
  const saved = harness.storageData.get(QUEUE_KEY);
  assert.equal(saved.length, 2);
  assert.equal(saved[0].remaining_doses, 2);
  assert.deepEqual(saved[1], second);
});

test('queue mutations require an authorized sender and a valid payload', async () => {
  const url =
    'https://panorama.prod.ehealthontario.ca/ImmsWeb/pages/recordImms/form';
  const chartSender = {
    id: 'vaxlink-test',
    frameId: 0,
    url,
    tab: { id: 44, url }
  };
  const original = [row('saved')];
  const harness = createBackgroundHarness(makeTestNvcBundle());
  for (const [sender, operation, payload, accepted] of [
    [{ ...popupSender, id: 'another-extension' }, 'clear', {}, false],
    [{ id: 'vaxlink-test' }, 'clear', {}, false],
    [
      {
        ...popupSender,
        url: 'chrome-extension://vaxlink-test/scanner-setup.html'
      },
      'clear',
      {},
      false
    ],
    [{ ...chartSender, frameId: 1 }, 'clear', {}, false],
    [{ ...chartSender, url: 'https://example.org/chart' }, 'clear', {}, false],
    [
      { ...chartSender, tab: { id: 44, url: 'https://example.org/chart' } },
      'clear',
      {},
      false
    ],
    [popupSender, 'add', {}, false],
    [popupSender, 'consume', {}, false],
    [popupSender, 'update', { id: 'saved', patch: { id: 'another' } }, false],
    // A valid request must still work after a rejected mutation.
    [popupSender, 'clear', {}, true],
    [chartSender, 'clear', {}, true]
  ]) {
    harness.storageData.set(QUEUE_KEY, original);
    const result = await harness.sendMessage(
      {
        action: 'mutateQueue',
        storageKey: QUEUE_KEY,
        operation,
        payload
      },
      sender
    );
    assert.equal(result.success, accepted);
    const saved = harness.storageData.get(QUEUE_KEY);
    if (accepted) assert.equal(saved.length, 0);
    else assert.equal(saved, original);
  }
});
