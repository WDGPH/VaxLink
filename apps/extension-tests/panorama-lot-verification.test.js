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

function fixture(browserWindow) {
  const state = {
    controls: [],
    funding: [],
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
      if (selector.includes('fundedRadio:selectOneRadio')) return state.funding;
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
      window: browserWindow,
      MouseEvent: FormEvent,
      Event: FormEvent,
      getComputedStyle: () => ({ visibility: 'visible' })
    });
  context.window.confirm = () => true;
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
    2,
    2
  );
  assert.equal(match.allowEmptyFinalLot, true);
  assert.equal(context.matchesGridDetail({ ...entry, ...match }), true);
  field.value = 'lot-option';
  assert.equal(context.matchesGridDetail({ ...entry, ...match }), false);
});

test('scan order can distinguish repeats after Delete when the detail count agrees', () => {
  const { context, state, root, select } = fixture();
  const date = '2026/11/24';
  context.getPanoramaCurrentAgentSelectionText = () => 'MMR';
  context.getPanoramaAdministeredDateTimeFields = () => ({
    dateField: { value: date }
  });
  const rows = ['SAMPLE-1', 'SAMPLE-2'].map((lot) => ({
    agent: 'mmr',
    date,
    entry: { lot }
  }));
  const field = select('SAMPLE-1');
  field.options.push({ text: 'SAMPLE-2', value: 'other-lot' });
  state.controls = [root, field];
  const form = context.getPanoramaAutofillForm();

  const afterDelete = { rows, deletedRows: [{ agent: 'hb', date }] };
  const first = context.identifyGridDetail(afterDelete, form, 1, 2);
  assert.equal(first.row, rows[0]);
  assert.equal(first.scanOrder, true);

  field.value = 'other-lot';
  assert.equal(
    context.identifyGridDetail(afterDelete, form, 1, 2).reason,
    'detail_lot_unconfirmed',
    'the selected Lot conflicts with scan order'
  );
  field.value = '';
  assert.equal(
    context.identifyGridDetail(afterDelete, form, 1, 1).reason,
    'duplicate_agent',
    'a missing row makes the remaining order uncertain'
  );

  rows[1].date = '2026/11/25';
  const distinct = context.identifyGridDetail(afterDelete, form, 1, 2);
  assert.equal(distinct.row, rows[0]);
  assert.equal(distinct.scanOrder, false);
});

test('same-count reorder requires exact Lot evidence and uses scan order for tracked repeats', () => {
  const { context, state, root, select } = fixture();
  const date = '2026/11/24';
  let detailAgent = 'HPV';
  context.getPanoramaCurrentAgentSelectionText = () => detailAgent;
  context.getPanoramaAdministeredDateTimeFields = () => ({
    dateField: { value: '2026-11-24' }
  });
  const entry = { agent: 'hpv', date, lot: 'SAMPLE-1', dose: { record: {} } };
  const row = { agent: entry.agent, date, entry };
  const rows = [
    row,
    { agent: 'mmr', date },
    { agent: 'hpv', date: '2026/11/25' }
  ];
  const field = select('SAMPLE-1');
  state.controls = [root, field];
  const form = context.getPanoramaAutofillForm();
  const match = () => context.identifyGridDetail({ rows }, form, 3, 3);

  assert.equal(match().row, row);
  assert.equal(match().requireLotEvidence, true);
  assert.equal(match().allowEmptyFinalLot, false);
  const carried = { ...entry, ...match() };
  assert.equal(context.matchesGridDetail(carried), true);
  detailAgent = 'HPV alias';
  context.queueRecordMatchesPanoramaAgentText = () => true;
  assert.equal(context.matchesGridDetail(carried), false);
  detailAgent = 'HPV';
  context.queueRecordMatchesPanoramaAgentText = () => false;

  field.options[1].disabled = true;
  assert.equal(match().lotEvidence, 'disabled');
  field.options[1].disabled = false;
  field.options[1].text = 'SAMPLE1';
  assert.equal(match().lotEvidence, 'native_no_match');
  field.options[1].text = 'SAMPLE-1';

  rows[1] = { agent: 'hpv', date };
  assert.equal(match().reason, 'duplicate_agent', 'a manual row can compete');
  rows[1].entry = { lot: 'OTHER' };
  assert.equal(match().reason, 'duplicate_agent', 'even with different Lots');
  row.record = {};
  rows[1].record = {};
  const opening = context.identifyGridDetail(
    { rows: [rows[2], row, rows[1]], verifiedThrough: 0 },
    form,
    1,
    3
  );
  assert.equal(opening.row, row);
  assert.equal(opening.scanOrder, true);
  assert.equal(
    context.identifyGridDetail(
      { rows, detailReordered: true, verifiedThrough: 1 },
      form,
      3,
      3
    ).reason,
    'duplicate_agent',
    'scan order cannot fill after a missed detail'
  );
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
  agent.value = 'lot-option';
  f.label.textContent = 'STALE OTHER LOT';
  assert.equal(cleanup(), 'changed');
  assert.equal(
    agent.value,
    '',
    'a stale Lot label does not keep an owned Agent'
  );
  assert.equal(field.value, '', 'the blank native Lot was left alone');
  f.label.textContent = 'Select';
  owner.initialAgent = 'owned agent';
  agent.value = 'lot-option';
  assert.equal(cleanup(), 'empty');
  assert.equal(
    agent.value,
    'lot-option',
    'a pre-existing Agent stays selected'
  );
});

test('a failed search can leave a pre-existing nonmatching lot unchanged', () => {
  const { context, state, select, label, root } = fixture();
  const field = select('OTHER');
  field.value = 'lot-option';
  label.textContent = 'OTHER';
  state.controls = [root, field];
  context.getPanoramaCurrentAgentSelectionText = () => 'MMR';
  const owner = {
    form: context.getPanoramaAutofillForm(),
    initialLot: 'OTHER',
    initialAgreedLot: 'OTHER',
    initialAgent: 'MMR'
  };
  assert.equal(
    context.lotMissLeftSelectionAlone(owner, 'review', 'TARGET'),
    true
  );
  label.textContent = 'MISMATCH';
  assert.equal(
    context.lotMissLeftSelectionAlone(owner, 'review', 'TARGET'),
    false
  );
  label.textContent = '';
  assert.equal(
    context.lotMissLeftSelectionAlone(owner, 'review', 'TARGET'),
    false
  );
  label.textContent = 'OTHER';
  assert.equal(
    context.lotMissLeftSelectionAlone(owner, 'review', 'OTHER'),
    false
  );
  assert.equal(
    context.lotMissLeftSelectionAlone(
      { ...owner, sawMatchingLot: true },
      'review',
      'TARGET'
    ),
    false
  );
});

