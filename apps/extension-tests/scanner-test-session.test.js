import assert from 'node:assert/strict';
import test from 'node:test';
import { createScannerTestController } from '../extension/diagnostics/scanner-test.js';

const sessionId = '0ca46075-06a3-4b70-9d15-81ea5e9b3cda';

test('test session acknowledges ownership boundaries and emits only safe observations', async () => {
  const messages = [];
  const changes = [];
  let complete;
  let notify;
  let changed;
  const nextChange = () =>
    new Promise((resolve) => {
      changed = resolve;
    });
  const nextMessage = () =>
    new Promise((resolve) => {
      notify = resolve;
    });
  const connection = {
    setCaptureOwner(owner) {
      changes.push(owner);
      changed?.();
      return new Promise((resolve) => {
        complete = resolve;
      });
    }
  };
  const controller = createScannerTestController({
    getConnection: () => connection,
    post(message) {
      messages.push(message);
      notify?.(message);
    }
  });
  let result = nextMessage();
  let change = nextChange();
  controller.handleMessage({
    type: 'startTest',
    requestId: 1,
    sessionId,
    expiresAt: Date.now() + 50000
  });
  await change;
  assert.deepEqual(changes, [sessionId]);
  assert.equal(messages.length, 0);
  complete();
  assert.equal((await result).state, 'active');
  controller.onRead({ owner: sessionId, byteCount: 5 });
  controller.onScan(
    { rawText: '010012345678901210ABC', rawBytesHex: 'secret' },
    { owner: sessionId, completionReason: 'terminator' }
  );
  assert.equal(messages.at(-1).kind, 'frame');
  assert.equal(JSON.stringify(messages).includes('ABC'), false);
  assert.equal(JSON.stringify(messages).includes('secret'), false);
  result = nextMessage();
  change = nextChange();
  controller.handleMessage({ type: 'stopTest', requestId: 2, sessionId });
  await change;
  assert.equal(changes.at(-1), 'clinical');
  controller.onRead({ owner: sessionId, byteCount: 2 });
  const count = messages.length;
  complete();
  assert.equal((await result).state, 'stopped');
  controller.onRead({ owner: sessionId, byteCount: 2 });
  assert.equal(messages.length, count + 1);
});

test('disconnect invalidates a test in the process of starting', async () => {
  let finish;
  let notified;
  let started;
  const starting = new Promise((resolve) => {
    started = resolve;
  });
  const message = new Promise((resolve) => {
    notified = resolve;
  });
  const connection = {
    setCaptureOwner: () =>
      new Promise((resolve) => {
        finish = resolve;
        started();
      })
  };
  const controller = createScannerTestController({
    getConnection: () => connection,
    post: notified
  });
  controller.handleMessage({
    type: 'startTest',
    sessionId,
    expiresAt: Date.now() + 50000
  });
  await starting;
  assert.equal(controller.connectionLost(), true);
  finish();
  assert.equal((await message).state, 'paused');
});
