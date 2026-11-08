import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createContentHarness } from './helpers/clinic-sim.js';

function fixture() {
  const form = {
    isConnected: true,
    contains(node) {
      return node?.form === this;
    },
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
  const globals = {
    state,
    Date: class extends Date {
      static now() {
        return state.now;
      }
    },
    document: { getElementById: () => null },
    location: new URL(
      'https://panorama.prod.ehealthontario.ca/ImmsWeb/pages/recordImms/form'
    ),
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
  };
  const { context, documentListeners, windowListeners } =
    createContentHarness(globals);
  // Replace only the page/catalogue dependencies for each case. Ownership and
  // its initial state come from the complete production script above.
  const { document, ...dependencies } = globals;
  Object.assign(context, dependencies);
  Object.assign(context.document, document);
  vm.runInContext('adminDateTimeAutofillEnabled = false;', context);
  return {
    ...context,
    context,
    state,
    form,
    documentListeners,
    windowListeners,
    setMode: context.updatePanoramaWorkflowMode
  };
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
  const control = { form: inside ? f.state.form : {} };
  const target = {
    closest: (selector) => (selector.startsWith('input,') ? control : overlay)
  };
  for (const listener of f.documentListeners.get(type))
    listener({
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
    (f) => f.windowListeners.get('pagehide').forEach((listener) => listener()),
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

test('page callbacks during a field write stop the next write', () => {
  for (const boundary of ['focus', 'input', 'change']) {
    const f = fixture();
    const data = f.beginPanoramaAutofill({});
    const next = { value: 'untouched' };
    const replace = () => {
      f.state.form = { isConnected: true };
    };
    const field = {
      value: 'original',
      focus() {
        if (boundary === 'focus') replace();
      },
      dispatchEvent(event) {
        if (event.type === boundary) replace();
      },
      blur() {}
    };
    assert.throws(
      () =>
        f.runPanoramaAutofill(data, () => {
          f.fillPanoramaMaskedTextInput(field, 'new');
          next.value = 'overwritten';
        }),
      /Autofill stopped/
    );
    assert.equal(next.value, 'untouched');
    if (boundary === 'focus') assert.equal(field.value, 'original');
    if (boundary === 'input') assert.equal(field.value, '');
  }
});

test('a funding click cannot fall through to a stale radio write', () => {
  const f = fixture();
  const data = f.beginPanoramaAutofill({});
  const box = {
    click() {
      f.state.form = { isConnected: true };
    }
  };
  const radio = {
    checked: false,
    closest: () => ({ querySelector: () => box })
  };
  f.context.document.querySelector = () => radio;
  assert.throws(
    () =>
      f.runPanoramaAutofill(data, () => f.setPanoramaFundedRadioValue('PF')),
    /Autofill stopped/
  );
  assert.equal(radio.checked, false);
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

// The form can change before an automatic observer has started its next fill.
test('manual takeover applies to a replacement form and before the first fill', () => {
  for (const oldOwner of [false, true]) {
    const f = fixture();
    if (oldOwner) f.beginPanoramaAutofill({});
    f.state.form = { ...f.form };
    interaction(f);
    assert.equal(
      f.isPanoramaAutofillCurrent(f.beginPanoramaAutofill({}, false)),
      false
    );
  }
});

test('mode transitions cannot revive an old fill and allow new-mode work', () => {
  const f = fixture();
  const old = f.beginPanoramaAutofill({});
  f.setMode('multiple');
  assert.equal(
    f.isPanoramaAutofillCurrent(f.beginPanoramaAutofill({}, false)),
    true
  );
  f.setMode('single');
  assert.equal(f.isPanoramaAutofillCurrent(old), false);
  assert.equal(
    f.isPanoramaAutofillCurrent(f.beginPanoramaAutofill({}, false)),
    true
  );
});

test('scanner context expires when the chart, form, or owner changes', () => {
  for (const change of [
    (f) => {
      f.state.form = { isConnected: true };
    },
    (f) => {
      f.context.location.href += '?new-chart';
    },
    (f) => {
      f.state.step = 'two';
    },
    (f) => {
      f.beginPanoramaAutofill({});
      f.beginPanoramaAutofill({});
    },
    (f) => {
      f.beginPanoramaAutofill({});
      interaction(f, { form: f.form });
    }
  ]) {
    const f = fixture();
    const token = f.getScannerDeliveryContext();
    assert.equal(f.isScannerDeliveryContextCurrent(token), true);
    change(f);
    assert.equal(f.isScannerDeliveryContextCurrent(token), false);
  }
});

test('manual edit of a newly probed replacement form invalidates its token', () => {
  const f = fixture();
  f.beginPanoramaAutofill({});
  f.state.form = { ...f.form };
  const token = f.getScannerDeliveryContext();
  interaction(f);
  assert.equal(f.isScannerDeliveryContextCurrent(token), false);
});
