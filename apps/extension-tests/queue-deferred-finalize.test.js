import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

const source = readFileSync(
  new URL('../extension/content.js', import.meta.url),
  'utf8'
);
const code = source.slice(
  source.indexOf('async function consumeQueueRecordAfterDeferredAutofill('),
  source.indexOf('\nfunction autoFillPanorama(')
);
const key = 'multiple_inject_queue_v1';

test('one deferred use consumes once, distinct uses consume again, and unknown counts remain unlimited', async () => {
  let release;
  let started;
  const pending = new Promise((resolve) => {
    started = resolve;
  });
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    storage: {
      [key]: [
        { id: 'vial', total_doses: 3, remaining_doses: 3 },
        { id: 'unknown' }
      ]
    },
    delayStorageSet(values, resume) {
      if (!(key in values) || release) return false;
      release = resume;
      started();
      return true;
    }
  });
  const context = vm.createContext({
    mutateQueueViaBackground: (storageKey, operation, payload) =>
      harness.sendMessage({
        action: 'mutateQueue',
        storageKey,
        operation,
        payload
      }),
    isPanoramaAutofillCurrent: () => true,
    getExpiryStatus: () => ({ flag: 'valid' }),
    logAnalyticsEvent() {},
    showVaxlinkToast() {},
    console
  });
  vm.runInContext(code, context);
  const makeUse = (id) => ({
    _vaxlinkQueueContext: { storageKey: key, recordId: id }
  });
  const use = makeUse('vial');
  const first = context.finalizeDeferredPanoramaAutofill(use);
  await pending;
  await context.finalizeDeferredPanoramaAutofill(use);
  release();
  await first;
  assert.equal(harness.storageData.get(key)[0].remaining_doses, 2);
  await context.finalizeDeferredPanoramaAutofill(makeUse('vial'));
  assert.equal(harness.storageData.get(key)[0].remaining_doses, 1);
  await context.finalizeDeferredPanoramaAutofill(makeUse('unknown'));
  assert.equal(harness.storageData.get(key)[1].id, 'unknown');
});
