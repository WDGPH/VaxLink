import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(
  new URL('../extension/content.js', import.meta.url),
  'utf8'
);
const ownerCode = source.slice(
  source.indexOf('// Tokens identify only'),
  source.indexOf('function setupMessageListener')
);
const fn = (name) =>
  source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'))[0];

function testForm() {
  const owners = [];
  const form = {
    isConnected: true,
    contains: (node) => node?.ownerForm === form,
    querySelectorAll: () => owners
  };
  const control = {
    ownerForm: form,
    closest(selector) {
      return selector.startsWith('input,') ? this : null;
    }
  };
  return { form, control, owners };
}

function setup() {
  let id = 0;
  let { form, control, owners } = testForm();
  let field = {
    get form() {
      return form;
    },
    closest: () => form
  };
  let release;
  const lookup = new Promise((resolve) => {
    release = resolve;
  });
  let fills = 0;
  const context = vm.createContext({
    toastHost: null,
    hudHost: null,
    crypto: { randomUUID: () => String(++id) },
    window: { location: { href: 'https://example/recordImms/' } },
    document: { querySelectorAll: () => [field] },
    isHandsFreeSupportedPage: () => true,
    stopPanoramaLotTradeWatcher: null,
    activeWorkflowMode: 'single',
    lastHandledScanValue: '',
    lastHandledScanAt: 0,
    handleVaxlinkCommand: () => false,
    vlog() {},
    logAnalyticsEvent() {},
    playAudioCue() {},
    parseGS1BarcodeFromScanner: () => ({ lot: 'LOT' }),
    lookupVaccineInfoByLot: () => lookup,
    getExpiryStatus: () => ({ flag: 'valid' }),
    getQueueStorageKeyForWorkflow: () => null,
    adminDateTimeAutofillEnabled: false,
    autoFillPanorama: () => {
      fills++;
      return { status: 'failed' };
    },
    isAutofillSuccess: () => false,
    isAutofillPending: () => false,
    showVaxlinkToast() {},
    console
  });
  vm.runInContext(
    [
      ownerCode,
      fn('cancelPanoramaFillRetriesForManualEdit'),
      fn('handleHandsFreeScan')
    ].join('\n'),
    context
  );
  return {
    context,
    get control() {
      return control;
    },
    get owners() {
      return owners;
    },
    release,
    get fills() {
      return fills;
    },
    replaceForm() {
      form.isConnected = false;
      ({ form, control, owners } = testForm());
    },
    replaceControl() {
      field = { form, closest: () => form };
    }
  };
}

test('trusted edit during lookup prevents the old scan from filling', async () => {
  const h = setup();
  const pending = h.context.handleHandsFreeScan('scan', 'scanner', 'id');
  h.context.cancelPanoramaFillRetriesForManualEdit({
    isTrusted: true,
    target: h.control
  });
  h.release({ error: 'unavailable' });
  const result = await pending;
  assert.equal(result.accepted, false);
  assert.equal(h.fills, 0);
});

test('only meaningful interactions with the owning form or its linked panels invalidate context', () => {
  const h = setup();
  const operation = h.context.beginPanoramaOperation();
  const initial = h.context.getPanoramaContext();
  const outside = {
    closest: (selector) => (selector.startsWith('input,') ? outside : null)
  };
  for (const event of [
    { isTrusted: false, type: 'input', target: h.control },
    { isTrusted: true, type: 'pointerdown', target: outside },
    { isTrusted: true, type: 'keydown', key: 'Shift', target: h.control },
    { isTrusted: true, type: 'keydown', key: 'Tab', target: h.control },
    { isTrusted: true, type: 'pointerdown', target: { closest: () => null } }
  ]) {
    h.context.cancelPanoramaFillRetriesForManualEdit(event);
    assert.equal(
      h.context.samePanoramaContext(initial, h.context.getPanoramaContext()),
      true
    );
    assert.equal(h.context.ownsPanoramaOperation(operation), true);
  }
  h.context.cancelPanoramaFillRetriesForManualEdit({
    isTrusted: true,
    type: 'input',
    target: h.control
  });
  assert.equal(
    h.context.samePanoramaContext(initial, h.context.getPanoramaContext()),
    false
  );
});

