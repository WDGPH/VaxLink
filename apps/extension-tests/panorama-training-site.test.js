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

// Load the complete content script so checks use the shipped runtime functions.
function pagePredicates(url, { iframe = false } = {}) {
  const location = new URL(url);
  const window = { location, __vaxlinkHandsFreeInitialized: true };
  window.self = window;
  window.top = iframe ? {} : window;
  const context = vm.createContext({
    URL,
    window,
    location,
    console,
    document: {
      readyState: 'loading',
      addEventListener() {},
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      }
    },
    chrome: {
      runtime: { getManifest: () => ({}), onMessage: { addListener() {} } },
      storage: { onChanged: { addListener() {} } }
    },
    setTimeout() {
      return 0;
    },
    clearTimeout() {}
  });
  vm.runInContext(
    readFileSync(new URL('content.js', extension), 'utf8'),
    context
  );
  return {
    handsFree: context.isHandsFreeSupportedPage(),
    panoramaHud: context.isPanoramaRecordImmsPage()
  };
}

test('manifest keeps the exact HTTPS training match without broader eHealth access', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('manifest.json', extension), 'utf8')
  );
  const matches = manifest.content_scripts.flatMap((script) => script.matches);
  assert.deepEqual(
    matches.filter((pattern) => pattern.includes('trpanorama')),
    [`https://${TRAINING_HOST}/*`]
  );
  assert.equal(
    matches.some((pattern) => pattern.includes('inputhealth.com')),
    false
  );
  const permissions = [
    ...matches,
    ...(manifest.host_permissions || []),
    ...(manifest.optional_host_permissions || [])
  ];
  assert.deepEqual(
    permissions.filter((pattern) => pattern.includes('trpanorama')),
    [`https://${TRAINING_HOST}/*`]
  );
  assert.equal(
    permissions.some((pattern) => {
      const host = pattern.split('/')[2] || '';
      return host.includes('ehealthontario.ca') && host.includes('*');
    }),
    false
  );
});

test('runtime gates recognize supported URLs and preserve the hands-free frame boundary', () => {
  // Expected columns: hands-free and Panorama page recognition.
  const cases = [
    ...PANORAMA_HOSTS.map((host) => [
      `https://${host}${RECORD_PATH}`,
      [true, true]
    ]),
    [
      `https://${TRAINING_HOST}/training/recordImms/details?tab=1#details`,
      [true, true]
    ],
    ...['inputhealth.com', 'clinic.inputhealth.com'].map((host) => [
      `https://${host}/chart`,
      [false, false]
    ]),
    [TRAINING_URL, [false, false], true],
    ['https://clinic.inputhealth.com/chart', [false, false], true],
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
    ].map((url) => [url, [false, false]])
  ];
  for (const [url, expected, iframe = false] of cases) {
    const { handsFree, panoramaHud } = pagePredicates(url, { iframe });
    assert.deepEqual(
      [handsFree, panoramaHud],
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
    tabResponse: { accepted: true, success: true }
  });
  const response = await harness.sendMessage({
    action: 'scannerScanCaptured',
    scan: {
      type: 'vaxlink.scan',
      rawText: '10TRAININGLOT1',
      source: 'web-serial'
    }
  });
  assert.equal(response.success, true);
  assert.equal(harness.tabMessages.length, 1);
  assert.equal(harness.tabMessages[0].tabId, 44);
  assert.equal(harness.tabMessages[0].message.action, 'vaxlinkScanCaptured');
  assert.equal(harness.tabMessages[0].options.frameId, 0);
});

test('scanner routing keeps scans pending on retired sites and requires a Panorama capability for hidden URLs', async () => {
  for (const [url, category, routed] of [
    ['https://clinic.inputhealth.com/chart', 'panorama-immunization', false],
    ['https://example.org/recordImms/detail', 'panorama-immunization', false],
    [`https://${TRAINING_HOST}/login`, 'panorama-immunization', false],
    ['', 'inputhealth', false],
    ['', 'panorama-immunization', true]
  ]) {
    const harness = createBackgroundHarness(makeTestNvcBundle(), {
      tabs: [{ id: 44, active: true, url }],
      tabResponse: (_id, message) =>
        message.action === 'getIntegrationHealth'
          ? { schemaVersion: 1, category, initialized: { listener: true } }
          : { accepted: true, success: true }
    });
    const result = await harness.sendMessage({
      action: 'scannerScanCaptured',
      scan: { rawText: '10SYNTHETIC' }
    });
    assert.equal(result.routed, routed);
    assert.equal(
      harness.tabMessages.some(
        ({ message }) => message.action === 'vaxlinkScanCaptured'
      ),
      routed
    );
    if (!routed)
      assert.equal(
        harness.storageData.get('vaxlink_pending_scan_inbox_v1').length,
        1
      );
  }
});
