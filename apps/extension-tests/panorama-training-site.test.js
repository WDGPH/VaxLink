import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

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
  const definition = source.match(
    new RegExp(`^function ${name}\\([^]*?^}`, 'm')
  );
  assert.ok(definition, `Missing runtime predicate: ${name}`);
  return vm.runInNewContext(`(${definition[0]})`, { URL, ...globals });
}

const supportsChart = loadPredicate('background.js', 'isSupportedChartUrl');

function pagePredicates(url, { iframe = false } = {}) {
  const window = { location: new URL(url) };
  window.self = window;
  window.top = iframe ? {} : window;
  return {
    handsFree: loadPredicate('content.js', 'isHandsFreeSupportedPage', {
      window
    })(),
    panoramaHud: loadPredicate('content.js', 'isPanoramaRecordImmsPage', {
      window
    })()
  };
}

test('manifest limits page integration to Panorama immunization entry paths', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('manifest.json', extension), 'utf8')
  );
  const matches = manifest.content_scripts.flatMap((script) => script.matches);
  assert.deepEqual(
    matches,
    PANORAMA_HOSTS.flatMap((host) =>
      ['phsdsm/ImmsWeb/pages/recordImms/*', 'ImmsWeb/pages/recordImms/*'].map(
        (path) => `https://${host}/${path}`
      )
    )
  );
  assert.deepEqual(manifest.host_permissions, ['https://nvc-cnv.canada.ca/*']);
  assert.deepEqual(manifest.optional_host_permissions || [], []);
  const permissions = [
    ...manifest.permissions,
    ...(manifest.optional_permissions || [])
  ];
  for (const permission of ['activeTab', 'scripting', 'tabs']) {
    assert.equal(permissions.includes(permission), false, permission);
  }
});

test('runtime gates recognize supported URLs and preserve the hands-free frame boundary', () => {
  // Expected columns: scanner routing, hands-free, Panorama HUD.
  const cases = [
    ...PANORAMA_HOSTS.flatMap((host) =>
      [RECORD_PATH, RECORD_PATH.replace('/phsdsm', '')].map((path) => [
        `https://${host}${path}?tab=1#details`,
        [true, true, true]
      ])
    ),
    ...['inputhealth.com', 'clinic.inputhealth.com'].map((host) => [
      `https://${host}/chart`,
      [false, false, false]
    ]),
    [TRAINING_URL, [true, false, true], true],
    ['https://clinic.inputhealth.com/chart', [false, false, false], true],
    ...[
      `https://${TRAINING_HOST}/`,
      `https://${TRAINING_HOST}/login?next=${RECORD_PATH}#${RECORD_PATH}`,
      `https://${TRAINING_HOST}/training/recordImms/details`,
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
    assert.deepEqual(
      [supportsChart(url), handsFree, panoramaHud],
      expected,
      `${url} (iframe=${iframe})`
    );
  }
});

test('background routes a Single scan to the active training chart', async () => {
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    idleState: 'active',
    storage: { vaxlink_workflow_mode_v1: 'single' },
    tabs: [
      {
        id: 44,
        windowId: 9,
        active: true,
        currentWindow: true,
        url: TRAINING_URL
      }
    ],
    tabResponse: {
      supported: true,
      contextToken: 'training-form',
      accepted: true,
      success: true
    }
  });
  const response = await harness.captureScannerScan({
    type: 'vaxlink.scan',
    rawText: '10TRAININGLOT1',
    source: 'web-serial'
  });
  assert.equal(response.success, true);
  assert.equal(harness.tabMessages.length, 2);
  assert.equal(harness.tabMessages[1].tabId, 44);
  assert.equal(harness.tabMessages[1].message.action, 'vaxlinkScanCaptured');
  assert.equal(harness.tabMessages[1].options.frameId, 0);
});

test('background requires an existing integration before sending to a tab without a URL', async () => {
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    idleState: 'active',
    storage: { vaxlink_workflow_mode_v1: 'single' },
    tabs: [{ id: 44, active: true, currentWindow: true }],
    tabResponse: { supported: false }
  });
  await harness.captureScannerScan({ rawText: '10LOT', source: 'web-serial' });
  assert.deepEqual(
    harness.tabMessages.map(({ message }) => message.action),
    ['getPanoramaIntegration']
  );
});

test('background delivers to a tab without a URL only after the integration handshake', async () => {
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    idleState: 'active',
    storage: { vaxlink_workflow_mode_v1: 'single' },
    tabs: [{ id: 44, active: true, currentWindow: true }],
    tabResponse: {
      supported: true,
      contextToken: 'training-form',
      accepted: true,
      success: true
    }
  });
  await harness.captureScannerScan({ rawText: '10LOT', source: 'web-serial' });
  assert.deepEqual(
    harness.tabMessages.map(({ message }) => message.action),
    ['getPanoramaIntegration', 'vaxlinkScanCaptured']
  );
});
