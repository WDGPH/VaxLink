import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

test('Settings keeps scanner controls in place and offers a specific Panorama support check', async () => {
  const background = createBackgroundHarness(makeTestNvcBundle());
  const listeners = {};
  const nodes = Object.fromEntries(
    [
      'scannerSettingsFrame',
      'scannerSetupPrompt',
      'scannerConnectionNote',
      'scannerCaptureWarning',
      'openScannerSettingsBtn',
      'continueWithoutScannerBtn',
      'settingsPanel',
      'settingsToggleBtn',
      'analyticsPanel',
      'analyticsToggleBtn',
      'analyticsSummary',
      'analyticsLabelInput',
      'deviceMetadata',
      'checkPanoramaBtn',
      'panoramaCheckResult',
      'scannerSettingsState',
      'mainWorkflowPanel',
      'singleModeBtn',
      'multipleModeBtn',
      'inventoryModeBtn',
      'output'
    ].map((id) => [
      id,
      {
        style: {},
        dataset: {},
        classList: {
          values: {},
          toggle(name, value) {
            this.values[name] = value;
          }
        },
        focus() {},
        attributes: {},
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
        getAttribute(name) {
          return this.attributes[name] || null;
        },
        addEventListener(type, listener) {
          listeners[`${id}:${type}`] = listener;
        }
      }
    ])
  );
  let ready;
  let selectedTabs = [{ id: 7 }];
  let queryError = null;
  const opened = [];
  const queries = [];
  const requests = [];
  const messages = [];
  const writes = [];
  const localData = {
    vaxlink_analytics_v1: {
      deviceId: 'SAMPLE-DEVICE-ID',
      deviceLabel: 'Sample workstation',
      days: {
        [new Date().toISOString().slice(0, 10)]: {
          workflows: {
            single: { liveScans: 2, popupParses: 1 },
            multiple: { liveScans: 3 },
            inventory: { liveScans: 4 }
          },
          autofill: { success: 5 }
        }
      }
    }
  };
  let runtimeListener;
  globalThis.document = {
    getElementById: (id) => nodes[id] || null,
    addEventListener(_type, listener) {
      ready = listener;
    }
  };
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({}),
      getURL: (path) => `chrome-extension://vaxlink-test/${path}`,
      onMessage: {
        addListener(listener) {
          runtimeListener = listener;
        }
      },
      sendMessage(message, done) {
        messages.push(message);
        requests.push(background.sendMessage(message).then(done));
      }
    },
    storage: {
      onChanged: { addListener() {} },
      local: {
        get(keys, done) {
          done(Object.fromEntries(keys.map((key) => [key, localData[key]])));
        },
        set(_values, done) {
          writes.push(_values);
          done?.();
        }
      }
    },
    tabs: {
      query(options, done) {
        queries.push(options);
        chrome.runtime.lastError = queryError;
        done(selectedTabs);
        chrome.runtime.lastError = null;
      },
      create(options, done) {
        opened.push(options.url);
        chrome.runtime.lastError = null;
        done?.();
      }
    }
  };
  try {
    await import('../extension/popup.js?setup-navigation');
    await ready();
    await Promise.all(requests);
    assert.match(
      nodes.analyticsSummary.innerHTML,
      /Scans today<\/span>\s*<strong[^>]*>10<\/strong>/
    );
    assert.match(
      nodes.analyticsSummary.innerHTML,
      /Forms filled today<\/span>\s*<strong[^>]*>5<\/strong>/
    );
    assert.doesNotMatch(nodes.analyticsSummary.innerHTML, /SAMPLE-DEVICE-ID/);
    assert.match(nodes.deviceMetadata.textContent, /SAMPLE-DEVICE-ID/);
    assert.equal(nodes.analyticsLabelInput.value, 'Sample workstation');
    for (const mode of ['single', 'multiple', 'inventory']) {
      await listeners[`${mode}ModeBtn:click`]();
      assert.equal(nodes.scannerSetupPrompt.hidden, false);
      assert.equal(
        nodes.mainWorkflowPanel.classList.values['scanner-setup-required'],
        true
      );
      listeners['openScannerSettingsBtn:click']();
      assert.equal(nodes.settingsPanel.hidden, false);
      assert.equal(nodes.mainWorkflowPanel.hidden, true);
      assert.equal(nodes.settingsToggleBtn.attributes['aria-expanded'], 'true');
      assert.equal(nodes.analyticsPanel.hidden, true);
      listeners['analyticsToggleBtn:click']();
      assert.equal(nodes.settingsPanel.hidden, true);
      assert.equal(nodes.analyticsPanel.hidden, false);
      assert.equal(nodes.mainWorkflowPanel.hidden, true);
      assert.equal(
        nodes.settingsToggleBtn.attributes['aria-expanded'],
        'false'
      );
      assert.equal(
        nodes.analyticsToggleBtn.attributes['aria-expanded'],
        'true'
      );
      listeners['settingsToggleBtn:click']();
      assert.equal(nodes.settingsPanel.hidden, false);
      assert.equal(nodes.analyticsPanel.hidden, true);
      listeners['settingsToggleBtn:click']();
      assert.equal(nodes.settingsPanel.hidden, true);
      assert.equal(nodes.mainWorkflowPanel.hidden, false);
      listeners['analyticsToggleBtn:click']();
      listeners['analyticsToggleBtn:click']();
      assert.equal(nodes.analyticsPanel.hidden, true);
      assert.equal(nodes.mainWorkflowPanel.hidden, false);
    }
    assert.equal(
      messages.some((message) => message.action === 'getWorkstationHealth'),
      false
    );
    listeners['settingsToggleBtn:click']();
    selectedTabs = [{ id: 99 }];
    await listeners['checkPanoramaBtn:click']();
    assert.deepEqual(
      messages.find((message) => message.action === 'getWorkstationHealth'),
      { action: 'getWorkstationHealth', tabId: 7 }
    );
    assert.match(nodes.panoramaCheckResult.textContent, /Panorama integration/);
    listeners['settingsToggleBtn:click']();
    const previousWrites = writes.length;
    listeners['continueWithoutScannerBtn:click']();
    assert.equal(
      writes.length,
      previousWrites,
      'continuing does not change scanner or workflow settings'
    );
    for (const mode of ['single', 'multiple', 'inventory']) {
      await listeners[`${mode}ModeBtn:click`]();
      assert.equal(nodes.scannerSetupPrompt.hidden, true);
      assert.equal(
        nodes.mainWorkflowPanel.classList.values['scanner-setup-required'],
        false
      );
    }
    runtimeListener({
      action: 'scannerDaemon.statusChanged',
      status: { state: 'connected' }
    });
    assert.equal(nodes.scannerConnectionNote.hidden, true);
    runtimeListener({
      action: 'scannerDaemon.scanEcho',
      response: { success: false }
    });
    assert.equal(
      nodes.scannerCaptureWarning.hidden,
      false,
      'failed captures stay visible in Settings'
    );
    runtimeListener({
      action: 'scannerDaemon.statusChanged',
      status: { state: 'waiting_for_device' }
    });
    assert.equal(
      nodes.scannerSetupPrompt.hidden,
      true,
      'a disconnected scanner does not need first-time setup'
    );
    assert.match(nodes.scannerConnectionNote.textContent, /offline/);
    await Promise.all(requests);
    for (const [tabs, error] of [
      [[{ id: 7 }], null],
      [[], null],
      [[{ id: 7 }], { message: 'Tab query failed' }]
    ]) {
      selectedTabs = tabs;
      queryError = error;
      nodes.scannerSettingsFrame.attributes.src = '';
      listeners['settingsToggleBtn:click']();
      assert.deepEqual(queries.at(-1), {
        active: true,
        currentWindow: true
      });
      assert.equal(
        nodes.scannerSettingsFrame.attributes.src,
        'chrome-extension://vaxlink-test/scanner-setup.html'
      );
      const queryCount = queries.length;
      listeners['settingsToggleBtn:click']();
      listeners['settingsToggleBtn:click']();
      assert.equal(
        queries.length,
        queryCount + 1,
        'reopening keeps the iframe and selects the current chart for support'
      );
      listeners['settingsToggleBtn:click']();
    }
    assert.deepEqual(opened, [], 'Settings does not open a separate tab');
    assert.equal(
      messages.some(
        (message) => message.action === 'scannerDaemon.connectGranted'
      ),
      false
    );
    await Promise.all(requests);
  } finally {
    for (let index = 0; index < requests.length; index++) await requests[index];
    await new Promise(setImmediate);
    delete globalThis.document;
    delete globalThis.chrome;
  }
});
