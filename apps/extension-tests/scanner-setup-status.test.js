import assert from 'node:assert/strict';
import test from 'node:test';

test('scanner diagnostics preserve capture evidence and connection acknowledgements cannot claim live status', async () => {
  const profileId = 'zebra-ds8178-usb-cdc';
  const port = { getInfo: () => ({ usbVendorId: 1504, usbProductId: 1 }) };
  const nodes = Object.fromEntries(
    [
      'profileSelect',
      'profileNote',
      'requestPortBtn',
      'connectGrantedBtn',
      'disconnectBtn',
      'connectionStatus',
      'scannerIdentity',
      'connectionDetails',
      'scannerUsbIdentity',
      'scannerDiagnostics',
      'routeStatus'
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
  let ready, listener, releaseCommand, commandStarted;
  globalThis.window = {};
  window.parent = window;
  globalThis.document = {
    getElementById: (id) => nodes[id],
    addEventListener(_type, handler) {
      ready = handler;
    }
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      serial: {
        addEventListener() {},
        getPorts: async () => [port],
        requestPort: async () => port
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
    await import('../extension/scanner-setup.js?status-regression');
    await ready();
    assert.equal(nodes.connectionStatus.textContent, 'Connection unknown');
    assert.equal(nodes.connectGrantedBtn.hidden, false);
    assert.equal(
      nodes.scannerDiagnostics.open,
      true,
      'standalone capture warnings must be visible'
    );
    live('error');
    assert.match(
      nodes.connectionDetails.textContent,
      /captures in this session: 2/
    );
    assert.match(nodes.connectionDetails.textContent, /2026-11-11T15:20:00/);
    assert.match(nodes.connectionDetails.textContent, /Cable unavailable/);
    for (const action of ['requestPortBtn', 'connectGrantedBtn']) {
      for (const updateBeforeAcknowledgement of [false, true]) {
        live('waiting_for_device');
        const started = new Promise((resolve) => {
          commandStarted = resolve;
        });
        nodes[action].listeners.click();
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
    }
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.chrome;
    if (navigatorDescriptor)
      Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
  }
});