test('detached select panels require a link to a widget in the owning form', () => {
  const h = setup();
  const panel = { id: 'widget_panel' };
  const option = {
    closest(selector) {
      if (selector.startsWith('.ui-selectonemenu-panel')) return panel;
      if (selector.startsWith('input,')) return this;
      return null;
    }
  };
  const initial = h.context.getPanoramaContext();
  const event = { isTrusted: true, type: 'pointerdown', target: option };
  h.context.cancelPanoramaFillRetriesForManualEdit(event);
  assert.equal(
    h.context.samePanoramaContext(initial, h.context.getPanoramaContext()),
    true
  );
  const owner = {
    id: 'widget',
    classList: { contains: (name) => name === 'ui-selectonemenu' },
    getAttribute: () => null
  };
  h.owners.push(owner);
  h.context.cancelPanoramaFillRetriesForManualEdit(event);
  const afterWidget = h.context.getPanoramaContext();
  assert.equal(h.context.samePanoramaContext(initial, afterWidget), false);
  owner.id = 'other';
  owner.getAttribute = (name) =>
    name === 'aria-controls' ? 'widget_panel' : null;
  h.context.cancelPanoramaFillRetriesForManualEdit(event);
  assert.equal(
    h.context.samePanoramaContext(afterWidget, h.context.getPanoramaContext()),
    false
  );
});

test('a replacement form invalidates ownership while replacement controls in the same form do not', () => {
  const h = setup();
  const operation = h.context.beginPanoramaOperation();
  h.replaceControl();
  assert.equal(h.context.ownsPanoramaOperation(operation), true);
  h.replaceForm();
  assert.equal(h.context.ownsPanoramaOperation(operation), false);
});

test('a newer operation and navigation invalidate the old operation', () => {
  const h = setup();
  const first = h.context.beginPanoramaOperation();
  const second = h.context.beginPanoramaOperation();
  assert.equal(h.context.ownsPanoramaOperation(first), false);
  h.context.window.location.href = 'https://example/other';
  assert.equal(h.context.ownsPanoramaOperation(second), false);
});

test('a superseded scan can be retried with the same scan ID', async () => {
  const h = setup();
  const first = h.context.handleHandsFreeScan('scan', 'scanner', 'same-id');
  h.context.cancelPanoramaFillRetriesForManualEdit({
    isTrusted: true,
    target: h.control
  });
  h.release({ error: 'unavailable' });
  assert.equal((await first).accepted, false);
  await h.context.handleHandsFreeScan('scan', 'scanner', 'same-id');
  assert.equal(h.fills, 1);
});

function schedulerFixture() {
  let id = 0;
  let now = 1000;
  let timerId = 0;
  let { form, control, owners } = testForm();
  let field = { form, closest: () => form };
  let writes = 0;
  let completions = 0;
  const timers = new Map();
  const setTimer = (callback, delay) => {
    const key = ++timerId;
    timers.set(key, { callback, delay });
    return key;
  };
  const context = vm.createContext({
    toastHost: null,
    hudHost: null,
    crypto: { randomUUID: () => String(++id) },
    window: { location: { href: 'https://example/recordImms/' } },
    document: { querySelectorAll: () => [field], body: null },
    isHandsFreeSupportedPage: () => true,
    Date: { now: () => now },
    setTimeout: setTimer,
    setInterval: setTimer,
    clearTimeout: (key) => timers.delete(key),
    getPanoramaTradeCandidates: () => [],
    getPanoramaAgentCandidates: () => [],
    hasPanoramaDeferredDetailData: () => true,
    hasPanoramaDeferredDetailFieldsFilled: () => true,
    isPrimeFacesAjaxBusy: () => false,
    fillPanoramaDeferredDetailFields: () => {
      writes++;
    },
    completePanoramaAutofill: () => {
      completions++;
    },
    isPanoramaFormVerified: () => true,
    console
  });
  vm.runInContext(
    `${ownerCode}\nlet stopPanoramaLotTradeWatcher = null;\n${fn('cancelPanoramaFillRetriesForManualEdit')}\n${fn('schedulePanoramaLotOrTradeSelection')}`,
    context
  );
  const fire = (delay) => {
    const item = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(item, `missing timer ${delay}`);
    timers.delete(item[0]);
    item[1].callback();
  };
  const operation = context.beginPanoramaOperation();
  context.schedulePanoramaLotOrTradeSelection({ _vaxlinkOperation: operation });
  fire(0); // Start the scheduler.
  fire(0); // First stable pass.
  now += 800;
  fire(800); // Second stable pass schedules the late callbacks.
  return {
    context,
    get control() {
      return control;
    },
    fire,
    hasTimer: (delay) =>
      [...timers.values()].some((timer) => timer.delay === delay),
    get writes() {
      return writes;
    },
    get completions() {
      return completions;
    },
    replaceControl() {
      field = { form, closest: () => form };
    },
    replaceForm() {
      form.isConnected = false;
      ({ form, control, owners } = testForm());
      field = { form, closest: () => form };
    }
  };
}

