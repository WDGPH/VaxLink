import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(
  new URL('../extension/content.js', import.meta.url),
  'utf8'
);
function definition(name, async = false) {
  const match = source.match(
    new RegExp(`^${async ? 'async ' : ''}function ${name}\\([^]*?^}`, 'm')
  );
  assert.ok(match, `Missing production function ${name}`);
  return match[0];
}

function fixture() {
  const form = {
    isConnected: true,
    contains: (node) => node?.form === form,
    querySelectorAll: () => []
  };
  const state = {
    form,
    step: 'one',
    fills: 0,
    timers: [],
    now: 1000,
    resolved: false
  };
  const context = vm.createContext({
    state,
    Date: class extends Date {
      static now() {
        return state.now;
      }
    },
    document: { getElementById: () => null },
    location: { href: 'https://panorama.test/record' },
    getFields: () => [{ closest: () => state.form }],
    getPanoramaAgentSelectors: () => [],
    getPanoramaMultiStepIndicatorKey: () => state.step,
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    KeyboardEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
    isHandsFreeSupportedPage: () => true,
    handleVaxlinkCommand: () => false,
    parseGS1BarcodeFromScanner: () => ({ lot: 'LOT1' }),
    lookupVaccineInfoByLot: () => state.lookup,
    mergeVaccineInfoIntoParsed: () => {},
    getExpiryStatus: () => ({ flag: 'valid' }),
    logAnalyticsEvent: () => {},
    vlog: () => {},
    playAudioCue: () => {},
    getQueueStorageKeyForWorkflow: () => null,
    autoFillPanorama: () => {
      state.fills++;
      return { status: 'filled' };
    },
    isAutofillSuccess: () => true,
    isAutofillPending: () => false,
    getPanoramaTradeCandidates: () => [],
    getPanoramaAgentCandidates: () => [],
    hasPanoramaDeferredDetailData: () => true,
    hasPanoramaDeferredDetailFieldsFilled: () => state.resolved,
    fillPanoramaDeferredDetailFields: () => {
      state.fills++;
    },
    isPrimeFacesAjaxBusy: () => false,
    setTimeout: (callback, delay) => {
      callback.delay = delay;
      state.timers.push(callback);
      return state.timers.length;
    },
    clearTimeout: () => {},
    setInterval: () => 1,
    console
  });
  const names = [
    'getPanoramaAutofillForm',
    'beginPanoramaAutofill',
    'isPanoramaAutofillCurrent',
    'cancelPanoramaAutofill',
    'handlePanoramaAutofillUserInteraction',
    'runPanoramaAutofill',
    'assertPanoramaAutofillWrite',
    'fillPanoramaMaskedTextInput',
    'schedulePanoramaLotOrTradeSelection'
  ];
  vm.runInContext(
    `let panoramaAutofillOwner = null, panoramaWritingData = null;
    let stopPanoramaLotTradeWatcher = null, activeWorkflowMode = 'single';
    let lastHandledScanValue = '', lastHandledScanAt = 0;
    let adminDateTimeAutofillEnabled = false;
    ${names.map((name) => definition(name)).join('\n')}
    ${definition('handleHandsFreeScan', true)}
    globalThis.api = { beginPanoramaAutofill, isPanoramaAutofillCurrent,
      handlePanoramaAutofillUserInteraction, runPanoramaAutofill,
      fillPanoramaMaskedTextInput, handleHandsFreeScan, schedulePanoramaLotOrTradeSelection,
      setMode: (mode) => { activeWorkflowMode = mode; } };`,
    context
  );
  return { ...context.api, context, state, form };
}

function interaction(
  f,
  {
    inside = true,
    trusted = true,
    type = 'pointerdown',
    overlay = null,
    key,
    ctrlKey = false
  } = {}
) {
  const control = { form: inside ? f.form : {} };
  const target = {
    closest: (selector) => (selector.startsWith('input,') ? control : overlay)
  };
  f.handlePanoramaAutofillUserInteraction({
    isTrusted: trusted,
    type,
    target,
    key,
    ctrlKey
  });
}

