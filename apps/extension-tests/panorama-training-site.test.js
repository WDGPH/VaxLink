import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { createBackgroundHarness } from './helpers/clinic-sim.js';

const extension = new URL('../extension/', import.meta.url);
const TRAINING_HOST = 'trpanoramadhir.prod.ehealthontario.ca';
const RECORD_PATH = '/phsdsm/ImmsWeb/pages/recordImms/recordImms.xhtml';
const TRAINING_URL = `https://${TRAINING_HOST}${RECORD_PATH}`;
const PANORAMA_HOSTS = [
  'www.panorama.prod.ehealthontario.ca',
  'panorama.prod.ehealthontario.ca',
  TRAINING_HOST
];

// Evaluate the actual runtime predicates, not a copy of their matching logic.
function loadPredicate(file, name, globals = {}) {
  const source = readFileSync(new URL(file, extension), 'utf8');
  const definition = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
  assert.ok(definition, `Missing runtime predicate: ${name}`);
  return vm.runInNewContext(`(${definition[0]})`, { URL, ...globals });
}

const supportsChart = loadPredicate('background.js', 'isSupportedChartUrl');

function pagePredicates(url, { iframe = false } = {}) {
  const window = { location: new URL(url) };
  window.self = window;
  window.top = iframe ? {} : window;
  return {
    handsFree: loadPredicate('content.js', 'isHandsFreeSupportedPage', { window })(),
    panoramaHud: loadPredicate('content.js', 'isPanoramaRecordImmsPage', { window })()
  };
}

test('manifest keeps the exact HTTPS training match without broader eHealth access', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', extension), 'utf8'));
  const matches = manifest.content_scripts.flatMap((script) => script.matches);
  assert.deepEqual(matches.filter((pattern) => pattern.includes('trpanorama')), [
    `https://${TRAINING_HOST}/*`
  ]);
  const permissions = [...matches, ...(manifest.host_permissions || []),
    ...(manifest.optional_host_permissions || [])];
  assert.deepEqual(permissions.filter((pattern) => pattern.includes('trpanorama')), [
    `https://${TRAINING_HOST}/*`
  ]);
  assert.equal(permissions.some((pattern) => {
    const host = pattern.split('/')[2] || '';
    return host.includes('ehealthontario.ca') && host.includes('*');
  }), false);
});

test('runtime gates recognize supported URLs and preserve the hands-free frame boundary', () => {
  // Expected columns: scanner routing, hands-free, Panorama HUD.
  const cases = [
    ...PANORAMA_HOSTS.map((host) => [`https://${host}${RECORD_PATH}`, [true, true, true]]),
    [`https://${TRAINING_HOST}/training/recordImms/details?tab=1#details`, [true, true, true]],
    ...['inputhealth.com', 'clinic.inputhealth.com'].map((host) =>
      [`https://${host}/chart`, [true, true, false]]),
    [TRAINING_URL, [true, false, true], true],
    ['https://clinic.inputhealth.com/chart', [true, false, false], true],
    ...[
      `https://${TRAINING_HOST}/`,
      `https://${TRAINING_HOST}/login?next=${RECORD_PATH}#${RECORD_PATH}`,
      `https://${TRAINING_HOST}/ImmsWeb/pages/recordImms`,
      `https://www.${TRAINING_HOST}${RECORD_PATH}`,
      `https://${TRAINING_HOST}.example.org${RECORD_PATH}`,
      `https://other.prod.ehealthontario.ca${RECORD_PATH}`,
      `https://example.org/${TRAINING_HOST}${RECORD_PATH}`,
      'https://inputhealth.com.example.org/chart',
      ...PANORAMA_HOSTS.map((host) => `http://${host}${RECORD_PATH}`),
      'http://clinic.inputhealth.com/chart'
    ].map((url) => [url, [false, false, false]])
  ];
  for (const [url, expected, iframe = false] of cases) {
    const { handsFree, panoramaHud } = pagePredicates(url, { iframe });
    assert.deepEqual([supportsChart(url), handsFree, panoramaHud], expected, `${url} (iframe=${iframe})`);
  }
});

test('background routes a Single scan to the active training chart', async () => {
  const harness = createBackgroundHarness({ resourceType: 'Bundle', entry: [] }, {
    idleState: 'active',
    storage: { vaxlink_workflow_mode_v1: 'single' },
    tabs: [{ id: 44, windowId: 9, active: true, currentWindow: true, url: TRAINING_URL }],
    tabResponse: { accepted: true, success: true }
  });
  const response = await harness.sendMessage({
    action: 'scannerScanCaptured',
    scan: { type: 'vaxlink.scan', rawText: '10TRAININGLOT1', source: 'web-serial' }
  });
  assert.equal(response.success, true);
  assert.equal(harness.tabMessages.length, 1);
  assert.equal(harness.tabMessages[0].tabId, 44);
  assert.equal(harness.tabMessages[0].message.action, 'vaxlinkScanCaptured');
  assert.equal(harness.tabMessages[0].options.frameId, 0);
});
