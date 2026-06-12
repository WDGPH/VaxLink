/**
 * Analytics events must bucket by LOCAL calendar day. Ontario evening clinics
 * run past 20:00 EDT = 00:00 UTC; UTC bucketing split one clinic day into two
 * and mis-scoped the "today" export filter (which compares the same key).
 */

// Must be set before anything constructs a Date so the harness sees the zone.
process.env.TZ = 'America/Toronto';

import assert from 'node:assert/strict';
import test from 'node:test';

import { createBackgroundHarness } from './helpers/clinic-sim.js';

const ANALYTICS_KEY = 'vaxlink_analytics_v1';

test('analytics events bucket by local calendar day, not UTC', async () => {
  const harness = createBackgroundHarness({ resourceType: 'Bundle', entry: [] });

  // 2026-06-12T01:30Z is 21:30 EDT on 2026-06-11 — an evening-clinic event.
  const response = await harness.sendMessage({
    action: 'logAnalyticsEvent',
    eventType: 'scan_captured',
    payload: { workflow: 'multiple', ts: '2026-06-12T01:30:00.000Z' }
  });
  assert.equal(response.success, true);

  const analytics = harness.storageData.get(ANALYTICS_KEY);
  assert.ok(analytics, 'analytics store must exist');
  assert.equal(analytics.recentEvents.at(-1).day, '2026-06-11',
    'evening-EDT event must bucket into the local day, not the next UTC day');
  assert.ok(analytics.days['2026-06-11'], 'local day bucket must exist');
  assert.equal(analytics.days['2026-06-12'], undefined, 'no spillover UTC day bucket');
});

test('a malformed ts falls back to today instead of throwing', async () => {
  const harness = createBackgroundHarness({ resourceType: 'Bundle', entry: [] });
  const response = await harness.sendMessage({
    action: 'logAnalyticsEvent',
    eventType: 'scan_captured',
    payload: { workflow: 'multiple', ts: 'not-a-date' }
  });
  assert.equal(response.success, true, 'invalid ts must not crash the analytics writer');
});
