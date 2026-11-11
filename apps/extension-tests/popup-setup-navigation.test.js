import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

test('Scanner setup opens and focuses Settings without leaving the popup', async () => {
  const background = createBackgroundHarness(makeTestNvcBundle());
  const listeners = {};
  const nodes = Object.fromEntries(
    [
      'scannerSettingsSection',
      'scannerSetupPrompt',
      'scannerConnectionNote',
      'scannerCaptureWarning',
      'openScannerSettingsBtn',
      'continueWithoutScannerBtn',
      'settingsPanel',
      'workflowHeader',
      'panelHeader',
      'panelTitle',
      'closePanelBtn',
      'settingsToggleBtn',
      'analyticsPanel',
      'analyticsToggleBtn',
      'analyticsSummary',
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
  let focusedSummary = false;
  let scrolledSummary = false;
  nodes.scannerSettingsSection.querySelector = () => ({
    focus() {
      focusedSummary = true;
    },
    scrollIntoView() {
      scrolledSummary = true;
    }
  });
  let ready;
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
        [new Intl.DateTimeFormat('en-CA').format(new Date())]: {
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
        done([]);
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
    assert.doesNotMatch(nodes.analyticsSummary.innerHTML, /Sample workstation/);
    for (const mode of ['single', 'multiple', 'inventory']) {
      await listeners[`${mode}ModeBtn:click`]();
      assert.equal(nodes.scannerSetupPrompt.hidden, false);
      assert.equal(
        nodes.mainWorkflowPanel.classList.values['scanner-setup-required'],
        true
      );
      focusedSummary = false;
      scrolledSummary = false;
      listeners['openScannerSettingsBtn:click']();
      assert.equal(nodes.scannerSettingsSection.open, true);
      assert.equal(focusedSummary, true);
      assert.equal(scrolledSummary, true);
      assert.equal(nodes.settingsPanel.hidden, false);
      assert.equal(nodes.mainWorkflowPanel.hidden, true);
      assert.equal(nodes.workflowHeader.hidden, true);
      assert.equal(nodes.panelHeader.hidden, false);
      assert.equal(nodes.panelTitle.textContent, 'Settings');
      assert.equal(
        nodes.closePanelBtn.attributes['aria-label'],
        'Close Settings'
      );
      listeners['closePanelBtn:click']();
      assert.equal(nodes.settingsPanel.hidden, true);
      assert.equal(nodes.mainWorkflowPanel.hidden, false);
      assert.equal(nodes.panelHeader.hidden, true);
      assert.equal(nodes.workflowHeader.hidden, false);
      listeners['analyticsToggleBtn:click']();
      assert.equal(nodes.settingsPanel.hidden, true);
      assert.equal(nodes.analyticsPanel.hidden, false);
      assert.equal(nodes.panelTitle.textContent, 'Local Activity');
      assert.equal(
        nodes.closePanelBtn.attributes['aria-label'],
        'Close Local Activity'
      );
      assert.equal(
        nodes.analyticsToggleBtn.attributes['aria-expanded'],
        'true'
      );
      listeners['closePanelBtn:click']();
      assert.equal(nodes.analyticsPanel.hidden, true);
      assert.equal(nodes.mainWorkflowPanel.hidden, false);
    }
    assert.equal(
      messages.some((message) => message.action === 'getWorkstationHealth'),
      false
    );
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
    assert.deepEqual(opened, [], 'Settings does not open a separate tab');
    assert.deepEqual(queries, [], 'Settings does not inspect the selected tab');
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