test('the clear action requires a visible and editable Lot control', () => {
  const { context, state, select, label, root } = fixture();
  const field = select('OTHER', 'lot-option');
  label.textContent = 'OTHER';
  state.controls = [root, field];
  root.getBoundingClientRect = shown;
  root.getAttribute = () => null;
  root.classList = { contains: () => false };
  const form = context.getPanoramaAutofillForm();
  assert.equal(context.getClearableGridLot(form).field, field);
  field.matches = (selector) => selector === ':disabled';
  assert.equal(context.getClearableGridLot(form), null);
  field.matches = () => false;
  root.getBoundingClientRect = () => ({ width: 0, height: 0 });
  assert.equal(context.getClearableGridLot(form), null);
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

test('Next clears a server-default wrong Lot on only a unique exact reordered detail', async () => {
  for (const scenario of [
    'default',
    'delayed label',
    'option replaced while waiting',
    'restored default',
    'counter only',
    'client choice',
    'visible mismatch',
    'duplicate identity',
    'target available',
    'staff takeover',
    'Lot replaced',
    'route changed'
  ]) {
    const { context, state, select, label, root } = fixture();
    const form = context.getPanoramaAutofillForm();
    const outgoing = select('PREVIOUS', 'lot-option');
    const field = select('WRONG', 'lot-option');
    const writes = [];
    const notices = [];
    const waits = [];
    const routeCheck = Promise.withResolvers();
    let routeChecks = 0;
    const delayed = ['delayed label', 'option replaced while waiting'].includes(
      scenario
    );
    const shouldClear = [
      'default',
      'delayed label',
      'restored default'
    ].includes(scenario);
    field.options[1].defaultSelected = scenario !== 'client choice';
    if (scenario === 'target available')
      field.options.push({ text: 'INTENDED', value: 'correct' });
    field.dispatchEvent = (event) => writes.push([event.type, field.value]);
    label.textContent = delayed
      ? 'Select'
      : scenario === 'visible mismatch'
        ? 'ANOTHER'
        : 'WRONG';
    label.isConnected = true;
    label.getBoundingClientRect = shown;
    root.getBoundingClientRect = shown;
    root.getAttribute = () => null;
    root.classList = { contains: () => false };
    state.controls = [root, field];
    state.step = '2-of-3';
    const date = '2026/11/24';
    const entry = { lot: 'INTENDED', date, route: {} };
    const row = { agent: 'mmr', date, entry };
    const handoff = {
      form,
      url: context.location.href,
      step: 1,
      position: '1-of-3',
      rows: [
        row,
        { agent: 'hpv', date },
        { agent: scenario === 'duplicate identity' ? 'mmr' : 'hb', date }
      ],
      deletedRows: [],
      navigation: {
        form,
        before: '1-of-3',
        after: '2-of-3',
        surface: scenario === 'counter only' ? field : outgoing,
        until: Infinity,
        report() {}
      }
    };
    Object.assign(context, {
      testHandoff: handoff,
      getPanoramaFormContext: () => ({ kind: 'multiple_detail', ready: true }),
      getPanoramaCurrentAgentSelectionText: () => 'MMR',
      getPanoramaAdministeredDateTimeFields: () => ({
        dateField: { value: date }
      }),
      checkPanoramaScannerRoute() {
        return ++routeChecks === 1 ? routeCheck.promise : true;
      },
      setTimeout(callback, delay) {
        if (delay === 700) waits.push(callback);
      },
      clearTimeout() {},
      showCarryProblem(message) {
        notices.push(message);
      }
    });
    vm.runInContext('gridDetailHandoff = testHandoff', context);

    if (delayed) {
      await context.advanceGridHandoff();
      assert.equal(routeChecks, 0);
      assert.deepEqual(writes, [], 'wait for the visible label to agree');
      if (scenario === 'option replaced while waiting')
        field.options[1] = { ...field.options[1] };
      label.textContent = 'WRONG';
    }
    const advance = context.advanceGridHandoff();
    await new Promise(setImmediate);
    if (scenario === 'staff takeover') context.cancelPanoramaAutofill();
    if (scenario === 'Lot replaced')
      state.controls = [root, select('WRONG', 'lot-option')];
    routeCheck.resolve(scenario !== 'route changed');
    await new Promise(setImmediate);
    if (shouldClear) {
      assert.deepEqual(writes, [
        ['input', ''],
        ['change', '']
      ]);
      assert.equal(label.textContent, 'Select');
      assert.equal(notices.length, 0, 'wait for Panorama to settle');
      if (scenario === 'restored default') {
        field.value = 'lot-option';
        label.textContent = 'WRONG';
      }
      waits.shift()();
    }
    await advance;
    if (shouldClear && scenario !== 'restored default')
      assert.match(notices[0], /cleared the preselected Lot/);
    else {
      if (!shouldClear) assert.deepEqual(writes, [], scenario);
      assert.equal(field.value, 'lot-option', scenario);
      assert.ok(notices.every((notice) => !notice.includes('cleared')));
    }
    assert.equal(outgoing.value, 'lot-option', scenario);
    assert.equal(row.entry, entry, 'keep the pending dose for Delete');
    assert.equal(handoff.attempted, undefined, 'no dose fill ran');
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
        lock_cycle:
          'VaxLink could not confirm the original chart. Check the chart and the Immunization tray.'
      }[scenario];
      assert.deepEqual(warnings, expected ? [expected] : [], scenario);
    }
    if (
      ['normal', 'manual_use', 'toolbar_blur', 'duplicate_agent'].includes(
        scenario
      )
    ) {
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

test('manual repeated Agents warn and guard both native Enter Details buttons', () => {
  const { context, documentListeners } = fixture();
  const form = context.getPanoramaAutofillForm();
  let dismiss;
  const warning = {
    innerHTML: '',
    get firstElementChild() {
      return this.innerHTML || null;
    },
    querySelector(selector) {
      assert.equal(selector, '[data-dismiss-repeated-grid]');
      return {
        addEventListener(type, callback) {
          assert.equal(type, 'click');
          dismiss = callback;
        }
      };
    },
    replaceChildren() {
      this.innerHTML = '';
    }
  };
  const agents = ['MMR', 'MMR'];
  const dates = ['2026/11/24', '2026/11/25'];
  const extraDate = { value: '' };
  let inGrid = true;
  let update;
  context.document.body = {};
  context.document.querySelectorAll = (selector) =>
    selector.includes('dataTable_data') ? [extraDate] : [];
  context.document.createElement = () =>
    assert.fail('the warning uses the VaxLink notification area');
  Object.assign(context, {
    repeatedAgentNotice: warning,
    ensureToastHost: () => {},
    isPanoramaMultipleImmunizationGridPage: () => inGrid,
    getPanoramaFormContext: () => ({ kind: 'multiple_grid' }),
    getPanoramaMultipleGridRows: () => rows,
    getPanoramaMultipleGridRowState: (index) => ({
      agentText: agents[index],
      dateText: dates[index]
    }),
    MutationObserver: class {
      constructor(callback) {
        update = callback;
      }
      observe() {}
    }
  });
  vm.runInContext('toastRepeatedAgentSlot = repeatedAgentNotice', context);
  const rows = agents.map((_, index) => ({
    getAttribute: () => String(index),
    getBoundingClientRect: shown
  }));
  const enter = (id) => {
    let blocked = false;
    for (const click of documentListeners.get('click')) {
      click({
        isTrusted: true,
        target: { closest: () => ({ id, form }) },
        preventDefault: () => (blocked = true),
        stopImmediatePropagation() {}
      });
    }
    return !blocked;
  };
  context.watchRepeatedGridAgents();
  const notice = warning.innerHTML;
  assert.match(notice, /class="vl-toast info persistent show" role="status"/);
  assert.match(notice, /same Agent/);
  assert.match(notice, />Dismiss</);
  assert.doesNotMatch(notice, /Remove row/);
  let confirmations = 0;
  context.window.confirm = (message) => {
    confirmations++;
    assert.match(message, /Continue with repeated agents.*review rows/);
    return false;
  };
  assert.equal(enter('_btnNextPage'), false);
  assert.equal(warning.innerHTML, notice);
  assert.equal(confirmations, 1);
  context.window.confirm = () => {
    dates[1] = '2026/11/26';
    return true;
  };
  assert.equal(
    enter('Bottom_btnNextPage'),
    false,
    'a changed grid needs review'
  );
  context.window.confirm = () => true;
  assert.equal(enter('Bottom_btnNextPage'), true);
  context.window.confirm = () =>
    assert.fail('the unchanged grid was just confirmed');
  assert.equal(enter('_btnNextPage'), true);
  dates[1] = '2026/11/28';
  update();
  context.window.confirm = () => false;
  assert.equal(
    enter('_btnNextPage'),
    false,
    'changing a date needs a new confirmation'
  );
  dismiss({ isTrusted: false });
  assert.equal(warning.innerHTML, notice);
  dismiss({ isTrusted: true });
  assert.equal(warning.innerHTML, '');
  context.window.confirm = () => assert.fail('Dismiss acknowledged this grid');
  assert.equal(enter('_btnNextPage'), true);
  assert.equal(enter('Bottom_btnNextPage'), true);
  extraDate.value = '2026/11/29';
  update();
  assert.equal(warning.innerHTML, notice);
  context.window.confirm = () => false;
  assert.equal(enter('Bottom_btnNextPage'), false);
  inGrid = false;
  update();
  assert.equal(warning.innerHTML, '');
  inGrid = true;
  update();
  assert.equal(warning.innerHTML, notice);
  agents[1] = 'HPV';
  update();
  assert.equal(warning.innerHTML, '');
  context.window.confirm = () => assert.fail('a unique grid needs no prompt');
  assert.equal(enter('_btnNextPage'), true);
});

test('Enter Details keeps skipped and ambiguous doses available while later matches can fill', async () => {
  const storageKey = 'multiple_inject_queue_v1';
  const date = '2026/11/24';
  for (const scenario of [
    'skipped_step',
    'shorter_list',
    'ambiguous_agent',
    'ordered_duplicates',
    'next_then_delete',
    'slow_next',
    'reset_grid',
    'repeated_recovery',
    'repeated_recovery_ambiguous',
    'repeated_recovery_later',
    'repeat_after_delete',
    'second_delete_with_repeats',
    'reordered_after_delete',
    'reordered_after_delete_missing_lot',
    'browser_history',
    'history_expired',
    'resolved_navigation_late',
    'anchor_before_detail',
    'anchor_after_writer',
    'anchor_without_witness',
    'back_after_anchor',
    'reordered_rows',
    'reordered_same_count',
    'reordered_same_count_repeats',
    'reordered_same_count_manual_repeat',
    'reordered_same_count_unverified_repeat',
    'manual_use_after_lot_wait',
    'unconfirmed_release'
  ]) {
    const backAfterAnchor = scenario === 'back_after_anchor';
    const silentAnchor = scenario === 'anchor_without_witness';
    const anchor = scenario.startsWith('anchor_') || backAfterAnchor;
    const navigationListeners = [];
    const {
      context,
      state,
      root,
      select,
      storageListeners,
      windowListeners,
      documentListeners
    } = fixture(
      anchor && {
        navigation: {
          addEventListener(type, listener) {
            assert.equal(type, 'navigate');
            navigationListeners.push(listener);
          }
        }
      }
    );
    const url = context.location.href;
    const form = context.getPanoramaAutofillForm();
    const tab = { id: 42, url, active: true };
    const repeatedDelete = scenario === 'second_delete_with_repeats';
    const repeatAfterDelete = scenario === 'repeat_after_delete';
    const sameCountReorder = scenario.startsWith('reordered_same_count');
    const manualRepeat = scenario === 'reordered_same_count_manual_repeat';
    const unverifiedRepeat =
      scenario === 'reordered_same_count_unverified_repeat';
    const reorderedRepeats =
      manualRepeat ||
      unverifiedRepeat ||
      scenario === 'reordered_same_count_repeats';
    const recovery = scenario.startsWith('repeated_recovery');
    const ambiguousRecovery = scenario === 'repeated_recovery_ambiguous';
    const laterRecovery = scenario === 'repeated_recovery_later';
    const deleteFirst =
      repeatedDelete ||
      repeatAfterDelete ||
      scenario.startsWith('reordered_after_delete');
    const agents = recovery
      ? [
          'MMR',
          'HPV',
          'MMR',
          ...(laterRecovery ? [] : [ambiguousRecovery ? 'MMR' : 'HPV'])
        ]
      : repeatedDelete || repeatAfterDelete
        ? ['HB', 'MMR', 'MMR']
        : [
            scenario.startsWith('reordered_after_delete') ? 'HPV' : 'MMR',
            scenario === 'ordered_duplicates' || deleteFirst ? 'MMR' : 'HPV',
            reorderedRepeats
              ? 'MMR'
              : ['ambiguous_agent', 'next_then_delete'].includes(scenario)
                ? 'HPV'
                : 'HB'
          ];
    const records = agents.map((agent, index) => ({
      id: String(index),
      lot: `SAMPLE-${index}`,
      generic_name: agent,
      ...(repeatAfterDelete && index === 0
        ? { dose_tracking: 'single_use' }
        : { remaining_doses: 2 })
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
    const newReservations = [];
    let blockedRoutes = 0;
    let release;
    let routeGate;
    context.chrome.runtime.sendMessage = (message, reply) => {
      if (
        anchor &&
        message.operation === 'reserve_dose' &&
        !message.payload.requireReservation
      )
        newReservations.push(message.payload.id);
      if (
        routeGate &&
        message.action === 'checkScannerChart' &&
        message.scannerRoute
      ) {
        blockedRoutes++;
        return routeGate.promise.then(() =>
          worker.sendMessage(message, sender)
        );
      }
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

    const gridAgents = agents.map(() => '');
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
    let detailAgent = sameCountReorder ? agents[1] : agents[reordered ? 2 : 0];
    let detailDate = reordered ? '2026-11-24' : date;
    let offeredLot = manualUse ? 'OTHER' : 'SAMPLE-2';
    let selectedLot = '';
    let retry;
    let navigationTimeout;
    let detailReady = true;
    let observeHandoff;
    const fills = [];
    const scanOrderNotices = [];
    const skippedNotices = [];
    const realFill = context.autoFillPanorama;
    const realLotWidget = context.getPanoramaLotWidget;
    let detailSelect;
    const replaceDetailSelect = () => {
      if (detailSelect) {
        detailSelect.isConnected = false;
        detailSelect.form = null;
      }
      detailSelect = {
        form,
        tagName: 'SELECT',
        isConnected: true,
        get value() {
          return selectedLot ? 'chosen' : '';
        },
        get selectedIndex() {
          return selectedLot ? 2 : -1;
        },
        get options() {
          return [
            { text: offeredLot, value: 'pf' },
            { text: `N-${offeredLot}`, value: 'npf' },
            ...(selectedLot ? [{ text: selectedLot, value: 'chosen' }] : [])
          ];
        }
      };
    };
    replaceDetailSelect();
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
        select: detailSelect
      }),
      autoFillPanorama(data) {
        fills.push(data);
        return { status: 'pending' };
      },
      showVaxlinkToast(data) {
        if (data._carryScanOrder) scanOrderNotices.push(state.step);
      },
      handleUnusedSkippedDose(record, canRemove, token) {
        skippedNotices.push({ ...record, canRemove, token });
      },
      setTimeout(callback, delay) {
        if (delay === 500) retry = callback;
        if (delay === 10000) navigationTimeout = callback;
        return 1;
      },
      clearTimeout() {},
      MutationObserver: class {
        constructor(callback) {
          observeHandoff = callback;
        }
        observe() {}
        disconnect() {}
      }
    });

    if (manualUse || deleteFirst || anchor || scenario === 'reset_grid') {
      const changes = { vaxlink_recent_activity_enabled: { newValue: true } };
      for (const listener of storageListeners) listener(changes, 'local');
      await new Promise(setImmediate);
    }
    const orderedScans = scenario === 'ordered_duplicates';
    const gridToken = orderedScans && context.getScannerDeliveryContext(kind);
    const route =
      orderedScans &&
      (await worker.sendMessage({ action: 'checkScannerChart' }, sender))
        .scannerRoute;
    for (const { id } of records) {
      if (manualRepeat && id === '2') {
        gridAgents[2] = agents[2];
        continue;
      }
      const result = await context.useTrayVaccine(
        id,
        gridToken || context.getScannerDeliveryContext(kind, true),
        route ? { ...route, startBy: Date.now() + 10000 } : null
      );
      assert.equal(result.status, 'grid_added', scenario);
    }
    if (orderedScans) {
      context.cancelPanoramaAutofill();
      await assert.rejects(
        context.useTrayVaccine(records[0].id, gridToken, {
          ...route,
          startBy: Date.now() + 10000
        }),
        /ready for entry/
      );
    }
    const popup = {
      id: 'vaxlink-test',
      url: 'chrome-extension://vaxlink-test/popup.html'
    };
    if (scenario === 'reset_grid') {
      const reset = (isTrusted, ownerForm) =>
        context.startGridHandoff({
          isTrusted,
          target: { closest: () => ({ value: 'Reset', form: ownerForm }) }
        });
      reset(false, form);
      reset(true, {});
      assert.ok(saved().every((row) => row.dose_reservations?.length === 1));
      reset(true, form);
      await new Promise(setImmediate);
      assert.ok(saved().every((row) => !row.dose_reservations));
      assert.equal(saved().length, 3);
      assert.equal(fills.length, 0);
      vm.runInContext('chartActivity.flush()', context);
      const { rows } = await worker.sendMessage(
        { action: 'exportRecentActivity' },
        popup
      );
      const actions = rows.filter(
        ({ event }) => event === 'multiple_form_action'
      );
      assert.equal(actions.length, 1);
      assert.equal(actions[0].action, 'reset');
      assert.equal(actions[0].result, 'selected');
      continue;
    }
    const clickAction = (textContent, id) => {
      const target = { closest: () => ({ textContent, id, form }) };
      let prevented = false;
      for (const type of ['pointerdown', 'click']) {
        for (const listener of documentListeners.get(type))
          listener({
            type,
            isTrusted: true,
            target,
            preventDefault: () => (prevented = true),
            stopImmediatePropagation() {}
          });
      }
      return !prevented;
    };
    assert.equal(clickAction('Enter Details'), true);
    if (scenario === 'shorter_list') {
      visibleRows = [gridRows[0], gridRows[2]];
      await context.advanceGridHandoff();
    }
    kind = 'multiple_detail';
    state.step = reordered ? '1-of-2' : `1-of-${agents.length}`;
    if (recovery) {
      const reservations = saved().map((row) => row.dose_reservations[0].token);
      const history = () => windowListeners.get('popstate')[0]();
      let lot = select('OTHER-LOT', 'lot-option');
      context.getPanoramaLotWidget = () => ({ select: lot });
      context.document.querySelector = (selector) =>
        selector.includes('LotInfo:lotNumberSelect:selectOneMenu_input')
          ? lot
          : null;
      await context.advanceGridHandoff();
      assert.deepEqual(fills, []);
      assert.equal(lot.value, 'lot-option', 'the current Lot stays selected');
      assert.equal(clickAction('', 'Bottom_btnRemoveNext'), true);
      state.step = `1-of-${agents.length - 1}`;
      await context.advanceGridHandoff();
      assert.deepEqual(fills, [], 'the counter alone does not confirm Delete');
      if (laterRecovery) {
        detailAgent = 'HPV';
        lot = select('SAMPLE-1', 'lot-option');
        await context.advanceGridHandoff();
        assert.equal(fills[0]?.lot, 'SAMPLE-1');
        await context.finalizeDeferredPanoramaAutofill(fills[0]);
        assert.equal(clickAction('', '_btnApplyAddNext'), true);
        state.step = '2-of-2';
        detailAgent = 'MMR';
        lot = select('SAMPLE-2');
        lot.options.push({ text: 'SAMPLE-0', value: 'deleted-lot' });
        await context.advanceGridHandoff();
        assert.equal(
          fills.length,
          1,
          'the skipped Lot still competes after Next'
        );
        assert.equal(lot.value, '');
        assert.equal(saved()[2].dose_reservations[0].token, reservations[2]);
        context.clearGridCarry();
        continue;
      }
      lot = select('SAMPLE-2');
      lot.options.push({ text: 'SAMPLE-0', value: 'deleted-lot' });
      await context.advanceGridHandoff();
      assert.deepEqual(fills, [], 'both offered Lots leave the row ambiguous');
      lot.value = 'lot-option';
      await context.advanceGridHandoff();
      await new Promise(setImmediate);
      assert.equal(skippedNotices[0]?.canRemove, false);
      assert.ok(saved().some(({ id }) => id === '0'));
      if (ambiguousRecovery) {
        assert.deepEqual(fills, []);
        assert.ok(
          saved()
            .slice(1)
            .every(({ dose_reservations }) => dose_reservations?.length === 1)
        );
        context.clearGridCarry();
        continue;
      }
      assert.equal(fills[0]?.lot, 'SAMPLE-2');
      await context.finalizeDeferredPanoramaAutofill(fills[0]);

      assert.equal(clickAction('', 'Bottom_btnApplyAddNext'), true);
      await new Promise(setImmediate);
      history();
      assert.equal(saved()[1].dose_reservations?.length, 1);
      detailAgent = 'HPV';
      state.step = '2-of-3';
      lot = select('OTHER-1');
      for (const index of [2, 3, 4, 5, 6])
        lot.options.push({ text: `OTHER-${index}`, value: `other-${index}` });
      lot.dispatchEvent = () =>
        assert.fail('missing Lot must leave the chart blank');
      const timers = new Set();
      let now = performance.now();
      Object.assign(context, {
        autoFillPanorama: realFill,
        getPanoramaSelectedAgentTexts: () => [detailAgent],
        getPanoramaAdministeredDateTimeFields: () => ({
          dateField: { value: detailDate },
          timeField: { value: '09:30' }
        }),
        performance: { now: () => now },
        setTimeout(callback, delay) {
          const timer = { callback, at: now + delay };
          timers.add(timer);
          return timer;
        },
        clearTimeout: (timer) => timers.delete(timer)
      });
      const settle = async () => {
        await context.advanceGridHandoff();
        for (let attempt = 0; attempt < 40 && timers.size; attempt++) {
          const timer = [...timers].sort((a, b) => a.at - b.at)[0];
          timers.delete(timer);
          now = timer.at;
          await timer.callback();
          await new Promise(setImmediate);
        }
      };
      await settle();
      assert.equal(saved()[1].dose_reservations, undefined);
      assert.equal(saved()[1].remaining_doses, 2);
      assert.equal(lot.value, '');
      const unused = vm.runInContext(
        'panoramaAutofillOwner.unusedDose',
        context
      );
      assert.equal((await unused)?.id, '1');
      assert.equal(clickAction('', '_btnRemoveNext'), true);
      lot = select('SAMPLE-3', 'lot-option');
      state.step = '2-of-2';
      await context.advanceGridHandoff();
      await new Promise(setImmediate);
      history();
      await settle();
      assert.deepEqual(
        skippedNotices.map(({ id, canRemove, token }) => [
          id,
          canRemove,
          token
        ]),
        [
          ['0', false, reservations[0]],
          ['1', true, reservations[1]]
        ]
      );
      assert.deepEqual(
        saved().map(({ remaining_doses }) => remaining_doses),
        [2, 2, 1, 1]
      );
      assert.ok(saved().every(({ dose_reservations }) => !dose_reservations));
      continue;
    }
    if (deleteFirst) {
      if (!repeatAfterDelete)
        await context.releaseGridDetailStep('staff_input');
      assert.equal(clickAction('Delete'), true);
      assert.equal(skippedNotices.length, 0);
      windowListeners.get('popstate')[0]();
      state.step = '1-of-2';
      detailAgent = agents[2];
      replaceDetailSelect();
      if (repeatedDelete) selectedLot = 'SAMPLE-2';
      if (repeatAfterDelete) {
        detailReady = false;
        await context.advanceGridHandoff();
        assert.equal(skippedNotices.length, 0);
        await assert.rejects(
          context.mutateQueueViaBackground(storageKey, 'remove', {
            id: '0',
            expectedSingleUseLot: 'SAMPLE-0'
          }),
          /original chart/
        );
        detailReady = true;
      }
      await context.advanceGridHandoff();
      if (repeatAfterDelete) {
        await new Promise(setImmediate);
        assert.deepEqual(
          skippedNotices.map(({ id }) => id),
          ['0']
        );
        assert.ok(saved().some(({ id }) => id === '0'));
        assert.equal(fills[0]?.lot, 'SAMPLE-1');
        await context.finalizeDeferredPanoramaAutofill(fills[0]);
        assert.equal(clickAction('Next'), true);
        state.step = '2-of-2';
        replaceDetailSelect();
        await context.advanceGridHandoff();
        assert.equal(fills[1]?.lot, 'SAMPLE-2');
        await context.finalizeDeferredPanoramaAutofill(fills[1]);
        assert.deepEqual(scanOrderNotices, ['1-of-2', '2-of-2']);
        const remove = (lot) =>
          context.mutateQueueViaBackground(storageKey, 'remove', {
            id: '0',
            expectedSingleUseLot: lot
          });
        await assert.rejects(remove('DIFFERENT'), /dose changed/);
        await assert.rejects(
          context.mutateQueueViaBackground(storageKey, 'remove', {
            id: '1',
            expectedSingleUseLot: 'SAMPLE-1'
          }),
          /dose changed/
        );
        await remove('SAMPLE-0');
        assert.deepEqual(
          saved().map((dose) => [dose.id, dose.remaining_doses]),
          [
            ['1', 1],
            ['2', 1]
          ]
        );
        vm.runInContext('chartActivity.flush()', context);
        const { rows } = await worker.sendMessage(
          { action: 'exportRecentActivity' },
          popup
        );
        assert.deepEqual(
          rows
            .filter(
              ({ action, result }) =>
                action === 'delete' &&
                ['selected', 'step_changed'].includes(result)
            )
            .map(({ result, total }) => [result, total]),
          [
            ['selected', 3],
            ['step_changed', 2]
          ]
        );
        assert.ok(
          rows.some(
            ({ event, scanOrder }) =>
              event === 'grid_detail_decision' && scanOrder
          )
        );
        continue;
      }
      if (repeatedDelete) {
        assert.equal(fills.length, 0);
        assert.equal(saved()[0].dose_reservations, undefined);
        assert.equal(clickAction('Delete'), true);
        state.step = '1-of-1';
        replaceDetailSelect();
        selectedLot = '';
        await context.advanceGridHandoff();
        assert.equal(fills.length, 0);
        for (const dose of saved().slice(1)) {
          assert.equal(dose.remaining_doses, 2);
          assert.equal(dose.dose_reservations.length, 1);
        }
        context.clearGridCarry();
        await new Promise(setImmediate);
        continue;
      }
      assert.deepEqual(
        fills.map(({ lot }) => lot),
        ['SAMPLE-2']
      );
      await context.finalizeDeferredPanoramaAutofill(fills[0]);
      assert.equal(clickAction('Next'), true);
      state.step = '2-of-2';
      detailAgent = agents[1];
      replaceDetailSelect();

      // Panorama returned an enabled, blank Lot select containing other lots.
      // The grid can match this detail without proving the dose can be filled.
      const lot = select('OTHER-1 - Exp. 2099-01-31');
      for (const index of [2, 3, 4, 5, 6]) {
        lot.options.push({
          text: `${index === 6 ? 'N-' : ''}OTHER-${index} - Exp. 2099-01-31`,
          value: `other-${index}`
        });
      }
      const writes = [];
      lot.dispatchEvent = (event) => writes.push([event.type, lot.value]);
      let currentLot = lot;
      let ajaxBusy = false;
      state.controls = [root, lot];
      context.document.querySelector = (selector) =>
        selector.includes('LotInfo:lotNumberSelect:selectOneMenu_input')
          ? currentLot
          : null;
      const fundingClicks = [];
      state.funding = [
        'SHOW_ALL',
        'PUBLICLY_FUNDED',
        'NON_PUBLICLY_FUNDED'
      ].map((value) => ({
        value,
        checked: false,
        closest: () => ({
          querySelector: () => ({ click: () => fundingClicks.push(value) })
        })
      }));
      const feedback = [];
      const timers = new Set();
      let now = performance.now();
      Object.assign(context, {
        autoFillPanorama: realFill,
        getPanoramaLotWidget: realLotWidget,
        getPanoramaSelectedAgentTexts: () => [detailAgent],
        isPrimeFacesAjaxBusy: () => ajaxBusy,
        getPanoramaAdministeredDateTimeFields: () => ({
          dateField: { value: detailDate },
          timeField: { value: '09:30' }
        }),
        showVaxlinkToast: (data) => feedback.push(data),
        performance: { now: () => now },
        setTimeout(callback, delay) {
          const timer = { callback, at: now + delay };
          timers.add(timer);
          return timer;
        },
        clearTimeout: (timer) => timers.delete(timer)
      });
      const tick = async () => {
        const timer = [...timers].sort((a, b) => a.at - b.at)[0];
        assert.ok(timer, 'the Lot watcher should still be running');
        timers.delete(timer);
        now = timer.at;
        await timer.callback();
        await new Promise(setImmediate);
      };
      assert.equal(context.getPanoramaLotWidget()?.select, lot);
      assert.equal(
        context.readGridDetailLotEvidence('SAMPLE-1', true),
        'blank_final'
      );
      await context.advanceGridHandoff();
      await tick();
      assert.deepEqual(writes, []);
      assert.equal(saved()[1].remaining_doses, 2);
      assert.equal(saved()[1].dose_reservations.length, 1);

      const missingLot = scenario === 'reordered_after_delete_missing_lot';
      if (!missingLot) {
        // Panorama's partial response can replace the whole detail widget.
        ajaxBusy = true;
        lot.isConnected = false;
        currentLot = select('SAMPLE-1 - Exp. 2099-01-31');
        currentLot.options[1].value = 'requested-lot';
        currentLot.dispatchEvent = (event) =>
          writes.push([event.type, currentLot.value]);
        state.controls = [root, currentLot];
        await tick();
        assert.deepEqual(writes, []);
        assert.equal(saved()[1].remaining_doses, 2);
        ajaxBusy = false;
      }
      for (let attempt = 0; attempt < 40 && timers.size; attempt++)
        await tick();

      assert.deepEqual(fundingClicks, []);
      assert.deepEqual(
        writes,
        missingLot
          ? []
          : [
              ['input', 'requested-lot'],
              ['change', 'requested-lot']
            ]
      );
      assert.deepEqual(
        saved().map(({ remaining_doses }) => remaining_doses),
        [2, missingLot ? 2 : 1, 1]
      );
      assert.equal(saved()[1].dose_reservations, undefined);
      assert.equal(lot.value, '', 'the original Lot select stays untouched');
      if (missingLot) {
        const notice = feedback.find(
          ({ _fillFeedback }) => _fillFeedback === 'lot_not_matched'
        );
        assert.equal(notice?._doseKept, true);
      }

      vm.runInContext('chartActivity.flush()', context);
      const { rows } = await worker.sendMessage(
        { action: 'exportRecentActivity' },
        {
          id: 'vaxlink-test',
          url: 'chrome-extension://vaxlink-test/popup.html'
        }
      );
      const decision = rows.find(
        ({ event, step, reordered }) =>
          event === 'grid_detail_decision' && step === 2 && reordered
      );
      assert.equal(decision?.row, 2);
      assert.equal(decision.lotEvidence, 'blank_final');
      const operation = rows.filter(
        ({ operation }) => operation === decision.operation
      );
      const end = operation.find(({ event }) => event === 'lot_search_end');
      const release = operation.find(
        ({ event }) => event === 'lot_tray_release'
      );
      if (missingLot) {
        const { result, control, count, funding, site } = end;
        assert.deepEqual(
          [result, control, count, funding, site],
          ['target_absent', 'select', 6, '', 'training']
        );
        assert.equal(release?.result, 'released');
        assert.doesNotMatch(JSON.stringify([end, release]), /SAMPLE-1|OTHER-/);
      } else {
        assert.equal(end, undefined);
        assert.equal(release, undefined);
        assert.ok(
          operation.some(
            ({ event, reason }) => event === 'stop' && reason === 'settled'
          )
        );
      }
      continue;
    }

    if (scenario === 'ordered_duplicates') {
      // A different Agent and a conflicting Lot cannot select a reservation.
      detailAgent = agents[2];
      selectedLot = 'SAMPLE-0';
      await context.advanceGridHandoff();
      assert.equal(fills.length, 0);
      detailAgent = agents[0];
      selectedLot = '';
      for (const [index, { lot }] of records.entries()) {
        state.step = `${index + 1}-of-3`;
        detailAgent = agents[index];
        if (index === 1) {
          selectedLot = 'SAMPLE-0';
          await context.advanceGridHandoff();
          assert.equal(fills.length, 1);
          assert.equal(saved()[1].remaining_doses, 2);
          assert.equal(selectedLot, 'SAMPLE-0');
          selectedLot = '';
        }
        await context.advanceGridHandoff();
        await context.advanceGridHandoff();
        assert.equal(fills.length, index + 1);
        assert.equal(fills[index].lot, lot);
        await context.finalizeDeferredPanoramaAutofill(fills[index]);
      }
      assert.deepEqual(
        saved().map(({ remaining_doses }) => remaining_doses),
        [1, 1, 1]
      );
      assert.deepEqual(scanOrderNotices, ['1-of-3', '2-of-3']);
      continue;
    }
    if (sameCountReorder) {
      const pendingRoute = Promise.withResolvers();
      routeGate = pendingRoute;
      offeredLot = records[1].lot;
      const pendingFill = context.advanceGridHandoff();
      await new Promise(setImmediate);
      offeredLot = records[0].lot;
      routeGate = null;
      pendingRoute.resolve();
      await pendingFill;
      assert.equal(fills.length, 0, 'the Lot changed during the route check');

      for (const [index, recordIndex] of [1, 0, 2].entries()) {
        if (index) {
          assert.equal(clickAction('Next'), true);
          replaceDetailSelect();
        }
        state.step = `${index + 1}-of-3`;
        detailAgent = agents[recordIndex];
        offeredLot = records[recordIndex].lot;
        if (reorderedRepeats && index === 1 && !manualRepeat) {
          selectedLot = records[2].lot;
          await context.advanceGridHandoff();
          assert.equal(
            fills.length,
            1,
            'a conflicting Lot leaves the scan pending'
          );
          assert.equal(selectedLot, records[2].lot);
          selectedLot = '';
        }
        await context.advanceGridHandoff();
        if (manualRepeat && index) {
          assert.equal(fills.length, 1, 'a manual row still competes');
          continue;
        }
        if (unverifiedRepeat && index === 2) {
          assert.equal(fills.length, 2, 'the previous dose did not verify');
          continue;
        }
        assert.equal(fills.length, index + 1);
        assert.equal(fills[index].lot, offeredLot);
        if (!unverifiedRepeat || index !== 1)
          await context.finalizeDeferredPanoramaAutofill(fills[index]);
      }
      if (manualRepeat || unverifiedRepeat) {
        context.clearGridCarry();
        await new Promise(setImmediate);
      }
      assert.deepEqual(
        saved().map(({ remaining_doses }) => remaining_doses),
        manualRepeat || unverifiedRepeat ? [2, 1, 2] : [1, 1, 1]
      );
      assert.ok(saved().every(({ dose_reservations }) => !dose_reservations));
      assert.deepEqual(
        scanOrderNotices,
        unverifiedRepeat
          ? ['2-of-3']
          : reorderedRepeats && !manualRepeat
            ? ['2-of-3', '3-of-3']
            : []
      );
      continue;
    }
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

    if (anchor) {
      const settled = () => new Promise(setImmediate);
      const reservations = () =>
        saved()
          .slice(1)
          .map((row) => row.dose_reservations?.[0]?.token);
      const held = reservations();
      assert.ok(held.every(Boolean));
      const outgoing = detailSelect;
      const event = (type, urls) => {
        for (const listener of windowListeners.get(type))
          listener({ type, isTrusted: true, ...urls });
      };
      const navigate = (
        destinationUrl,
        navigationType = 'push',
        hashChange = true
      ) => {
        for (const listener of navigationListeners)
          listener({
            isTrusted: true,
            hashChange,
            navigationType,
            destination: { sameDocument: true, url: destinationUrl }
          });
        context.location.href = destinationUrl;
      };
      const anchorUrl = new URL('#topPageAnchor', url).href;
      const anchorEvents = () => {
        event('popstate');
        event('hashchange', { oldURL: url, newURL: context.location.href });
      };
      const installIncoming = () => {
        offeredLot = records[1].lot;
        replaceDetailSelect();
        observeHandoff();
      };

      assert.equal(clickAction('', 'Bottom_btnApplyAddNext'), true);
      state.step = '2-of-3';
      detailAgent = agents[1];
      observeHandoff();
      await settled();
      assert.equal(fills.length, 1, 'the outgoing Lot still belongs to step 1');
      assert.equal(outgoing.isConnected, true);
      assert.equal(form.contains(outgoing), true);

      if (scenario === 'anchor_before_detail') {
        navigate(anchorUrl);
        anchorEvents();
        await settled();
        assert.deepEqual(reservations(), held, 'wait for the replacement Lot');
        assert.equal(fills.length, 1);
      }
      if (backAfterAnchor) {
        routeGate = Promise.withResolvers();
      }
      if (backAfterAnchor || silentAnchor) {
        navigate(anchorUrl, 'push', !silentAnchor);
      }
      installIncoming();
      await settled();
      if (silentAnchor) {
        assert.equal(
          fills.length,
          1,
          'a silent URL change cannot authorize a fill'
        );
        event('popstate');
        await settled();
        assert.equal(
          fills.length,
          1,
          'history without a native anchor witness cannot authorize a fill'
        );
        assert.deepEqual(reservations(), [undefined, undefined]);
        assert.deepEqual(
          newReservations,
          records.map(({ id }) => id)
        );
        continue;
      }
      if (scenario !== 'anchor_before_detail') {
        if (scenario === 'anchor_after_writer') {
          assert.equal(fills[1]?.lot, records[1].lot);
          navigate(anchorUrl);
        }
        anchorEvents();
        await settled();
      }

      if (backAfterAnchor) {
        assert.equal(blockedRoutes, 1);
        assert.deepEqual(reservations(), held);
        const oldURL = context.location.href;
        navigate(url, 'traverse');
        event('popstate');
        event('hashchange', { oldURL, newURL: url });
        await settled();
        assert.deepEqual(reservations(), [undefined, undefined]);
        routeGate.resolve();
        routeGate = null;
        await settled();
        assert.equal(fills.length, 1, 'Back revokes the pending route reply');
        assert.deepEqual(reservations(), [undefined, undefined]);
      } else {
        assert.deepEqual(
          fills.map(({ lot }) => lot),
          [records[0].lot, records[1].lot]
        );
        assert.deepEqual(reservations(), held);
        assert.equal(
          context.isPanoramaAutofillCurrent(fills[1]),
          true,
          scenario
        );
        await context.finalizeDeferredPanoramaAutofill(fills[1]);
        assert.deepEqual(reservations(), [undefined, held[1]], scenario);
      }
      assert.equal(outgoing.isConnected, false);
      assert.deepEqual(
        saved().map(({ remaining_doses }) => remaining_doses),
        backAfterAnchor ? [1, 2, 2] : [1, 1, 2]
      );
      assert.deepEqual(
        newReservations,
        records.map(({ id }) => id)
      );
      vm.runInContext('chartActivity.flush()', context);
      const { rows } = await worker.sendMessage(
        { action: 'exportRecentActivity' },
        popup
      );
      const results = rows
        .filter(({ action }) => action === 'next')
        .map(({ result }) => result);
      assert.deepEqual(
        results.filter((result) => result.startsWith('anchor_')),
        ['anchor_popstate', 'anchor_hashchange']
      );
      assert.equal(
        results.filter((result) => result === 'step_changed').length,
        1
      );
      assert.equal(results.includes('marker_armed'), true);
      assert.equal(results.includes('history_rejected'), backAfterAnchor);
      assert.equal(
        rows.filter(
          ({ event, result }) =>
            event === 'grid_handoff' && result === 'reservation_released'
        ).length,
        backAfterAnchor ? 2 : 0
      );
      continue;
    }

    if (
      [
        'next_then_delete',
        'slow_next',
        'browser_history',
        'history_expired',
        'resolved_navigation_late'
      ].includes(scenario)
    ) {
      const history = () => windowListeners.get('popstate')[0]();
      if (scenario !== 'browser_history')
        assert.equal(clickAction('', 'Bottom_btnApplyAddNext'), true);
      history();
      if (scenario === 'history_expired')
        context.performance = { now: () => Number.MAX_SAFE_INTEGER };
      state.step = '2-of-3';
      detailAgent = agents[1];
      replaceDetailSelect();
      if (scenario === 'slow_next') {
        let now = performance.now();
        context.performance = { now: () => now };
        const pendingRoute = Promise.withResolvers();
        routeGate = pendingRoute;
        const pendingFill = context.advanceGridHandoff();
        await new Promise(setImmediate);
        const pending = saved()[1].dose_reservations[0].token;
        assert.equal(clickAction('', 'Bottom_btnApplyAddNext'), true);
        // The route reply arrives while Panorama still shows the form we submitted.
        routeGate = null;
        pendingRoute.resolve();
        await pendingFill;
        assert.equal(saved()[1].dose_reservations[0].token, pending);
        assert.equal(saved()[1].remaining_doses, 2);
        assert.equal(fills.length, 1);
        now += 10001;
        navigationTimeout();
        await context.advanceGridHandoff();
        assert.equal(
          fills.length,
          1,
          'a timeout does not authorize an old write'
        );
        await new Promise(setImmediate);
        assert.equal(saved()[1].dose_reservations, undefined);

        state.step = '3-of-3';
        detailAgent = agents[2];
        await context.advanceGridHandoff();
        assert.equal(fills.length, 1, 'a late replacement cannot resume carry');
        await new Promise(setImmediate);
        assert.equal(saved()[1].remaining_doses, 2);
        assert.equal(saved()[1].dose_reservations, undefined);
        assert.equal(saved()[2].remaining_doses, 2);
        continue;
      }
      await context.advanceGridHandoff();
      if (scenario === 'resolved_navigation_late') {
        assert.equal(fills[1]?.lot, 'SAMPLE-1');
        await context.finalizeDeferredPanoramaAutofill(fills[1]);
        context.performance = { now: () => performance.now() + 10001 };
        state.step = '3-of-3';
        detailAgent = agents[2];
        await context.advanceGridHandoff();
        await new Promise(setImmediate);
        assert.equal(fills.length, 2, 'another step needs a new action');
        assert.equal(saved()[2].dose_reservations, undefined);
        continue;
      }
      if (scenario !== 'next_then_delete') {
        assert.equal(fills.length, 1);
        await new Promise(setImmediate);
        assert.ok(saved().every(({ dose_reservations }) => !dose_reservations));
        continue;
      }
      assert.equal(fills[1].lot, 'SAMPLE-1');
      assert.equal(clickAction('', '_btnRemoveNext'), true);
      // A Delete may leave the old detail on screen until Panorama responds.
      await context.advanceGridHandoff();
      assert.equal(fills.length, 2);
      state.step = '2-of-2';
      detailAgent = agents[2];
      replaceDetailSelect();
      selectedLot = 'SAMPLE-1';
      await context.advanceGridHandoff();
      assert.equal(
        fills.length,
        2,
        'a deleted dose still makes a conflicting lot unsafe'
      );
      selectedLot = '';
      await context.advanceGridHandoff();
      history();
      assert.equal(fills[2].lot, 'SAMPLE-2');
      await context.finalizeDeferredPanoramaAutofill(fills[2]);
      assert.deepEqual(
        saved().map(({ remaining_doses }) => remaining_doses),
        [1, 2, 1]
      );
      continue;
    }

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
      context.clearGridCarry();
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
      assert.equal(wait.total, 2);
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
