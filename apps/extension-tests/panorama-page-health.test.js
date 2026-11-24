import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentHarness } from './helpers/clinic-sim.js';

test('page health keeps its load identity and waits for settings without changing scan context', () => {
  const { context, messageListeners, storageReads } = createContentHarness();
  const form = { isConnected: true };
  context.getPanoramaAutofillForm = () => form;
  context.getPanoramaFormContext = () => ({
    kind: 'provider_single',
    ready: true
  });
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
  context.getPanoramaFormContext = () => ({
    kind: 'provider_single',
    ready: true
  });
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

test('the visible form explains readiness and its classification follows AJAX replacement', () => {
  const node = (textContent = '') => ({
    textContent,
    get innerText() {
      return this.textContent;
    },
    closest: () => null,
    getBoundingClientRect: () => ({ width: 100, height: 20 })
  });
  const agent = node();
  const date = node();
  const title = node('Add Provider Recorded');
  const otherTitle = node();
  const type = node();
  const step = node();
  const gridRow = node();
  let form = {
    isConnected: true,
    closest: () => null,
    get textContent() {
      return [title, otherTitle, type, step]
        .map((n) => n.textContent)
        .join(' ');
    },
    querySelectorAll(selector) {
      if (selector.includes('immsDetailssection_recordImms_agentiterm'))
        return [agent];
      if (selector.includes('dateAdministedDate:dateInput_input'))
        return [date];
      if (selector.startsWith('h1')) return [title, otherTitle, type];
      if (selector.startsWith('div')) return [step];
      return [];
    }
  };
  let grid = false;
  let gridRowVisible = true;
  const { context, messageListeners, storageReads } = createContentHarness({
    getComputedStyle: (item) => ({
      visibility:
        item.hidden || (item === gridRow && !gridRowVisible)
          ? 'hidden'
          : 'visible'
    }),
    document: {
      querySelectorAll: (selector) => form.querySelectorAll(selector)
    }
  });
  context.getPanoramaAutofillForm = () => form;
  context.isPanoramaMultipleImmunizationGridPage = () => grid;
  context.getPanoramaMultipleGridRows = () => [gridRow];
  context.getPanoramaMultipleGridAgentField = () => agent;
  context.getPanoramaMultipleGridDate1Field = () => date;
  storageReads[0].callback({});

  const probe = () => {
    let result;
    messageListeners[0]({ action: 'getPanoramaIntegration' }, {}, (reply) => {
      result = reply;
    });
    return result;
  };
  const initial = probe();
  assert.equal(initial.formContext.kind, 'provider_single');
  assert.equal(initial.formContext.ready, true);
  date.disabled = true;
  const unavailable = probe();
  assert.equal(unavailable.formContext.kind, 'provider_single');
  assert.equal(unavailable.formContext.blockedBy, 'date_control_unavailable');
  assert.equal(unavailable.contextToken, initial.contextToken);
  date.disabled = false;
  otherTitle.textContent = 'Add Non-Provider Recorded';
  assert.equal(probe().formContext.blockedBy, 'conflicting_titles');
  title.textContent = 'Add Immunization';
  otherTitle.textContent = '';
  type.textContent = 'Immunization Type:\nNon-Provider Recorded';
  const nonProvider = probe();
  assert.equal(nonProvider.formContext.kind, 'non_provider_single');
  assert.equal(nonProvider.formContext.ready, true);
  assert.notEqual(nonProvider.contextToken, initial.contextToken);
  step.textContent = '1 of 2 Immunizations';
  assert.equal(probe().formContext.kind, 'multiple_detail');
  step.hidden = true;
  assert.equal(probe().formContext.blockedBy, 'conflicting_titles');
  grid = true;
  assert.equal(probe().formContext.blockedBy, 'conflicting_controls');
  agent.hidden = true;
  const gridState = probe();
  assert.equal(gridState.formContext.kind, 'multiple_grid');
  assert.equal(gridState.formContext.ready, true);
  gridRowVisible = false;
  const noRows = probe();
  assert.equal(noRows.formContext.blockedBy, 'no_grid_rows');
  assert.equal(noRows.contextToken, gridState.contextToken);
  form = { ...form };
  assert.notEqual(probe().contextToken, noRows.contextToken);
  assert.equal(
    context.isScannerDeliveryContextCurrent(noRows.contextToken),
    false
  );
});
