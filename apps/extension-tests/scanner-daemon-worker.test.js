import assert from 'node:assert/strict';
import test from 'node:test';

test('dedicated scanner worker opens a granted Web Serial port and disconnects cleanly', async () => {
  const workerMessages = [];
  const workerListeners = new Map();
  let resolveRead = null;
  let readable = {
    getReader() {
      return {
        read() {
          return new Promise((resolve) => {
            resolveRead = resolve;
          });
        },
        async cancel() {
          resolveRead?.({ value: undefined, done: true });
        },
        releaseLock() {}
      };
    }
  };
  let closeCount = 0;
  const port = {
    get readable() {
      return readable;
    },
    writable: null,
    getInfo: () => ({ usbVendorId: 0x05e0, usbProductId: 0x1200 }),
    open: async () => undefined,
    setSignals: async () => undefined,
    close: async () => {
      closeCount += 1;
      readable = null;
    }
  };

  globalThis.self = {
    postMessage: (message) => workerMessages.push(message),
    addEventListener: (type, listener) => workerListeners.set(type, listener)
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { serial: { getPorts: async () => [port] } }
  });

  await import(
    `../extension/scanner/scanner-daemon-worker.js?test=${Date.now()}`
  );
  workerListeners.get('message')({
    data: {
      type: 'connectGranted',
      profileId: 'zebra-ds8178-usb-cdc',
      preferredPortInfo: { usbVendorId: 0x05e0, usbProductId: 0x1200 }
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const connected = workerMessages.find(
    (message) => message.status?.state === 'connected'
  );
  assert.ok(connected, 'worker must report a connected background serial port');

  resolveRead({
    value: new TextEncoder().encode('01001234567890121727123110LOCKLOT1\r\n'),
    done: false
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const captured = workerMessages.find((message) => message.type === 'scan');
  const captureStatus = workerMessages.find(
    (message) => message.status?.captureCount === 1
  );
  assert.ok(captured, 'worker must emit the decoded hardware scan');
  assert.ok(
    captureStatus,
    'worker must expose a non-PHI hardware capture counter'
  );
  assert.ok(captureStatus.status.lastCaptureAt);

  workerListeners.get('message')({ data: { type: 'disconnect' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(closeCount, 1);
  assert.ok(
    workerMessages.some((message) => message.status?.state === 'disabled')
  );
  assert.ok(
    workerMessages.some(
      (message) => message.type === 'disconnected' && message.success
    )
  );

  delete globalThis.self;
  delete globalThis.navigator;
});

for (const [label, ports] of [
  [
    'ambiguous',
    [
      { usbVendorId: 0x05e0, usbProductId: 1 },
      { usbVendorId: 0x05e0, usbProductId: 1 }
    ]
  ],
  ['unidentified', [{}]]
]) {
  test(`${label} granted scanners do not retry on device events`, async () => {
    const listeners = new Map();
    let selections = 0;
    let report;
    const reported = new Promise((resolve) => {
      report = resolve;
    });
    globalThis.self = {
      postMessage(message) {
        if (message.status?.state === 'error') report();
      },
      addEventListener(type, fn) {
        listeners.set(type, fn);
      }
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        serial: {
          async getPorts() {
            selections++;
            return ports.map((info) => ({ getInfo: () => info }));
          }
        }
      }
    });
    try {
      await import(
        `../extension/scanner/scanner-daemon-worker.js?selection=${label}`
      );
      listeners.get('message')({
        data: { type: 'connectGranted', profileId: 'generic-usb-cdc' }
      });
      await reported;
      listeners.get('message')({ data: { type: 'refreshPorts' } });
      await Promise.resolve();
      assert.equal(selections, 1);
    } finally {
      delete globalThis.self;
      delete globalThis.navigator;
    }
  });
}
