/**
 * Issue #25: a hardware scanner can fire twice on one vial, silently queueing
 * the same vaccine twice in multiple-inject mode (clinic feedback: Pneum-C-15
 * queued twice, only noticed at the 'enter details' step).
 *
 * The guard lives in background.js appendQueueRecord: an identical scan
 * identity (raw barcode, else gtin+lot+serial) within 10 s of an existing
 * queue row is rejected with duplicate_ignored instead of being appended.
 * Inventory mode is exempt — repeated identical scans there are stock counts.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createBackgroundHarness } from './helpers/clinic-sim.js';

const MULTIPLE_KEY = 'multiple_inject_queue_v1';
const INVENTORY_KEY = 'inventory_scan_batch_v1';

const EMPTY_BUNDLE = { resourceType: 'Bundle', entry: [] };

function makeRecord(overrides = {}) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    scanned_at: new Date().toISOString(),
    raw_barcode: '0100123456789012101LOT123A',
    tradename: 'Prevnar 20',
    gtin: '00123456789012',
    lot: 'LOT123A',
    serial: '',
    expiry_flag: 'valid',
    ...overrides
  };
}

async function append(harness, storageKey, record) {
  const response = await harness.sendMessage({
    action: 'appendQueueRecord',
    storageKey,
    record
  });
  assert.equal(response.success, true, 'append message must succeed');
  return response.record;
}

test('double-fire of the same barcode within 10s is ignored in multiple mode', async () => {
  const harness = createBackgroundHarness(EMPTY_BUNDLE);
  const first = makeRecord();
  const firstResult = await append(harness, MULTIPLE_KEY, first);
  assert.equal(firstResult.duplicate_ignored, undefined);
  assert.equal(firstResult.queueSizeAfter, 1);

  const second = makeRecord({ scanned_at: new Date(Date.parse(first.scanned_at) + 1200).toISOString() });
  const secondResult = await append(harness, MULTIPLE_KEY, second);
  assert.equal(secondResult.duplicate_ignored, true, 'second scan must be flagged as duplicate');
  assert.equal(secondResult.duplicate_of, first.id);
  assert.equal(secondResult.queueSizeAfter, 1, 'queue must not grow');

  const rows = harness.storageData.get(MULTIPLE_KEY);
  assert.equal(rows.length, 1, 'only the first scan may be stored');
});

test('the same barcode scanned again outside the window is queued', async () => {
  const harness = createBackgroundHarness(EMPTY_BUNDLE);
  const first = makeRecord();
  await append(harness, MULTIPLE_KEY, first);

  const later = makeRecord({ scanned_at: new Date(Date.parse(first.scanned_at) + 30000).toISOString() });
  const result = await append(harness, MULTIPLE_KEY, later);
  assert.equal(result.duplicate_ignored, undefined, 'a deliberate later re-scan is legitimate');
  assert.equal(harness.storageData.get(MULTIPLE_KEY).length, 2);
});

test('gtin+lot identity catches duplicates when no raw barcode is present', async () => {
  const harness = createBackgroundHarness(EMPTY_BUNDLE);
  const first = makeRecord({ raw_barcode: '' });
  await append(harness, MULTIPLE_KEY, first);

  const second = makeRecord({
    raw_barcode: '',
    scanned_at: new Date(Date.parse(first.scanned_at) + 500).toISOString()
  });
  const result = await append(harness, MULTIPLE_KEY, second);
  assert.equal(result.duplicate_ignored, true);
  assert.equal(harness.storageData.get(MULTIPLE_KEY).length, 1);
});

test('different serial numbers are distinct physical units, not duplicates', async () => {
  const harness = createBackgroundHarness(EMPTY_BUNDLE);
  const first = makeRecord({ raw_barcode: '', serial: 'SER001' });
  await append(harness, MULTIPLE_KEY, first);

  const second = makeRecord({
    raw_barcode: '',
    serial: 'SER002',
    scanned_at: new Date(Date.parse(first.scanned_at) + 500).toISOString()
  });
  const result = await append(harness, MULTIPLE_KEY, second);
  assert.equal(result.duplicate_ignored, undefined);
  assert.equal(harness.storageData.get(MULTIPLE_KEY).length, 2);
});

test('inventory queue is exempt: identical scans are stock counts', async () => {
  const harness = createBackgroundHarness(EMPTY_BUNDLE);
  const first = makeRecord();
  await append(harness, INVENTORY_KEY, first);

  const second = makeRecord({ scanned_at: new Date(Date.parse(first.scanned_at) + 500).toISOString() });
  const result = await append(harness, INVENTORY_KEY, second);
  assert.equal(result.duplicate_ignored, undefined, 'inventory counting must allow identical scans');
  assert.equal(harness.storageData.get(INVENTORY_KEY).length, 2);
});
