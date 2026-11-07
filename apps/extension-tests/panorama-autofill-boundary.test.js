import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(
  new URL('../extension/content.js', import.meta.url),
  'utf8'
);
const chart =
  'https://trpanoramadhir.prod.ehealthontario.ca/ImmsWeb/pages/recordImms/detail';

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
  vm.runInContext(source, context, { filename: 'content.js' });
  return { context, listeners, sideEffects };
}
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
