import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(
  new URL('../extension/content.js', import.meta.url),
  'utf8'
);
const identity = source.slice(
  source.indexOf('const contentManifestAtLoad'),
  source.indexOf('const HANDS_FREE_BUILD')
);
const listener = source.match(/^function setupMessageListener\([^]*?^}/m)[0];

test('page health keeps the identity captured at load and waits for settings', () => {
  let manifest = {
    version: '1.0.0',
    version_name: '1.1.0-alpha',
    name: 'VaxLink Alpha'
  };
  let reads = 0;
  let onMessage;
  const context = vm.createContext({
    chrome: {
      runtime: {
        getManifest: () => {
          reads++;
          return manifest;
        },
        onMessage: {
          addListener: (fn) => {
            onMessage = fn;
          }
        }
      }
    },
    window: {},
    panoramaOperation: null,
    VAXLINK_BUILD_ID: 'old-build',
    isHandsFreeSupportedPage: () => true,
    getPanoramaContext: () => ({ document: 'doc', form: 'form' }),
    vlog() {}
  });
  vm.runInContext(`${identity}\n${listener}\nsetupMessageListener();`, context);
  manifest = { version: '2.0.0', name: 'VaxLink' };
  context.VAXLINK_BUILD_ID = 'new-build';
  let reply;
  onMessage({ action: 'getPanoramaIntegration' }, {}, (value) => {
    reply = value;
  });
  assert.equal(reply.ready, false);
  assert.equal(reply.initialized.listener, true);
  assert.equal(reply.initialized.settings, false);
  assert.equal(reply.buildAtLoad.version, '1.0.0');
  assert.equal(reply.buildAtLoad.versionName, '1.1.0-alpha');
  assert.equal(reply.buildAtLoad.name, 'VaxLink Alpha');
  assert.equal(reply.buildAtLoad.fingerprint, 'old-build');
  assert.equal(reads, 1);
  vm.runInContext('panoramaSettingsInitialized = true', context);
  onMessage({ action: 'getPanoramaIntegration' }, {}, (value) => {
    reply = value;
  });
  assert.equal(reply.ready, true);
});
