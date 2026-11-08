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
