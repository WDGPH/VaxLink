import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';
const control = {
  id: 'vaxlink-test',
  url: 'chrome-extension://vaxlink-test/popup.html'
};
const chart = {
  id: 42,
  active: true,
  currentWindow: true,
  url: 'https://inputhealth.com/chart'
};
const integration = (extra = {}) => ({
  schemaVersion: 1,
  buildAtLoad: { id: 'unpacked-source', version: '1.2.0-alpha' },
  initialized: { listener: true, settings: true },
  workflow: 'single',
  category: 'inputhealth',
  ...extra
});
const health = (harness, sender = control) =>
  harness.sendMessage({ action: 'getWorkstationHealth' }, sender);

test('health uses existing statuses and explicitly labels unpacked or stale page integration', async () => {
  for (const [reply, expected] of [
    [integration(), 'development'],
    [
      integration({ initialized: { listener: true, settings: false } }),
      'not_ready'
    ],
    [
      integration({ buildAtLoad: { id: 'a'.repeat(64), version: '1.1.5' } }),
      'stale'
    ],
    [{ success: false, error: 'old content script' }, 'missing'],
    [
      integration({
        buildAtLoad: { id: 'patient data', version: '1.2.0-alpha' }
      }),
      'unknown'
    ]
  ]) {
    const harness = createBackgroundHarness(makeTestNvcBundle(), {
      tabs: [chart],
      tabResponse: reply
    });
    const result = await health(harness);
    assert.equal(result.success, true);
    assert.equal(result.health.integration.state, expected);
    assert.equal(result.health.catalogue.usable, true);
    assert.equal(result.health.scanner.source, 'cached');
    assert.equal(harness.offscreenCreations.length, 0);
    assert.equal(JSON.stringify(result).includes('patient data'), false);
    assert.equal(
      harness.tabMessages.every(
        ({ message }) => message.action === 'getIntegrationHealth'
      ),
      true
    );
  }
});

test('same extension ID cannot authorize health controls from a chart or another scheme', async () => {
  const harness = createBackgroundHarness(makeTestNvcBundle());
  for (const sender of [
    { ...control, url: chart.url, tab: chart },
    { ...control, url: 'other-scheme://vaxlink-test/popup.html' },
    { ...control, tab: chart }
  ])
    assert.equal((await health(harness, sender)).success, false);
  assert.equal(harness.tabMessages.length, 0);
});

test('health probes an existing content script when Chrome omits the tab URL', async () => {
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    tabs: [{ id: 42, active: true, currentWindow: true }],
    tabResponse: integration()
  });
  const reply = await health(harness);
  assert.equal(reply.health.integration.state, 'development');
  assert.equal(harness.tabMessages[0].message.action, 'getIntegrationHealth');
});
