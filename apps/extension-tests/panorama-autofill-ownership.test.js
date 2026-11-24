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

test('one pending watcher restarts its stable interval after repairing details', () => {
  const f = fixture();
  f.state.resolved = true;
  let finalized = 0;
  f.context.finalizeDeferredPanoramaAutofill = () => finalized++;
  f.context.fillPanoramaDeferredDetailFields = () => {
    f.state.resolved = true;
    f.state.fills++;
  };
  const data = f.beginPanoramaAutofill({});
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
});

test('a chosen funding category waits for its Lot list and a miss can try the other category once', async () => {
  const f = fixture();
  const events = [];
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
    showVaxlinkToast: (data) => prompts.push(data._fundingChoiceRequired),
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
    showVaxlinkToast: (data) => notices.push(data._fillFeedback),
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
