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

function harness(urls, handshake = false, probe = null) {
  const messages = [];
  let injections = 0;
  const targets = [];
  const chrome = {
    runtime: { lastError: null },
    tabs: {
      query(_query, callback) {
        const url = urls.shift();
        queueMicrotask(() => callback([{ id: 1, url }]));
      },
      sendMessage(_id, message, _options, callback) {
        messages.push(message.action);
        if (message.action === 'getPanoramaIntegration')
          return callback({ supported: handshake });
        chrome.runtime.lastError = { message: 'Receiving end does not exist' };
        callback();
        chrome.runtime.lastError = null;
      }
    },
    scripting: {
      executeScript(details, callback) {
        targets.push(details.target);
        if (details.func) return callback(probe ? [probe] : []);
        injections++;
        chrome.runtime.lastError = { message: 'No document with id' };
        callback();
        chrome.runtime.lastError = null;
      }
    }
  };
  const context = vm.createContext({ chrome, URL, setTimeout, clearTimeout });
  vm.runInContext(code, context);
  return {
    messages,
    targets,
    get injections() {
      return injections;
    },
    send: () =>
      new Promise((resolve) =>
        context.sendAutoFillMessage(1, { lot: 'test' }, resolve)
      )
  };
}

test('missing tab URL requires a successful read-only handshake before delivery', async () => {
  const h = harness([undefined]);
  const result = await h.send();
  assert.equal(result.success, false);
  assert.deepEqual(h.messages, ['getPanoramaIntegration']);
  assert.equal(h.injections, 0);
});

test('navigation to an unsupported page prevents recovery injection', async () => {
  const h = harness([supported, 'https://example.org/chart']);
  const result = await h.send();
  assert.equal(result.success, false);
  assert.deepEqual(h.messages, ['autoFill']);
  assert.equal(h.injections, 0);
});

test('a handshake does not authorize injection when URL metadata is unavailable', async () => {
  const h = harness([undefined, undefined], true);
  const result = await h.send();
  assert.equal(result.success, false);
  assert.deepEqual(h.messages, ['getPanoramaIntegration', 'autoFill']);
  assert.equal(h.injections, 0);
});

test('recovery fails closed if the probe has no document identity', async () => {
  const h = harness([supported, supported], false, { result: true });
  const result = await h.send();
  assert.equal(result.success, false);
  assert.equal(h.injections, 0);
});

test('navigation after probe cannot inject into the replacement document', async () => {
  const h = harness([supported, supported], false, {
    result: true,
    documentId: 'original-document'
  });
  const result = await h.send();
  assert.equal(result.success, false);
  assert.equal(h.injections, 1);
  assert.deepEqual(Array.from(h.targets[1].documentIds), ['original-document']);
  assert.deepEqual(h.messages, ['autoFill']);
});
