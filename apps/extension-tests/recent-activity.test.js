import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
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
