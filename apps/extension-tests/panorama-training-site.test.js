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

function setup(url, { iframe = false, lookalike = false } = {}) {
  const location = new URL(url);
  const window = { location, __vaxlinkHandsFreeInitialized: true };
  window.self = window;
  window.top = iframe ? {} : window;
  const sideEffects = { writes: 0, events: 0, clicks: 0, storage: 0 };
  let value = '';
  const field = {
    id: 'immsDetailssection_recordImms_agentiterm:selectOneMenu_input',
    tagName: 'INPUT',
    type: 'text',
    disabled: false,
    get value() {
      return value;
    },
    set value(next) {
      value = next;
      sideEffects.writes++;
    },
    getAttribute() {
      return '';
    },
    focus() {},
    blur() {},
    dispatchEvent() {
      sideEffects.events++;
    },
    click() {
      sideEffects.clicks++;
    },
    closest() {
      return null;
    },
    getBoundingClientRect() {
      return { width: 10, height: 10 };
    }
  };
  const listeners = [];
  const context = vm.createContext({
    URL,
    window,
    location,
    console,
    document: {
      readyState: 'loading',
      addEventListener() {},
      querySelector(selector) {
        return lookalike && selector.includes('agentiterm') ? field : null;
      },
      querySelectorAll(selector) {
        return lookalike &&
          (selector.includes('agentiterm') || selector.includes('input'))
          ? [field]
          : [];
      },
      getElementById() {
        return null;
      }
    },
    chrome: {
      runtime: {
        id: 'test',
        getManifest: () => ({}),
        onMessage: {
          addListener(fn) {
            listeners.push(fn);
          }
        },
        sendMessage() {}
      },
      storage: {
        local: {
          set() {
            sideEffects.storage++;
          }
        },
        onChanged: { addListener() {} }
      }
    },
    setTimeout() {
      return 0;
    },
    clearTimeout() {},
    setInterval() {
      return 0;
    },
    clearInterval() {}
  });
  vm.runInContext(
    readFileSync(new URL('content.js', extension), 'utf8'),
    context,
    { filename: 'content.js' }
  );
  return { context, listeners, sideEffects };
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
    const { context } = setup(url, { iframe });
    const handsFree = context.isHandsFreeSupportedPage();
    const panoramaHud = context.isPanoramaRecordImmsPage();
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

const chart = `https://${TRAINING_HOST}/ImmsWeb/pages/recordImms/detail`;
const payload = {
  lot: 'SYNTHETIC',
  name: 'test',
  _vaxlinkQueueContext: {
    storageKey: 'multiple_inject_queue_v1',
    recordId: 'row-1'
  }
};

for (const [name, url, iframe] of [
  ['InputHealth', 'https://clinic.inputhealth.com/chart', false],
  ['unrelated origin', 'https://example.org/recordImms/detail', false],
  ['HTTP Panorama', chart.replace('https:', 'http:'), false],
  [
    'wrong Panorama path',
    'https://trpanoramadhir.prod.ehealthontario.ca/other',
    false
  ],
  ['Panorama iframe', chart, true]
]) {
  test(`${name} lookalike rejects direct fill without side effects`, () => {
    const run = setup(url, { iframe, lookalike: true });
    const result = run.context.autoFillPanorama({ ...payload });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'unsupported_page');
    assert.deepEqual(run.sideEffects, {
      writes: 0,
      events: 0,
      clicks: 0,
      storage: 0
    });
    let response;
    run.listeners[0](
      { action: 'autoFill', data: { ...payload } },
      { id: 'test' },
      (reply) => {
        response = reply;
      }
    );
    if (!iframe) {
      assert.equal(response.success, false);
      assert.equal(response.status, 'failed');
    } else assert.equal(response, undefined);
    assert.deepEqual(run.sideEffects, {
      writes: 0,
      events: 0,
      clicks: 0,
      storage: 0
    });
  });
}

