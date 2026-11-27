import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  createBackgroundHarness,
  createContentHarness,
  deliverScannerScanToChart,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

const preference = 'vaxlink_recent_activity_enabled';
const popup = {
  id: 'vaxlink-test',
  url: 'chrome-extension://vaxlink-test/popup.html'
};
const chartUrl =
  'https://trpanoramadhir.prod.ehealthontario.ca/ImmsWeb/pages/recordImms/form';
const chart = {
  id: 'vaxlink-test',
  frameId: 0,
  url: chartUrl,
  tab: { id: 4, url: chartUrl }
};
const row = (ms = 0) => ({
  event: 'scan',
  operation: 1,
  ms,
  mode: 'single',
  stage: 'none',
  decision: 'accepted'
});

function fixture(options) {
  const worker = createBackgroundHarness(makeTestNvcBundle(), options);
  const manage = (action, payload = {}, sender = popup) =>
    worker.sendMessage({ action, ...payload }, sender);
  const open = () => manage('openRecentActivity', {}, chart);
  const append = ({ token, source }, rows) =>
    manage('appendRecentActivity', { token, source, rows }, chart);
  return { ...worker, manage, open, append };
}

test('packaged Alpha defaults on while other builds and an explicit opt-out default off', async () => {
  for (const [manifestName, saved, enabled] of [
    ['VaxLink Alpha', undefined, true],
    ['VaxLink Alpha', false, false],
    ['VaxLink', undefined, false],
    ['VaxLink Development', undefined, false],
    ['VaxLink', true, true]
  ]) {
    const worker = fixture({
      manifestName,
      storage: saved === undefined ? {} : { [preference]: saved }
    });
    assert.equal((await worker.manage('getRecentActivity')).enabled, enabled);
    assert.equal(!!(await worker.open()).token, enabled);
  }
});

test('Debug rejects unexpected fields and requires a chart sender to append and the popup to export', async () => {
  const worker = fixture();
  const ticket = await worker.open();
  assert.equal((await worker.manage('openRecentActivity')).success, false);
  assert.equal(
    (await worker.manage('openRecentActivity', {}, { ...chart, frameId: 1 }))
      .success,
    false
  );
  assert.equal(
    (await worker.manage('exportRecentActivity', {}, chart)).success,
    false
  );
  assert.equal(
    (await worker.append(ticket, [{ ...row(), patient: 'FICTIONAL' }])).success,
    false
  );
  assert.equal((await worker.append(ticket, [row()])).success, true);
  const exported = await worker.manage('exportRecentActivity');
  assert.equal(exported.retained, 1);
  assert.equal(exported.build.name, 'VaxLink Alpha');
  assert.equal(exported.token, undefined);
});

test('Debug records the destination of locked captures without identifiers', async () => {
  const worker = fixture({ idleState: 'locked' });
  const rawText = '01001234567890121729123110SAMPLE-LOCK';
  assert.equal((await worker.captureScannerScan({ rawText })).locked, true);
  await new Promise(setImmediate);
  const exported = await worker.manage('exportRecentActivity');
  assert.ok(exported.rows.some(({ event }) => event === 'lock_observed'));
  assert.equal(
    exported.rows.find(({ event }) => event === 'locked_capture').result,
    'tray'
  );
  assert.equal(
    exported.rows.find(({ event }) => event === 'scan').decision,
    'accepted'
  );
  assert.doesNotMatch(
    JSON.stringify(exported),
    /SAMPLE-LOCK|lockedAt|captureId/
  );
});

