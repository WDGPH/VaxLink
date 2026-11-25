import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  createBackgroundHarness,
  createContentHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

const id =
  'recordImmsForm:immsDetailssection_LotInfo:lotNumberSelect:selectOneMenu';
const shown = () => ({ width: 100, height: 20 });

function fixture() {
  const state = {
    controls: [],
    trade: [],
    nodes: new Map(),
    extraPanels: [],
    step: 'first'
  };
  const form = {
    isConnected: true,
    querySelectorAll(selector) {
      if (selector.includes('LotInfo:lotNumberSelect:')) return state.controls;
      if (selector.includes('createImms_tradenameinput:')) return state.trade;
      return [];
    },
    contains: (node) => node?.form === form
  };
  class FormEvent {
    constructor(type) {
      this.type = type;
    }
  }
  const { context, windowListeners, documentListeners, storageListeners } =
    createContentHarness({
      MouseEvent: FormEvent,
      Event: FormEvent,
      getComputedStyle: () => ({ visibility: 'visible' })
    });
  Object.assign(context, {
    getPanoramaAutofillForm: () => form,
    getPanoramaFormContext: () => ({ kind: 'provider_single' }),
    getPanoramaMultiStepIndicatorKey: () => state.step
  });
  context.document.getElementById = (id) => state.nodes.get(id);
  context.document.querySelectorAll = (selector) =>
    selector.includes('_panel')
      ? [...state.nodes.values(), ...state.extraPanels].filter((node) =>
          node.id.endsWith('_panel')
        )
      : [];
  const label = { id: `${id}_label`, form, textContent: 'Select' };
  state.nodes.set(label.id, label);
  const run = (lot, options) => {
    const owner = context.beginPanoramaAutofill({ lot });
    return context.runPanoramaAutofill(owner, () =>
      context.tryFillPanoramaLot(lot, options)
    );
  };
  const root = {
    id,
    form,
    contains: (node) => state.controls.includes(node),
    querySelector: () => null,
    querySelectorAll: (selector) => (selector.includes('_label') ? [label] : [])
  };

  function select(text, value = '') {
    const options = [
      { text: 'Select', value: '' },
      { text, value: 'lot-option' }
    ];
    return {
      id: `${id}_input`,
      tagName: 'SELECT',
      isConnected: true,
      options,
      value,
      get selectedIndex() {
        return options.findIndex((option) => option.value === this.value);
      },
      focus() {},
      blur() {},
      dispatchEvent() {}
    };
  }

  function panel(panelId, text) {
    const item = {
      isConnected: true,
      textContent: text,
      clicks: 0,
      getAttribute: () => null,
      getBoundingClientRect: shown,
      classList: { contains: () => false },
      dispatchEvent() {},
      click() {
        this.clicks++;
      }
    };
    state.nodes.set(panelId, {
      id: panelId,
      isConnected: true,
      contains: (el) => el === item,
      getBoundingClientRect: shown,
      querySelectorAll: () => [item]
    });
    return item;
  }
  return {
    context,
    state,
    select,
    run,
    panel,
    label,
    root,
    windowListeners,
    documentListeners,
    storageListeners
  };
}

test('the last reordered assignment can enter an empty detail after reservation is checked again', () => {
  const f = fixture();
  const { context } = f;
  const field = f.select('OTHER');
  f.state.controls = [f.root, field];
  context.getPanoramaCurrentAgentSelectionText = () => 'RSV';
  context.getPanoramaAdministeredDateTimeFields = () => ({
    dateField: { value: '2026/11/24' }
  });
  const entry = {
    agent: 'rsv',
    lot: 'TARGET',
    date: '2026/11/24',
    dose: { record: { generic_name: 'RSV' } }
  };
  const rows = [
    { agent: 'rsv', date: entry.date, entry },
    { agent: 'other' },
    { agent: 'third' }
  ];
  const match = context.identifyGridDetail(
    { rows },
    context.getPanoramaAutofillForm(),
    3,
    3
  );
  assert.equal(match.allowEmptyFinalLot, true);
  assert.equal(context.matchesGridDetail({ ...entry, ...match }), true);
  field.value = 'lot-option';
  assert.equal(context.matchesGridDetail({ ...entry, ...match }), false);
});

test('grid carry uses exact enabled Lot evidence on the current widget', () => {
  const { context, state, root, select, panel, label } = fixture();
  const lot = 'SAMPLE-1';
  const field = select(lot, 'lot-option');
  state.controls = [root, field];
  const evidence = () => context.readGridDetailLotEvidence(lot, false);

  assert.equal(evidence(), 'selected');
  label.textContent = 'DIFFERENT';
  assert.equal(evidence(), 'conflicting_selection');
  label.textContent = 'Select';
  field.options[1].text = 'SAMPLE1';
  assert.equal(evidence(), 'conflicting_selection');
  field.options[1].text = lot;
  field.options[1].disabled = true;
  assert.equal(evidence(), 'disabled');

  field.value = '';
  const item = panel(`${id}_panel`, lot);
  root.contains = (node) =>
    node === field || node === state.nodes.get(`${id}_panel`);
  assert.equal(evidence(), 'disabled', 'the native choices take precedence');
  field.options.pop();
  assert.equal(evidence(), 'panel_option');
  context.getPanoramaFundedRadioValue = () => 'NON_PUBLICLY_FUNDED';
  assert.equal(evidence(), 'panel_no_match');
  item.textContent = `N-${lot}`;
  assert.equal(evidence(), 'panel_option');
  item.getAttribute = (name) => (name === 'aria-disabled' ? 'true' : null);
  assert.equal(evidence(), 'panel_unavailable');

  state.controls = [{ ...root, contains: (node) => node === field }, field];
  assert.equal(evidence(), 'panel_unlinked', 'the old panel still has its ID');
});