test('supported Panorama form without controls reports not ready and makes no changes', () => {
  const run = setup(chart);
  const result = run.context.autoFillPanorama({ ...payload });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'form_not_ready');
  assert.deepEqual(run.sideEffects, {
    writes: 0,
    events: 0,
    clicks: 0,
    storage: 0
  });
  let response;
  run.listeners[0](
    { action: 'autoFill', data: { ...payload } },
    { id: 'test' },
    (reply) => {
      response = reply;
    }
  );
  assert.equal(response.success, false);
  assert.equal(response.status, 'failed');
  assert.match(response.error, /not ready/i);
});

function menuFixture({
  nativeOptions = [],
  ownItems = [],
  otherItems = [],
  clickChanges = true
} = {}) {
  const run = setup(TRAINING_URL);
  const { context } = run;
  context.Event = class {
    constructor(type) {
      this.type = type;
    }
  };
  context.MouseEvent = context.Event;
  const base = 'recordImmsForm:agentiterm:selectOneMenu';
  const label = { textContent: '', setAttribute() {} };
  const classes = (...names) => ({ contains: (name) => names.includes(name) });
  const rect = () => ({ width: 10, height: 10 });
  const focus = {
    id: `${base}_focus`,
    tagName: 'INPUT',
    value: 'HB',
    disabled: false,
    focus() {},
    blur() {}
  };
  const native = {
    id: `${base}_input`,
    tagName: 'SELECT',
    disabled: false,
    options: nativeOptions.map((text, index) => ({
      text,
      value: String(index + 1),
      disabled: false
    })),
    selectedIndex: -1,
    focus() {},
    blur() {},
    dispatchEvent() {},
    set value(value) {
      this.selectedIndex = this.options.findIndex(
        (option) => option.value === value
      );
    },
    get value() {
      return this.options[this.selectedIndex]?.value || '';
    }
  };
  const clicks = { own: 0, other: 0 };
  const item = (text, which) => ({
    textContent: text,
    classList: classes(),
    getBoundingClientRect: rect,
    getAttribute(name) {
      return name === 'data-label' ? text : null;
    },
    dispatchEvent() {},
    click() {
      clicks[which]++;
      if (clickChanges) {
        label.textContent = text;
        let index = native.options.findIndex((option) => option.text === text);
        if (index < 0) {
          native.options.push({
            text,
            value: `panel-${text}`,
            disabled: false
          });
          index = native.options.length - 1;
        }
        native.selectedIndex = index;
      }
    }
  });
  const panel = {
    getBoundingClientRect: rect,
    querySelectorAll: () => ownItems.map((text) => item(text, 'own'))
  };
  const otherPanel = {
    querySelectorAll: () => otherItems.map((text) => item(text, 'other'))
  };
  const widget = {
    classList: classes('ui-selectonemenu'),
    querySelector: () => null
  };
  const elements = new Map([
    [base, widget],
    [`${base}_input`, native],
    [`${base}_panel`, panel],
    [`${base}_label`, label],
    ['other_panel', otherPanel]
  ]);
  context.document.getElementById = (id) => elements.get(id) || null;
  context.document.querySelectorAll = () => {
    throw new Error('Unscoped document option search');
  };
  return { context, focus, native, label, clicks, elements, base };
}

test('focus control uses its enabled native select first and rejects a disabled select', () => {
  const menu = menuFixture({ nativeOptions: ['HB'], ownItems: ['HB'] });
  assert.equal(menu.context.fillField(menu.focus, 'HB'), true);
  assert.equal(menu.native.value, '1');
  assert.equal(menu.label.textContent, 'HB');
  assert.equal(menu.clicks.own, 0);
  menu.native.disabled = true;
  assert.equal(menu.context.fillField(menu.focus, 'HB'), false);
  assert.equal(menu.clicks.own, 0);
});

