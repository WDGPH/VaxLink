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

test('Panorama partial updates change the visible Multiple Immunizations step inside the same form', () => {
  // Structural IDs from Panorama's grid and detail responses. No chart values.
  const factory = 'recordImmsForm:immsDetails_dataTable:immsDetails_Factory';
  const grid = `${factory}:historicalfactoryTable`;
  const form = {
    id: 'recordImmsForm',
    isConnected: true,
    closest: () => null,
    querySelectorAll: query
  };
  function node(tag, id = '', properties = {}) {
    return {
      tagName: tag.toUpperCase(),
      id,
      textContent: '',
      getBoundingClientRect: () => ({ width: 100, height: 20 }),
      closest: (selector) => (selector === 'form' ? form : null),
      ...properties
    };
  }
  const row = node('tr');
  const gridBody = node('tbody', `${grid}:dataTable_data`, {
    querySelectorAll: (selector) => (selector === 'tr[data-ri]' ? [row] : [])
  });
  const addRows = node('button', `${grid}:addButtonId:commandButtonId`);
  const gridAgent = node(
    'select',
    `${grid}:dataTable:0:immsAgentMenu:selectOneMenu_input`
  );
  const gridDate = node(
    'input',
    `${grid}:dataTable:0:dateIn1:dateInput_input`,
    { type: 'text' }
  );
  // PrimeFaces hides the native select inside its visible widget.
  const agentWidget = node('div');
  const agent = () =>
    node(
      'select',
      `${factory}:immsDetailssection_recordImms_agentiterm:selectOneMenu_input`,
      {
        getBoundingClientRect: () => ({ width: 0, height: 0 }),
        closest: (selector) =>
          selector === '.ui-selectonemenu' ? agentWidget : form
      }
    );
  const date = () =>
    node(
      'input',
      `${factory}:immsDetailssection_dateAdministedDate:dateInput_input`,
      {
        type: 'text'
      }
    );
  const counter = (step, total) =>
    node('span', `${factory}:pagecounter`, {
      textContent: `\u00a0${step}\u00a0 of \u00a0${total}\u00a0 immunizations\u00a0`
    });
  let nodes = [gridBody, addRows, gridAgent, gridDate];
  // This fixture only needs the chart's tag, tag list, and ID fragment queries.
  function query(selector) {
    const idFragment = selector.match(/^([a-z]+)\[id\*="([^"]+)"\]$/);
    return nodes.filter((item) =>
      idFragment
        ? item.tagName.toLowerCase() === idFragment[1] &&
          item.id.includes(idFragment[2])
        : selector
            .split(',')
            .some((tag) => tag.trim().toUpperCase() === item.tagName)
    );
  }
  const { context, messageListeners, storageReads } = createContentHarness({
    document: {
      querySelectorAll: query,
      querySelector: (selector) => query(selector)[0] || null
    },
    getComputedStyle: (item) => ({
      visibility: item.hidden ? 'hidden' : 'visible'
    })
  });
  storageReads[0].callback({});
  const probe = () => {
    let result;
    messageListeners[0]({ action: 'getPanoramaIntegration' }, {}, (reply) => {
      result = reply;
    });
    return result;
  };

  const gridState = probe();
  assert.equal(context.getPanoramaAutofillForm(), form);
  assert.equal(gridState.formContext.kind, 'multiple_grid');
  assert.equal(gridState.formContext.ready, true);

  const firstStep = counter(1, 4);
  const firstDate = date();
  nodes.push(firstStep, agent(), firstDate);
  assert.equal(probe().formContext.blockedBy, 'conflicting_controls');

  gridBody.hidden = true;
  firstDate.disabled = true;
  const loading = probe();
  assert.equal(loading.formContext.kind, 'multiple_detail');
  assert.equal(loading.formContext.blockedBy, 'date_control_unavailable');
  firstDate.disabled = false;
  const firstDetail = probe();
  assert.equal(firstDetail.formContext.ready, true);
  assert.equal(firstDetail.contextToken, loading.contextToken);
  assert.notEqual(firstDetail.contextToken, gridState.contextToken);

  // Delete replaces the controls and changes the total while keeping step 1.
  firstStep.hidden = true;
  nodes = [firstStep, counter(1, 3), agent(), date()];
  assert.equal(context.getPanoramaAutofillForm(), form);
  assert.equal(
    context.getPanoramaMultiStepIndicatorKey({ visibleOnly: true }),
    '1-of-3'
  );
  const afterDelete = probe();
  assert.equal(afterDelete.formContext.ready, true);
  assert.notEqual(afterDelete.contextToken, firstDetail.contextToken);
  assert.equal(
    context.isScannerDeliveryContextCurrent(firstDetail.contextToken),
    false
  );

  nodes = [counter(2, 3), agent(), date()];
  const afterNext = probe();
  assert.equal(afterNext.formContext.ready, true);
  assert.notEqual(afterNext.contextToken, afterDelete.contextToken);
});