test('late scheduler writes stop after a trusted edit or a newer operation', () => {
  for (const cancel of [
    (h) =>
      h.context.cancelPanoramaFillRetriesForManualEdit({
        isTrusted: true,
        target: h.control
      }),
    (h) => h.context.beginPanoramaOperation()
  ]) {
    const h = schedulerFixture();
    assert.equal(h.hasTimer(1500), true);
    assert.equal(h.hasTimer(3500), true);
    cancel(h);
    assert.equal(h.hasTimer(1500), false);
    assert.equal(h.hasTimer(3500), false);
    assert.equal(h.writes, 0);
  }
});

test('late scheduler callbacks allow same-form controls but stop on navigation or a replacement form', () => {
  const same = schedulerFixture();
  same.replaceControl();
  same.fire(1500);
  same.fire(3500);
  assert.equal(same.writes, 1);
  assert.equal(same.completions, 1);
  for (const change of [
    (h) => {
      h.context.window.location.href = 'https://example/other';
    },
    (h) => h.replaceForm()
  ]) {
    const h = schedulerFixture();
    change(h);
    h.fire(1500);
    assert.equal(h.hasTimer(3500), false);
    assert.equal(h.writes, 0);
  }
});

test('application waits for both corrective passes and a fresh full verification', () => {
  const h = schedulerFixture();
  assert.equal(h.completions, 0);
  h.context.isPanoramaFormVerified = () => false;
  h.fire(1500);
  assert.equal(h.writes, 1);
  assert.equal(h.completions, 0);
  h.context.isPanoramaFormVerified = () => true;
  h.fire(3500);
  assert.equal(h.completions, 1);
  assert.equal(h.hasTimer(16000), false);
});

test('busy or unverified final passes retain the scan and the original retry deadline', () => {
  for (const busy of [true, false]) {
    const h = schedulerFixture();
    h.context.isPrimeFacesAjaxBusy = () => busy;
    h.context.isPanoramaFormVerified = () => false;
    h.fire(1500);
    h.fire(3500);
    assert.equal(h.completions, 0);
    assert.equal(h.hasTimer(16000), true);
    h.fire(16000);
    assert.equal(h.hasTimer(500), false);
  }
});

test('observed URL change rotates the context even when the form is reused', () => {
  const h = setup();
  const before = h.context.getPanoramaContext();
  h.context.window.location.href = 'https://example/recordImms/other';
  const after = h.context.getPanoramaContext();
  assert.notEqual(after.document, before.document);
  assert.equal(after.form, before.form);
  assert.equal(h.context.samePanoramaContext(before, after), false);
});

test('scan ID suppression applies only to the context where it was verified', async () => {
  const h = setup();
  vm.runInContext(
    "lastAppliedScanner = { scanId: 'verified', context: getPanoramaContext() }",
    h.context
  );
  assert.equal(
    (await h.context.handleHandsFreeScan('scan', 'scanner', 'verified'))
      .duplicate_ignored,
    true
  );
  h.context.window.location.href = 'https://example/recordImms/other';
  const pending = h.context.handleHandsFreeScan('scan', 'scanner', 'verified');
  h.release({ error: 'unavailable' });
  assert.notEqual((await pending).duplicate_ignored, true);
  assert.equal(h.fills, 1);
});