test('a terminal miss clears the owned filter and closes only the same open Lot menu', () => {
  for (const replaced of [false, true]) {
    const f = fixture();
    const data = f.context.beginPanoramaAutofill({ lot: 'TRAIN' });
    const events = [];
    const filter = {
      value: 'TRAIN',
      dispatchEvent(event) {
        events.push(event.type);
        if (replaced) current = null;
      }
    };
    const panel = {
      contains: (node) => node === filter,
      getBoundingClientRect: shown
    };
    const widget = {
      panel,
      root: { querySelector: () => ({ click: () => events.push('close') }) }
    };
    let current = widget;
    f.context.getPanoramaLotWidget = () => current;
    f.context.KeyboardEvent = f.context.Event;
    data._vaxlinkOwner.lotSearchFilter = filter;
    f.context.closePanoramaLotSearch(data);
    assert.equal(filter.value, '');
    assert.deepEqual(
      events,
      replaced ? ['input'] : ['input', 'keyup', 'close']
    );
  }
});

test('Lot labels distinguish prefix lots and preserve expiry, funding, and punctuation formats', () => {
  const { context } = fixture();
  for (const text of [
    'ABC1',
    'ABC-1 - Exp. 2028-03-31',
    'N-AB/C.1 (Non-Publicly Funded)',
    'N-ABC1 — NPF',
    'ABC1 | Publicly Funded'
  ]) {
    assert.equal(context.panoramaLotLabelMatches(text, 'ABC1'), true, text);
  }
  for (const text of [
    'ABC12',
    'ABC-12 - Exp. 2028-03-31',
    'AB9 (PF)',
    'ABC1 (NPF)',
    'N-ABC1 (Publicly Funded)'
  ]) {
    assert.equal(context.panoramaLotLabelMatches(text, 'ABC1'), false, text);
  }
  const hyphenated = 'ABC1-PF-2 - Exp. 2028-03-31';
  assert.equal(context.panoramaLotLabelMatches(hyphenated, 'ABC1-PF-2'), true);
  assert.equal(context.panoramaLotLabelMatches(hyphenated, 'ABC1'), false);
});

test('only the current widget’s panel can select a Lot, and the click must change its selection', () => {
  const f = fixture();
  const stale = f.panel(`${id}_panel`, 'ABC1');
  assert.equal(f.run('ABC1'), false);
  assert.equal(stale.clicks, 0);

  f.state.nodes.delete(`${id}_panel`);
  const unrelated = f.panel('otherLot_panel', 'ABC1');
  f.state.controls = [f.root];
  assert.equal(f.run('ABC1'), false);
  assert.equal(unrelated.clicks, 0);

  const current = f.panel(`${id}_panel`, 'ABC1');
  f.state.extraPanels.push({ ...f.state.nodes.get(`${id}_panel`) });
  assert.equal(f.run('ABC1'), false);
  assert.equal(current.clicks, 0);
  f.state.extraPanels.length = 0;
  f.state.nodes.set(`${id}_label`, { ...f.label, textContent: 'ABC1' });
  f.label.textContent = 'ABC12';
  assert.equal(f.run('ABC1'), false);
  assert.equal(current.clicks, 1);
  current.click = () => {
    f.label.textContent = 'ABC1 - Exp. 2028-03-31';
  };
  assert.equal(f.run('ABC1'), true);
  assert.equal(unrelated.clicks, 0);
});

test('native confirmation ignores a stale label and re-reads a replaced Lot select', () => {
  const f = fixture();
  f.label.textContent = 'ABC1';
  const incorrect = f.select('ABC12', 'lot-option');
  f.state.controls = [f.root, incorrect];
  assert.equal(f.run('ABC1'), false);
  assert.equal(f.context.hasPanoramaLotSelection('ABC1'), false);

  const original = f.select('ABC1');
  const replacement = f.select('ABC1');
  original.dispatchEvent = ({ type }) => {
    if (type === 'change') {
      original.isConnected = false;
      f.state.controls = [f.root, replacement];
    }
  };
  f.state.controls = [f.root, original];
  assert.equal(f.run('ABC1'), false);
  assert.equal(replacement.value, '');
  assert.equal(f.run('ABC1'), true);
  assert.equal(replacement.value, 'lot-option');
});

