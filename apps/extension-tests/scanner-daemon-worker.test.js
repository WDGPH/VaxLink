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
  assert.equal(workerMessages.at(-1).status.state, 'disabled');

  delete globalThis.self;
  delete globalThis.navigator;
});

test('worker refuses ambiguous identical granted ports without scheduling retries', async () => {
  const messages = [];
  const listeners = new Map();
  let opens = 0;
  const port = () => ({
    getInfo: () => ({ usbVendorId: 0x05e0, usbProductId: 0x1200 }),
    open: async () => {
      opens += 1;
    }
  });
  globalThis.self = {
    postMessage: (message) => messages.push(message),
    addEventListener: (type, listener) => listeners.set(type, listener)
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { serial: { getPorts: async () => [port(), port()] } }
  });
  try {
    await import(
      `../extension/scanner/scanner-daemon-worker.js?ambiguous=${Date.now()}`
    );
    const errorStatus = new Promise((resolve) => {
      const post = globalThis.self.postMessage;
      globalThis.self.postMessage = (message) => {
        post(message);
        if (message.status?.state === 'error') resolve(message.status);
      };
    });
    listeners.get('message')({
      data: {
        type: 'connectGranted',
        profileId: 'zebra-ds8178-usb-cdc',
        preferredPortInfo: { usbVendorId: 0x05e0, usbProductId: 0x1200 }
      }
    });
    const status = await errorStatus;
    assert.match(status.lastError, /select the scanner/i);
    assert.equal(opens, 0);
    listeners.get('message')({ data: { type: 'refreshPorts' } });
    await Promise.resolve();
    assert.equal(messages.at(-1).status.state, 'error');
  } finally {
    delete globalThis.self;
    delete globalThis.navigator;
  }
});

test('failed test transition requires closing the paused reader before reconnect', async () => {
  const listeners = new Map();
  const messages = [];
  let notify;
  let readResolve;
  let opens = 0;
  let closes = 0;
  let failCancel = true;
  let signalReader;
  const readerStarted = new Promise((resolve) => {
    signalReader = resolve;
  });
  const waitFor = (predicate) =>
    new Promise((resolve) => {
      notify = (message) => {
        if (predicate(message)) {
          notify = null;
          resolve(message);
        }
      };
    });
  const port = {
    readable: {
      getReader() {
        return {
          read: () =>
            new Promise((resolve) => {
              readResolve = resolve;
              signalReader();
            }),
          cancel: async () => {
            if (failCancel) {
              failCancel = false;
              throw new Error('cancel failed');
            }
            readResolve?.({ done: true });
          },
          releaseLock() {}
        };
      }
    },
    writable: null,
    getInfo: () => ({ usbVendorId: 0x05e0, usbProductId: 0x1200 }),
    open: async () => {
      opens += 1;
    },
    setSignals: async () => {},
    close: async () => {
      closes += 1;
    }
  };
  globalThis.self = {
    postMessage(message) {
      messages.push(message);
      notify?.(message);
    },
    addEventListener: (type, listener) => listeners.set(type, listener)
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { serial: { getPorts: async () => [port] } }
  });
  try {
    await import(
      `../extension/scanner/scanner-daemon-worker.js?recovery=${Date.now()}`
    );
    const connected = waitFor(
      (message) => message.status?.state === 'connected'
    );
    const connect = {
      type: 'connectGranted',
      profileId: 'zebra-ds8178-usb-cdc',
      preferredPortInfo: port.getInfo()
    };
    listeners.get('message')({ data: connect });
    await connected;
    await readerStarted;
    // The worker installs the opened connection after the provider returns.
    await Promise.resolve();
    const paused = waitFor((message) => message.type === 'testState');
    listeners.get('message')({
      data: {
        type: 'startTest',
        requestId: 'test',
        sessionId: '0ca46075-06a3-4b70-9d15-81ea5e9b3cda',
        expiresAt: Date.now() + 50000
      }
    });
    assert.equal((await paused).state, 'paused');
    const reconnected = waitFor(
      (message) => message.status?.state === 'connected' && opens === 2
    );
    listeners.get('message')({ data: connect });
    await reconnected;
    assert.equal(closes, 1);
    const disabled = waitFor((message) => message.status?.state === 'disabled');
    listeners.get('message')({ data: { type: 'disconnect' } });
    await disabled;
  } finally {
    delete globalThis.self;
    delete globalThis.navigator;
  }
});