test('cancelled ownership prevents a queued record consume request', async () => {
  let sends = 0;
  const context = vm.createContext({
    ownsPanoramaOperation: () => false,
    chrome: {
      runtime: {
        sendMessage: () => {
          sends++;
        }
      }
    }
  });
  vm.runInContext(fn('consumeQueueRecordAfterDeferredAutofill'), context);
  assert.equal(
    await context.consumeQueueRecordAfterDeferredAutofill(
      { storageKey: 'queue', recordId: '1' },
      {}
    ),
    null
  );
  assert.equal(sends, 0);
});

test('completion verifies the form independently and acknowledges only once', async () => {
  let verified = false;
  let applied = 0;
  const context = vm.createContext({
    isPanoramaFormVerified: () => verified,
    reportPanoramaApplied: () => {
      applied++;
    },
    showVaxlinkToast() {},
    console
  });
  vm.runInContext(fn('completePanoramaAutofill'), context);
  const data = { _vaxlinkOperation: {} };
  await context.completePanoramaAutofill(data);
  assert.equal(applied, 0);
  verified = true;
  await context.completePanoramaAutofill(data);
  await context.completePanoramaAutofill(data);
  assert.equal(applied, 1);
});

for (const changed of [false, true]) {
  test(`confirmed queue use ${changed ? 'warns after a late form change' : 'reports application while still verified'}`, async () => {
    let verified = true;
    let finishConsume;
    let consumes = 0;
    let applied = 0;
    const notices = [];
    const events = [];
    const context = vm.createContext({
      isPanoramaFormVerified: () => verified,
      consumeQueueRecordAfterDeferredAutofill: () => {
        consumes++;
        return new Promise((resolve) => {
          finishConsume = resolve;
        });
      },
      reportPanoramaApplied: () => {
        applied++;
      },
      showVaxlinkToast: (data) => notices.push(data),
      logAnalyticsEvent: (type, data) => events.push({ type, data }),
      console
    });
    vm.runInContext(fn('completePanoramaAutofill'), context);
    const data = { _vaxlinkOperation: {}, _vaxlinkQueueContext: {} };
    const completing = context.completePanoramaAutofill(data);
    await context.completePanoramaAutofill(data);
    assert.equal(consumes, 1);
    assert.equal(applied, 0);
    assert.equal(notices.length, 0);
    verified = !changed;
    // A successful reply acknowledges a storage operation that already finished.
    finishConsume({
      record: { id: 'used', expiry_flag: 'valid' },
      queueSizeAfter: 0
    });
    await completing;
    assert.equal(applied, changed ? 0 : 1);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]._queueReviewRequired === true, changed);
    assert.equal(events.length, changed ? 0 : 1);
    if (changed)
      assert.deepEqual(Object.keys(notices[0]), ['_queueReviewRequired']);
  });
}

test('confirmed consumption survives ownership changing before the reply', async () => {
  let owned = true;
  let reply;
  const events = [];
  const context = vm.createContext({
    ownsPanoramaOperation: () => owned,
    chrome: {
      runtime: {
        sendMessage: (_request, callback) => {
          reply = callback;
        }
      }
    },
    logAnalyticsEvent: (type) => events.push(type)
  });
  vm.runInContext(fn('consumeQueueRecordAfterDeferredAutofill'), context);
  const pending = context.consumeQueueRecordAfterDeferredAutofill(
    { storageKey: 'queue', recordId: 'used' },
    { id: 'operation', context: {} }
  );
  owned = false;
  const record = { id: 'used', expiry_flag: 'valid' };
  reply({ success: true, record, queueSizeAfter: 0 });
  const consumed = await pending;
  assert.equal(consumed.record, record);
  assert.equal(consumed.queueSizeAfter, 0);
  assert.deepEqual(events, ['queue_used']);
});

