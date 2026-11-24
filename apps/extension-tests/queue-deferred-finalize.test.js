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
    getPanoramaFormContext: () => ({ kind: 'provider_single' }),
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
  await context.finalizeDeferredPanoramaAutofill({ ...use });
  release();
  await first;
  assert.equal(harness.storageData.get(key)[0].remaining_doses, 2);
  await context.finalizeDeferredPanoramaAutofill(makeUse('vial'));
  assert.equal(harness.storageData.get(key)[0].remaining_doses, 1);
  await context.finalizeDeferredPanoramaAutofill(makeUse('unknown'));
  assert.equal(harness.storageData.get(key)[1].id, 'unknown');
});

test('Local Activity preserves product names and skips lot aliases from saved rows', async () => {
  const worker = createBackgroundHarness(makeTestNvcBundle(), {
    storage: {
      [key]: [
        {
          id: 'legacy-alias',
          name: 'TRAININGLOT',
          lot: 'TRAININGLOT',
          remaining_doses: 1
        },
        {
          id: 'legacy-name',
          name: 'Legacy vaccine',
          lot: 'LEGACY-LOT',
          remaining_doses: 1
        }
      ]
    }
  });
  const { context } = createContentHarness();
  const sender = {
    id: 'vaxlink-test',
    frameId: 0,
    url: chartUrl,
    tab: { id: 44, url: chartUrl }
  };
  context.chrome.runtime.sendMessage = (message, done) => {
    void worker.sendMessage(message, sender).then(done);
  };
  const form = { isConnected: true };
  Object.assign(context, {
    getPanoramaAutofillForm: () => form,
    getPanoramaFormContext: () => ({ kind: 'provider_single' }),
    getPanoramaMultiStepIndicatorKey: () => '',
    showVaxlinkToast() {}
  });
  for (const recordId of ['legacy-alias', 'legacy-name']) {
    const data = context.beginPanoramaAutofill({
      _vaxlinkQueueContext: { storageKey: key, recordId }
    });
    await context.finalizeDeferredPanoramaAutofill(data);
  }
  assert.equal(worker.storageData.get(key).length, 0);
  const { data } = await worker.sendMessage({ action: 'getAnalyticsExport' });
  assert.equal(data.rollup.queues.multipleUsed, 2);
  assert.equal(data.rollup.vaccines['Legacy vaccine'], 2);
  assert.doesNotMatch(JSON.stringify(data), /TRAININGLOT|LEGACY-LOT/);
});

test('a failed tray debit leaves one failed outcome and no verified use', async () => {
  const sender = {
    id: 'vaxlink-test',
    frameId: 0,
    documentId: 'owned-chart',
    url: chartUrl,
    tab: { id: 44, url: chartUrl }
  };
  const worker = createBackgroundHarness(makeTestNvcBundle(), {
    storage: { [key]: [{ id: 'vial', lot: 'LOT', remaining_doses: 2 }] },
    failStorageSet(values) {
      return values[key]?.[0]?.remaining_doses === 1;
    }
  });
  const { context } = createContentHarness();
  const form = { isConnected: true };
  let data;
  const messages = [];
  Object.assign(context, {
    getPanoramaAutofillForm: () => form,
    getPanoramaFormContext: () => ({ kind: 'provider_single', ready: true }),
    getPanoramaMultiStepIndicatorKey: () => '',
    showVaxlinkToast() {},
    autoFillPanorama(owned) {
      data = owned;
      data._vaxlinkOwner.writeAttempted = true;
      return { status: 'pending' };
    }
  });
  context.chrome.runtime.sendMessage = (message, reply) => {
    messages.push(message);
    void worker.sendMessage(message, sender).then(reply);
  };
  const contextToken = context.getScannerDeliveryContext(
    'provider_single',
    true
  );
  assert.equal(
    (await context.useTrayVaccine('vial', contextToken)).status,
    'pending'
  );
  await Promise.all([
    context.finalizeDeferredPanoramaAutofill(data),
    context.finalizeDeferredPanoramaAutofill({ ...data })
  ]);
  const row = worker.storageData.get(key)[0];
  assert.equal(row.remaining_doses, 2);
  assert.equal(row.dose_reservations[0].review, true);
  assert.equal(
    messages.filter(({ operation }) => operation === 'consume').length,
    1
  );
  assert.deepEqual(
    messages
      .filter(({ eventType }) => eventType === 'autofill_result')
      .map(({ payload }) => payload.success),
    [false]
  );
  assert.equal(
    messages.some(({ eventType }) => eventType === 'queue_used'),
    false
  );
});
