import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  createContentHarness,
  deliverScannerScanToChart
} from './helpers/clinic-sim.js';

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
      'https://trpanoramadhir.prod.ehealthontario.ca/ImmsWeb/pages/recordImms/form'
    ),
    getFields: () => [{ closest: () => state.form }],
    getPanoramaAgentSelectors: () => [],
    getPanoramaMultiStepIndicatorKey: () => state.step,
    getPanoramaFormContext: () => ({ kind: 'provider_single', ready: true }),
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
    performance: { now: () => state.now },
    setTimeout: (callback, delay) => {
      callback.delay = delay;
      callback.at = state.now + delay;
      state.timers.push(callback);
      return callback;
    },
    clearTimeout: (callback) => {
      state.timers = state.timers.filter((timer) => timer !== callback);
    },
    console
  };
  const {
    context,
    documentListeners,
    windowListeners,
    storageListeners,
    messageListeners,
    storageReads
  } = createContentHarness(globals);
  // Replace only the page/catalogue dependencies for each case. Ownership and
  // its initial state come from the complete production script above.
  const { document, ...dependencies } = globals;
  Object.assign(context, dependencies);
  Object.assign(context.document, document);
  storageReads
    .find(({ keys }) => keys.includes('vaxlink_workflow_mode_v1'))
    .callback({});
  vm.runInContext(
    'adminDateAutofillEnabled = false; adminTimeAutofillEnabled = false;',
    context
  );
  return {
    ...context,
    context,
    state,
    form,
    documentListeners,
    windowListeners,
    storageListeners,
    messageListeners,
    runTimer(callback = state.timers[0]) {
      assert.ok(callback, 'expected a pending check');
      state.timers = state.timers.filter((timer) => timer !== callback);
      state.now = callback.at;
      return callback();
    },
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

test('a Lot selected while scan-order carry waits stops the fill', async () => {
  const f = fixture();
  const feedback = [];
  const data = f.beginPanoramaAutofill({ lot: 'SAMPLE-1' });
  data._vaxlinkOwner.gridDetail = { scanOrder: true };
  f.context.showCarryProblem = (message) => feedback.push(message);
  f.schedulePanoramaLotOrTradeSelection(data);
  f.context.readGridDetailLotEvidence = () => 'conflicting_selection';

  await f.runTimer();

  assert.equal(f.state.fills, 0);
  assert.equal(f.state.timers.length, 0);
  assert.match(feedback[0], /Panorama selected a different lot/);
});

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
    value: 'PUBLICLY_FUNDED',
    checked: false,
    closest: () => ({ querySelector: () => box })
  };
  f.form.querySelectorAll = () => [radio];
  assert.throws(
    () =>
      f.runPanoramaAutofill(data, () =>
        f.setPanoramaFundedRadioValue(radio.value)
      ),
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
  const pending = deliverScannerScanToChart(f, 'scan', 1100);
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
    const retry = f.state.timers[0];
    if (invalidate) f.beginPanoramaAutofill({});
    f.runTimer(retry);
    assert.equal(f.state.fills, invalidate ? 0 : 1);
  }
});

