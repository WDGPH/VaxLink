import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
  createContentHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

const key = 'multiple_inject_queue_v1';
const chartUrl =
  'https://panorama.prod.ehealthontario.ca/ImmsWeb/pages/recordImms/form';

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
  const { context } = createContentHarness();
  const form = { isConnected: true };
  Object.assign(context, {
    getPanoramaAutofillForm: () => form,
    getPanoramaMultiStepIndicatorKey: () => '',
    getExpiryStatus: () => ({ flag: 'valid' }),
    logAnalyticsEvent() {},
    showVaxlinkToast() {}
  });
  context.chrome.runtime.sendMessage = (message, done) => {
    void harness
      .sendMessage(message, {
        id: 'vaxlink-test',
        frameId: 0,
        url: chartUrl,
        tab: { id: 44, url: chartUrl }
      })
      .then(done);
  };
  context.updatePanoramaWorkflowMode('multiple');
  const makeUse = (id) =>
    context.beginPanoramaAutofill({
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