test('an exact Lot wins over another spelling and ambiguous fallbacks are refused', () => {
  const f = fixture();
  const select = f.select('AB-123 - Exp. 2028-03-31', 'lot-option');
  select.options.push({ text: 'AB123 - Exp. 2028-03-31', value: 'exact' });
  f.state.controls = [f.root, select];

  assert.equal(f.context.hasPanoramaLotSelection('AB123'), false);
  assert.equal(f.run('AB123'), true);
  assert.equal(select.value, 'exact');
  assert.equal(f.run('AB/123'), false);
  assert.equal(f.context.hasPanoramaLotSelection('AB/123'), false);

  select.options.pop();
  assert.equal(f.run('AB/123'), true);
  assert.equal(select.value, 'lot-option');
});

test('an older Trade-only row waits for the current select to retain its choice', () => {
  const f = fixture();
  const field = f.select('Priorix');
  const replacement = f.select('Priorix');
  field.id = replacement.id =
    'recordImmsForm:immsDetailssection_createImms_tradenameinput:selectOneMenu_input';
  field.dispatchEvent = ({ type }) => {
    if (type !== 'change') return;
    field.isConnected = false;
    f.state.trade = [replacement];
  };
  f.state.trade = [field];
  const data = f.context.beginPanoramaAutofill({ tradename: 'Priorix' });
  const fill = () =>
    f.context.runPanoramaAutofill(data, () =>
      f.context.tryFillPanoramaLotOrTrade(data)
    );
  assert.equal(fill(), false);
  assert.equal(replacement.value, '');
  assert.equal(fill(), true);
  assert.equal(f.context.hasPanoramaLotOrTradeSelection(data), true);
});

test('an older finite Trade-only row reserves before entry and consumes only after Trade readback', async () => {
  const f = fixture();
  const key = 'multiple_inject_queue_v1';
  const worker = createBackgroundHarness(makeTestNvcBundle(), {
    storage: {
      [key]: [{ id: 'old-trade', tradename: 'Priorix', remaining_doses: 1 }]
    }
  });
  const operations = [];
  const url = f.context.location.href;
  f.context.chrome.runtime.sendMessage = (message, reply) => {
    if (!reply) return;
    if (message.action === 'mutateQueue') operations.push(message);
    void worker
      .sendMessage(message, {
        id: 'vaxlink-test',
        frameId: 0,
        documentId: 'trade-chart',
        url,
        tab: { id: 45, url }
      })
      .then(reply);
  };
  f.context.getPanoramaFormContext = () => ({
    kind: 'provider_single',
    ready: true
  });
  f.context.showVaxlinkToast = () => {};
  const trade = f.select('Priorix');
  trade.id =
    'recordImmsForm:immsDetailssection_createImms_tradenameinput:selectOneMenu_input';
  f.state.trade = [trade];
  f.context.isPanoramaImmunizationPage = () => true;
  f.context.hasPanoramaAgentSelection = () => true;
  let verified;
  f.context.schedulePanoramaLotOrTradeSelection = (
    data,
    _delay,
    { finalizeOnResolved }
  ) => {
    assert.equal(worker.storageData.get(key)[0].dose_reservations.length, 1);
    assert.equal(finalizeOnResolved, true);
    assert.equal(f.context.hasPanoramaLotOrTradeSelection(data), true);
    verified = data;
  };
  const token = f.context.getScannerDeliveryContext('provider_single', true);
  assert.equal(
    (await f.context.useTrayVaccine('old-trade', token)).status,
    'pending'
  );
  assert.equal(worker.storageData.get(key).length, 1);
  await f.context.finalizeDeferredPanoramaAutofill(verified);
  assert.equal(trade.value, 'lot-option');
  assert.deepEqual(
    operations.map(({ operation }) => operation),
    ['reserve_dose', 'consume']
  );
  assert.equal(operations[0].payload.token, operations[1].payload.token);
  assert.equal(worker.storageData.get(key).length, 0);
});

test('only current product readback permits Date and another refresh stops Time', () => {
  const f = fixture();
  const date = { value: '' };
  const time = { value: '' };
  let agentMatches = false;
  const lot = f.select('ABC1');
  f.state.controls = [f.root, lot];
  const writes = [];
  Object.assign(f.context, {
    isPanoramaImmunizationPage: () => true,
    hasPanoramaAgentSelection: () => agentMatches,
    tryFillPanoramaAgent: () => true,
    getPanoramaFundedRadioValue: () => 'SHOW_ALL',
    schedulePanoramaLotOrTradeSelection() {},
    getPanoramaAdministeredDateTimeFields: () => ({
      dateField: date,
      timeField: time
    }),
    fillPanoramaMaskedTextInput(field, value) {
      writes.push(field);
      field.value = value;
      if (field === date) lot.value = '';
      return true;
    }
  });
  const owned = f.context.beginPanoramaAutofill({ lot: 'ABC1', name: 'MMR' });
  assert.equal(f.context.autoFillPanorama(owned).status, 'pending');
  assert.deepEqual(writes, []);
  assert.equal(lot.value, '');
  agentMatches = true;
  f.context.runPanoramaAutofill(owned, () => {
    assert.equal(f.context.tryFillPanoramaLot(owned.lot), true);
    f.context.fillPanoramaDeferredDetailFields(owned);
  });
  assert.deepEqual(writes, [date]);
  assert.equal(time.value, '');
});