test('automatic grid leaves recovered rows at their existing indices', async () => {
  const filled = [];
  const context = vm.createContext({
    multiGridFillPending: false,
    activeWorkflowMode: 'multiple',
    MULTIPLE_INJECT_QUEUE_KEY: 'queue',
    isPanoramaMultipleImmunizationGridPage: () => true,
    isPrimeFacesAjaxBusy: () => false,
    beginPanoramaOperation: () => ({}),
    ownsPanoramaOperation: () => true,
    getLocalStorage: async () => ({
      queue: [{ id: 'a' }, { id: 'b', requires_review: true }, { id: 'c' }]
    }),
    getPanoramaMultipleGridRows: () => [{}, {}, {}],
    buildAutofillPayloadFromQueueRecord: (row) => row,
    fillPanoramaMultipleGridRow: (index, row) => filled.push([index, row.id]),
    console
  });
  vm.runInContext(fn('maybeAutoFillPanoramaMultipleGrid'), context);
  await context.maybeAutoFillPanoramaMultipleGrid();
  assert.deepEqual(filled, [
    [0, 'a'],
    [2, 'c']
  ]);
});

test('an initial field write keeps a queued record pending until scheduler verification', () => {
  let options;
  const context = vm.createContext({
    ownsPanoramaOperation: () => true,
    getPanoramaSharedFundingLotProductLabel: () => '',
    getPanoramaFundedRadioValue: () => '',
    resetPanoramaFundedRadioToShowAll: () => 'already',
    hasPanoramaAgentSelection: () => true,
    isPrimeFacesAjaxBusy: () => false,
    tryFillPanoramaLot: () => true,
    fillPanoramaDeferredDetailFields: () => 0,
    hasPanoramaDeferredDetailData: () => false,
    getPanoramaTradeCandidates: () => [],
    schedulePanoramaLotOrTradeSelection: (_data, _delay, value) => {
      options = value;
    },
    createAutofillResult: (status, extra) => ({ status, ...extra })
  });
  vm.runInContext(fn('fillPanoramaImmunizationFields'), context);
  const result = context.fillPanoramaImmunizationFields({
    lot: 'LOT',
    _vaxlinkQueueContext: { recordId: '1' }
  });
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'waiting_for_form_verification');
  assert.equal(options.preserveFundingFilter, false);
});

test('strict verification rejects missing agent, lot prefixes and disabled unset optional selections', () => {
  let agent = true;
  let lot = 'ABC12 - Exp. 2027-01-01';
  let reasonSelected = true;
  const context = vm.createContext({
    ownsPanoramaOperation: () => true,
    getPanoramaAgentCandidates: () => ['agent'],
    getPanoramaAgentSelectors: () => ['agent'],
    isAgentCandidateAccepted: () => agent,
    getFields: (selectors) =>
      selectors[0] === 'agent'
        ? [{ tagName: 'SELECT' }]
        : selectors[0] === 'reason'
          ? [{}]
          : selectors[0] === 'consent'
            ? []
            : [{ text: lot }],
    normalizePanoramaLotToken: (value) =>
      String(value)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, ''),
    getFieldFilledText: (field) => field.text,
    getPanoramaAdministeredDateTimeValues: () => ({}),
    getPanoramaAdministeredDateTimeFields: () => ({}),
    reasonConsentAutofillEnabled: true,
    getPanoramaReasonForImmunizationSelectors: () => ['reason'],
    getPanoramaConsentReasonSelectors: () => ['consent'],
    getPanoramaReasonForImmunizationValue: () => 'Routine',
    getPanoramaConsentReasonValue: () => 'Consent obtained',
    panoramaSelectHasDesiredSelection: () => reasonSelected
  });
  vm.runInContext(fn('isPanoramaFormVerified'), context);
  assert.equal(context.isPanoramaFormVerified({ lot: 'ABC1' }, {}), false);
  lot = 'ABC1 - Exp. 2027-01-01';
  agent = false;
  assert.equal(context.isPanoramaFormVerified({ lot: 'ABC1' }, {}), false);
  agent = true;
  reasonSelected = false;
  assert.equal(context.isPanoramaFormVerified({ lot: 'ABC1' }, {}), false);
  reasonSelected = true;
  assert.equal(context.isPanoramaFormVerified({ lot: 'ABC1' }, {}), true);
});

