import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

test('pairing needs a click, preserves cancellation, and waits for connection handoff', async () => {
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  const nodes = Object.fromEntries(
    [
      'chooseScannerBtn',
      'testScannerBtn',
      'closePairingBtn',
      'pairingStatus',
      'setupHint',
      'scannerProfile',
      'profileControls',
      'profileHint',
      'basicSetup',
      'liveSetup',
      'longRangeSetup',
      'testFeedbackPanel',
      'feedbackStatus'
    ].map((id) => [
      id,
      {
        dataset: {},
        addEventListener(type, listener) {
          this[type] = listener;
        }
      }
    ])
  );
  nodes.scannerProfile.value = '';
  const feedbackButtons = ['works', 'attention', 'expired'].map((result) => ({
    dataset: { feedback: result },
    addEventListener(type, listener) {
      this[type] = listener;
    }
  }));
  nodes.testFeedbackPanel.querySelectorAll = () => feedbackButtons;
  let portError, releaseCommand, commandStarted, pagehide;
  let testProfileId = 'zebra-ds8178-usb-cdc';
  let statusNotice;
  let requestCount = 0,
    closeCount = 0;
  const commands = [];
  const chooserOptions = [];
  const info = { usbVendorId: 1504, usbProductId: 1 };
  globalThis.document = { getElementById: (id) => nodes[id] };
  globalThis.window = {
    location: { search: '?profile=zebra-ds8178-usb-cdc' },
    addEventListener(type, listener) {
      if (type === 'pagehide') pagehide = listener;
    },
    close() {
      closeCount++;
    }
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      serial: {
        async requestPort(options) {
          requestCount++;
          chooserOptions.push(options);
          if (portError) throw portError;
          return { getInfo: () => info };
        },
        getPorts: async () => [{ getInfo: () => info }]
      }
    }
  });
  globalThis.chrome = {
    storage: {
      local: {
        get(_key, done) {
          done({ vaxlink_serial_scanner_profile_v1: 'zebra-ds8178-usb-cdc' });
        }
      }
    },
    runtime: {
      onMessage: {
        addListener(listener) {
          statusNotice = listener;
        }
      },
      sendMessage(message, done) {
        commands.push(message);
        if (message.action === 'scannerDaemon.getStatus') {
          done({
            success: true,
            source: 'live',
            status: {
              testing: true,
              state: 'connected',
              profileId: testProfileId
            }
          });
          return;
        }
        releaseCommand = done;
        commandStarted();
      }
    }
  };
  try {
    await import('../extension/scanner-pairing.js');
    assert.equal(
      requestCount,
      0,
      'loading the window must not open the chooser'
    );
    nodes.closePairingBtn.click();
    assert.equal(closeCount, 1);
    closeCount = 0;

    portError = new DOMException(
      'No port selected by the user.',
      'NotFoundError'
    );
    await nodes.chooseScannerBtn.click();
    assert.equal(
      commands.length,
      0,
      'cancelling must not change saved scanner settings'
    );
    assert.equal(closeCount, 0);
    assert.equal(nodes.chooseScannerBtn.disabled, false);
    assert.equal(nodes.pairingStatus.dataset.error, 'false');
    assert.match(nodes.pairingStatus.textContent, /No scanner selected/);
    assert.deepEqual(chooserOptions[0], {});

    portError = undefined;
    for (const failure of ['background', 'transport', null]) {
      const started = new Promise((resolve) => {
        commandStarted = resolve;
      });
      const pending = nodes.chooseScannerBtn.click();
      // requestPort is called before the click handler first yields.
      assert.equal(requestCount, commands.length + 2);
      await started;
      assert.equal(nodes.chooseScannerBtn.disabled, true);
      assert.equal(
        closeCount,
        0,
        'keep the window until the background accepts'
      );
      assert.deepEqual(commands.at(-1), {
        action: 'scannerDaemon.select',
        profileId: 'zebra-ds8178-usb-cdc',
        preferredPortInfo: info
      });
      if (failure === 'transport')
        chrome.runtime.lastError = { message: 'Background unavailable' };
      releaseCommand(
        failure
          ? { success: false, error: 'Connection request failed' }
          : { success: true, accepted: true }
      );
      delete chrome.runtime.lastError;
      await pending;
      if (failure) {
        assert.equal(closeCount, 0);
        assert.equal(nodes.chooseScannerBtn.disabled, false);
        assert.equal(nodes.pairingStatus.dataset.error, 'true');
        assert.match(
          nodes.pairingStatus.textContent,
          /Connection request failed|Background unavailable/
        );
      } else assert.equal(closeCount, 1);
    }

    for (const [profileId, section] of [
      ['zebra-ds8178-ssi-live', nodes.liveSetup],
      ['zebra-ds8178-cdc-long-range', nodes.longRangeSetup]
    ]) {
      const started = new Promise((resolve) => {
        commandStarted = resolve;
      });
      nodes.scannerProfile.value = profileId;
      nodes.scannerProfile.change();
      assert.equal(nodes.basicSetup.hidden, true);
      assert.equal(section.hidden, false);
      const pending = nodes.chooseScannerBtn.click();
      await started;
      assert.deepEqual(chooserOptions.at(-1), {
        filters: [{ usbVendorId: 1504 }]
      });
      assert.equal(commands.at(-1).profileId, profileId);
      releaseCommand({ success: false, error: 'Connection request failed' });
      await pending;
    }
    nodes.scannerProfile.value = '';
    nodes.scannerProfile.change();
    assert.equal(nodes.basicSetup.hidden, false);
    assert.equal(nodes.liveSetup.hidden, true);
    assert.equal(nodes.longRangeSetup.hidden, true);

    assert.equal(nodes.testScannerBtn.hidden, false);
    const begin = nodes.testScannerBtn.click();
    assert.equal(commands.at(-1).action, 'scannerDaemon.startTest');
    releaseCommand({ success: true });
    await begin;
    assert.equal(nodes.closePairingBtn.textContent, 'Finish test');
    assert.match(nodes.pairingStatus.textContent, /Test scans stay out/);
    assert.equal(nodes.testFeedbackPanel.hidden, true);
    testProfileId = 'zebra-ds8178-ssi-live';
    statusNotice({ action: 'scannerDaemon.statusChanged' });
    await Promise.resolve();
    assert.equal(nodes.testFeedbackPanel.hidden, false);
    const sounding = feedbackButtons[1].click();
    assert.deepEqual(commands.at(-1), {
      action: 'scannerDaemon.testFeedback',
      result: 'attention'
    });
    assert.ok(feedbackButtons.every((button) => button.disabled));
    releaseCommand({ success: true });
    await sounding;
    assert.match(
      nodes.feedbackStatus.textContent,
      /accepted the sound command/
    );
    pagehide();
    assert.equal(commands.at(-1).action, 'scannerDaemon.endTest');
    releaseCommand({ success: true });

    const finish = nodes.closePairingBtn.click();
    assert.equal(commands.at(-1).action, 'scannerDaemon.endTest');
    assert.equal(closeCount, 1);
    releaseCommand({ success: true });
    await finish;
    assert.equal(closeCount, 2);
  } finally {
    for (const key of ['document', 'window', 'navigator', 'chrome']) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
      else delete globalThis[key];
    }
  }
});