test('an observed refresh can change option text in place on the same Lot widget', () => {
  const f = fixture();
  const select = f.select('ABC1', 'lot-option');
  f.state.controls = [f.root, select];
  const data = f.context.beginPanoramaAutofill({ lot: 'ABC1' });
  data._vaxlinkOwner.lotListBeforeRefresh = f.context.readPanoramaLotList();
  assert.equal(f.context.panoramaDetailProductMatches(data), false);
  select.options[1].text = 'ABC1 - Exp. 2028-03-31';
  assert.equal(f.context.panoramaDetailProductMatches(data), true);
});

test('the current Lot widget distinguishes two funding matches from a sole N- entry', () => {
  const f = fixture();
  let funding = 'SHOW_ALL';
  f.context.getPanoramaFundedRadioValue = () => funding;
  const prefixed = f.select('N-ABC1 - Exp. 2028-03-31');
  f.state.controls = [f.root, prefixed];
  assert.equal(f.run('ABC1'), true);
  assert.equal(prefixed.value, 'lot-option');
  prefixed.value = '';
  funding = 'PUBLICLY_FUNDED';
  assert.equal(f.run('ABC1'), false);
  assert.equal(prefixed.value, '');

  funding = 'SHOW_ALL';
  const publicPanelOption = f.panel(`${id}_panel`, 'ABC1 | Publicly Funded');
  assert.equal(f.run('ABC1'), false);
  assert.equal(prefixed.value, '');
  assert.equal(publicPanelOption.clicks, 0);
  funding = 'NON_PUBLICLY_FUNDED';
  assert.equal(f.run('ABC1'), true);
  assert.equal(prefixed.value, 'lot-option');
});

test('an options change during focus cannot turn a sole funding match into a silent choice', () => {
  const f = fixture();
  const select = f.select('ABC1');
  f.state.controls = [f.root, select];
  select.focus = () => {
    select.options.push({ text: 'N-ABC1', value: 'other-bucket' });
  };
  assert.equal(f.run('ABC1'), false);
  assert.equal(select.value, '');
});

test('Lot cleanup clears a newly selected wrong entry and preserves a staff selection', () => {
  const f = fixture();
  const field = f.select('WRONG', 'lot-option');
  f.state.controls = [f.root, field];
  const data = f.context.beginPanoramaAutofill({ lot: 'INTENDED' });
  const owner = data._vaxlinkOwner;
  const events = [];
  field.dispatchEvent = (event) => events.push(event.type);
  const cleanup = (options) =>
    f.context.runPanoramaAutofill(data, () =>
      f.context.clearPanoramaNonMatchingLot(data, options)
    );

  owner.initialLot = 'WRONG';
  owner.lotSelectionWidgetId = id;
  assert.equal(cleanup({ resetAgent: false }), 'review');
  assert.equal(field.value, 'lot-option');
  owner.initialLot = '';
  owner.lotSelectionWidgetId = undefined;
  assert.equal(cleanup(), 'review');
  assert.equal(field.value, 'lot-option');
  owner.lotSelectionWidgetId = id;
  assert.equal(cleanup(), 'changed');
  assert.equal(field.value, '');
  assert.deepEqual(events, ['input', 'change']);

  const agent = f.select('Owned Agent', 'lot-option');
  agent.dispatchEvent = ({ type }) => {
    if (type === 'change') field.value = '';
  };
  f.context.getPanoramaDetailAgentFields = () => [agent];
  f.context.getPanoramaCurrentAgentSelectionText = () =>
    agent.value ? 'owned agent' : '';
  owner.initialAgent = '';
  owner.filledAgent = 'owned agent';
  owner.lotSelectionWidgetId = undefined;
  field.value = 'lot-option';
  assert.equal(cleanup({ resetAgent: false }), 'changed');
  assert.equal(field.value, '');
  assert.equal(
    agent.value,
    'lot-option',
    'the Agent stays for the alternate search'
  );
  assert.equal(cleanup(), 'changed');
  assert.equal(
    agent.value,
    '',
    'a terminal miss clears an owned Agent even with an empty Lot'
  );
  owner.initialAgent = 'owned agent';
  agent.value = 'lot-option';
  assert.equal(cleanup(), 'empty');
  assert.equal(
    agent.value,
    'lot-option',
    'a pre-existing Agent stays selected'
  );
});

