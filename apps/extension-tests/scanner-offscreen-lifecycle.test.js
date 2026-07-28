import assert from 'node:assert/strict';
import test from 'node:test';

import { createBackgroundHarness } from './helpers/clinic-sim.js';

test('background creates exactly one persistent WORKERS offscreen document', async () => {
  const harness = createBackgroundHarness({ resourceType: 'Bundle', entry: [] });

  const first = await harness.sendMessage({ action: 'scannerDaemon.ensure' });
  const second = await harness.sendMessage({ action: 'scannerDaemon.ensure' });

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(harness.offscreenCreations.length, 1);
  assert.deepEqual(Array.from(harness.offscreenCreations[0].reasons), ['WORKERS']);
  assert.match(harness.offscreenCreations[0].justification, /scanner connection active/i);
});
