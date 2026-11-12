import assert from 'node:assert/strict';
import test from 'node:test';

test('scanner errors stay visible and command acknowledgements cannot claim live connection', async () => {
  const profileId = 'zebra-ds8178-usb-cdc';
  const port = { getInfo: () => ({ usbVendorId: 1504, usbProductId: 1 }) };
  const nodes = Object.fromEntries(
    [
      'requestPortBtn',
      'connectGrantedBtn',
      'disconnectBtn',
      'connectionStatus',
      'scannerIdentity'
    ].map((id) => [
      id,
      {
        value: profileId,
        hidden: false,
        listeners: {},
        classList: {
          contains() {
            return false;
          }
        },
        addEventListener(type, listener) {
          this.listeners[type] = listener;
        }
      }
    ])
  );
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'navigator'
  );
  let listener, releaseCommand, commandStarted;
  const pairingWindows = [];
  globalThis.document = {
    getElementById: (id) => nodes[id]
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      serial: {
        addEventListener() {},
        getPorts: async () => [port],
        requestPort: () => assert.fail('Pair must use the pairing window')
      }
    }
  });
  globalThis.chrome = {
    windows: {
      create(options, done) {
        pairingWindows.push(options);
        done();
      }
    },
    storage: {
      local: {
        get(_keys, done) {
          done({});
        }
      }
    },
    runtime: {
      getURL: (path) => `chrome-extension://vaxlink-test/${path}`,
      onMessage: {
        addListener(handler) {
          listener = handler;
        }
      },
      sendMessage(message, done) {
        if (message.action === 'scannerDaemon.getStatus') {
          done({
            success: true,
            status: { state: 'connected', profileId },
            source: 'cached',
            captureError: true
          });
        } else {
          releaseCommand = done;
          commandStarted();
        }
      }
    }
  };
  const live = (state) =>
    listener({
      action: 'scannerDaemon.statusChanged',
      status: {
        state,
        profileId,
        captureCount: 2,
        lastCaptureAt: '2026-11-11T15:20:00Z',
        lastError: state === 'error' ? 'Cable unavailable' : ''
      }
    });
  try {
    const { initializeScannerSettings } =
      await import('../extension/scanner-settings.js?status-regression');
    initializeScannerSettings();
    await Promise.resolve();
    assert.equal(nodes.connectionStatus.textContent, 'Connection unknown');
    assert.equal(nodes.connectGrantedBtn.hidden, false);
    live('error');
    assert.match(nodes.connectionStatus.textContent, /Cable unavailable/);
    nodes.requestPortBtn.listeners.click();
    assert.deepEqual(pairingWindows, [
      {
        url: `chrome-extension://vaxlink-test/scanner-pairing.html?profile=${profileId}`,
        type: 'normal',
        width: 500,
        height: 440,
        focused: true
      }
    ]);
    assert.match(nodes.connectionStatus.textContent, /Cable unavailable/);
    for (const updateBeforeAcknowledgement of [false, true]) {
      live('waiting_for_device');
      const started = new Promise((resolve) => {
        commandStarted = resolve;
      });
      nodes.connectGrantedBtn.listeners.click();
      await started;
      if (updateBeforeAcknowledgement) live('connected');
      releaseCommand({
        success: true,
        status: { state: 'connected', profileId }
      });
      // The command's controlled promise has resolved. Let its UI continuation run.
      await Promise.resolve();
      assert.equal(
        nodes.connectionStatus.className,
        updateBeforeAcknowledgement ? 'status success' : 'status info'
      );
      assert.match(
        nodes.connectionStatus.textContent,
        updateBeforeAcknowledgement
          ? /^Connected$/
          : /Connecting|Checking connection/
      );
    }
  } finally {
    delete globalThis.document;
    delete globalThis.chrome;
    if (navigatorDescriptor)
      Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
  }
});