test('a carried sole Lot is cleared after a refresh unless staff take over', async () => {
  for (const scenario of ['sole', 'takeover', 'ambiguous', 'repeated']) {
    const f = fixture();
    const field = f.select('WRONG', 'lot-option');
    f.state.controls = [f.root, field];
    const data = f.context.beginPanoramaAutofill({ lot: 'INTENDED' });
    data._vaxlinkOwner.initialLot = 'WRONG';
    data._vaxlinkOwner.gridDetail = {};
    f.context.matchesGridDetail = () => true;
    if (scenario === 'ambiguous')
      field.options.push({ value: 'other', text: 'ANOTHER' });
    const ticks = [];
    f.context.setTimeout = (cb) => ticks.push(cb);
    const confirmation = f.context.cleanUpPanoramaLotMiss(data, false);
    if (scenario === 'ambiguous') {
      assert.equal(await confirmation, 'review');
      assert.equal(field.value, 'lot-option');
      continue;
    }
    assert.equal(field.value, '');
    const refreshed = f.select('WRONG', 'lot-option');
    f.state.controls = [f.root, refreshed];
    if (scenario === 'takeover') f.context.cancelPanoramaAutofill();
    ticks.shift()();
    await new Promise(setImmediate);
    if (scenario === 'takeover') {
      assert.equal(await confirmation, 'review');
      assert.equal(refreshed.value, 'lot-option');
      continue;
    }
    assert.equal(refreshed.value, '');
    if (scenario === 'repeated') refreshed.value = 'lot-option';
    ticks.shift()();
    assert.equal(
      await confirmation,
      scenario === 'repeated' ? 'review' : 'cleared'
    );
  }
});

test('explicit grid Use assigns only the chosen dose and leaves it for Details', async () => {
  const storageKey = 'multiple_inject_queue_v1';
  for (const [tracking, remaining, replace] of [
    ['single_use', 1, false],
    ['counted', 2, false],
    ['pinned', null, false],
    ['single_use', 1, true]
  ]) {
    const f = fixture();
    const saved = {
      id: 'chosen',
      lot: 'SAMPLE',
      tradename: 'Priorix',
      dose_tracking: tracking,
      remaining_doses: remaining
    };
    const worker = createBackgroundHarness(makeTestNvcBundle(), {
      storage: { [storageKey]: [{ ...saved, id: 'other' }, saved] }
    });
    const form = f.context.getPanoramaAutofillForm();
    const row = {
      form,
      isConnected: true,
      getAttribute: (key) => ({ 'data-ri': '1', 'data-rk': 'row-1' })[key],
      getBoundingClientRect: shown
    };
    let agent = '';
    const url = f.context.location.href;
    f.context.chrome.runtime.sendMessage = (message, reply) => {
      if (!reply) return;
      void worker
        .sendMessage(message, {
          id: 'vaxlink-test',
          frameId: 0,
          documentId: 'grid-chart',
          url,
          tab: { id: 42, url }
        })
        .then(reply);
    };
    Object.assign(f.context, {
      getPanoramaFormContext: () => ({ kind: 'multiple_grid', ready: true }),
      getPanoramaMultipleGridRows: () => [row],
      getPanoramaMultipleGridRowState: () => ({
        agentText: agent,
        dateText: '2026/11/24'
      }),
      fillPanoramaMultipleGridAgent() {
        assert.equal(
          worker.storageData.get(storageKey)[0].dose_reservations,
          undefined
        );
        if (tracking !== 'pinned')
          assert.equal(
            worker.storageData.get(storageKey)[1].dose_reservations.length,
            1
          );
        f.context.assertPanoramaAutofillWrite();
        agent = 'MMR';
        if (replace) row.isConnected = false;
        return true;
      },
      showVaxlinkToast() {}
    });
    const token = f.context.getScannerDeliveryContext('multiple_grid', true);
    const result = await f.context.useTrayVaccine('chosen', token);
    assert.equal(result.status, replace ? 'failed' : 'grid_added');
    const rows = worker.storageData.get(storageKey);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].remaining_doses, remaining);
    assert.equal(
      rows[1].dose_reservations?.some((item) => item.review) || false,
      replace
    );
  }
});