test('Scanner setup shares an in-flight window and restores the same open page after worker restart', async () => {
  const sessionStorage = new Map();
  const tabs = new Map();
  const updates = [];
  const updatedListeners = new Set();
  const removedListeners = new Set();
  let observeLoad;
  let closeOnFocus = false;
  let created = 0;
  let releaseCreate;
  let observeCreate;
  const creating = new Promise((resolve) => {
    observeCreate = resolve;
  });
  const options = {
    sessionStorage,
    tabsApi: {
      onUpdated: {
        addListener(listener) {
          updatedListeners.add(listener);
          observeLoad?.();
        },
        removeListener(listener) {
          updatedListeners.delete(listener);
        }
      },
      onRemoved: {
        addListener(listener) {
          removedListeners.add(listener);
        },
        removeListener(listener) {
          removedListeners.delete(listener);
        }
      },
      async get(id) {
        const tab = tabs.get(id);
        if (!tab) throw new Error('No tab');
        return tab;
      },
      async sendMessage(id, message) {
        assert.equal(message.action, 'scannerPairing.isOpen');
        if (!tabs.get(id)?.pairing) throw new Error('No receiver');
        return { pairing: true };
      },
      async update(id, details) {
        assert.equal(details.active, true);
        return this.get(id);
      }
    },
    windows: {
      async create(details) {
        const id = ++created;
        assert.equal(details.type, 'normal');
        assert.equal(
          details.url,
          'chrome-extension://vaxlink-test/scanner-pairing.html'
        );
        if (id === 1)
          await new Promise((resolve) => {
            releaseCreate = resolve;
            observeCreate();
          });
        const tab = {
          id,
          windowId: id + 100,
          pairing: true,
          status: 'loading'
        };
        tabs.set(id, tab);
        return { tabs: [tab] };
      },
      async get(id) {
        return { id, state: 'minimized' };
      },
      async update(id, details) {
        updates.push({ id, focused: details.focused, state: details.state });
        if (closeOnFocus) tabs.delete(id - 100);
      }
    }
  };
  const sender = {
    id: 'vaxlink-test',
    url: 'chrome-extension://vaxlink-test/popup.html'
  };
  const request = {
    action: 'scannerPairing.open',
    profileId: 'zebra-ds8178-usb-cdc'
  };
  const harness = createBackgroundHarness(makeTestNvcBundle(), options);
  assert.equal((await harness.sendMessage(request)).success, false);
  assert.equal(created, 0);
  const first = harness.sendMessage(request, sender);
  await creating;
  const repeated = harness.sendMessage(request, sender);
  releaseCreate();
  assert.ok(
    (await Promise.all([first, repeated])).every((response) => response.success)
  );
  assert.equal(created, 1);

  tabs.get(1).status = 'complete';
  const restarted = createBackgroundHarness(makeTestNvcBundle(), options);
  assert.equal((await restarted.sendMessage(request, sender)).success, true);
  assert.equal(created, 1);
  assert.deepEqual(updates.at(-1), { id: 101, focused: true, state: 'normal' });
  tabs.get(1).pairing = false;
  tabs.get(1).status = 'loading';
  const waiting = new Promise((resolve) => {
    observeLoad = resolve;
  });
  const navigated = restarted.sendMessage(request, sender);
  await waiting;
  assert.equal(
    updates.length,
    1,
    'do not focus a tab while its page is unknown'
  );
  assert.equal(created, 1);
  tabs.get(1).status = 'complete';
  for (const listener of updatedListeners) listener(1, { status: 'complete' });
  assert.equal((await navigated).success, true);
  assert.equal(
    created,
    2,
    'leave another page alone if the tab navigated away'
  );
  assert.equal(updatedListeners.size, 0);
  assert.equal(
    removedListeners.size,
    2,
    'only the permanent test-close listeners remain'
  );
  tabs.get(2).status = 'complete';
  closeOnFocus = true;
  assert.equal((await restarted.sendMessage(request, sender)).success, true);
  assert.equal(
    created,
    3,
    'open a replacement if the pairing tab closes during focus'
  );
  tabs.delete(3);
  assert.equal((await restarted.sendMessage(request, sender)).success, true);
  assert.equal(created, 4, 'open a fresh pairing page after closure');
});
