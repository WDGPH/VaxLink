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

test('ownership change discards partial and late reads before resuming', async () => {
  const reads = [];
  const scans = [];
  const observations = [];
  let cancelResolve;
  let cancelStarted;
  const cancelling = new Promise((resolve) => {
    cancelStarted = resolve;
  });
  let releaseCount = 0;
  const port = {
    readable: {
      getReader() {
        let resolveRead;
        return {
          read() {
            return new Promise((resolve) => {
              resolveRead = resolve;
              reads.push(resolve);
            });
          },
          cancel() {
            cancelStarted();
            return new Promise((resolve) => {
              cancelResolve = resolve;
            });
          },
          releaseLock() {
            releaseCount += 1;
          }
        };
      }
    },
    writable: null,
    getInfo: () => ({ usbVendorId: 0x05e0 }),
    open: async () => {},
    setSignals: async () => {},
    close: async () => {}
  };
  const connection = await openSerialScanner(port, 'zebra-ds8178-usb-cdc', {
    onScan: (scan, metadata) => scans.push({ scan, metadata }),
    onRead: (metadata) => observations.push(metadata)
  });
  reads.shift()({ value: Buffer.from('PART'), done: false });
  await Promise.resolve();
  const switchToTest = connection.setCaptureOwner('test-owner');
  await cancelling;
  reads.shift()({ value: Buffer.from('LATE\n'), done: false });
  await Promise.resolve();
  assert.equal(scans.length, 0);
  cancelResolve();
  await switchToTest;
  assert.equal(releaseCount, 1);
  reads.shift()({ value: Buffer.from('TEST\n'), done: false });
  await Promise.resolve();
  assert.equal(scans[0].scan.rawText, 'TEST');
  assert.equal(scans[0].metadata.owner, 'test-owner');
  assert.equal(scans[0].metadata.completionReason, 'terminator');
  assert.deepEqual(
    observations.map((item) => item.owner),
    ['clinical', 'test-owner']
  );
  const closed = connection.close();
  reads.shift()({ done: true });
  cancelResolve();
  await closed;
});

test('ownership change cannot succeed after the scanner closes', async () => {
  let resolveRead;
  const cancelResolvers = [];
  let cancelled;
  const cancelStarted = new Promise((resolve) => {
    cancelled = resolve;
  });
  const port = {
    readable: {
      getReader: () => ({
        read: () =>
          new Promise((resolve) => {
            resolveRead = resolve;
          }),
        cancel: () => {
          cancelled();
          return new Promise((resolve) => {
            cancelResolvers.push(resolve);
          });
        },
        releaseLock() {}
      })
    },
    writable: null,
    getInfo: () => ({ usbVendorId: 0x05e0 }),
    open: async () => {},
    setSignals: async () => {},
    close: async () => {}
  };
  const connection = await openSerialScanner(port, 'zebra-ds8178-usb-cdc');
  const transition = connection.setCaptureOwner('test-owner');
  await cancelStarted;
  const closing = connection.close();
  resolveRead({ done: true });
  cancelResolvers.forEach((resolve) => resolve());
  await assert.rejects(transition, /not connected/);
  await closing;
});
