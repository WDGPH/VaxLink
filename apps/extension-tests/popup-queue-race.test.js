/**
 * Popup/background write race on multiple_inject_queue_v1.
 *
 * The popup's ScanQueueManager keeps an in-memory copy of the queue and used
 * to persist the whole array from that copy. With the popup open during
 * hands-free scanning, a scan appended by the background worker between the
 * popup's last sync and its next mutation was silently clobbered (or a
 * removal resurrected rows). Mutations now re-read storage first.
 *
 * The chrome mock here deliberately does NOT fire onChanged, simulating the
 * stale-popup window where the sync hasn't arrived yet.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

const QUEUE_KEY = 'multiple_inject_queue_v1';

function installBrowserGlobals() {
  const store = new Map();
  globalThis.chrome = {
    runtime: { lastError: null },
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

  const stored = store.get(QUEUE_KEY).map((r) => r.id);
  assert.deepEqual(stored, ['b', 'scan-c'], 'remove must keep the concurrently appended scan');
});

test('a popup add does not resurrect rows removed elsewhere', async () => {
  store.set(QUEUE_KEY, [row('a'), row('b')]);
  const manager = makeManager();
  await manager.load();

  // Another context (HUD remove / queue drain) deleted row b.
  store.set(QUEUE_KEY, [row('a')]);

  await manager.add(row('popup-d'));

  const stored = store.get(QUEUE_KEY).map((r) => r.id);
  assert.deepEqual(stored, ['a', 'popup-d'], 'add must not bring back the deleted row');
});

test('updateById patches the freshest copy of the row', async () => {
  store.set(QUEUE_KEY, [row('a', { total_doses: 5, remaining_doses: 5 })]);
  const manager = makeManager();
  await manager.load();

  // Queue drain consumed a dose in another context.
  store.set(QUEUE_KEY, [row('a', { total_doses: 5, remaining_doses: 4 })]);

  const updated = await manager.updateById('a', { dose_tracking: 'manual' });
  assert.equal(updated.remaining_doses, 4, 'patch must apply on the stored row, not the stale copy');
});

test('consumeById decrements doses without losing concurrent appends', async () => {
  store.set(QUEUE_KEY, [row('vial', { total_doses: 10, remaining_doses: 10 })]);
  const manager = makeManager();
  await manager.load();

  store.set(QUEUE_KEY, [row('vial', { total_doses: 10, remaining_doses: 10 }), row('scan-e')]);

  const consumed = await manager.consumeById('vial');
  assert.equal(consumed.remaining_doses, 9);
  const stored = store.get(QUEUE_KEY).map((r) => r.id);
  assert.deepEqual(stored, ['vial', 'scan-e']);
});
