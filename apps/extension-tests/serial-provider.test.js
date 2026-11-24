import assert from 'node:assert/strict';
import test from 'node:test';

import { openSerialScanner } from '../extension/scanner/serial-provider.js';

test('a terminal read error closes the COM port before reconnect is requested', async () => {
  const events = [];
  let readable = {
    getReader() {
      return {
        read: async () => {
          throw new DOMException('Device disconnected', 'NetworkError');
        },
        releaseLock() {},
        cancel: async () => undefined
      };
    }
  };
  const port = {
    get readable() {
      return readable;
    },
    writable: null,
    getInfo: () => ({ usbVendorId: 0x05e0, usbProductId: 0x1200 }),
    open: async () => {
      events.push('open');
    },
    close: async () => {
      events.push('close');
      readable = null;
    },
    setSignals: async () => undefined
  };

  await openSerialScanner(port, 'zebra-ds8178-usb-cdc', {
    onStatus(status) {
      events.push(status.state);
    },
    onError(error) {
      events.push(`error:${error.name}`);
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ['open', 'open', 'close', 'error:NetworkError']);
});

test('a cancelled opening waits for close without starting the reader', async () => {
  const events = [];
  const controller = new AbortController();
  let finishOpen;
  const openResult = new Promise((resolve) => {
    finishOpen = resolve;
  });
  let finishClose;
  const closeResult = new Promise((resolve) => {
    finishClose = resolve;
  });
  let confirmClosing;
  const closing = new Promise((resolve) => {
    confirmClosing = resolve;
  });
  const port = {
    readable: {
      getReader() {
        events.push('read');
      }
    },
    open: () => openResult,
    close() {
      confirmClosing();
      return closeResult;
    }
  };

  const opening = openSerialScanner(port, 'zebra-ds8178-usb-cdc', {
    signal: controller.signal,
    onScan: () => events.push('scan'),
    onStatus: (status) => events.push(status.state)
  });
  controller.abort();
  finishOpen();
  await closing;
  assert.deepEqual(events, []);
  finishClose();
  assert.equal(await opening, null);
  assert.deepEqual(events, []);
});