test('visible menu searches only its associated panel and requires a matching selection', () => {
  const menu = menuFixture({ ownItems: ['MMR'], otherItems: ['HB'] });
  assert.equal(menu.context.fillField(menu.focus, 'HB'), false);
  assert.equal(menu.clicks.other, 0);
  assert.equal(menu.clicks.own, 0);
  const matching = menuFixture({ ownItems: ['HB'], otherItems: ['HB'] });
  assert.equal(matching.context.fillField(matching.focus, 'HB'), true);
  assert.equal(matching.clicks.own, 1);
  assert.equal(matching.clicks.other, 0);
  const unknownWidget = {
    ...matching.focus,
    id: 'other-widget',
    tagName: 'DIV'
  };
  assert.equal(matching.context.fillField(unknownWidget, 'HB'), false);
  assert.equal(unknownWidget.value, 'HB');
  const unknownInput = {
    ...unknownWidget,
    tagName: 'INPUT',
    getAttribute: () => 'combobox'
  };
  assert.equal(matching.context.fillField(unknownInput, 'HB'), false);
});

test('agent selection never treats HB-pediatric as HB', () => {
  const menu = menuFixture({
    nativeOptions: ['HB-pediatric'],
    ownItems: ['HB-pediatric'],
    otherItems: ['HB']
  });
  assert.equal(menu.context.fillField(menu.focus, 'HB'), false);
  assert.equal(menu.native.selectedIndex, -1);
  assert.equal(menu.clicks.own, 0);
  assert.equal(menu.clicks.other, 0);
});

test('single-agent label fallback fills and verifies a native select', () => {
  const run = setup(TRAINING_URL);
  const { context } = run;
  context.Event = class {
    constructor(type) {
      this.type = type;
    }
  };
  const select = {
    id: 'legacyAgent',
    tagName: 'SELECT',
    disabled: false,
    options: [{ value: 'hb', text: 'HB' }],
    selectedIndex: -1,
    focus() {},
    blur() {},
    dispatchEvent() {},
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
    set value(value) {
      this.selectedIndex = this.options.findIndex(
        (option) => option.value === value
      );
    },
    get value() {
      return this.options[this.selectedIndex]?.value || '';
    }
  };
  const label = {
    tagName: 'LABEL',
    textContent: 'Agent',
    getAttribute: (name) => (name === 'for' ? select.id : null)
  };
  context.document.getElementById = (id) => (id === select.id ? select : null);
  context.document.querySelectorAll = (selector) =>
    selector === 'label, span, div, td, th, strong' ? [label] : [];
  const result = context.fillPanoramaImmunizationFields({ name: 'HB' });
  assert.equal(result.status, 'success');
  assert.equal(select.value, 'hb');
});

test('focus text and an inert panel click do not confirm a selection', () => {
  const menu = menuFixture({ ownItems: ['HB'], clickChanges: false });
  menu.elements.delete(`${menu.base}_input`);
  menu.elements.delete(`${menu.base}_label`);
  assert.equal(menu.focus.value, 'HB');
  assert.equal(menu.context.fillField(menu.focus, 'HB'), false);
  assert.equal(menu.clicks.own, 1);
});

test('a synchronous native reset is not reported or reflected as a selection', () => {
  const menu = menuFixture({ nativeOptions: ['HB'] });
  menu.label.textContent = 'Select';
  menu.native.dispatchEvent = (event) => {
    if (event.type === 'change') menu.native.selectedIndex = -1;
  };
  assert.equal(menu.context.fillSelectField(menu.native, 'HB'), false);
  assert.equal(menu.native.selectedIndex, -1);
  assert.equal(menu.label.textContent, 'Select');
});

test('agent option value cannot override a conflicting clinical label', () => {
  const menu = menuFixture({ nativeOptions: ['HB-pediatric'] });
  menu.native.options[0].value = 'HB';
  assert.equal(menu.context.fillSelectField(menu.native, 'HB'), false);
  assert.equal(menu.native.selectedIndex, -1);
  assert.equal(menu.label.textContent, '');
});
