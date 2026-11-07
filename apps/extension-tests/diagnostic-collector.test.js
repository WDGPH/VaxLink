import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/diagnostics/collector.js';

const { createCollector } = globalThis.VaxLinkDiagnosticCollector;
const id = '12345678-1234-4234-8234-123456789abc';
function fixture() {
  let time = 1000000;
  let value;
  let fail = false;
  const storage = {
    async get(key) {
      if (fail) throw new Error('storage failed');
      return { [key]: structuredClone(value) };
    },
    async set(data) {
      if (fail) throw new Error('storage failed');
      value = structuredClone(Object.values(data)[0]);
    },
    async remove() {
      if (fail) throw new Error('storage failed');
      value = undefined;
    }
  };
  return {
    collector: createCollector({
      storage,
      now: () => time,
      randomUUID: () => id
    }),
    advance: (ms) => {
      time += ms;
    },
    fail: (v) => {
      fail = v;
    }
  };
}
function event(extra = {}) {
  return {
    sessionId: id,
    operationId: id,
    context: 'content',
    contextId: id,
    seq: 1,
    observedAt: 1000000,
    code: 'snapshot',
    outcome: 'observed',
    metadata: { field: 'lot', matchCount: 1, enabled: true },
    ...extra
  };
}

test('allows typed observations and rejects raw, unknown, unbounded or untyped fields', async () => {
  const { collector } = fixture();
  await collector.start();
  assert.equal(await collector.record(event()), true);
  for (const bad of [
    event({ raw: 'patient' }),
    event({ metadata: { value: 'patient' } }),
    event({ metadata: { toString: 'patient' } }),
    event({ metadata: { count: '1' } }),
    event({ metadata: { count: 1e20 } }),
    event({ reason: 'patient' }),
    event({ operationId: 'barcode' })
  ]) {
    assert.equal(await collector.record(bad), false);
  }
  const result = await collector.read();
  assert.equal(result.events.length, 1);
  assert.equal(result.dropped, 7);
  assert.equal(JSON.stringify(result).includes('patient'), false);
});

test('serializes concurrent records and counts overflow', async () => {
  const { collector } = fixture();
  await collector.start();
  const results = await Promise.all(
    Array.from({ length: 1001 }, (_, seq) => collector.record(event({ seq })))
  );
  assert.equal(results.filter(Boolean).length, 1000);
  const result = await collector.read();
  assert.equal(result.events.length, 1000);
  assert.equal(result.dropped, 1);
  assert.deepEqual(
    result.events.map((item) => item.seq),
    Array.from({ length: 1000 }, (_, i) => i)
  );
});

test('expires recording and stopped data on reads and writes', async () => {
  const { collector, advance } = fixture();
  await collector.start();
  advance(15 * 60 * 1000);
  assert.equal(await collector.record(event()), false);
  assert.equal((await collector.read()).state, 'stopped');
  advance(30 * 60 * 1000);
  assert.equal(await collector.read(), null);
  await collector.start();
  await collector.stop();
  advance(30 * 60 * 1000);
  assert.equal(await collector.read(), null);
});

test('propagates storage failures and recovers the write chain', async () => {
  const { collector, fail } = fixture();
  await collector.start();
  fail(true);
  await assert.rejects(collector.record(event()), /storage failed/);
  fail(false);
  assert.equal(await collector.record(event()), true);
});

test('batch ingestion stamps receipt time and rejects caller receipt and oversized batches', async () => {
  const { collector } = fixture();
  await collector.start();
  const result = await collector.recordBatch([
    event(),
    event({ receivedAt: 1 })
  ]);
  assert.deepEqual(result, { accepted: 1, dropped: 1 });
  assert.equal((await collector.read()).events[0].receivedAt, 1000000);
  await assert.rejects(collector.recordBatch(Array(26).fill(event())), /batch/);
});

test('full buffer keeps final failure and counts the replaced routine event', async () => {
  const { collector } = fixture();
  await collector.start();
  for (let i = 0; i < 40; i++)
    await collector.recordBatch(
      Array.from({ length: 25 }, (_, n) => event({ seq: i * 25 + n }))
    );
  assert.equal(
    await collector.record(
      event({ seq: 1001, code: 'fill', outcome: 'failed' })
    ),
    true
  );
  const session = await collector.read();
  assert.equal(session.events.length, 1000);
  assert.equal(session.events.at(-1).outcome, 'failed');
  assert.equal(session.dropped, 1);
});