test('workflow Debug links the kept scan to the saved tray without exporting identifiers', async () => {
  const kept = '1795816890000-kept01';
  const removed = '1795816890001-drop02';
  const worker = fixture({
    storage: {
      multiple_inject_queue_v1: [
        {
          id: kept,
          lot: 'PRIVATE-LOT',
          dose_tracking: 'single_use',
          dose_reservations: [{ token: 'PRIVATE-TOKEN', review: true }]
        }
      ],
      vaxlink_skipped_dose_history_v1: [{ id: removed, lot: 'PRIVATE-LOT' }]
    }
  });
  const ticket = await worker.open();
  const base = { operation: 1, ms: 0, mode: 'multiple', stage: 'grid' };
  const archived = {
    ...base,
    event: 'skipped_dose',
    action: 'remove',
    result: 'removed',
    scanKey: removed
  };
  const timeline = [
    {
      ...base,
      event: 'grid_handoff',
      row: 1,
      step: 0,
      result: 'assigned',
      scanKey: kept
    },
    {
      ...base,
      event: 'grid_keep_choice',
      row: 1,
      alternatives: 1,
      result: 'selected'
    },
    archived,
    { ...base, event: 'hud_render', rows: 1, displayed: 1, removing: 0 },
    {
      ...base,
      event: 'detail_notice_action',
      action: 'delete',
      result: 'submitted',
      step: 1,
      total: 2
    }
  ];
  assert.equal((await worker.append(ticket, timeline)).success, true);
  assert.equal(
    (await worker.append(ticket, [{ ...archived, scanKey: 'patient-name' }]))
      .success,
    false
  );
  const log = await worker.manage('exportRecentActivity');
  assert.equal(log.trayAtExport.rows, 1);
  assert.equal(log.trayAtExport.review, 1);
  assert.match(log.rows[0].scanRef, /^[0-9a-f]{16}$/);
  assert.equal(log.trayAtExport.scans[0].scanRef, log.rows[0].scanRef);
  assert.equal(log.trayAtExport.recentlyRemoved[0], log.rows[2].scanRef);
  assert.notEqual(log.rows[0].scanRef, log.rows[2].scanRef);
  assert(log.rows.every((row) => Number.isSafeInteger(row.receivedAt)));
  assert.doesNotMatch(
    JSON.stringify(log),
    /kept01|drop02|PRIVATE-LOT|PRIVATE-TOKEN|patient-name/
  );
});

test('Debug accepts bounded Resume and tray actions through their supported senders', async () => {
  const worker = fixture();
  const ticket = await worker.open();
  const base = { operation: 1, ms: 0, mode: 'multiple', stage: 'grid' };
  const resume = {
    ...base,
    event: 'locked_resume',
    trigger: 'automatic',
    result: 'started',
    count: 2
  };
  const use = { ...base, event: 'tray_use', source: 'hud', result: 'selected' };
  assert.equal((await worker.append(ticket, [resume, use])).success, true);
  assert.equal(
    (await worker.append(ticket, [{ ...resume, trigger: 'unknown' }])).success,
    false
  );
  for (const [payload, sender] of [
    [{ result: 'selected' }, chart],
    [{ result: 'selected' }, { ...popup, url: `${popup.url}#carry-support` }],
    [{ result: 'unknown' }, popup],
    [{ result: 'selected', recordId: 'FIXTURE' }, popup]
  ]) {
    assert.equal(
      (await worker.manage('recordPopupTrayUse', payload, sender)).success,
      false
    );
  }
  assert.equal(
    (await worker.manage('recordPopupTrayUse', { result: 'blocked' })).success,
    true
  );
  const { rows } = await worker.manage('exportRecentActivity');
  assert.deepEqual(
    Array.from(rows, ({ event, result, source, stage }) => [
      event,
      result,
      source,
      stage
    ]),
    [
      ['locked_resume', 'started', undefined, 'grid'],
      ['tray_use', 'selected', 'hud', 'grid'],
      ['tray_use', 'blocked', 'popup', 'none']
    ]
  );
});

test('Debug keeps readiness reasons alongside a scan-order decision and staff action', async () => {
  const worker = fixture();
  const ticket = await worker.open();
  const routing = {
    workflow: 'immunization',
    form: 'multiple_grid',
    chartReady: true,
    formReady: false,
    singleAutofill: true,
    gridAutofill: true
  };
  const blocked = ['agent_control_unavailable', 'date_control_unavailable'].map(
    (formBlockedBy) => ({ ...row(), routing: { ...routing, formBlockedBy } })
  );
  const detail = { operation: 2, ms: 0, mode: 'multiple', stage: 'detail' };
  const decision = {
    ...detail,
    event: 'grid_detail_decision',
    row: 2,
    step: 1,
    total: 2,
    reason: 'candidate_ready',
    waitExpired: false,
    alias: false,
    reordered: false,
    lotEvidence: 'native_option',
    funding: ''
  };
  const action = {
    ...detail,
    event: 'multiple_form_action',
    action: 'delete',
    result: 'step_changed',
    step: 1,
    total: 2
  };
  const batch = [
    ...blocked,
    decision,
    { ...decision, scanOrder: true },
    action,
    { ...action, result: 'marker_declined' },
    {
      ...detail,
      event: 'grid_handoff',
      row: 2,
      step: 1,
      result: 'release_unconfirmed'
    }
  ];
  const reply = await worker.append(ticket, batch);
  assert.equal(reply.success, true);
  const exported = await worker.manage('exportRecentActivity');
  assert.equal(exported.retained, batch.length);
  assert.equal(exported.rows[3].scanOrder, true);
  assert.equal(exported.rows[4].result, 'step_changed');
});