test('Enter Details carries only the exact grid row and foreground route', async () => {
  const storageKey = 'multiple_inject_queue_v1';
  const lot = 'SAMPLE';
  const date = '2026/11/24';
  for (const scenario of [
    'normal',
    'manual_use',
    'different_date',
    'replace_before',
    'replace_during',
    'duplicate_agent',
    'duplicate_during_transition',
    'different_lot',
    'sole_lot',
    'navigate_during_cleanup',
    'manual_takeover_while_waiting',
    'lock_cycle',
    'toolbar_blur',
    'hidden_before_click',
    'blur_after_click',
    'carry_off'
  ]) {
    const f = fixture();
    const { context, state } = f;
    const url = context.location.href;
    const tab = { id: 42, url, active: true };
    const worker = createBackgroundHarness(makeTestNvcBundle(), {
      tabs: [tab],
      storage: {
        [storageKey]: [
          { id: 'chosen', lot, tradename: 'Priorix', remaining_doses: 2 }
        ]
      }
    });
    const sender = {
      id: 'vaxlink-test',
      frameId: 0,
      documentId: 'grid-chart',
      url,
      tab
    };
    context.chrome.runtime.sendMessage = (message, reply) => {
      const result = worker.sendMessage(message, sender);
      if (reply) void result.then(reply);
      return result;
    };
    const form = context.getPanoramaAutofillForm();
    const makeRow = (index) => ({
      form,
      isConnected: true,
      getAttribute: (key) =>
        ({ 'data-ri': String(index), 'data-rk': `row-${index}` })[key],
      getBoundingClientRect: shown
    });
    let rows = [makeRow(0)];
    let kind = 'multiple_grid';
    let agent = '';
    let productFill;
    const warnings = [];
    const readLot = context.getPanoramaDisplayedLot;
    const soleLot = f.select('DIFFERENT', 'lot-option');
    Object.assign(context, {
      getPanoramaFormContext: () => ({ kind, ready: true }),
      getPanoramaMultipleGridRows: () => rows,
      getPanoramaMultipleGridRowState: () => ({
        agentText: agent,
        dateText: date
      }),
      fillPanoramaMultipleGridAgent() {
        context.assertPanoramaAutofillWrite();
        agent = 'MMR';
        return true;
      },
      getPanoramaCurrentAgentSelectionText: () => agent,
      getPanoramaAdministeredDateTimeFields: () => ({
        dateField: {
          value: scenario === 'different_date' ? '2026/11/23' : date
        }
      }),
      getPanoramaDisplayedLot: (widget) =>
        ['different_lot', 'manual_takeover_while_waiting'].includes(scenario)
          ? 'DIFFERENT'
          : readLot(widget),

      autoFillPanorama(data) {
        productFill = data;
        return { status: 'pending' };
      },
      showVaxlinkToast(data) {
        if (data._entryWarning) warnings.push(data._entryWarning);
      },
      setTimeout(callback, delay) {
        if (delay === 700) {
          if (scenario === 'navigate_during_cleanup') state.step = '2-of-2';
          queueMicrotask(callback);
        }
        return 1;
      },
      clearTimeout() {},
      MutationObserver: class {
        observe() {}
        disconnect() {}
      }
    });
    if (scenario === 'carry_off')
      context.applyAutofillSettings({ vaxlink_grid_detail_autofill_v1: false });
    const choose = await context.useTrayVaccine(
      'chosen',
      context.getScannerDeliveryContext(kind, true)
    );
    assert.equal(choose.status, 'grid_added', scenario);
    assert.equal(choose.carryToDetails, scenario !== 'carry_off', scenario);
    const saved = () => worker.storageData.get(storageKey)[0];
    assert.equal(saved().remaining_doses, 2, scenario);
    const token = saved().dose_reservations?.[0]?.token;

    if (scenario === 'replace_before') rows = [makeRow(0)];
    if (scenario === 'duplicate_agent') rows.push(makeRow(1));
    if (scenario === 'toolbar_blur') {
      f.windowListeners.get('blur')[0]();
      assert.equal(saved().dose_reservations?.[0]?.token, token);
      assert.equal(productFill, undefined);
    }
    if (scenario === 'hidden_before_click') {
      context.document.visibilityState = 'hidden';
      f.documentListeners.get('visibilitychange')[0]();
      context.document.visibilityState = 'visible';
    }
    context.startGridHandoff({
      isTrusted: true,
      target: { closest: () => ({ textContent: 'Enter Details', form }) }
    });
    if (scenario === 'blur_after_click') f.windowListeners.get('blur')[0]();
    if (scenario === 'replace_during') {
      rows = [makeRow(0)];
      await context.advanceGridHandoff();
    }
    if (scenario === 'lock_cycle') {
      worker.setIdleState('locked');
      worker.setIdleState('active');
    }
    if (scenario === 'duplicate_during_transition') {
      rows.push(makeRow(1));
      await context.advanceGridHandoff();
    }
    kind = 'multiple_detail';
    if (['sole_lot', 'navigate_during_cleanup'].includes(scenario))
      state.controls = [f.root, soleLot];
    state.step = scenario === 'duplicate_agent' ? '1-of-2' : '1-of-1';
    rows = [];
    if (scenario === 'manual_use') {
      const manualToken = context.getScannerDeliveryContext(kind, true);
      assert.equal(
        (await context.useTrayVaccine('chosen', manualToken)).status,
        'pending'
      );
    }
    const advancement = context.advanceGridHandoff();
    if (scenario === 'manual_takeover_while_waiting') {
      const lotControl = { form };
      context.handlePanoramaAutofillUserInteraction({
        isTrusted: true,
        type: 'pointerdown',
        target: {
          closest: (selector) =>
            selector.startsWith('input') ? lotControl : null
        }
      });
    }
    await advancement;
    await new Promise(setImmediate);
    assert.equal(
      warnings.some((warning) => warning.includes('selected a different lot')),
      ['different_lot', 'sole_lot'].includes(scenario),
      scenario
    );
    if (
      !['different_lot', 'sole_lot', 'navigate_during_cleanup'].includes(
        scenario
      )
    ) {
      const expected = {
        replace_before:
          'VaxLink could not match the saved doses to the grid. Check the Immunization tray.',
        duplicate_agent:
          'VaxLink could not match the saved doses to the grid. Check the Immunization tray.',
        lock_cycle:
          'VaxLink could not confirm the original chart. Check the chart and the Immunization tray.'
      }[scenario];
      assert.deepEqual(warnings, expected ? [expected] : [], scenario);
    }
    if (['normal', 'manual_use', 'toolbar_blur'].includes(scenario)) {
      assert.ok(productFill, scenario);
      assert.equal(
        saved().dose_reservations[0].token === token,
        scenario !== 'manual_use',
        scenario
      );
      await context.finalizeDeferredPanoramaAutofill(productFill);
      assert.equal(saved().remaining_doses, 1, scenario);
    } else {
      assert.equal(productFill, undefined, scenario);
      assert.equal(saved().remaining_doses, 2, scenario);
    }
    if (scenario === 'different_date') {
      assert.equal(saved().dose_reservations[0].token, token);
      context.clearGridCarry();
      await new Promise(setImmediate);
    }
    if (['sole_lot', 'navigate_during_cleanup'].includes(scenario)) {
      assert.equal(soleLot.value, '');
      if (scenario === 'sole_lot') {
        assert.match(warnings.at(-1), /cleared/);
        assert.equal(saved().dose_reservations, undefined);
      } else assert.equal(saved().dose_reservations[0].review, true);
    } else assert.equal(saved().dose_reservations, undefined, scenario);
  }
});

