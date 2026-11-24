/**
 * Analytics events must bucket by LOCAL calendar day. Ontario evening clinics
 * run past 20:00 EDT = 00:00 UTC; UTC bucketing split one clinic day into two
 * and mis-scoped the "today" export filter (which compares the same key).
 */

// Must be set before anything constructs a Date so the harness sees the zone.
process.env.TZ = 'America/Toronto';

import assert from 'node:assert/strict';
import test from 'node:test';
import '../extension/shared/vaccine-label.js';

import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

const ANALYTICS_KEY = 'vaxlink_analytics_v1';

test('analytics events bucket by local calendar day, not UTC', async () => {
  const harness = createBackgroundHarness(makeTestNvcBundle());

  // 2026-06-12T01:30Z is 21:30 EDT on 2026-06-11 — an evening-clinic event.
  const response = await harness.sendMessage({
    action: 'logAnalyticsEvent',
    eventType: 'scan_captured',
    payload: { workflow: 'multiple', ts: '2026-06-12T01:30:00.000Z' }
  });
  assert.equal(response.success, true);

  const analytics = harness.storageData.get(ANALYTICS_KEY);
  assert.ok(analytics, 'analytics store must exist');
  assert.equal(
    analytics.days['2026-06-11']?.workflows.multiple.liveScans,
    1,
    'evening-EDT event must bucket into the local day, not the next UTC day'
  );
  assert.equal(analytics.recentEvents, undefined);
  assert.equal(
    analytics.days['2026-06-12'],
    undefined,
    'no spillover UTC day bucket'
  );
});

test('a malformed ts falls back to today instead of throwing', async () => {
  const harness = createBackgroundHarness(makeTestNvcBundle());
  const response = await harness.sendMessage({
    action: 'logAnalyticsEvent',
    eventType: 'scan_captured',
    payload: { workflow: 'multiple', ts: 'not-a-date' }
  });
  assert.equal(
    response.success,
    true,
    'invalid ts must not crash the analytics writer'
  );
});

test('simultaneous first use and export share the saved Activity identity', async () => {
  const initializing = Promise.withResolvers();
  const writes = [];
  let resumeInitialization;
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    delayStorageSet(values, resume) {
      if (!values[ANALYTICS_KEY]) return false;
      if (!resumeInitialization) {
        resumeInitialization = resume;
        initializing.resolve();
        return true;
      }
      writes.push(values[ANALYTICS_KEY].lastExportAt);
      return false;
    }
  });
  const first = harness.sendMessage({ action: 'getAnalyticsSummary' });
  await initializing.promise;
  const second = harness.sendMessage({ action: 'getAnalyticsSummary' });
  const exporting = harness.sendMessage({ action: 'getAnalyticsExport' });
  resumeInitialization();

  const { deviceId, firstSeenAt } = (await first).summary;
  assert.ok(deviceId && firstSeenAt);
  const exported = (await exporting).data;
  for (const snapshot of [(await second).summary, exported]) {
    assert.equal(snapshot.deviceId, deviceId);
    assert.equal(snapshot.firstSeenAt, firstSeenAt);
  }
  assert.equal(harness.storageData.get(ANALYTICS_KEY).deviceId, deviceId);
  assert.deepEqual(writes, [null, exported.exportedAt]);
});

test('an Activity reset and export wait for an earlier delayed count', async () => {
  const counting = Promise.withResolvers();
  let resumeCount;
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    delayStorageSet(values, resume) {
      if (!values[ANALYTICS_KEY] || resumeCount) return false;
      resumeCount = resume;
      counting.resolve(values[ANALYTICS_KEY].deviceId);
      return true;
    }
  });
  const count = harness.sendMessage({
    action: 'logAnalyticsEvent',
    eventType: 'inventory_export',
    payload: { rows: 2 }
  });
  const oldDeviceId = await counting.promise;
  const beforeReset = harness.sendMessage({ action: 'getAnalyticsExport' });
  const reset = harness.sendMessage({ action: 'resetAnalyticsStore' });
  const afterReset = harness.sendMessage({ action: 'getAnalyticsExport' });
  resumeCount();

  assert.equal((await count).success, true);
  const before = (await beforeReset).data;
  assert.equal(before.deviceId, oldDeviceId);
  assert.equal(before.rollup.exports.inventoryRows, 2);
  const resetSummary = (await reset).summary;
  assert.equal(resetSummary.lastExportAt, null);
  const after = (await afterReset).data;
  assert.equal(after.deviceId, resetSummary.deviceId);
  assert.equal(after.daysTracked, 0);
  assert.equal(after.rollup.exports.inventoryCount, 0);
  assert.equal(after.rollup.expiry.noticesShown, null);
  assert.equal(
    harness.storageData.get(ANALYTICS_KEY).lastExportAt,
    after.exportedAt
  );
});

test('Activity accepts older product names and skips barcode identifiers used as display names', () => {
  const label = globalThis.vaxlinkVaccineLabel;
  for (const field of ['lot', 'gtin', 'din', 'drug_code']) {
    assert.equal(label({ name: 'IDENTIFIER', [field]: 'identifier' }), '');
  }
  assert.equal(
    label({ name: 'Legacy vaccine name', lot: 'TRAIN-01' }),
    'Legacy vaccine name'
  );
  assert.equal(
    label({ name: 'TRAIN-01', lot: 'TRAIN-01', tradename: 'Trade name' }),
    'Trade name'
  );
});
