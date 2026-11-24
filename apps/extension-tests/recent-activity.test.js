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
    ['barcode', 'nvc_lookup', 'funding_prompt', 'scan']
  );
  assert.equal(
    new Set(Array.from(exported.rows, (row) => row.operation)).size,
    1
  );
  assert.equal(exported.rows[1].result, 'not_found');
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
