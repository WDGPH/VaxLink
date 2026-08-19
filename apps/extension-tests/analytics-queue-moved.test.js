/**
 * "Move to Inventory" / "Move to Multiple Queue" must be tracked distinctly
 * from queue_saved/queue_used/queue_cleared so pilot analytics can show how
 * often leftover multi-inject scans get parked vs. pulled back out.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createBackgroundHarness } from './helpers/clinic-sim.js';

const ANALYTICS_KEY = 'vaxlink_analytics_v1';

test('a multiple -> inventory move increments multipleToInventoryMoved', async () => {
  const harness = createBackgroundHarness({ resourceType: 'Bundle', entry: [] });

  const response = await harness.sendMessage({
    action: 'logAnalyticsEvent',
    eventType: 'queue_moved',
    payload: { workflow: 'multiple', queue: 'inventory', source: 'popup_button' }
  });
  assert.equal(response.success, true);

  const analytics = harness.storageData.get(ANALYTICS_KEY);
  const day = analytics.days[Object.keys(analytics.days)[0]];
  assert.equal(day.queues.multipleToInventoryMoved, 1);
  assert.equal(day.queues.inventoryToMultipleMoved, 0);
});

test('an inventory -> multiple move increments inventoryToMultipleMoved', async () => {
  const harness = createBackgroundHarness({ resourceType: 'Bundle', entry: [] });

  const response = await harness.sendMessage({
    action: 'logAnalyticsEvent',
    eventType: 'queue_moved',
    payload: { workflow: 'inventory', queue: 'multiple', source: 'popup_button' }
  });
  assert.equal(response.success, true);

  const analytics = harness.storageData.get(ANALYTICS_KEY);
  const day = analytics.days[Object.keys(analytics.days)[0]];
  assert.equal(day.queues.inventoryToMultipleMoved, 1);
  assert.equal(day.queues.multipleToInventoryMoved, 0);
});
