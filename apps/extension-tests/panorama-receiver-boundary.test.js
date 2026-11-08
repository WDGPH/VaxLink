import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(
  new URL('../extension/content.js', import.meta.url),
  'utf8'
);
const identity =
  'const contentBuildAtLoad = null; let panoramaSettingsInitialized = false;';
const listener = source.match(/^function setupMessageListener\([^]*?^}/m)[0];

test('fill and scan messages reject uninitialized settings or a changed form', () => {
  let onMessage;
  let fillCalls = 0;
  let scanCalls = 0;
  const context = vm.createContext({
    chrome: {
      runtime: {
        getManifest: () => ({ version: '1', name: 'VaxLink' }),
        onMessage: {
          addListener: (fn) => {
            onMessage = fn;
          }
        }
      }
    },
    window: {},
    isHandsFreeSupportedPage: () => true,
    getPanoramaContext: () => ({ document: 'doc', form: 'new' }),
    samePanoramaContext: (a, b) =>
      !!a && a.document === b.document && a.form === b.form,
    autoFillPanorama: () => {
      fillCalls++;
    },
    handleHandsFreeScan: () => {
      scanCalls++;
    },
    vlog() {}
  });
  context.window.top = context.window.self = context.window;
  vm.runInContext(`${identity}\n${listener}\nsetupMessageListener();`, context);
  let reply;
  const send = (action, expectedContext) =>
    onMessage({ action, expectedContext }, {}, (value) => {
      reply = value;
    });
  send('vaxlinkScanCaptured', { document: 'doc', form: 'new' });
  assert.equal(reply.accepted, false);
  vm.runInContext('panoramaSettingsInitialized = true', context);
  send('autoFill', { document: 'doc', form: 'old' });
  assert.equal(reply.success, false);
  send('vaxlinkScanCaptured', { document: 'doc', form: 'old' });
  assert.equal(reply.accepted, false);
  assert.equal(fillCalls, 0);
  assert.equal(scanCalls, 0);
});

test('trusted takeover invalidates a handshake before scan delivery', () => {
  let onMessage;
  let token = 0;
  let calls = 0;
  const form = { isConnected: true };
  const field = { form };
  const owner = source.slice(
    source.indexOf('// Tokens identify only'),
    source.indexOf('function setupMessageListener')
  );
  const cancel = source.match(
    /^function cancelPanoramaFillRetriesForManualEdit\([^]*?^}/m
  )[0];
  const context = vm.createContext({
    crypto: { randomUUID: () => String(++token) },
    chrome: {
      runtime: {
        getManifest: () => ({ version: '1', name: 'VaxLink' }),
        onMessage: {
          addListener: (fn) => {
            onMessage = fn;
          }
        }
      }
    },
    window: { location: { href: 'https://example/recordImms/' } },
    document: { querySelectorAll: () => [field] },
    isHandsFreeSupportedPage: () => true,
    toastHost: null,
    hudHost: null,
    stopPanoramaLotTradeWatcher: null,
    handleHandsFreeScan: () => {
      calls++;
    },
    vlog() {}
  });
  context.window.top = context.window.self = context.window;
  vm.runInContext(
    `${identity}\n${owner}\n${cancel}\n${listener}\nsetupMessageListener(); panoramaSettingsInitialized = true;`,
    context
  );
  let reply;
  onMessage({ action: 'getPanoramaIntegration' }, {}, (value) => {
    reply = value;
  });
  const expectedContext = reply.context;
  context.cancelPanoramaFillRetriesForManualEdit({
    isTrusted: true,
    target: {}
  });
  onMessage({ action: 'vaxlinkScanCaptured', expectedContext }, {}, (value) => {
    reply = value;
  });
  assert.equal(reply.accepted, false);
  assert.equal(reply.status, 'context_changed');
  assert.equal(calls, 0);
});