test('Enter Details keeps skipped and ambiguous doses available while later matches can fill', async () => {
  const storageKey = 'multiple_inject_queue_v1';
  const date = '2026/11/24';
  for (const scenario of [
    'skipped_step',
    'shorter_list',
    'ambiguous_agent',
    'reordered_rows',
    'manual_use_after_lot_wait',
    'unconfirmed_release'
  ]) {
    const { context, state, storageListeners } = fixture();
    const url = context.location.href;
    const form = context.getPanoramaAutofillForm();
    const tab = { id: 42, url, active: true };
    const agents = [
      'MMR',
      'HPV',
      scenario === 'ambiguous_agent' ? 'HPV' : 'HB'
    ];
    const records = agents.map((agent, index) => ({
      id: String(index),
      lot: `SAMPLE-${index}`,
      generic_name: agent,
      remaining_doses: 2
    }));
    const worker = createBackgroundHarness(makeTestNvcBundle(), {
      tabs: [tab],
      storage: { [storageKey]: records }
    });
    const saved = () => worker.storageData.get(storageKey);
    const sender = {
      id: 'vaxlink-test',
      frameId: 0,
      documentId: 'grid-chart',
      url,
      tab
    };
    let release;
    context.chrome.runtime.sendMessage = (message, reply) => {
      const result =
        release && message.operation === 'stop_dose'
          ? release.promise.then(() =>
              scenario === 'unconfirmed_release'
                ? { success: true, rows: saved() }
                : worker.sendMessage(message, sender)
            )
          : worker.sendMessage(message, sender);
      if (reply) void result.then(reply);
      return result;
    };

    const gridAgents = ['', '', ''];
    const gridRows = records.map(({ id }) => ({
      form,
      isConnected: true,
      getAttribute: (key) => ({ 'data-ri': id, 'data-rk': `row-${id}` })[key],
      getBoundingClientRect: shown
    }));
    let kind = 'multiple_grid';
    let visibleRows = gridRows;
    const manualUse = [
      'manual_use_after_lot_wait',
      'unconfirmed_release'
    ].includes(scenario);
    const reordered = scenario === 'reordered_rows' || manualUse;
    let detailAgent = agents[reordered ? 2 : 0];
    let detailDate = reordered ? '2026-11-24' : date;
    let selectedLot = '';
    let retry;
    let detailReady = true;
    const fills = [];
    Object.assign(context, {
      getPanoramaFormContext: () => ({ kind, ready: detailReady }),
      getPanoramaMultipleGridRows: () => visibleRows,
      getPanoramaMultipleGridRowState: (index) => ({
        agentText: gridAgents[index],
        dateText: date
      }),
      fillPanoramaMultipleGridAgent(index, data) {
        context.assertPanoramaAutofillWrite();
        gridAgents[index] = data.generic_name;
        return true;
      },
      getPanoramaCurrentAgentSelectionText: () => detailAgent,
      getPanoramaAdministeredDateTimeFields: () => ({
        dateField: { value: detailDate }
      }),
      getPanoramaLotWidget: () => ({
        label: { textContent: selectedLot },
        select: {
          tagName: 'SELECT',
          value: selectedLot ? 'chosen' : '',
          selectedIndex: selectedLot ? 2 : -1,
          options: [
            { text: manualUse ? 'OTHER' : 'SAMPLE-2', value: 'pf' },
            { text: manualUse ? 'N-OTHER' : 'N-SAMPLE-2', value: 'npf' },
            ...(selectedLot ? [{ text: selectedLot, value: 'chosen' }] : [])
          ]
        }
      }),
      autoFillPanorama(data) {
        fills.push(data);
        return { status: 'pending' };
      },
      showVaxlinkToast() {},
      setTimeout(callback, delay) {
        if (delay === 500) retry = callback;
        return 1;
      },
      clearTimeout() {},
      MutationObserver: class {
        observe() {}
        disconnect() {}
      }
    });

    if (manualUse) {
      const changes = { vaxlink_recent_activity_enabled: { newValue: true } };
      for (const listener of storageListeners) listener(changes, 'local');
      await new Promise(setImmediate);
    }
    for (const { id } of records) {
      const result = await context.useTrayVaccine(
        id,
        context.getScannerDeliveryContext(kind, true)
      );
      assert.equal(result.status, 'grid_added', scenario);
    }
    context.startGridHandoff({
      isTrusted: true,
      target: { closest: () => ({ textContent: 'Enter Details', form }) }
    });
    if (scenario === 'shorter_list') {
      visibleRows = [gridRows[0], gridRows[2]];
      await context.advanceGridHandoff();
    }
    kind = 'multiple_detail';
    state.step = '1-of-3';
    if (reordered) {
      selectedLot = 'SAMPLE-0';
      await context.advanceGridHandoff();
      assert.equal(
        fills.length,
        0,
        'a different Lot cannot authorize a reordered detail'
      );
      selectedLot = '';
      if (manualUse) {
        await context.advanceGridHandoff();
        const pendingToken = saved()[2].dose_reservations[0].token;
        assert.equal(fills.length, 0);
        release = Promise.withResolvers();
        void context.releaseGridDetailStep('staff_input');
        const token = context.getScannerDeliveryContext(kind, true);
        const using = context.useTrayVaccine('2', token);
        await new Promise(setImmediate);
        assert.equal(saved()[2].dose_reservations.length, 1);
        assert.equal(saved()[2].dose_reservations[0].token, pendingToken);
        release.resolve();
        if (scenario === 'unconfirmed_release') {
          await assert.rejects(using, /Check the original chart/);
          assert.equal(fills.length, 0);
          assert.equal(saved()[2].dose_reservations[0].token, pendingToken);
          continue;
        }
        assert.equal((await using).status, 'pending');
        assert.notEqual(saved()[2].dose_reservations[0].token, pendingToken);
      } else {
        // Both funding categories offer the target, neither is selected.
        retry();
        await new Promise(setImmediate);
      }
    } else await context.advanceGridHandoff();
    assert.deepEqual(
      fills.map(({ lot }) => lot),
      [reordered ? 'SAMPLE-2' : 'SAMPLE-0'],
      scenario
    );
    await context.finalizeDeferredPanoramaAutofill(fills[0]);

    state.step = scenario === 'skipped_step' ? '3-of-3' : '2-of-2';
    detailAgent = agents[reordered ? 0 : 2];
    selectedLot = reordered ? 'SAMPLE-0' : '';
    detailDate = '';
    detailReady = false;
    await context.advanceGridHandoff();
    detailReady = true;
    await context.advanceGridHandoff();
    assert.equal(fills.length, 1, scenario);

    detailDate = date;
    const routeCheck = context.advanceGridHandoff();
    detailDate = '';
    await routeCheck;
    assert.equal(fills.length, 1, scenario);

    detailDate = date;
    await context.advanceGridHandoff();
    if (scenario === 'ambiguous_agent') {
      assert.equal(fills.length, 1, scenario);
    } else {
      assert.deepEqual(
        fills.map(({ lot }) => lot),
        reordered ? ['SAMPLE-2', 'SAMPLE-0'] : ['SAMPLE-0', 'SAMPLE-2'],
        scenario
      );
      await context.finalizeDeferredPanoramaAutofill(fills[1]);
    }
    await new Promise(setImmediate);
    assert.deepEqual(
      saved().map(({ remaining_doses }) => remaining_doses),
      [1, 2, scenario === 'ambiguous_agent' ? 2 : 1],
      scenario
    );
    assert.ok(
      saved().every(({ dose_reservations }) => !dose_reservations),
      scenario
    );
    if (manualUse) {
      vm.runInContext('chartActivity.flush()', context);
      const trace = await worker.sendMessage(
        { action: 'exportRecentActivity' },
        {
          id: 'vaxlink-test',
          url: 'chrome-extension://vaxlink-test/popup.html'
        }
      );
      const assigned = trace.rows.find(
        (row) =>
          row.event === 'grid_handoff' &&
          row.row === 3 &&
          row.result === 'assigned'
      );
      const wait = trace.rows.find(
        (row) =>
          row.event === 'grid_detail_decision' &&
          row.lotEvidence === 'native_no_match'
      );
      assert.equal(wait.operation, assigned.operation);
      assert.equal(wait.row, 3);
      assert.equal(wait.step, 1);
      assert.equal(wait.total, 3);
      assert.equal(wait.reordered, true);
      const takeover = trace.rows.find(
        (row) => row.event === 'grid_takeover' && row.trigger === 'tray_use'
      );
      assert.equal(takeover.operation, assigned.operation);
      assert.equal(takeover.trigger, 'tray_use');
      assert.equal(takeover.reservation, 'released');
    }
  }
});
