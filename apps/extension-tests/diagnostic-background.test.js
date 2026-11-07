import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import '../extension/diagnostics/collector.js';
import '../extension/diagnostics/producer.js';
import '../extension/diagnostics/background.js';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const make = (initial = {}) => {
  const values = structuredClone(initial);
  const storage = {
    async get(key) {
      return { [key]: structuredClone(values[key]) };
    },
    async set(data) {
      Object.assign(values, structuredClone(data));
    },
    async remove(key) {
      delete values[key];
    }
  };
  const chrome = {
    storage: { session: storage },
    runtime: {
      id: 'abc',
      getURL: (path) => `chrome-extension://abc/${path.replace(/^\//, '')}`,
      sendMessage: async () => {}
    },
    tabs: { query: async () => [], sendMessage: async () => {} }
  };
  const controller = globalThis.VaxLinkDiagnosticBackground.create({
    chrome,
    health: async () => ({ ready: true })
  });
  const send = (request, sender) =>
    new Promise((resolve) => {
      assert.equal(controller.handleMessage(request, sender, resolve), true);
    });
  return { controller, send, values };
};
const viewer = {
  id: 'abc',
  url: 'chrome-extension://abc/diagnostics.html?origin=22',
  documentId: 'viewer'
};
const content = {
  id: 'abc',
  url: 'https://inputhealth.com/chart',
  frameId: 0,
  tab: { id: 22 },
  documentId: 'doc-1'
};
const contextId = '11111111-1111-4111-8111-111111111111';
test('controls require an extension-owned page and producers cannot mix contexts', async () => {
  const { controller, send } = make();
  await controller.ready;
  for (const sender of [
    content,
    { ...viewer, id: 'other' },
    { ...viewer, url: 'https://abc/diagnostics.html' },
    {
      ...viewer,
      url: 'chrome-extension://abc/diagnostics.html?origin=22&other=x'
    },
    { ...viewer, url: 'https://inputhealth.com/diagnostics.html' }
  ]) {
    assert.equal(
      (await send({ action: 'diagnostics.start' }, sender)).success,
      false
    );
  }
  const started = await send({ action: 'diagnostics.start' }, viewer);
  const sessionId = started.session.id;
  assert.equal(
    (
      await send(
        { action: 'diagnostics.join', context: 'content', contextId },
        content
      )
    ).session.id,
    sessionId
  );
  const event = {
    sessionId,
    operationId: crypto.randomUUID(),
    context: 'content',
    contextId,
    seq: 0,
    observedAt: Date.now(),
    code: 'route',
    outcome: 'observed'
  };
  const batch = {
    action: 'diagnostics.events',
    sessionId,
    context: 'content',
    contextId,
    events: [event],
    dropped: 0
  };
  assert.equal((await send(batch, content)).accepted, 1);
  assert.equal(
    (
      await send(
        { ...batch, events: [{ ...event, context: 'worker' }] },
        content
      )
    ).success,
    false
  );
  assert.equal(
    (await send(batch, { ...content, documentId: 'doc-2' })).success,
    false
  );
  assert.equal(
    (await send({ ...batch, sessionId: crypto.randomUUID() }, content)).success,
    false
  );
  assert.equal(
    (
      await send(
        { action: 'diagnostics.stop', sessionId: crypto.randomUUID() },
        viewer
      )
    ).success,
    false
  );
  assert.equal(
    (await send({ action: 'diagnostics.stop', sessionId }, viewer)).success,
    true
  );
  assert.equal((await send(batch, content)).success, false);
});
test('queue links remain session-local, restore on wake, and are never exported', async () => {
  const first = make();
  await first.controller.ready;
  const { session } = await first.send({ action: 'diagnostics.start' }, viewer);
  const link = first.controller.newOperation();
  first.controller.rememberQueue('private-record-id', link);
  await new Promise((resolve) => setImmediate(resolve));
  const second = make(first.values);
  await second.controller.ready;
  assert.equal(
    second.controller.parentForQueue('private-record-id'),
    link.operationId
  );
  const exported = await second.send(
    { action: 'diagnostics.export', sessionId: session.id },
    viewer
  );
  assert.equal(JSON.stringify(exported).includes('private-record-id'), false);
  assert.ok(
    exported.data.session.events.some(
      (event) => event.code === 'lifecycle' && event.outcome === 'interrupted'
    )
  );
  await second.send(
    { action: 'diagnostics.stop', sessionId: session.id },
    viewer
  );
  await second.send({ action: 'diagnostics.start' }, viewer);
  assert.equal(second.controller.parentForQueue('private-record-id'), null);
  assert.equal(second.controller.adopt(link), null);
});

