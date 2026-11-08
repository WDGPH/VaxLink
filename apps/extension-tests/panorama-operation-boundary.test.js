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

function setup() {
  let id = 0;
  let form = { isConnected: true };
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
    isPanoramaAgentLotWidgetNode: () => true,
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
    release,
    get fills() {
      return fills;
    },
    replaceForm() {
      form.isConnected = false;
      form = { isConnected: true };
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
    target: { id: 'dateAdministedDate' }
  });
  h.release({ error: 'unavailable' });
  const result = await pending;
  assert.equal(result.accepted, false);
  assert.equal(h.fills, 0);
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
    target: { id: 'displayExpiredRecalledCheckbox' }
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
  let form = { isConnected: true };
  let field = { form, closest: () => form };
  let writes = 0;
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
    isPanoramaAgentLotWidgetNode: () => true,
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
    reportPanoramaApplied: () => {},
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
    fire,
    hasTimer: (delay) =>
      [...timers.values()].some((timer) => timer.delay === delay),
    get writes() {
      return writes;
    },
    replaceControl() {
      field = { form, closest: () => form };
    },
    replaceForm() {
      form.isConnected = false;
      form = { isConnected: true };
      field = { form, closest: () => form };
    }
  };
}

test('late scheduler writes stop after a trusted edit or a newer operation', () => {
  for (const cancel of [
    (h) =>
      h.context.cancelPanoramaFillRetriesForManualEdit({
        isTrusted: true,
        target: { id: 'dateAdministedDate' }
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
  assert.equal(same.writes, 2);
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
  assert.equal(options.finalizeOnResolved, true);
});

test('strict verification rejects missing agent, lot prefixes and disabled unset optional selections', () => {
  let agent = true;
  let lot = 'ABC12 - Exp. 2027-01-01';
  let reasonSelected = true;
  const context = vm.createContext({
    ownsPanoramaOperation: () => true,
    getPanoramaAgentCandidates: () => ['agent'],
    hasPanoramaAgentSelection: () => agent,
    getFields: (selectors) =>
      selectors[0] === 'reason'
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
