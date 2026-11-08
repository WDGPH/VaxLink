import assert from 'node:assert/strict';
import test from 'node:test';

import { openSerialScanner } from '../extension/scanner/serial-provider.js';

test('a terminal read error closes the COM port before reconnect is requested', async () => {
  const events = [];
  let errorObserved;
  const observed = new Promise((resolve) => {
    errorObserved = resolve;
  });
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
      errorObserved();
    }
  });

  await observed;
  assert.deepEqual(events, ['open', 'open', 'close', 'error:NetworkError']);
});

test('a read completing after cancellation is discarded', async () => {
  let finishRead;
  let scans = 0;
  let bytes = 0;
  let readable = {
    getReader: () => ({
      read: () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
      cancel: async () => {
        finishRead({
          value: new TextEncoder().encode('10LATE\n'),
          done: false
        });
      },
      releaseLock() {}
    })
  };
  const port = {
    get readable() {
      return readable;
    },
    writable: null,
    getInfo: () => ({}),
    open: async () => {},
    close: async () => {
      readable = null;
    },
    setSignals: async () => {}
  };
  const scanner = await openSerialScanner(port, 'generic-usb-cdc', {
    onScan: () => scans++,
    onBytes: () => bytes++
  });
  await scanner.close();
  assert.equal(scans, 0);
  assert.equal(bytes, 0);
});

test('reader cancellation failure is reported to the caller', async () => {
  const port = {
    readable: {
      getReader: () => ({
        read: () => new Promise(() => {}),
        cancel: async () => {
          throw new Error('cancel failed');
        },
        releaseLock() {}
      })
    },
    writable: null,
    getInfo: () => ({}),
    open: async () => {},
    close: async () => {},
    setSignals: async () => {}
  };
  const scanner = await openSerialScanner(port, 'generic-usb-cdc');
  await assert.rejects(scanner.close(), /cancel failed/);
});

test('port close failure is not acknowledged as release', async () => {
  let finishRead;
  const port = {
    readable: {
      getReader: () => ({
        read: () =>
          new Promise((resolve) => {
            finishRead = resolve;
          }),
        cancel: async () => {
          finishRead({ done: true });
        },
        releaseLock() {}
      })
    },
    writable: null,
    getInfo: () => ({}),
    open: async () => {},
    close: async () => {
      throw new Error('close failed');
    },
    setSignals: async () => {}
  };
  const scanner = await openSerialScanner(port, 'generic-usb-cdc');
  await assert.rejects(scanner.close(), /close failed/);
});