test('newer fills and changed clinical context invalidate the previous owner', () => {
  for (const change of [
    (f) => f.beginPanoramaAutofill({}),
    (f) => {
      f.state.form = { isConnected: true };
    },
    (f) => {
      f.form.isConnected = false;
    },
    (f) => {
      f.context.location.href += '/other';
    },
    (f) => {
      f.state.step = 'two';
    },
    (f) => f.setMode('multiple')
  ]) {
    const f = fixture();
    const data = f.beginPanoramaAutofill({});
    assert.equal(f.isPanoramaAutofillCurrent(data), true);
    change(f);
    assert.equal(f.isPanoramaAutofillCurrent(data), false);
  }
});

test('manual interaction cancels only the active form or its linked overlay', () => {
  for (const options of [
    { inside: true },
    { inside: false, overlay: { id: 'agent_panel' }, linked: true },
    { inside: false, overlay: { id: 'linked-list' }, aria: true },
    { inside: true, type: 'keydown', key: 'a' }
  ]) {
    const f = fixture();
    const data = f.beginPanoramaAutofill({});
    if (options.linked)
      f.context.document.getElementById = () => ({ form: f.form });
    if (options.aria)
      f.form.querySelectorAll = () => [
        {
          getAttribute: (name) =>
            name === 'aria-controls' ? 'linked-list' : null
        }
      ];
    interaction(f, options);
    assert.equal(f.isPanoramaAutofillCurrent(data), false);
    assert.equal(
      f.isPanoramaAutofillCurrent(f.beginPanoramaAutofill({}, false)),
      false
    );
    assert.equal(
      f.isPanoramaAutofillCurrent(f.beginPanoramaAutofill({})),
      true
    );
  }
  for (const options of [
    { inside: false },
    { inside: false, overlay: { id: 'other_panel' } },
    { inside: true, trusted: false },
    { inside: true, type: 'keydown', key: 'Tab' },
    { inside: true, type: 'keydown', key: 'a', ctrlKey: true }
  ]) {
    const f = fixture();
    const data = f.beginPanoramaAutofill({});
    interaction(f, options);
    assert.equal(f.isPanoramaAutofillCurrent(data), true);
  }
});

test('form replacement during focus stops the next field write', () => {
  const f = fixture();
  const data = f.beginPanoramaAutofill({});
  const field = {
    value: 'original',
    focus() {
      f.state.form = { isConnected: true };
    }
  };
  assert.throws(
    () =>
      f.runPanoramaAutofill(data, () =>
        f.fillPanoramaMaskedTextInput(field, 'new')
      ),
    /Autofill stopped/
  );
  assert.equal(field.value, 'original');
});

test('a scan lookup resolving after manual takeover cannot start a fill', async () => {
  const f = fixture();
  let resolve;
  f.state.lookup = new Promise((done) => {
    resolve = done;
  });
  const pending = f.handleHandsFreeScan('scan');
  interaction(f);
  resolve({});
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(f.state.fills, 0);
});

test('a delayed retry cannot write after a newer fill takes ownership', () => {
  for (const invalidate of [false, true]) {
    const f = fixture();
    const data = f.beginPanoramaAutofill({});
    f.schedulePanoramaLotOrTradeSelection(data);
    f.state.timers.shift()(); // Start the retry watcher.
    const retry = f.state.timers.shift();
    if (invalidate) f.beginPanoramaAutofill({});
    retry();
    assert.equal(f.state.fills, invalidate ? 0 : 1);
  }
});

test('late corrective passes do not write after manual takeover', () => {
  for (const cancel of [false, true]) {
    const f = fixture();
    f.state.resolved = true;
    const data = f.beginPanoramaAutofill({});
    f.schedulePanoramaLotOrTradeSelection(data);
    f.state.timers.shift()();
    const retry = f.state.timers[0];
    retry();
    f.state.now += 800;
    retry();
    const late = f.state.timers.filter((timer) =>
      [1500, 3500].includes(timer.delay)
    );
    assert.equal(late.length, 2);
    if (cancel) interaction(f);
    for (const callback of late) callback();
    assert.equal(f.state.fills, cancel ? 0 : 2);
  }
});