test('late corrective passes do not write after manual takeover', () => {
  for (const cancel of [false, true]) {
    const f = fixture();
    f.state.resolved = true;
    const data = f.beginPanoramaAutofill({});
    f.schedulePanoramaLotOrTradeSelection(data);
    f.runTimer();
    f.runTimer();
    f.runTimer();
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
test('a scanner receipt claims one outcome and late repair checks its foreground route', async () => {
  const f = fixture();
  const messages = [];
  const outcomes = [];
  let acknowledge;
  let started;
  const receiptStarted = new Promise((resolve) => {
    started = resolve;
  });
  let routeActive = true;
  f.context.showVaxlinkToast = () => {};
  f.context.logAnalyticsEvent = (event, values) => {
    if (event === 'autofill_result') outcomes.push(values.success);
  };
  f.context.chrome.runtime.sendMessage = async (message) => {
    messages.push(message);
    if (message.action === 'verifyScannerChartFields') {
      started();
      return new Promise((resolve) => {
        acknowledge = resolve;
      });
    }
    return { success: routeActive };
  };
  const fill = f.beginPanoramaAutofill({});
  fill._vaxlinkOwner.scannerDelivery = {
    captureId: 'scanner-capture',
    contextToken: 'owned-form',
    scannerRoute: { epoch: 'epoch', generation: 1, startBy: 5000 }
  };
  f.state.resolved = true;
  f.schedulePanoramaLotOrTradeSelection(fill, 0, { finalizeOnResolved: true });
  await f.runTimer();
  await f.runTimer();
  await f.runTimer();
  await receiptStarted;
  await f.context.finalizeDeferredPanoramaAutofill({ ...fill });
  assert.equal(
    messages.filter(({ action }) => action === 'verifyScannerChartFields')
      .length,
    1
  );
  acknowledge({ success: true });
  await new Promise(setImmediate);
  assert.deepEqual(outcomes, [true]);

  await f.runTimer();
  assert.equal(f.state.fills, 1);
  const late = messages.at(-1);
  assert.equal(late.action, 'checkScannerChart');
  assert.equal(late.captureId, undefined);
  routeActive = false;
  await f.runTimer();
  assert.equal(f.state.fills, 1);
  assert.deepEqual(outcomes, [true]);
});

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

test('overlapping context probes keep an in-transit scan valid on the same form', () => {
  const f = fixture();
  const scanA = f.getScannerDeliveryContext();
  const scanB = f.getScannerDeliveryContext();
  assert.ok(scanA);
  assert.equal(scanB, scanA);
  assert.equal(f.isScannerDeliveryContextCurrent(scanA), true);
});

test('popup focus preserves the deliberate chart context and retires the automatic route', () => {
  const f = fixture();
  f.beginPanoramaAutofill({}, true, { automatic: true });
  const kind = 'provider_single';
  const automatic = f.getScannerDeliveryContext(kind);
  const explicit = f.getScannerDeliveryContext(kind, true);
  f.windowListeners.get('blur').forEach((listener) => listener());
  assert.equal(f.isScannerDeliveryContextCurrent(automatic, kind), false);
  assert.equal(f.isScannerDeliveryContextCurrent(explicit, kind, true), true);
  f.context.document.visibilityState = 'hidden';
  f.documentListeners.get('visibilitychange').forEach((listener) => listener());
  f.context.document.visibilityState = 'visible';
  assert.equal(f.isScannerDeliveryContextCurrent(explicit, kind, true), false);
  const changed = f.getScannerDeliveryContext(kind, true);
  interaction(f);
  assert.equal(f.isScannerDeliveryContextCurrent(changed, kind, true), false);
});

test('context changes rotate the token and cannot revive an in-transit scan', () => {
  for (const change of [
    (f) => f.setMode('multiple'),
    (f) => interaction(f),
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
    const replacement = f.getScannerDeliveryContext();
    assert.notEqual(replacement, token);
    assert.equal(f.isScannerDeliveryContextCurrent(replacement), true);
    assert.equal(f.getScannerDeliveryContext(), replacement);
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
test('formulation-specific vaccines do not match the broader Agent on a detail step', () => {
  const { context } = createContentHarness();
  assert.equal(context.isAgentTextAccepted('MMR', 'MMRV'), false);
  assert.equal(
    context.isAgentTextAccepted('HB', 'Hepatitis B [HB-pediatric]'),
    false
  );
  assert.equal(
    context.isAgentTextAccepted('HB-pediatric', 'Hepatitis B [HB-pediatric]'),
    true
  );
  for (const [record, intended, different] of [
    [
      { tradename: 'ProQuad', antigen: 'Measles, mumps, rubella, varicella' },
      'MMR-Var',
      'MMR'
    ],
    [
      { tradename: 'Engerix-B', antigen: 'Hepatitis B', strength: '10' },
      'HB-pediatric',
      'HB'
    ],
    [
      { tradename: 'Recombivax HB', antigen: 'Hepatitis B', strength: '10' },
      'HB',
      'HB-pediatric'
    ]
  ]) {
    assert.equal(
      context.queueRecordMatchesPanoramaAgentText(record, intended),
      true
    );
    assert.equal(
      context.queueRecordMatchesPanoramaAgentText(record, different),
      false
    );
  }
});

test('a scanner lookup stays held after focus, workflow, or deadline changes', async () => {
  for (const interrupt of [
    (f) => {
      const token = f.getScannerDeliveryContext();
      f.windowListeners.get('blur').forEach((listener) => listener());
      // The chart reports focus again before the catalogue reply arrives.
      assert.equal(f.isScannerDeliveryContextCurrent(token), false);
    },
    (f) => f.setMode('inventory'),
    (f) => {
      f.state.now += 100;
    }
  ]) {
    const f = fixture();
    let resolve;
    f.state.lookup = new Promise((done) => {
      resolve = done;
    });
    const actions = [];
    f.context.chrome.runtime.sendMessage = async ({ action }) => {
      actions.push(action);
      return { success: true };
    };
    const pending = deliverScannerScanToChart(f, 'scan', 1100);
    interrupt(f);
    resolve({});
    const result = await pending;
    assert.equal(result.accepted, false);
    assert.equal(result.status, 'cancelled');
    assert.equal(f.state.fills, 0);
    assert.deepEqual(actions, []);
  }
});

test('an owned field interaction before the deadline can continue on the same chart', () => {
  const f = fixture();
  const data = f.beginPanoramaAutofill({}, true, {
    automatic: true,
    startBy: 1100
  });
  const field = { value: '', focus() {}, dispatchEvent() {}, blur() {} };
  f.runPanoramaAutofill(data, () =>
    f.fillPanoramaMaskedTextInput(field, '2026/11/24')
  );
  f.state.now = 1100;
  assert.equal(field.value, '2026/11/24');
  assert.equal(f.isPanoramaAutofillCurrent(data), true);
  f.windowListeners.get('blur').forEach((listener) => listener());
  assert.equal(f.isPanoramaAutofillCurrent(data), false);
});

test('one pending watcher restarts stability and reports both late checks', async () => {
  const f = fixture();
  f.state.resolved = true;
  let finalized = 0;
  const observations = [];
  const activity = vm.runInContext('chartActivity', f.context);
  activity.isCurrent = () => true;
  activity.record = (_trace, event, fields) =>
    observations.push({ event, ...fields });
  f.context.hasPanoramaDeferredDetailFieldsFilled = (_data, observed) => {
    if (observed)
      Object.assign(observed, {
        time: f.state.resolved ? 'match' : 'mismatch',
        reason: 'not_requested'
      });
    return f.state.resolved;
  };
  f.context.observePanoramaDetail = () => ({
    time: f.state.resolved ? 'complete' : 'blank'
  });
  f.context.finalizeDeferredPanoramaAutofill = () => finalized++;
  f.context.fillPanoramaDeferredDetailFields = () => {
    f.state.resolved = true;
    f.state.fills++;
    return 1;
  };
  const data = f.beginPanoramaAutofill({});
  data._vaxlinkOwner.activity = {};
  f.schedulePanoramaLotOrTradeSelection(data, 0, { finalizeOnResolved: true });
  assert.equal(f.state.timers.length, 1);
  f.runTimer();
  f.state.resolved = false;
  f.runTimer();
  assert.equal(f.state.fills, 1);
  assert.equal(finalized, 0);
  assert.equal(f.state.timers.length, 1);
  f.runTimer();
  assert.equal(finalized, 0, 'the repair starts another stability wait');
  f.runTimer();
  assert.equal(finalized, 1);
  assert.deepEqual(
    f.state.timers.map((timer) => timer.delay),
    [1500, 3500]
  );
  f.state.resolved = false;
  await f.runTimer();
  f.context.fillPanoramaDeferredDetailFields = () => 0;
  await f.runTimer();
  const late = observations.filter(({ wake }) => wake === 'late');
  assert.deepEqual(
    observations
      .filter((row) => row.event === 'late_readback')
      .map((row) => [row.delay, row.result]),
    [
      [1500, 'restored'],
      [3500, 'still_populated']
    ]
  );
  assert.equal(late.length, 2);
  assert.equal(late[0].deferredCheck.before.time, 'mismatch');
  assert.equal(late[0].deferredCheck.after.time, 'match');
  assert.equal(finalized, 1);
});

test('detail readbacks distinguish the painted reason from the native value across a funding refresh', () => {
  const f = fixture();
  const data = f.beginPanoramaAutofill({});
  const owner = data._vaxlinkOwner;
  owner.activity = {};
  const rows = [];
  const activity = vm.runInContext('chartActivity', f.context);
  activity.isCurrent = (trace) => trace === owner.activity;
  activity.record = (_trace, event, fields) => rows.push({ event, ...fields });
  const field = {
    id: 'reason_input',
    value: '1',
    options: [{ text: 'Routine' }],
    selectedIndex: 0
  };
  let label = { form: f.form, textContent: 'Select One' };
  let timeField = { value: '09:__' };
  let funding = 'SHOW_ALL';
  const list = { control: {}, rows: [] };
  Object.assign(f.context, {
    getFields: (selectors) =>
      selectors[0].includes('reasonForImmunization') ? [field] : [],
    getPanoramaAdministeredDateTimeFields: () => ({ timeField }),
    getPanoramaFundedRadioValue: () => funding,
    readPanoramaLotList: () => ({ ...list, rows: [...list.rows] }),
    isVisible: () => true,
    getComputedStyle: () => ({ visibility: 'visible' })
  });
  f.context.document.getElementById = () => label;
  f.observePanoramaDetail(data);
  funding = 'PUBLICLY_FUNDED';
  label = { ...label, textContent: 'Routine' };
  list.rows.push({ node: {}, text: 'training option' });
  timeField = { value: '09:30' };
  f.observePanoramaDetail(data);
  f.observePanoramaDetail(data);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    [rows[0].native, rows[0].visible, rows[0].time],
    ['requested', 'blank', 'partial']
  );
  assert.deepEqual(
    [rows[1].funding, rows[1].visible, rows[1].time],
    ['PUBLICLY_FUNDED', 'requested', 'complete']
  );
  assert.deepEqual(Array.from(rows[1].changed), ['label', 'time', 'lot']);
  assert.doesNotMatch(JSON.stringify(rows), /09:30|training option|Routine/);
  let onAjax;
  f.context.jsf = {
    ajax: {
      addOnEvent: (fn) => {
        assert.equal(onAjax, undefined);
        onAjax = fn;
      }
    }
  };
  f.observePanoramaAjax();
  f.observePanoramaAjax();
  f.context.getPanoramaAutofillForm = () => f.form;
  for (const source of [
    { form: f.form, id: 'foo:fundedRadio:bar' },
    { form: {}, id: 'outside' }
  ]) {
    onAjax({ status: 'begin', source });
    onAjax({ status: 'success', source });
  }
  assert.deepEqual(rows.slice(2), [
    { event: 'ajax_complete', source: 'funding' }
  ]);
});

test('a chosen funding category waits for its Lot list and a miss can try the other category once', async () => {
  const f = fixture();
  const events = [];
  const cleanupModes = [];
  const handlers = new Map();
  const selected = { funding: 'SHOW_ALL', lot: false };
  const select = { options: [{ text: 'OLD', value: 'other-lot' }] };
  let searches = 0;
  let rescueStartedAt;
  const slot = {
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll() {
      return ['PUBLICLY_FUNDED', 'NON_PUBLICLY_FUNDED']
        .filter((choice) =>
          this.innerHTML.includes(`data-vl-funded-choice="${choice}"`)
        )
        .map((choice) => ({
          getAttribute: () => choice,
          addEventListener: (_event, callback) => handlers.set(choice, callback)
        }));
    }
  };
  Object.assign(f.context, {
    testSlot: slot,
    ensureToastHost() {},
    escapeToastHtml: (text) => text,
    isPanoramaImmunizationPage: () => true,
    getPanoramaFundedRadioValue: () => selected.funding,
    setPanoramaFundedRadioValue: (choice) => {
      selected.funding = choice;
      return 'clicked';
    },
    getPanoramaLotWidget: () => ({ select }),
    hasPanoramaLotSelection: () => selected.lot,
    tryFillPanoramaLotOrTrade(_data, { panelRescue }) {
      searches++;
      if (panelRescue) rescueStartedAt ??= f.state.now;
      selected.lot = select.options[0].text === 'N-TRAIN';
      return selected.lot;
    },
    clearPanoramaNonMatchingLot(_data, { resetAgent }) {
      cleanupModes.push(resetAgent);
      return 'review';
    },
    logAnalyticsEvent: (event, payload) => events.push({ event, payload }),
    playAudioCue() {},
    isAutofillSuccess: (result) => result?.status === 'success',
    isAutofillPending: (result) => result?.status === 'pending'
  });
  // Use the actual autofill entry point for the initial and alternate choices.
  f.context.autoFillPanorama = (data) =>
    f.context.runPanoramaAutofill(data, () =>
      f.context.fillPanoramaImmunizationFields(data)
    );
  vm.runInContext('toastRoutineSlot = testSlot;', f.context);
  f.context.applyAutofillSettings({ vaxlink_auto_resolve_funding_v1: false });
  f.state.resolved = true;
  const data = f.beginPanoramaAutofill({ lot: 'TRAIN' });
  const initial = f.context.autoFillPanorama(data);
  assert.equal(initial.reason, 'funding_choice_required');
  assert.equal(searches, 0);
  const choosePublic = handlers.get('PUBLICLY_FUNDED');
  await choosePublic();
  await choosePublic();
  f.runTimer();
  f.runTimer();
  assert.equal(searches, 0, 'the old list is still on the form');
  select.options[0].text = 'DIFFERENT LOT';
  for (let attempt = 0; attempt < 15 && f.state.timers.length; attempt++)
    f.runTimer();
  assert.match(slot.innerHTML, /Try the other funding category/);
  assert.deepEqual(cleanupModes, [false]);
  assert.match(slot.innerHTML, /Check the Agent and Lot on the chart/);
  assert.equal(rescueStartedAt, 3000, 'panel rescue starts after two seconds');
  assert.equal(
    f.state.now - rescueStartedAt,
    3000,
    'a usable list must remain unchanged for three seconds'
  );
  assert.doesNotMatch(
    slot.innerHTML,
    /data-vl-funded-choice="PUBLICLY_FUNDED"/
  );
  assert.equal(
    events.filter(({ event }) => event === 'autofill_result').length,
    0
  );
  await handlers.get('NON_PUBLICLY_FUNDED')();
  f.runTimer();
  select.options[0].text = 'N-TRAIN';
  for (let attempt = 0; attempt < 8 && f.state.timers.length; attempt++)
    f.runTimer();
  await Promise.resolve();
  assert.equal(
    events.filter(({ event }) => event === 'funding_prompt_shown').length,
    2
  );
  assert.equal(
    events.filter(({ event }) => event === 'funding_choice_made').length,
    2
  );
  assert.equal(
    events.filter(({ event }) => event === 'funding_comparison').length,
    0
  );
  assert.deepEqual(
    events
      .filter(({ event }) => event === 'autofill_result')
      .map(({ payload }) => payload.success),
    [true]
  );
});

test('a delayed funding choice rechecks the scanner route and the same form before filling', async () => {
  for (const outcome of ['same chart', 'changed form', 'rejected route']) {
    const f = fixture();
    const { promise, resolve } = Promise.withResolvers();
    let click;
    let checks = 0;
    let resumed;
    const slot = {
      innerHTML: '',
      querySelector: () => null,
      querySelectorAll: () => [
        {
          getAttribute: () => 'NON_PUBLICLY_FUNDED',
          addEventListener: (_event, handler) => (click = handler)
        }
      ]
    };
    Object.assign(f.context, {
      testSlot: slot,
      ensureToastHost() {},
      escapeToastHtml: (text) => text,
      isAutofillPending: (result) => result?.status === 'pending',
      checkPanoramaScannerRoute: () => {
        checks += 1;
        return promise;
      },
      autoFillPanorama: (data) => {
        resumed = data._fundedRadioChoice;
        return { status: 'pending' };
      }
    });
    vm.runInContext('toastRoutineSlot = testSlot;', f.context);
    const data = f.beginPanoramaAutofill({ lot: 'LOT1' }, true, {
      automatic: true,
      startBy: f.state.now + 10
    });
    data._vaxlinkOwner.scannerDelivery = { captureId: 'scan' };
    f.showVaxlinkToast({ ...data, _fundingChoiceRequired: 'manual' });
    f.state.now += 60_000;
    const pending = click();
    await click();
    assert.equal(checks, 1, outcome);
    assert.equal(resumed, undefined);
    if (outcome === 'changed form') f.state.form = { ...f.form };
    resolve(outcome !== 'rejected route');
    await pending;
    assert.equal(
      resumed,
      outcome === 'same chart' ? 'NON_PUBLICLY_FUNDED' : undefined,
      outcome
    );
  }
});

test('automatic comparison waits for the Agent refresh before offering both funding choices', () => {
  const f = fixture();
  const select = {
    options: [
      { text: 'TRAIN', value: 'public' },
      { text: 'N-TRAIN', value: 'private' }
    ]
  };
  const reports = [];
  const prompts = [];
  let agentMatches = false;
  Object.assign(f.context, {
    panoramaDetailAgentMatches: () => agentMatches,
    tryFillPanoramaAgent: () => (agentMatches = true),
    getPanoramaLotWidget: () => ({ select }),
    getPanoramaFundedRadioValue: () => 'SHOW_ALL',
    tryFillPanoramaLotOrTrade: () =>
      assert.fail('both entries need staff choice'),
    showVaxlinkToast: (data) => {
      if (data._fundingChoiceRequired)
        prompts.push(data._fundingChoiceRequired);
    },
    logAnalyticsEvent: (event, payload) =>
      reports.push([event, payload.outcome])
  });
  f.schedulePanoramaLotOrTradeSelection(
    f.beginPanoramaAutofill({ lot: 'TRAIN' })
  );
  f.runTimer();
  f.runTimer();
  assert.deepEqual(prompts, []);
  select.options[0].text = 'TRAIN - Exp. 2099-01-31';
  f.runTimer();
  assert.deepEqual(prompts, ['both']);
  assert.deepEqual(reports, [['funding_comparison', 'both']]);
  assert.equal(f.state.timers.length, 0);
});

test('turning automatic funding off stops a pending Lot selection', () => {
  const f = fixture();
  f.context.initHandsFreeScanner();
  const onChange = f.storageListeners.at(-1);
  const data = f.beginPanoramaAutofill({ lot: 'TRAIN' });
  f.schedulePanoramaLotOrTradeSelection(data);
  assert.equal(f.state.timers.length, 1);
  onChange(
    { vaxlink_auto_resolve_funding_v1: { oldValue: true, newValue: false } },
    'local'
  );
  assert.equal(f.context.isPanoramaAutofillCurrent(data), false);
  assert.equal(f.state.timers.length, 0);
});

test('an unreadable Lot list does not establish a miss before the ten-second deadline', () => {
  const f = fixture();
  const reports = [];
  const notices = [];
  Object.assign(f.context, {
    getPanoramaLotWidget: () => null,
    hasPanoramaLotSelection: () => false,
    tryFillPanoramaLotOrTrade: () => false,
    showVaxlinkToast: (data) => {
      if (data._fillFeedback) notices.push(data._fillFeedback);
    },
    logAnalyticsEvent: (event, payload) =>
      reports.push([event, payload.success])
  });
  const data = f.beginPanoramaAutofill({ lot: 'TRAIN' });
  const started = f.state.now;
  f.schedulePanoramaLotOrTradeSelection(data, 0, { finalizeOnResolved: true });
  for (let attempt = 0; attempt < 24 && f.state.timers.length; attempt++)
    f.runTimer();
  assert.equal(f.state.now - started, 10000);
  assert.deepEqual(notices, ['deadline']);
  assert.deepEqual(reports, [['autofill_result', false]]);
  assert.equal(f.state.timers.length, 0);
});

test('a Lot miss first observed late uses the current list at the deadline', () => {
  for (const replaceAtDeadline of [false, true]) {
    const f = fixture();
    const notices = [];
    const reports = [];
    const select = { options: [] };
    let cleanups = 0;
    Object.assign(f.context, {
      getPanoramaLotWidget: () => ({ select }),
      hasPanoramaLotSelection: () => false,
      tryFillPanoramaLotOrTrade: () => false,
      clearPanoramaNonMatchingLot: () => {
        cleanups++;
        return 'review';
      },
      showVaxlinkToast: (data) => {
        if (data._fillFeedback)
          notices.push([data._fillFeedback, data._lotNeedsReview]);
      },
      logAnalyticsEvent: (event, payload) => {
        if (event === 'autofill_result') reports.push(payload.success);
      }
    });
    const data = f.beginPanoramaAutofill({ lot: 'TRAIN' });
    const started = f.state.now;
    f.schedulePanoramaLotOrTradeSelection(data, 0, {
      finalizeOnResolved: true
    });
    while (f.state.now - started < 7500) f.runTimer();
    select.options = [{ text: 'OTHER', value: 'other' }];
    while (f.state.now - started < 9500) f.runTimer();
    assert.deepEqual(notices, []);
    if (replaceAtDeadline) select.options = [];
    f.runTimer();
    assert.equal(f.state.now - started, 10000);
    assert.deepEqual(
      notices,
      replaceAtDeadline
        ? [['deadline', undefined]]
        : [['lot_not_matched', true]]
    );
    assert.equal(cleanups, replaceAtDeadline ? 0 : 1);
    assert.deepEqual(reports, [false]);
    assert.equal(f.state.timers.length, 0);
  }
});

test('a counted detail miss releases a blank Lot only before a possible product selection', async () => {
  for (const selected of [false, true]) {
    const f = fixture();
    const notices = [],
      changes = [];
    const select = {
      isConnected: true,
      options: [{ text: 'OTHER', value: 'other' }]
    };
    Object.assign(f.context, {
      getPanoramaFormContext: () => ({ kind: 'multiple_detail', ready: true }),
      getPanoramaCurrentAgentSelectionText: () => 'Training',
      getPanoramaLotWidget: () => ({ select }),
      hasPanoramaLotSelection: () => false,
      tryFillPanoramaLotOrTrade: () => false,
      cleanUpPanoramaLotMiss: () => 'empty',
      showVaxlinkToast: (data) => notices.push(data),
      mutateQueueViaBackground: async (_key, op, payload) => {
        changes.push([op, payload.written]);
        return { rows: [{ id: 'record' }] };
      }
    });
    const data = f.beginPanoramaAutofill({ lot: 'TRAIN' });
    Object.assign(data._vaxlinkOwner, {
      trayDose: { reserved: true, token: 'dose', recordId: 'record' },
      writeAttempted: true,
      sawMatchingLot: selected
    });
    vm.runInContext("activeTrayReservations.add('dose')", f.context);
    f.schedulePanoramaLotOrTradeSelection(data, 0, {
      finalizeOnResolved: true
    });
    while (f.state.timers.length) await f.runTimer();
    await new Promise(setImmediate);
    assert.deepEqual(changes, [['stop_dose', selected]]);
    assert.equal(
      notices.some((n) => n._doseKept),
      !selected
    );
  }
});

test('a repeatedly repaired Time shows detail progress after the Lot matches', () => {
  const f = fixture();
  const notices = [];
  let lotMatches = false;
  Object.assign(f.context, {
    hasPanoramaLotSelection: () => lotMatches,
    tryFillPanoramaLotOrTrade: () => false,
    fillPanoramaDeferredDetailFields() {
      f.state.resolved = true;
      return 1;
    },
    getPanoramaDeferredDetailFieldsNeedingReview: () => ['time'],
    showVaxlinkToast(data) {
      notices.push([
        data._fillProgress || data._fillFeedback,
        data._reviewFields
      ]);
    }
  });
  const data = f.beginPanoramaAutofill({ lot: 'TRAIN' });
  f.schedulePanoramaLotOrTradeSelection(data, 0, { finalizeOnResolved: true });
  f.runTimer();
  f.runTimer();
  f.runTimer();
  assert.deepEqual(notices, [['retrying', undefined]]);

  lotMatches = true;
  while (f.state.timers.length) {
    f.state.resolved = false;
    f.runTimer();
  }
  assert.deepEqual(notices.slice(0, 2), [
    ['retrying', undefined],
    ['checking_details', undefined]
  ]);
  assert.equal(notices.length, 3);
  assert.equal(notices[2][0], 'deadline_details');
  assert.deepEqual(notices[2][1], ['time']);
});

test('a changed Multiple detail Agent permanently cancels deliberate and carried Lot fills', () => {
  for (const automatic of [false, true]) {
    const f = fixture();
    let selected = 'Hepatitis B [HB]';
    const agent = { form: f.form };
    f.context.getPanoramaFormContext = () => ({
      kind: 'multiple_detail',
      ready: true
    });
    f.context.isPanoramaChartActive = () => true;
    f.context.getPanoramaDetailAgentFields = () => [agent];
    f.context.getPanoramaSelectedAgentTexts = () => [selected];
    const fill = f.beginPanoramaAutofill({ lot: 'LOT1' }, true, { automatic });
    assert.equal(f.isPanoramaAutofillCurrent(fill), true);
    selected = '[HB] Hepatitis B';
    assert.equal(f.isPanoramaAutofillCurrent(fill), true);
    selected = 'Hepatitis B Pediatric [HB-pediatric]';
    for (const listener of f.documentListeners.get('change'))
      listener({ isTrusted: false, type: 'change', target: agent });
    selected = 'Hepatitis B [HB]';
    assert.equal(
      f.context.runPanoramaAutofill(fill, () =>
        assert.fail('old Lot fill wrote after the original Agent returned')
      ),
      false
    );
  }
});
