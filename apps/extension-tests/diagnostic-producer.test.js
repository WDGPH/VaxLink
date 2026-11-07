import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import '../extension/diagnostics/collector.js';
import '../extension/diagnostics/producer.js';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const { createProducer } = globalThis.VaxLinkDiagnosticEvents;
const id = '12345678-1234-4234-8234-123456789abc';

test('disabled, expired, malformed, and stopped producers never deliver', async () => {
  const batches = [];
  const producer = createProducer({
    context: 'worker',
    deliver: async (batch) => batches.push(batch)
  });
  assert.equal(producer.newOperation(), null);
  assert.equal(producer.record(null, 'parse', 'parsed'), false);
  producer.setSession({ id, recordingUntil: Date.now() + 60000 });
  const link = producer.newOperation();
  assert.equal(
    producer.record(link, 'parse', 'parsed', { metadata: { raw: 'patient' } }),
    false
  );
  assert.equal(
    producer.record({ ...link, patient: 'x' }, 'parse', 'parsed'),
    false
  );
  assert.equal(producer.record(link, 'parse', 'parsed'), true);
  producer.setSession(null);
  await producer.flush();
  assert.equal(batches.length, 0);
  producer.setSession({ id, recordingUntil: Date.now() - 1 });
  assert.equal(producer.active(), false);
});

test('batches at most 25, bounds queued events, and reports producer drops', async () => {
  const batches = [];
  const producer = createProducer({
    context: 'worker',
    deliver: async (batch) => batches.push(batch)
  });
  producer.setSession({ id, recordingUntil: Date.now() + 60000 });
  const link = producer.newOperation();
  for (let i = 0; i < 102; i++)
    producer.record(link, 'serial_chunk', 'observed', {
      metadata: { byteCount: i }
    });
  await producer.flush();
  assert.equal(batches[0].events.length, 25);
  assert.equal(batches[0].dropped, 2);
  for (let i = 0; i < 3; i++) await producer.flush();
  assert.equal(batches.flatMap((batch) => batch.events).length, 100);
  producer.setSession(null);
});

test('flush waits for in-flight delivery and drains queued batches', async () => {
  const batches = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const producer = createProducer({
    context: 'worker',
    deliver: async (batch) => {
      batches.push(batch);
      if (batches.length === 1) await gate;
    }
  });
  producer.setSession({ id, recordingUntil: Date.now() + 60000 });
  const link = producer.newOperation();
  producer.record(link, 'parse', 'parsed');
  const first = producer.flush();
  for (let i = 0; i < 50; i++) producer.record(link, 'parse', 'parsed');
  let finished = false;
  const stop = producer.flush().then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  release();
  await Promise.all([first, stop]);
  assert.equal(batches.flatMap((batch) => batch.events).length, 51);
  assert.equal(producer.pendingCount(), 0);
  producer.setSession(null);
});

test('session replacement during unresolved delivery does not replay old events', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const batches = [];
  const producer = createProducer({
    context: 'worker',
    deliver: async (batch) => {
      batches.push(batch);
      await gate;
    }
  });
  producer.setSession({ id, recordingUntil: Date.now() + 60000 });
  const link = producer.newOperation();
  producer.record(link, 'parse', 'parsed');
  const pending = producer.flush();
  producer.record(link, 'parse', 'parsed');
  producer.setSession(null);
  release();
  await pending;
  assert.equal(batches.length, 1);
  assert.equal(producer.pendingCount(), 0);
});

test('a new session schedules its queued events after an older delivery finishes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const batches = [];
  const producer = createProducer({
    context: 'worker',
    deliver: async (batch) => {
      batches.push(batch);
      if (batches.length === 1) await gate;
    }
  });
  producer.setSession({ id, recordingUntil: Date.now() + 60000 });
  producer.record(producer.newOperation(), 'parse', 'parsed');
  const oldDelivery = producer.flush();
  const nextId = crypto.randomUUID();
  producer.setSession({ id: nextId, recordingUntil: Date.now() + 60000 });
  producer.record(producer.newOperation(), 'parse', 'parsed');
  release();
  await oldDelivery;
  assert.equal(producer.pendingCount(), 1);
  t.mock.timers.tick(100);
  await producer.flush();
  assert.deepEqual(
    batches.map((batch) => batch.sessionId),
    [id, nextId]
  );
  assert.equal(producer.pendingCount(), 0);
  producer.setSession(null);
});