test('a carry report opens Debug in the background and only the extension page can export', async () => {
  const opened = [];
  const worker = fixture({ createTab: async (tab) => opened.push(tab) });
  const reportPage = { ...popup, url: `${popup.url}#carry-support` };
  assert.equal((await worker.manage('openCarrySupport')).success, false);
  assert.equal(
    (await worker.manage('openCarrySupport', { url: popup.url }, chart))
      .success,
    false
  );
  assert.equal(
    (await worker.manage('openCarrySupport', {}, chart)).success,
    true
  );
  assert.equal(opened.length, 1);
  assert.equal(opened[0].url, reportPage.url);
  assert.equal(opened[0].active, false);
  assert.equal(
    (await worker.manage('exportRecentActivity', {}, chart)).success,
    false
  );
  assert.equal(
    (await worker.manage('exportRecentActivity', {}, reportPage)).success,
    true
  );
});

test('Debug retains only the newest 3,000 rows across worker restarts', async () => {
  const sessionStorage = new Map();
  const worker = fixture({ sessionStorage });
  const ticket = await worker.open();
  for (let start = 0; start < 3040; start += 32) {
    assert.equal(
      (
        await worker.append(
          ticket,
          Array.from({ length: 32 }, (_, n) => row(start + n))
        )
      ).success,
      true
    );
  }
  const reopened = fixture({ sessionStorage });
  const exported = await reopened.manage('exportRecentActivity');
  assert.equal(exported.retained, 3000);
  assert.equal(exported.overwritten, 40);
  assert.equal(exported.rows[0].ms, 40);
  assert.equal(exported.rows.at(-1).ms, 3039);
  assert.equal((await reopened.manage('getRecentActivity')).retained, 3000);
});

test('export and disable are ordered with a delayed append, then old tickets are stale', async () => {
  const appending = Promise.withResolvers();
  const wait = Promise.withResolvers();
  const worker = fixture({
    async beforeSessionSet(values) {
      if (!Object.values(values)[0].rows?.length) return;
      appending.resolve();
      await wait.promise;
    }
  });
  const ticket = await worker.open();
  const append = worker.append(ticket, [row()]);
  await appending.promise;
  const exporting = worker.manage('exportRecentActivity');
  const disabling = worker.manage('setRecentActivity', { enabled: false });
  const staleAppend = worker.append(ticket, [row(1)]);
  wait.resolve();
  assert.equal((await append).success, true);
  assert.equal((await exporting).retained, 1);
  assert.equal((await disabling).retained, 0);
  assert.equal((await staleAppend).stale, true);
  assert.equal(
    (await worker.manage('setRecentActivity', { enabled: true })).enabled,
    true
  );
  assert.equal((await worker.append(ticket, [row()])).stale, true);
});

test('Debug storage can fail without delaying capture, and disabling preserves Local Activity', async () => {
  const appending = Promise.withResolvers();
  const waiting = Promise.withResolvers();
  const worker = fixture({
    storage: { vaxlink_workflow_mode_v1: 'inventory' },
    async beforeSessionSet(values) {
      if (!Object.values(values)[0].rows?.length) return;
      appending.resolve();
      await waiting.promise;
      throw new Error('test write failure');
    }
  });
  try {
    const capture = worker.captureScannerScan({ rawText: '(10)TRAIN-01' });
    await appending.promise;
    assert.equal(
      (
        await Promise.race([
          capture,
          new Promise((resolve) => setImmediate(resolve))
        ])
      )?.queued,
      true
    );
  } finally {
    waiting.resolve();
  }
  assert.equal(
    (await worker.manage('setRecentActivity', { enabled: false })).enabled,
    false
  );
  assert.equal(
    (await worker.captureScannerScan({ rawText: '(10)TRAIN-02' })).queued,
    true
  );
  assert.equal((await worker.manage('getRecentActivity')).retained, 0);
  const { data } = await worker.sendMessage({ action: 'getAnalyticsExport' });
  assert.equal(data.rollup.workflows.inventory.liveScans, 2);
  assert.equal(worker.storageData.get('inventory_scan_batch_v1').length, 2);
});

