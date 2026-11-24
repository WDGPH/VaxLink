import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentHarness } from './helpers/clinic-sim.js';

test('page health keeps its load identity and waits for settings without changing scan context', () => {
  const { context, messageListeners, storageReads } = createContentHarness();
  const form = { isConnected: true };
  context.getPanoramaAutofillForm = () => form;
  context.getPanoramaMultiStepIndicatorKey = () => '';
  const atLoad = context.chrome.runtime.getManifest();
  let reads = 0;
  context.chrome.runtime.getManifest = () => {
    reads++;
    return { version: 'new-version', name: 'VaxLink' };
  };
  context.VAXLINK_BUILD_ID = 'new-build';
  const probe = () => {
    let result;
    messageListeners[0]({ action: 'getPanoramaIntegration' }, {}, (reply) => {
      result = reply;
    });
    return result;
  };
  const initial = probe();
  assert.equal(initial.ready, false);
  assert.equal(initial.initialized.listener, true);
  assert.equal(initial.initialized.settings, false);
  assert.equal(initial.buildAtLoad.version, atLoad.version);
  assert.equal(initial.buildAtLoad.versionName, atLoad.version_name);
  assert.equal(initial.buildAtLoad.name, atLoad.name);
  assert.equal(initial.buildAtLoad.fingerprint, null);
  assert.equal(reads, 0);
  storageReads[0].callback({});
  const initialized = probe();
  assert.equal(initialized.ready, true);
  assert.equal(initialized.contextToken, initial.contextToken);
  assert.equal(reads, 0);
});

test('installation inspection does not claim the chart or change delivery context', () => {
  const attributes = new Map();
  const writes = [];
  const chart = {
    getAttribute: (key) => attributes.get(key) || null,
    setAttribute(key, value) {
      writes.push(value);
      attributes.set(key, value);
    }
  };
  const { context, messageListeners } = createContentHarness({
    document: { documentElement: chart }
  });
  const form = { isConnected: true };
  context.getPanoramaAutofillForm = () => form;
  context.getPanoramaMultiStepIndicatorKey = () => '';
  const probe = () => {
    let result;
    messageListeners[0]({ action: 'getPanoramaIntegration' }, {}, (reply) => {
      result = reply;
    });
    return result;
  };
  const token = probe().contextToken;
  assert.equal(context.panoramaEntryBlockReason(), '');
  context.registerPanoramaInstallation();
  assert.deepEqual(writes, ['vaxlink-test']);

  attributes.set('data-vaxlink-installations', 'vaxlink-test another-copy');
  assert.match(context.panoramaEntryBlockReason(), /Two copies/);
  assert.equal(probe().contextToken, token);
  attributes.set('data-vaxlink-installations', '');
  assert.match(context.panoramaEntryBlockReason(), /Refresh the chart/);
  assert.deepEqual(writes, ['vaxlink-test']);
});
