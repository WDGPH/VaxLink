/**
 * Multiple Inject <-> Inventory move.
 *
 * Nurses scanning a batch of vaccines for several kids sometimes end up with
 * leftover vaccines that don't match any chart open today. Previously the
 * only queue exits were "Use for Chart" (consumes) or "Remove" (deletes for
 * good) - there was no way to park a leftover scan without losing it, or to
 * pull a parked scan back out for a different kid later. moveQueueRecord
 * transfers a record between the two ScanQueueManager-backed storage keys
 * without touching any other field (lot, dose counts, expiry).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

const MULTIPLE_KEY = 'multiple_inject_queue_v1';
const INVENTORY_KEY = 'inventory_scan_batch_v1';

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
const { ScanQueueManager, moveQueueRecord } = await import('../extension/popup-inventory.js');

function makeManager(storageKey) {
  return new ScanQueueManager({ storageKey, summaryEl: null, listEl: null, clearButton: null });
}

function row(id, extra = {}) {
  return { id, tradename: `Vaccine-${id}`, lot: `LOT-${id}`, ...extra };
}

test('moveQueueRecord transfers a record from Multiple to Inventory unchanged', async () => {
  store.set(MULTIPLE_KEY, [row('a'), row('leftover', { total_doses: 5, remaining_doses: 3 })]);
  store.set(INVENTORY_KEY, []);
  const multiple = makeManager(MULTIPLE_KEY);
  const inventory = makeManager(INVENTORY_KEY);
  await multiple.load();
  await inventory.load();

  const moved = await moveQueueRecord(multiple, inventory, 'leftover');

  assert.equal(moved.id, 'leftover');
  assert.deepEqual(store.get(MULTIPLE_KEY).map((r) => r.id), ['a']);
  assert.deepEqual(store.get(INVENTORY_KEY).map((r) => r.id), ['leftover']);
  assert.equal(store.get(INVENTORY_KEY)[0].remaining_doses, 3, 'dose count must survive the move');
});

test('moveQueueRecord can send a record back from Inventory to Multiple', async () => {
  store.set(MULTIPLE_KEY, []);
  store.set(INVENTORY_KEY, [row('parked')]);
  const multiple = makeManager(MULTIPLE_KEY);
  const inventory = makeManager(INVENTORY_KEY);
  await multiple.load();
  await inventory.load();

  const moved = await moveQueueRecord(inventory, multiple, 'parked');

  assert.equal(moved.id, 'parked');
  assert.deepEqual(store.get(INVENTORY_KEY), []);
  assert.deepEqual(store.get(MULTIPLE_KEY).map((r) => r.id), ['parked']);
});

test('moveQueueRecord is a no-op when the id is not found in the source', async () => {
  store.set(MULTIPLE_KEY, [row('a')]);
  store.set(INVENTORY_KEY, [row('b')]);
  const multiple = makeManager(MULTIPLE_KEY);
  const inventory = makeManager(INVENTORY_KEY);
  await multiple.load();
  await inventory.load();

  const moved = await moveQueueRecord(multiple, inventory, 'missing');

  assert.equal(moved, null);
  assert.deepEqual(store.get(MULTIPLE_KEY).map((r) => r.id), ['a']);
  assert.deepEqual(store.get(INVENTORY_KEY).map((r) => r.id), ['b']);
});

test('a concurrent background append to the source is not clobbered by a move', async () => {
  store.set(MULTIPLE_KEY, [row('a'), row('b')]);
  store.set(INVENTORY_KEY, []);
  const multiple = makeManager(MULTIPLE_KEY);
  const inventory = makeManager(INVENTORY_KEY);
  await multiple.load();
  await inventory.load();

  // Hands-free scan lands via the background worker between load() and the move.
  store.set(MULTIPLE_KEY, [row('a'), row('b'), row('scan-c')]);

  await moveQueueRecord(multiple, inventory, 'a');

  assert.deepEqual(store.get(MULTIPLE_KEY).map((r) => r.id), ['b', 'scan-c']);
  assert.deepEqual(store.get(INVENTORY_KEY).map((r) => r.id), ['a']);
});
