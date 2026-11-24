import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(
  new URL('../extension/popup.js', import.meta.url),
  'utf8'
);
const code = source.slice(
  source.indexOf('function isSupportedPanoramaUrl('),
  source.indexOf('\nfunction handleAutoFillResponse')
);
const supported =
  'https://panorama.prod.ehealthontario.ca/ImmsWeb/pages/recordImms/form';

function harness({ url, handshake = false, fillResponse = null }) {
  const messages = [];
  const chrome = {
    runtime: { lastError: null },
    tabs: {
      query(_query, callback) {
        queueMicrotask(() => callback([{ id: 1, url }]));
      },
      sendMessage(_id, message, options, callback) {
        assert.equal(options.frameId, 0);
        messages.push(message.action);
        if (message.action === 'getPanoramaIntegration')
          return callback({ supported: handshake });
        if (fillResponse) return callback(fillResponse);
        chrome.runtime.lastError = { message: 'Receiving end does not exist' };
        callback();
        chrome.runtime.lastError = null;
      }
    }
  };
  const context = vm.createContext({ chrome, URL, setTimeout, clearTimeout });
  vm.runInContext(code, context);
  return {
    messages,
    send: () =>
      new Promise((resolve) =>
        context.sendAutoFillMessage(1, { lot: 'test' }, resolve)
      )
  };
}

test('missing tab URL requires a successful read-only handshake before delivery', async () => {
  const h = harness({});
  const result = await h.send();
  assert.equal(result.success, false);
  assert.match(result.error, /refresh it and try again/);
  assert.deepEqual(h.messages, ['getPanoramaIntegration']);
});

test('unsupported Panorama path is rejected before a fill message', async () => {
  const h = harness({ url: new URL('/login', supported).href });
  const result = await h.send();
  assert.equal(result.success, false);
  assert.deepEqual(h.messages, []);
});

test('existing chart integration can fill when the tab URL is unavailable', async () => {
  const fillResponse = { success: true };
  const h = harness({ handshake: true, fillResponse });
  assert.equal(await h.send(), fillResponse);
  assert.deepEqual(h.messages, ['getPanoramaIntegration', 'autoFill']);
});

test('a chart without the integration prompts for refresh without retrying the fill', async () => {
  const h = harness({ url: supported });
  const result = await h.send();
  assert.equal(result.success, false);
  assert.match(result.error, /refresh it and try again/);
  assert.deepEqual(h.messages, ['autoFill']);
});
