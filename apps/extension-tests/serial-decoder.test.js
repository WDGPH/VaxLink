import assert from 'node:assert/strict';
import test from 'node:test';

import { bytesToHex, createLineFrameDecoder } from '../extension/scanner/serial-decoder.js';

test('line decoder emits CRLF-terminated ASCII frames', () => {
  const decoder = createLineFrameDecoder();
  const frames = decoder.push(new Uint8Array([
    ...Buffer.from('010001234567890510LOT17260101\r\n')
  ]));

  assert.equal(frames.length, 1);
  assert.equal(frames[0].text, '010001234567890510LOT17260101');
  assert.equal(frames[0].rawBytesHex, bytesToHex(Buffer.from('010001234567890510LOT17260101')));
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