test('final agent proof uses the native selection even when the widget label is stale', () => {
  const native = {
    tagName: 'SELECT',
    selectedIndex: 0,
    options: [{ text: 'Wrong agent' }]
  };
  const focus = { id: 'agent_focus' };
  const context = vm.createContext({
    ownsPanoramaOperation: () => true,
    getPanoramaAgentCandidates: () => ['Correct agent'],
    getFields: () => [native, focus],
    document: { getElementById: () => ({ textContent: 'Correct agent' }) },
    hasPanoramaTradeSelection: () => true,
    getPanoramaAdministeredDateTimeValues: () => ({}),
    getPanoramaAdministeredDateTimeFields: () => ({}),
    reasonConsentAutofillEnabled: false,
    canFillPanoramaControl: () => true
  });
  vm.runInContext(
    [
      'normalizeForMatch',
      'getFieldFilledText',
      'isShortAgentCandidate',
      'filledAgentTextMatchesCandidate',
      'isAgentTextAccepted',
      'isAgentCandidateAccepted',
      'getPanoramaAgentSelectors',
      'hasPanoramaAgentSelection',
      'isPanoramaFormVerified'
    ]
      .map(fn)
      .join('\n'),
    context
  );
  assert.equal(context.hasPanoramaAgentSelection({}), true);
  assert.equal(context.isPanoramaFormVerified({}, {}), false);
  native.options[0].text = 'Correct agent';
  assert.equal(context.isPanoramaFormVerified({}, {}), true);
});

test('masked input stops after focus replaces the owning form', () => {
  let owned = true;
  let events = 0;
  const field = {
    value: '',
    focus: () => {
      owned = false;
    },
    dispatchEvent: () => {
      events++;
    }
  };
  const context = vm.createContext({
    panoramaOperation: {},
    ownsPanoramaOperation: () => owned,
    Event,
    KeyboardEvent: class {}
  });
  vm.runInContext(fn('fillPanoramaMaskedTextInput'), context);
  assert.equal(context.fillPanoramaMaskedTextInput(field, '2027-01-01'), false);
  assert.equal(field.value, '');
  assert.equal(events, 0);
});

test('workflow change during NVC lookup holds the delivered scan', async () => {
  const h = setup();
  const pending = h.context.handleHandsFreeScan('scan', 'scanner', 'id');
  h.context.activeWorkflowMode = 'multiple';
  h.release({ error: 'unavailable' });
  assert.equal((await pending).status, 'workflow_changed');
  assert.equal(h.fills, 0);
});

test('only a recently verified scan suppresses a repeated raw barcode in the same context', async () => {
  const h = setup();
  vm.runInContext(
    "lastVerifiedScan = { raw: 'scan', context: getPanoramaContext(), at: Date.now() }",
    h.context
  );
  assert.equal(
    (await h.context.handleHandsFreeScan('scan', 'scanner', 'new-id'))
      .duplicate_ignored,
    true
  );
  vm.runInContext('lastVerifiedScan.at = Date.now() - 1600', h.context);
  const pending = h.context.handleHandsFreeScan('scan', 'scanner', 'new-id');
  h.release({ error: 'unavailable' });
  assert.notEqual((await pending).duplicate_ignored, true);
  assert.equal(h.fills, 1);
});

test('a background Single scan is held when the content mode is already different', async () => {
  const h = setup();
  h.context.activeWorkflowMode = 'multiple';
  h.context.getQueueStorageKeyForWorkflow = () => {
    throw new Error('must not reroute to a queue');
  };
  const result = await h.context.handleHandsFreeScan(
    'scan',
    'scanner',
    'single-id'
  );
  assert.equal(result.accepted, false);
  assert.equal(result.status, 'workflow_changed');
  assert.equal(h.fills, 0);
});
