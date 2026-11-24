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
  let reader = {
    status: {
      state: 'connected',
      profileId,
      lastKnownCaptureAt: '2026-11-11T15:20:00Z'
    },
    source: 'cached'
  };
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
            ...reader
          });
        } else {
          releaseCommand = done;
          commandStarted();
        }
      }
    }
  };
  const live = async (state) => {
    reader = {
      source: 'live',
      status: {
        state,
        profileId,
        lastError: state === 'error' ? 'Cable unavailable' : ''
      }
    };
    listener({ action: 'scannerDaemon.statusChanged', status: reader.status });
    await Promise.resolve();
  };
  try {
    const { initializeScannerSettings } =
      await import('../extension/scanner-settings.js?status-regression');
    initializeScannerSettings();
    await Promise.resolve();
    assert.match(
      nodes.connectionStatus.textContent,
      /^Connection unknown: Last known capture/
    );
    assert.equal(nodes.connectGrantedBtn.hidden, false);
    await live('error');
    assert.match(nodes.connectionStatus.textContent, /Cable unavailable/);
    nodes.requestPortBtn.listeners.click();
    assert.deepEqual(pairingWindows, [
      {
        url: `chrome-extension://vaxlink-test/scanner-pairing.html`,
        type: 'normal',
        width: 500,
        height: 440,
        focused: true
      }
    ]);
    assert.match(nodes.connectionStatus.textContent, /Cable unavailable/);
    await live('waiting_for_device');
    const started = new Promise((resolve) => {
      commandStarted = resolve;
    });
    const reconnect = nodes.connectGrantedBtn.listeners.click();
    await started;
    assert.equal(nodes.connectionStatus.textContent, 'Connecting…');
    releaseCommand({
      success: true,
      status: { state: 'connected', profileId }
    });
    await reconnect;
    await new Promise(setImmediate);
    assert.equal(nodes.connectionStatus.className, 'status info');
    assert.equal(nodes.connectionStatus.textContent, 'Disconnected');
    await live('connected');
    assert.equal(nodes.connectionStatus.className, 'status success');
    assert.equal(nodes.connectionStatus.textContent, 'Connected');
  } finally {
    delete globalThis.document;
    delete globalThis.chrome;
    if (navigatorDescriptor)
      Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
  }
});
