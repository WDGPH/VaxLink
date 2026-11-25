import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodePacket,
  fakeSerialPort,
  scannerPacket
} from './helpers/ssi-serial.js';

test('live result tokens are single-use and expire when the port reopens', async (t) => {
  const { port, writes, receive } = fakeSerialPort();
  const messages = [];
  const settle = () => new Promise(setImmediate);
  let onMessage;
  globalThis.self = {
    postMessage: (message) => messages.push(message),
    addEventListener: (_, listener) => {
      onMessage = listener;
    }
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { serial: { getPorts: async () => [port] } }
  });
  t.after(() => {
    delete globalThis.self;
    delete globalThis.navigator;
  });
  await import('../extension/scanner/scanner-daemon-worker.js?feedback');
  const send = (type, fields) => onMessage({ data: { type, ...fields } });
  const open = async (testing = false) => {
    send('connectGranted', { profileId: 'zebra-ds8178-ssi-live', testing });
    await settle();
  };
  const stop = async () => {
    send('disconnect');
    await settle();
    assert.equal(messages.at(-1).status.state, 'disabled');
  };
  const otherBeeps = () => writes.filter((packet) => packet[1] === 0xe6);

  await open();
  receive(decodePacket('FIRST'));
  await settle();
  const firstToken = messages.at(-1).feedbackToken;
  assert.equal(typeof firstToken, 'string');
  send('feedback', { feedbackToken: firstToken, result: 'works' });
  send('feedback', { feedbackToken: firstToken, result: 'expired' });
  await settle();
  assert.deepEqual(
    otherBeeps().map((packet) => packet[4]),
    [0]
  );
  receive(scannerPacket(0xd0));
  receive(decodePacket('SECOND'));
  await settle();
  const secondToken = messages.at(-1).feedbackToken;
  assert.ok(secondToken && secondToken !== firstToken);
  await stop();

  await open();
  receive(decodePacket('THIRD'));
  await settle();
  send('feedback', { feedbackToken: secondToken, result: 'expired' });
  send('testFeedback', { requestId: 1, result: 'expired' });
  await settle();
  assert.equal(messages.at(-1).requestId, 1);
  assert.equal(otherBeeps().length, 1);
  await stop();

  await open(true);
  receive(decodePacket('SAMPLE'));
  await settle();
  assert.equal(messages.at(-1).status.sampleReceived, true);
  assert.equal(messages.filter(({ type }) => type === 'scan').length, 3);
  send('testFeedback', { requestId: 2, result: 'attention' });
  await settle();
  receive(scannerPacket(0xd0));
  await settle();
  assert.equal(messages.at(-1).requestId, 2);
  assert.equal(messages.at(-1).success, true);
  assert.deepEqual(
    otherBeeps().map((packet) => packet[4]),
    [0, 6]
  );
  await stop();
});

test('scanner reads and disconnects even when optional control signals fail', async () => {
  const workerMessages = [];
  const workerListeners = new Map();
  let resolveRead = null;
  const stream = {
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
  let readable = null;
  let closeCount = 0;
  let forgetCount = 0;
  const port = {
    get readable() {
      return readable;
    },
    writable: null,
    getInfo: () => ({ usbVendorId: 0x05e0, usbProductId: 0x1200 }),
    async forget() {
      forgetCount += 1;
    },
    open: async () => {
      readable = stream;
    },
    setSignals: async () => {
      throw new DOMException('Failed to set control signals.', 'NetworkError');
    },
    close: async () => {
      closeCount += 1;
      readable = null;
    }
  };

  globalThis.self = {
    postMessage: (message) => workerMessages.push(message),
    addEventListener: (type, listener) => workerListeners.set(type, listener)
  };
  const unrelated = { getInfo: () => ({ usbVendorId: 1 }) };
  let ports = [port, unrelated];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { serial: { getPorts: async () => ports } }
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

  ports = [port];
  workerListeners.get('message')({ data: { type: 'refreshPorts' } });
  await Promise.resolve();
  assert.equal(closeCount, 0, 'an unrelated USB removal does not stop capture');

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

  workerListeners.get('message')({
    data: {
      type: 'connectGranted',
      profileId: 'zebra-ds8178-usb-cdc',
      testing: true
    }
  });
  await new Promise(setImmediate);
  resolveRead({
    value: new TextEncoder().encode('01001234567890121727123110TESTONLY\r\n'),
    done: false
  });
  await new Promise(setImmediate);
  assert.equal(workerMessages.at(-1).status.sampleReceived, true);
  assert.equal(workerMessages.at(-1).status.captureCount, 1);
  assert.equal(
    workerMessages.filter((message) => message.type === 'scan').length,
    1
  );
  workerListeners.get('message')({ data: { type: 'disconnect' } });
  await new Promise(setImmediate);

  for (const ambiguous of [true, false]) {
    ports = ambiguous ? [port, { getInfo: port.getInfo }] : [port, unrelated];
    workerListeners.get('message')({
      data: { type: 'disconnect', forget: true, portInfo: port.getInfo() }
    });
    await new Promise(setImmediate);
    assert.equal(workerMessages.at(-1).permissionRemoved, !ambiguous);
    assert.equal(forgetCount, ambiguous ? 0 : 1);
    assert.equal(workerMessages.at(-1).status.state, 'never_configured');
  }

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

test('Disconnect retries a failed close after a late open without reading any bytes', async (t) => {
  const workerMessages = [];
  let receive;
  let finishOpen;
  let startedOpening;
  let receiveReply;
  let readable = null;
  let closeCount = 0;
  const opening = new Promise((resolve) => {
    startedOpening = resolve;
  });
  const port = {
    get readable() {
      return readable;
    },
    getInfo: () => ({ usbVendorId: 0x05e0, usbProductId: 0x1200 }),
    open() {
      startedOpening();
      return new Promise((resolve) => {
        finishOpen = resolve;
      });
    },
    async close() {
      if (++closeCount === 1) throw new Error('Close failed');
      readable = null;
    }
  };
  globalThis.self = {
    postMessage(message) {
      workerMessages.push(message);
      if (message.type === 'reply') receiveReply(message);
    },
    addEventListener(type, listener) {
      receive = listener;
    }
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { serial: { getPorts: async () => [port] } }
  });
  t.after(() => {
    delete globalThis.self;
    delete globalThis.navigator;
  });

  await import('../extension/scanner/scanner-daemon-worker.js?lateOpen');
  receive({
    data: { type: 'connectGranted', profileId: 'zebra-ds8178-usb-cdc' }
  });
  await opening;
  const stop = (requestId) =>
    new Promise((resolve) => {
      receiveReply = resolve;
      receive({ data: { type: 'disconnect', requestId } });
    });
  const firstStop = stop(1);
  readable = {
    getReader() {
      assert.fail('cancelled connection must never open a reader');
    }
  };
  assert.ok(!workerMessages.some((message) => message.type === 'reply'));
  finishOpen();
  assert.match((await firstStop).error, /confirm that the scanner stopped/);
  assert.equal(closeCount, 1);
  assert.equal((await stop(2)).status.state, 'disabled');
  assert.equal(closeCount, 2);
  assert.ok(
    !workerMessages.some(
      (message) =>
        message.type === 'scan' || message.status?.state === 'connected'
    )
  );
});
