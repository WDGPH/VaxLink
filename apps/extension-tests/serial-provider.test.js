import assert from 'node:assert/strict';
import test from 'node:test';

import { openSerialScanner } from '../extension/scanner/serial-provider.js';
import {
  decodePacket,
  fakeSerialPort,
  scannerPacket
} from './helpers/ssi-serial.js';

const settle = () => new Promise(setImmediate);

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

test('all CDC profiles receive scans without writing commands', async () => {
  for (const profileId of [
    'zebra-ds8178-usb-cdc',
    'generic-usb-cdc',
    'zebra-ds8178-cdc-long-range'
  ]) {
    const { port, writes, receive } = fakeSerialPort();
    const scans = [];
    const connection = await openSerialScanner(port, profileId, (scan) =>
      scans.push(scan)
    );
    receive(Buffer.from('LOT1\r\nLOT'));
    receive(Buffer.from('1\r\n'));
    await settle();
    await connection.close();
    assert.deepEqual(
      scans.map((scan) => [scan.rawText, scan.device.profileId]),
      [
        ['LOT1', profileId],
        ['LOT1', profileId]
      ]
    );
    assert.equal(connection.playFeedback, undefined);
    assert.deepEqual(writes, []);
  }
});

test('SSI ACKs a capture while a feedback command waits and uses only the three fixed BEEP packets', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { port, writes, receive } = fakeSerialPort();
  const scans = [];
  const connection = await openSerialScanner(
    port,
    'zebra-ds8178-ssi-live',
    (scan) => scans.push(scan.rawText)
  );
  const ack = [0x04, 0xd0, 0x04, 0x00, 0xff, 0x28];
  const works = [0x05, 0xe6, 0x04, 0x00, 0x00, 0xff, 0x11];
  receive(decodePacket('FIRST'));
  await settle();
  assert.deepEqual(writes, [ack]);
  const pending = connection.playFeedback('works');
  await settle();
  receive(decodePacket('SECOND'));
  await settle();
  assert.deepEqual(writes, [ack, works, ack]);
  assert.deepEqual(scans, ['FIRST', 'SECOND']);
  receive(scannerPacket(0xd0));
  assert.deepEqual(await pending, { success: true });
  for (const [result, packet] of [
    ['attention', [0x05, 0xe6, 0x04, 0x00, 0x06, 0xff, 0x0b]],
    ['expired', [0x05, 0xe6, 0x04, 0x00, 0x11, 0xff, 0x00]]
  ]) {
    const feedback = connection.playFeedback(result);
    await settle();
    assert.deepEqual(writes.at(-1), packet);
    receive(scannerPacket(0xd0));
    assert.deepEqual(await feedback, { success: true });
  }
  assert.equal(writes.length, 5);
  assert.deepEqual(scans, ['FIRST', 'SECOND']);
  await connection.close();
});

test('SSI retries a BEEP at most twice and a late ACK cannot confirm another result', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { port, writes, receive } = fakeSerialPort();
  const scans = [];
  const connection = await openSerialScanner(
    port,
    'zebra-ds8178-ssi-live',
    (scan) => scans.push(scan.rawText)
  );
  const pending = connection.playFeedback('attention');
  await settle();
  assert.deepEqual(writes, [[0]], 'an idle port receives WAKEUP before BEEP');
  t.mock.timers.tick(100);
  await settle();
  assert.deepEqual(writes.at(-1), [0x05, 0xe6, 0x04, 0x00, 0x06, 0xff, 0x0b]);
  receive(scannerPacket(0xd1, 0, [1]));
  await settle();
  assert.deepEqual(writes.at(-1), [0x05, 0xe6, 0x04, 0x01, 0x06, 0xff, 0x0a]);
  t.mock.timers.tick(2000);
  await settle();
  t.mock.timers.tick(100);
  await settle();
  assert.deepEqual(writes.at(-1), [0x05, 0xe6, 0x04, 0x01, 0x06, 0xff, 0x0a]);
  t.mock.timers.tick(2000);
  assert.equal((await pending).success, false);
  assert.equal(writes.filter((bytes) => bytes[1] === 0xe6).length, 3);
  receive(scannerPacket(0xd0));
  receive(decodePacket('STILL-CAPTURED'));
  assert.equal((await connection.playFeedback('works')).success, false);
  await settle();
  assert.deepEqual(scans, ['STILL-CAPTURED']);
  assert.equal(writes.filter((bytes) => bytes[1] === 0xe6).length, 3);
  await connection.close();
});

test('SSI disconnect cancels a pending feedback command and releases both locks', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { port, writes, receive } = fakeSerialPort();
  const connection = await openSerialScanner(port, 'zebra-ds8178-ssi-live');
  receive(decodePacket('FIRST'));
  await settle();
  const feedback = connection.playFeedback('works');
  await settle();
  assert.equal(writes.filter((bytes) => bytes[1] === 0xe6).length, 1);
  await connection.close();
  assert.equal((await feedback).success, false);
  assert.equal(port.readable, null);
  assert.equal(port.writable, null);
  assert.equal(writes.filter((bytes) => bytes[1] === 0xe6).length, 1);
});

test('expired live feedback cannot write a BEEP after wake or a delayed retry', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { port, writes, receive } = fakeSerialPort();
  const connection = await openSerialScanner(port, 'zebra-ds8178-ssi-live');
  const beepCount = () => writes.filter((bytes) => bytes[1] === 0xe6).length;
  const expiring = connection.playFeedback('works', Date.now() + 50);
  await settle();
  t.mock.timers.tick(100);
  assert.equal((await expiring).success, false);
  assert.equal(beepCount(), 0);

  receive(decodePacket('RECENT'));
  await settle();
  const noReply = connection.playFeedback('attention', Date.now() + 3000);
  await settle();
  assert.equal(beepCount(), 1);
  t.mock.timers.tick(2000);
  await settle();
  t.mock.timers.tick(100);
  await settle();
  assert.equal(beepCount(), 2);
  t.mock.timers.tick(2000);
  assert.equal((await noReply).success, false);
  receive(scannerPacket(0xd0));
  assert.equal((await connection.playFeedback('expired')).success, false);
  assert.equal(beepCount(), 2);
  await connection.close();
});
