import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bytesToHex,
  createLineFrameDecoder
} from '../extension/scanner/serial-decoder.js';
import { createSsiTransport } from '../extension/scanner/ssi-transport.js';
import { decodePacket, scannerPacket } from './helpers/ssi-serial.js';

test('line decoder emits CRLF-terminated ASCII frames', () => {
  const decoder = createLineFrameDecoder();
  const frames = decoder.push(
    new Uint8Array([...Buffer.from('010001234567890510LOT17260101\r\n')])
  );

  assert.equal(frames.length, 1);
  assert.equal(frames[0].text, '010001234567890510LOT17260101');
  assert.equal(
    frames[0].rawBytesHex,
    bytesToHex(Buffer.from('010001234567890510LOT17260101'))
  );
});

test('line decoder keeps partial chunks until terminator arrives', () => {
  const decoder = createLineFrameDecoder();
  assert.deepEqual(decoder.push(Buffer.from('01000123')), []);

  const frames = decoder.push(Buffer.from('45678905\n'));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].text, '0100012345678905');
});

test('line decoder flush emits unterminated frame', () => {
  const decoder = createLineFrameDecoder();
  assert.deepEqual(decoder.push(Buffer.from('17100101')), []);

  const frames = decoder.flush();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].text, '17100101');
});

test('line decoder ignores empty terminator-only frames', () => {
  const decoder = createLineFrameDecoder();
  assert.deepEqual(decoder.push(Buffer.from('\r\n')), []);
});

test('long-range decoding waits for complete frames and drains an oversized frame', () => {
  const decoder = createLineFrameDecoder({
    delimiters: ['\r\n'],
    requireTerminator: true,
    maxFrameLength: 4
  });
  assert.deepEqual(decoder.push(Buffer.from('LOT1\r')), []);
  assert.deepEqual(decoder.flush(), []);
  assert.deepEqual(
    decoder.push(Buffer.from('\nLOT1\r\nTOO-LONG\r')).map(({ text }) => text),
    ['LOT1', 'LOT1']
  );
  assert.deepEqual(
    decoder.push(Buffer.from('\nLOT2\r\n')).map(({ text }) => text),
    ['Barcode exceeded the scanner capture limit.', 'LOT2']
  );
});

test('SSI assembles checked packets, keeps GS1 separators and ACKs retransmissions once per fragment', () => {
  const writes = [];
  const captured = [];
  const transport = createSsiTransport(
    {
      async write(bytes) {
        writes.push(bytesToHex(bytes));
      }
    },
    (frame) => captured.push(frame)
  );
  const first = decodePacket(']d201', 2);
  transport.push(first.slice(0, 4));
  assert.deepEqual(writes, []);
  transport.push(first.slice(4));
  assert.deepEqual(captured, []);
  const bad = decodePacket('01234567890128\x1d10LOT', 0);
  bad[bad.length - 1] ^= 1;
  transport.push(
    Buffer.concat([
      decodePacket(']d201', 3),
      bad,
      scannerPacket(0xd0),
      scannerPacket(0xd1, 0, [6]),
      decodePacket('01234567890128\x1d10LOT', 1),
      decodePacket('01234567890128\x1d10LOT', 1),
      decodePacket(']d20101234567890128\x1d10LOT', 0)
    ])
  );
  const text = ']d20101234567890128\x1d10LOT';
  assert.deepEqual(
    captured.map((frame) => frame.text),
    [text, text]
  );
  assert.equal(captured[0].rawBytesHex, bytesToHex(Buffer.from(text)));
  const ack = '04 d0 04 00 ff 28';
  assert.deepEqual(writes, [ack, ack, '05 d1 04 00 01 ff 25', ack, ack, ack]);
});

test('SSI cancels a timed-out barcode and its retry before accepting another capture', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const writes = [];
  const captured = [];
  const transport = createSsiTransport(
    {
      async write(bytes) {
        writes.push(bytesToHex(bytes));
      }
    },
    (frame) => captured.push(frame.text)
  );
  transport.push(decodePacket('FIRST', 2));
  t.mock.timers.tick(6000);
  const last = 'ORPHAN';
  transport.push(decodePacket(last, 0));
  transport.push(decodePacket(last, 1));
  assert.deepEqual(captured, []);
  transport.push(decodePacket('NEXT', 0));
  assert.deepEqual(captured, ['NEXT']);
  assert.deepEqual(writes, [
    '04 d0 04 00 ff 28',
    '05 d1 04 00 0a ff 1c',
    '05 d1 04 00 0a ff 1c',
    '04 d0 04 00 ff 28'
  ]);
});

test('a valid SSI retry recovers a rejected repeat without replaying an accepted capture', () => {
  const writes = [];
  const captured = [];
  const transport = createSsiTransport(
    {
      async write(bytes) {
        writes.push(bytes[1]);
      }
    },
    (frame) => captured.push(frame.text)
  );
  const barcode = '10TESTLOT';
  const damagedRetry = decodePacket(barcode, 1);
  damagedRetry[3] = 0;

  transport.push(
    Buffer.concat([
      decodePacket(barcode, 0),
      damagedRetry,
      decodePacket(barcode, 1)
    ])
  );
  assert.deepEqual(captured, [barcode]);

  for (const [offset, mask] of [
    [-1, 4],
    [7, 4],
    [7, 1]
  ]) {
    const rejectedOriginal = decodePacket(barcode, 0);
    rejectedOriginal[offset === -1 ? rejectedOriginal.length - 1 : offset] ^=
      mask;
    transport.push(Buffer.concat([rejectedOriginal, decodePacket(barcode, 1)]));
  }
  assert.deepEqual(captured, [barcode, barcode, barcode, barcode]);
  assert.deepEqual(
    writes,
    [0xd0, 0xd1, 0xd0, 0xd1, 0xd0, 0xd1, 0xd0, 0xd1, 0xd0]
  );
});

test('SSI forgets a prefix after the scanner exhausts a corrupt final packet', () => {
  for (const initialWasLost of [false, true]) {
    const replies = [];
    const captured = [];
    const transport = createSsiTransport(
      {
        async write(bytes) {
          replies.push(bytesToHex(bytes));
        }
      },
      (frame) => captured.push(frame.text)
    );
    transport.push(decodePacket('10WRONG', 2));
    for (const attempt of initialWasLost ? [1, 1] : [0, 1, 1]) {
      const bad = decodePacket('TAIL', attempt);
      bad[bad.length - 1] ^= 1;
      transport.push(bad);
    }
    assert.deepEqual(captured, []);
    transport.push(decodePacket('10NEXT', 0));
    assert.deepEqual(captured, ['10NEXT']);
    assert.deepEqual(replies, [
      '04 d0 04 00 ff 28',
      '05 d1 04 00 01 ff 25',
      '05 d1 04 00 01 ff 25',
      ...(!initialWasLost ? ['05 d1 04 00 0a ff 1c'] : []),
      '04 d0 04 00 ff 28'
    ]);
  }
});
