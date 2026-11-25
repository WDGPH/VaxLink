import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

test('Scanner setup opens and focuses Settings without leaving the popup', async () => {
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
      'recentActivitySettings',
      'recentActivityToggle',
      'recentActivityStatus',
      'recentActivityNotice',
      'exportRecentActivityBtn',
      'emailRecentActivityBtn',
      'openSupportEmailLink',
      'workflowHeader',
      'panelHeader',
      'panelTitle',
      'closePanelBtn',
      'settingsToggleBtn',
      'analyticsPanel',
      'analyticsToggleBtn',
      'analyticsSummary',
      'scannerSettingsTitle',
      'mainWorkflowPanel',
      'immunizationModeBtn',
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
  nodes.recentActivityToggle.disabled = true;
  nodes.recentActivityToggle.checked = false;
  let focusedTitle = false;
  let scrolledSection = false;
  nodes.scannerSettingsTitle.focus = () => {
    focusedTitle = true;
  };
  nodes.scannerSettingsSection.scrollIntoView = () => {
    scrolledSection = true;
  };
  let ready;
  const opened = [];
  const emailActions = [];
  nodes.openSupportEmailLink.click = () =>
    emailActions.push(nodes.openSupportEmailLink.href);
  const queries = [];
  const requests = [];
  const messages = [];
  const writes = [];
  const storageListeners = [];
  const localData = {
    vaxlink_analytics_v1: {
      deviceId: 'SAMPLE-DEVICE-ID',
      deviceLabel: 'Sample workstation',
      days: {
        [new Intl.DateTimeFormat('en-CA').format(new Date())]: {
          eventCount: 0,
          popupOpens: 0,
          sources: {},
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
  const background = createBackgroundHarness(makeTestNvcBundle(), {
    storage: localData,
    manifestName: 'VaxLink Alpha'
  });
  let runtimeListener;
  globalThis.document = {
    getElementById: (id) => nodes[id] || null,
    createElement: () => ({
      click() {
        emailActions.push({ filename: this.download, url: this.href });
      },
      remove() {}
    }),
    body: { appendChild() {} },
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
        requests.push(
          background
            .sendMessage(message, {
              id: 'vaxlink-test',
              url: 'chrome-extension://vaxlink-test/popup.html'
            })
            .then(done)
        );
      }
    },
    storage: {
      onChanged: {
        addListener(listener) {
          storageListeners.push(listener);
        }
      },
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
      /Scans<\/th><td>10<\/td><td>10<\/td>/
    );
    assert.match(
      nodes.analyticsSummary.innerHTML,
      /Forms filled<\/th><td>5<\/td><td>5<\/td>/
    );
    assert.doesNotMatch(nodes.analyticsSummary.innerHTML, /SAMPLE-DEVICE-ID/);
    assert.doesNotMatch(nodes.analyticsSummary.innerHTML, /Sample workstation/);

    listeners['settingsToggleBtn:click']();
    await Promise.all(requests);
    assert.equal(nodes.recentActivityToggle.disabled, false);
    assert.equal(nodes.recentActivityToggle.checked, true);
    assert.equal(nodes.recentActivityStatus.textContent, '0 events');
    assert.equal(nodes.exportRecentActivityBtn.disabled, true);
    assert.equal(nodes.emailRecentActivityBtn.disabled, true);
    const url =
      'https://trpanoramadhir.prod.ehealthontario.ca/ImmsWeb/pages/recordImms/form';
    const chart = { id: 'vaxlink-test', frameId: 0, url, tab: { id: 2, url } };
    const { token, source } = await background.sendMessage(
      { action: 'openRecentActivity' },
      chart
    );
    const appended = await background.sendMessage(
      {
        action: 'appendRecentActivity',
        token,
        source,
        rows: [
          {
            event: 'scan',
            operation: 1,
            ms: 0,
            mode: 'single',
            stage: 'none',
            decision: 'accepted'
          }
        ]
      },
      chart
    );
    assert.equal(appended.success, true);
    for (const listener of storageListeners)
      listener({ vaxlink_recent_activity_v1: {} }, 'session');
    await Promise.all(requests);
    assert.equal(nodes.emailRecentActivityBtn.disabled, false);
    await listeners['emailRecentActivityBtn:click']();
    await Promise.all(requests);
    assert.equal(emailActions.length, 2);
    const [download, openedEmail] = emailActions;
    assert.equal(download.filename, 'vaxlink-debug-details.json');
    const saved = await (await fetch(download.url)).json();
    assert.equal(saved.rows[0].decision, 'accepted');
    const mail = new URL(openedEmail);
    assert.equal(mail.protocol, 'mailto:');
    assert.equal(mail.pathname, 'innovation@wdgpublichealth.ca');
    assert.match(
      mail.searchParams.get('body'),
      /Attach vaxlink-debug-details\.json/
    );
    assert.doesNotMatch(mail.searchParams.get('body'), /"operation"|"rows"/);
    assert.equal(nodes.openSupportEmailLink.hidden, false);
    nodes.recentActivityToggle.checked = false;
    listeners['recentActivityToggle:change']();
    await Promise.all(requests);
    assert.equal(
      background.storageData.get('vaxlink_recent_activity_enabled'),
      false
    );
    assert.equal(nodes.recentActivityToggle.checked, false);
    assert.equal(nodes.recentActivityToggle.disabled, false);
    listeners['closePanelBtn:click']();

    for (const mode of ['immunization', 'inventory']) {
      await listeners[`${mode}ModeBtn:click`]();
      assert.equal(nodes.scannerSetupPrompt.hidden, false);
      assert.equal(
        nodes.mainWorkflowPanel.classList.values['scanner-setup-required'],
        true
      );
      focusedTitle = false;
      scrolledSection = false;
      listeners['openScannerSettingsBtn:click']();
      assert.equal(focusedTitle, true);
      assert.equal(scrolledSection, true);
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
    for (const mode of ['immunization', 'inventory']) {
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
