import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentHarness } from './helpers/clinic-sim.js';

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
  const { context } = createContentHarness({
    MouseEvent: FormEvent,
    Event: FormEvent
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
  return { context, state, select, run, panel, label, root };
}

test('Lot labels distinguish prefix lots and preserve expiry, funding, and punctuation formats', () => {
  const { context } = fixture();
  for (const text of [
    'ABC1',
    'ABC-1 - Exp. 2028-03-31',
    'AB/C.1 (Non-Publicly Funded)',
    'ABC1 — NPF',
    'ABC1 | Publicly Funded'
  ]) {
    assert.equal(context.panoramaLotLabelMatches(text, 'ABC1'), true, text);
  }
  for (const text of ['ABC12', 'ABC-12 - Exp. 2028-03-31', 'AB9 (PF)']) {
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
    resetPanoramaFundedRadioToShowAll: () => 'not_found',
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
  assert.equal(f.context.autoFillPanorama(owned).status, 'pending');
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
