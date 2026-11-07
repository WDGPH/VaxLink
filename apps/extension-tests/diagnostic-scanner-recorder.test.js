import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createScannerRecorder } from '../extension/diagnostics/scanner-recorder.js';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const id = '12345678-1234-4234-8234-123456789abc';

async function withTimers(run) {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers = new Map();
  let next = 0;
  globalThis.setTimeout = (fn) => {
    const key = ++next;
    timers.set(key, fn);
    return key;
  };
  globalThis.clearTimeout = (key) => timers.delete(key);
  try {
    await run(async () => {
      for (const [key, fn] of [...timers]) {
        timers.delete(key);
        fn();
      }
      await Promise.resolve();
      await Promise.resolve();
    });
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
}

test('inactive, expired and test-owner reads cause no diagnostic messages', async () =>
  withTimers(async (flush) => {
    const batches = [];
    const recorder = createScannerRecorder({
      post: (batch) => batches.push(batch)
    });
    recorder.onRead({ owner: 'clinical', byteCount: 10 });
    assert.equal(
      recorder.onFrame({ owner: 'clinical', completionReason: 'idle' }),
      null
    );
    recorder.setSession({ id, recordingUntil: Date.now() + 60000 });
    recorder.onRead({ owner: 'test', byteCount: 10 });
    assert.equal(
      recorder.onFrame({ owner: 'test', completionReason: 'idle' }),
      null
    );
    await flush();
    recorder.setSession({ id, recordingUntil: Date.now() - 1 });
    recorder.onRead({ owner: 'clinical', byteCount: 10 });
    await flush();
    assert.deepEqual(batches, []);
  }));

test('records bytes before frames, keeps frame IDs distinct and clears at boundary', async () =>
  withTimers(async (flush) => {
    const batches = [];
    const recorder = createScannerRecorder({
      post: (batch) => batches.push(batch)
    });
    recorder.setSession({ id, recordingUntil: Date.now() + 60000 });
    recorder.onRead({ owner: 'clinical', byteCount: 10, raw: 'secret' });
    const first = recorder.onFrame({
      owner: 'clinical',
      completionReason: 'terminator'
    });
    const second = recorder.onFrame({
      owner: 'clinical',
      completionReason: 'idle'
    });
    recorder.onRead({ owner: 'clinical', byteCount: 2 });
    recorder.boundary();
    const fourth = recorder.onFrame({
      owner: 'clinical',
      completionReason: 'overflow'
    });
    await flush();
    const events = batches.flatMap((batch) => batch.events);
    assert.notEqual(first.operationId, second.operationId);
    assert.notEqual(second.operationId, fourth.operationId);
    assert.equal(events[0].outcome, 'partial');
    assert.equal(events[1].code, 'serial_chunk');
    assert.equal(events[2].operationId, first.operationId);
    assert.equal(events[3].outcome, 'partial');
    assert.equal(events[6].outcome, 'cancelled');
    assert.equal(events.at(-1).reason, 'overflow');
    assert.equal(JSON.stringify(batches).includes('secret'), false);
    recorder.setSession(null);
  }));

test('post failures do not throw into scanner calls', async () =>
  withTimers(async (flush) => {
    const recorder = createScannerRecorder({
      post: () => {
        throw new Error('unavailable');
      }
    });
    recorder.setSession({ id, recordingUntil: Date.now() + 60000 });
    assert.doesNotThrow(() =>
      recorder.onRead({ owner: 'clinical', byteCount: 1 })
    );
    assert.ok(
      recorder.onFrame({ owner: 'clinical', completionReason: 'idle' })
    );
    await flush();
    assert.doesNotThrow(() => recorder.onDisconnect());
    recorder.setSession(null);
  }));

test('same session update preserves partial frame and queued observations', async () =>
  withTimers(async (flush) => {
    const batches = [];
    const recorder = createScannerRecorder({
      post: (batch) => batches.push(batch)
    });
    const session = { id, recordingUntil: Date.now() + 60000 };
    recorder.setSession(session);
    recorder.onRead({ owner: 'clinical', byteCount: 5 });
    recorder.setSession({ ...session });
    const link = recorder.onFrame({
      owner: 'clinical',
      completionReason: 'idle'
    });
    await flush();
    const events = batches.flatMap((batch) => batch.events);
    assert.deepEqual(
      events.map((event) => event.code),
      ['lifecycle', 'serial_chunk', 'frame']
    );
    assert.ok(events.every((event) => event.operationId === link.operationId));
    recorder.setSession(null);
  }));

test('failed delivery schedules only one drop-only disclosure until a new event', async () =>
  withTimers(async (flush) => {
    const batches = [];
    const recorder = createScannerRecorder({
      post: (batch) => {
        batches.push(batch);
        throw new Error('offline');
      }
    });
    recorder.setSession({ id, recordingUntil: Date.now() + 60000 });
    recorder.onRead({ owner: 'clinical', byteCount: 1 });
    await flush();
    await flush();
    await flush();
    assert.equal(batches.length, 2);
    assert.equal(batches[1].events.length, 0);
    assert.equal(batches[1].dropped, 2);
    recorder.onRead({ owner: 'clinical', byteCount: 1 });
    await flush();
    assert.equal(batches[2].dropped, 2);
    await flush();
    assert.equal(batches.length, 4);
    recorder.setSession(null);
  }));