test('a missing-lot lookup and funding prompt can be retained without adding identifiers to Local Activity', async () => {
  const worker = fixture({ storage: { [preference]: false } });
  const requests = [];
  const integration = createContentHarness({
    location: new URL(chartUrl),
    setTimeout: () => 1,
    clearTimeout() {}
  });
  const { context, storageListeners, windowListeners, storageReads } =
    integration;
  storageReads
    .find(({ keys }) => keys.includes('vaxlink_workflow_mode_v1'))
    .callback({});
  const toast = {
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const form = { isConnected: true, querySelectorAll: () => [] };
  Object.assign(context, {
    toast,
    getPanoramaAutofillForm: () => form,
    getPanoramaFormContext: () => ({ kind: 'provider_single', ready: true }),
    getPanoramaMultiStepIndicatorKey: () => '',
    getPanoramaAgentCandidates: () => ['Training vaccine'],
    ensureToastHost() {},
    escapeToastHtml: (text) => text,
    playAudioCue() {},
    isPanoramaImmunizationPage: () => true
  });
  vm.runInContext('toastRoutineSlot = toast;', context);
  context.chrome.runtime.sendMessage = (message, done) => {
    if (message.action === 'checkScannerChart')
      return Promise.resolve({ success: true });
    const response = worker.sendMessage(message, chart);
    requests.push(done ? response.then(done) : response);
    return response;
  };
  context.applyAutofillSettings({ vaxlink_auto_resolve_funding_v1: false });
  const setDebug = async (enabled) => {
    await worker.manage('setRecentActivity', { enabled });
    for (const listener of storageListeners)
      listener({ [preference]: { newValue: enabled } }, 'local');
    await Promise.all(requests);
  };

  for (const [enabled, lot] of [
    [false, 'TRAIN-OFF'],
    [true, 'TRAIN-ON']
  ]) {
    await setDebug(enabled);
    const result = await deliverScannerScanToChart(
      integration,
      `01001234567890121799123110${lot}`
    );
    assert.equal(result.activityRecording, enabled);
    assert.equal(result.pending, true, result.error);
    assert.match(toast.innerHTML, /Choose vaccine funding/);
    if (!enabled)
      assert.equal((await worker.manage('getRecentActivity')).retained, 0);
  }
  for (const listener of windowListeners.get('pagehide')) listener();
  await Promise.all(requests);
  const exported = await worker.manage('exportRecentActivity');
  assert.deepEqual(
    Array.from(exported.rows, (row) => row.event),
    ['barcode', 'nvc_lookup', 'detail_readback', 'funding_prompt', 'scan']
  );
  assert.equal(
    new Set(Array.from(exported.rows, (row) => row.operation)).size,
    1
  );
  assert.equal(exported.rows[1].result, 'not_found');
  assert.equal(exported.rows[2].visible, 'missing');
  assert.match(exported.rows[0].barcode, /00123456789012.*TRAIN-ON/);
  await setDebug(false);
  const { data } = await worker.sendMessage({ action: 'getAnalyticsExport' });
  assert.equal(data.rollup.funding.prompts, 2);
  assert.equal(data.rollup.autofill.attempts, 2);
  assert.equal(data.rollup.autofill.failure, 0);
  assert.doesNotMatch(
    JSON.stringify(data),
    /TRAIN-ON|TRAIN-OFF|00123456789012/
  );
});

test('detailed Debug checks retain statuses under the byte cap and reject field values', async () => {
  const sessionStorage = new Map();
  const worker = fixture({ sessionStorage });
  const ticket = await worker.open();
  const statuses = {
    date: 'not_requested',
    time: 'not_requested',
    reason: 'not_requested',
    consent: 'not_requested'
  };
  const check = {
    event: 'check',
    operation: 999999,
    ms: 86000000,
    mode: 'inventory',
    stage: 'detail',
    wake: 'fallback',
    agent: 'not_requested',
    lot: 'not_requested',
    trade: 'not_requested',
    deferred: 'not_requested',
    deferredCheck: { before: statuses, after: statuses }
  };
  assert.equal(
    (
      await worker.append(ticket, [
        {
          ...check,
          deferredCheck: {
            before: statuses,
            after: { ...statuses, time: '09:30' }
          }
        }
      ])
    ).success,
    false
  );
  const observation = {
    event: 'detail_readback',
    operation: 1,
    ms: 10,
    mode: 'multiple',
    stage: 'detail',
    funding: 'PUBLICLY_FUNDED',
    native: 'requested',
    visible: 'blank',
    time: 'partial',
    changed: ['lot', 'label']
  };
  assert.equal(
    (await worker.append(ticket, [{ ...observation, time: '09:30' }])).success,
    false
  );
  assert.equal(
    (
      await worker.append(ticket, [
        { ...observation, changed: ['patient text'] }
      ])
    ).success,
    false
  );
  for (let start = 0; start < 3000; start += 32) {
    const count = Math.min(32, 3000 - start);
    assert.equal(
      (await worker.append(ticket, Array(count).fill(check))).success,
      true
    );
  }
  const exported = await worker.manage('exportRecentActivity');
  const bytes = Buffer.byteLength(
    JSON.stringify([...sessionStorage.values()][0])
  );
  assert.ok(
    exported.retained < 3000,
    'the byte cap evicts rows before the count cap'
  );
  assert.equal(exported.retained + exported.overwritten, 3000);
  assert.ok(bytes <= 1024 * 1024);
});

test('Debug keeps the observed routing reason when a chart has no delivery token', async () => {
  const logged = Promise.withResolvers();
  const worker = fixture({
    buildId: 'training-build',
    storage: {
      vaxlink_workflow_mode_v1: 'single',
      vaxlink_administered_datetime_autofill_v1: false,
      vaxlink_administered_time_autofill_v1: true,
      vaxlink_grid_scan_autofill_v1: false
    },
    tabs: [{ id: 4, active: true, url: chartUrl }],
    tabResponse: {
      supported: true,
      contextToken: null,
      ready: false,
      formContext: {
        kind: 'unknown',
        ready: false,
        blockedBy: 'form_missing_or_ambiguous'
      },
      buildAtLoad: {
        name: 'VaxLink Alpha',
        version: '1.1.5',
        versionName: '1.2.0-alpha',
        fingerprint: 'training-build'
      }
    },
    beforeSessionSet(values) {
      if (Object.values(values)[0].rows?.length) logged.resolve();
    }
  });
  const result = await worker.captureScannerScan({ rawText: '(10)TRAINING' });
  assert.equal(result.queuedToWorkflow, true);
  await logged.promise;
  worker.storageData.set('vaxlink_workflow_mode_v1', 'inventory');
  const exported = await worker.manage('exportRecentActivity');
  assert.equal(exported.build.fingerprint, 'training-build');
  const routes = JSON.parse(JSON.stringify(exported.rows[0].routing));
  assert.deepEqual(routes, {
    workflow: 'immunization',
    form: 'unknown',
    formBlockedBy: 'form_missing_or_ambiguous',
    chartReady: false,
    formReady: false,
    singleAutofill: true,
    gridAutofill: false
  });
  assert.equal(exported.settingsAtExport.workflow, 'inventory');
  assert.equal(
    exported.settingsAtExport.autofill.multipleImmunizationsGrid,
    false
  );
  assert.equal(exported.settingsAtExport.autofill.administrationDate, false);
  assert.equal(exported.settingsAtExport.autofill.administrationTime, true);
  assert.doesNotMatch(JSON.stringify(exported.rows), /TRAINING|ehealthontario/);
});

test('an expired scan on the Multiple grid is traced before chart entry', async () => {
  const logged = Promise.withResolvers();
  const worker = fixture({
    buildId: 'training-build',
    tabs: [{ id: 4, active: true, url: chartUrl }],
    tabResponse: {
      supported: true,
      contextToken: 'training-grid',
      formContext: { kind: 'multiple_grid', ready: true }
    },
    beforeSessionSet(values) {
      if (Object.values(values)[0].rows?.length) logged.resolve();
    }
  });
  const result = await worker.captureScannerScan({
    rawText: '01001234567890121700010110TRAINING'
  });
  assert.equal(result.response?.status, 'expired');
  await logged.promise;
  const { rows } = await worker.manage('exportRecentActivity');
  assert.equal(rows[0].routing.form, 'multiple_grid');
  assert.equal(rows[1].reason, 'expired');
  assert.equal(rows[1].mode, 'multiple');
  assert.equal(rows[1].stage, 'none');
});
