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
  const pairingRequests = [];
  let holdNextStatus = false;
  let releaseStatus;
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
        if (message.action === 'scannerPairing.open') {
          pairingRequests.push(message);
          done({ success: true });
        } else if (message.action === 'scannerDaemon.getStatus') {
          const response = { success: true, ...reader };
          if (holdNextStatus) {
            holdNextStatus = false;
            releaseStatus = () => done(response);
          } else done(response);
        } else {
          releaseCommand = done;
          commandStarted();
        }
      }
    }
  };
  const live = async (state, portInfo) => {
    reader = {
      source: 'live',
      status: {
        state,
        profileId,
        portInfo,
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
    assert.deepEqual(pairingRequests, [{ action: 'scannerPairing.open' }]);
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
    for (const [info, label] of [
      [null, ''],
      [{ usbVendorId: 0x05e0 }, 'Scanner Zebra'],
      [
        { usbVendorId: 0x05e0, usbProductId: 0x0001 },
        'Scanner Zebra [USB 05E0:0001]'
      ],
      [
        { usbVendorId: 0x12ab, usbProductId: 0x00bc },
        'Scanner [USB 12AB:00BC]'
      ],
      [{ usbVendorId: 0x10000, usbProductId: -1 }, '']
    ]) {
      await live('connected', info);
      assert.equal(nodes.scannerIdentity.textContent, label);
      assert.equal(nodes.scannerIdentity.hidden, !label);
    }

    holdNextStatus = true;
    await live('waiting_for_device');
    await live('connected', { usbVendorId: 0x05e0, usbProductId: 1 });
    releaseStatus();
    await Promise.resolve();
    assert.equal(nodes.connectionStatus.textContent, 'Connected');
    assert.equal(
      nodes.scannerIdentity.textContent,
      'Scanner Zebra [USB 05E0:0001]'
    );
  } finally {
    delete globalThis.document;
    delete globalThis.chrome;
    if (navigatorDescriptor)
      Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
  }
});