test('export includes the supplied build identity', async () => {
  const { controller, send } = make();
  await controller.ready;
  const { session } = await send({ action: 'diagnostics.start' }, viewer);
  const identity = Object.freeze({
    id: 'unpacked-source',
    channel: 'development'
  });
  globalThis.VaxLinkBuildIdentity = identity;
  try {
    const result = await send(
      { action: 'diagnostics.export', sessionId: session.id },
      viewer
    );
    assert.deepEqual(result.data.build, identity);
  } finally {
    delete globalThis.VaxLinkBuildIdentity;
  }
});
test('expired recordings do not expose active links after wake', async () => {
  const first = make();
  await first.controller.ready;
  await first.send({ action: 'diagnostics.start' }, viewer);
  const key = 'vaxlink_diagnostic_session_v1';
  first.values[key].recordingUntil = Date.now() - 1;
  const second = make(first.values);
  await second.controller.ready;
  assert.equal(second.controller.session(), null);
  assert.equal(second.controller.newOperation(), null);
  assert.equal(
    Object.hasOwn(second.values, 'vaxlink_diagnostic_queue_links_v1'),
    false
  );
});

test('concurrent starts cannot replace an active session and ambiguous links stay unlinked', async () => {
  const { controller, send, values } = make();
  await controller.ready;
  const results = await Promise.all([
    send({ action: 'diagnostics.start' }, viewer),
    send({ action: 'diagnostics.start' }, viewer)
  ]);
  assert.equal(results.filter((result) => result.success).length, 1);
  const session = results.find((result) => result.success).session;
  const first = controller.newOperation();
  controller.rememberQueue('pending:same-time', first);
  controller.rememberQueue('pending:same-time', controller.newOperation());
  controller.rememberQueue('pending:same-time', first);
  assert.equal(controller.parentForQueue('pending:same-time'), null);
  await new Promise((resolve) => setImmediate(resolve));
  const restored = make(values);
  await restored.controller.ready;
  assert.equal(restored.controller.parentForQueue('pending:same-time'), null);
  assert.equal(
    (
      await restored.send(
        { action: 'diagnostics.stop', sessionId: session.id },
        viewer
      )
    ).success,
    true
  );
});

test('context bindings are bounded', async () => {
  const { controller, send } = make();
  await controller.ready;
  await send({ action: 'diagnostics.start' }, viewer);
  for (let i = 0; i < 128; i++) {
    const reply = await send(
      { action: 'diagnostics.join', context: 'content', contextId },
      { ...content, documentId: `doc-${i}` }
    );
    assert.equal(reply.success, true);
  }
  const reply = await send(
    { action: 'diagnostics.join', context: 'content', contextId },
    { ...content, documentId: 'overflow' }
  );
  assert.equal(reply.success, false);
});

test('stop retains all events queued in the background producer', async () => {
  const { controller, send } = make();
  await controller.ready;
  const { session } = await send({ action: 'diagnostics.start' }, viewer);
  const link = controller.newOperation();
  for (let i = 0; i < 50; i++)
    controller.record(link, 'route', 'observed', { metadata: { count: i } });
  assert.equal(
    (await send({ action: 'diagnostics.stop', sessionId: session.id }, viewer))
      .success,
    true
  );
  const { session: saved } = await send({ action: 'diagnostics.read' }, viewer);
  assert.equal(saved.events.length, 50);
  assert.equal(saved.dropped, 0);
});
