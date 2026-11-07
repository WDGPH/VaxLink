import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

function setup(sessionEnabled = true, supported = [], fail = []) {
  const callbacks = new Map();
  const messages = [];
  const timers = new Map();
  let timerId = 0;
  let clock = 1000;
  let observers = 0;
  let disconnects = 0;
  let binding = true;
  let rejectEvents = false;
  const session = {
    id: webcrypto.randomUUID(),
    recordingUntil: Date.now() + 60000
  };
  const context = vm.createContext({
    crypto: webcrypto,
    TextEncoder,
    Date,
    console,
    performance: { now: () => clock, mark() {}, clearMarks() {} },
    PerformanceObserver: class {
      static supportedEntryTypes = supported;
      constructor(callback) {
        observers++;
        this.callback = callback;
      }
      observe({ type }) {
        if (fail.includes(type)) throw new Error('unavailable');
        callbacks.set(type, this.callback);
      }
      disconnect() {
        disconnects++;
      }
    },
    setTimeout(fn, delay) {
      const id = ++timerId;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    chrome: {
      runtime: {
        sendMessage(message) {
          messages.push(message);
          if (message.action === 'diagnostics.join') {
            binding = true;
            return Promise.resolve({
              success: true,
              session: sessionEnabled ? session : null
            });
          }
          if (
            message.action === 'diagnostics.events' &&
            (!binding || rejectEvents)
          )
            return Promise.resolve({ success: false });
          return Promise.resolve({ success: true });
        }
      }
    }
  });
  for (const file of ['collector.js', 'producer.js', 'content.js']) {
    vm.runInContext(
      readFileSync(
        new URL(`../extension/diagnostics/${file}`, import.meta.url),
        'utf8'
      ),
      context
    );
  }
  const diag = context.VaxLinkContentDiagnostics.create();
  return {
    diag,
    messages,
    session,
    loseBinding() {
      binding = false;
    },
    rejectEvents() {
      rejectEvents = true;
    },
    emit(type, entries) {
      callbacks.get(type)({ getEntries: () => entries });
    },
    get observers() {
      return observers;
    },
    get disconnects() {
      return disconnects;
    },
    advance(ms) {
      clock += ms;
    },
    async flush() {
      for (const [id, timer] of [...timers]) {
        if (timer.delay > 100) continue;
        timers.delete(id);
        timer.fn();
      }
      for (let i = 0; i < 30; i++) await Promise.resolve();
    },
    async join() {
      diag.boot();
      for (let i = 0; i < 30; i++) await Promise.resolve();
    }
  };
}

function node(form, counter) {
  return {
    form,
    isConnected: true,
    disabled: false,
    options: [{ value: 'secret' }],
    value: 'secret patient value',
    innerHTML: 'secret markup',
    getBoundingClientRect() {
      counter.reads++;
      return { width: 1, height: 1 };
    }
  };
}
function group(item) {
  return {
    field: 'date',
    native: true,
    nodes: [item],
    matches: () => true,
    desiredMatches: () => 1
  };
}

test('inactive snapshots perform no layout reads or observer setup', async () => {
  const run = setup(false);
  const counter = { reads: 0 };
  const item = node({}, counter);
  await run.join();
  run.diag.snapshot(null, 'before', [group(item)]);
  assert.equal(counter.reads, 0);
  assert.equal(run.observers, 0);
});

test('snapshots omit values and aggregate repeated states while tracking replacement', async () => {
  const run = setup();
  await run.join();
  const link = run.diag.begin();
  const counter = { reads: 0 };
  const form = {};
  const first = node(form, counter);
  run.diag.snapshot(link, 'before', [group(first)]);
  for (let i = 0; i < 20; i++) {
    run.advance(200);
    run.diag.snapshot(link, 'change', [group(first)]);
  }
  const replacement = node(form, counter);
  run.advance(200);
  run.diag.snapshot(link, 'final', [group(replacement)]);
  await run.flush();
  const payload = JSON.stringify(run.messages);
  assert.doesNotMatch(payload, /secret|patient|markup|https?:/i);
  const events = run.messages
    .filter((message) => message.action === 'diagnostics.events')
    .flatMap((message) => message.events);
  const snapshots = events.filter((event) => event.code === 'snapshot');
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].metadata.repeated, 20);
  assert.equal(snapshots[1].metadata.replaced, true);
  assert.equal(snapshots[1].metadata.formId, snapshots[0].metadata.formId);
  assert.notEqual(snapshots[1].metadata.nodeId, snapshots[0].metadata.nodeId);
  const capability = events.find(
    (event) => event.code === 'lifecycle' && event.metadata
  );
  assert.equal(capability.metadata.resourceTiming, false);
  assert.equal(capability.metadata.longTasks, false);
  assert.equal(capability.metadata.longAnimationFrames, false);
});

test('resource observations exclude requests begun before recording and never retain URLs', async () => {
  const run = setup(
    true,
    ['resource', 'longtask', 'long-animation-frame'],
    ['longtask']
  );
  await run.join();
  run.advance(100);
  run.emit('resource', [
    {
      startTime: 999,
      responseEnd: 1050,
      duration: 51,
      name: 'https://secret.example/patient'
    },
    {
      startTime: 1010,
      requestStart: 1020,
      responseStart: 1040,
      responseEnd: 1080,
      duration: 70,
      initiatorType: 'fetch',
      name: 'https://secret.example/patient'
    }
  ]);
  run.emit('long-animation-frame', [{ duration: 60 }]);
  await run.flush();
  const events = run.messages
    .filter((message) => message.action === 'diagnostics.events')
    .flatMap((message) => message.events);
  const resources = events.filter((event) => event.code === 'resource');
  assert.equal(resources.length, 1);
  assert.equal(resources[0].elapsedMs, 80);
  assert.equal(resources[0].metadata.delayMs, 20);
  assert.equal(resources[0].metadata.resourceClass, 'fetch');
  assert.doesNotMatch(JSON.stringify(run.messages), /secret|patient|https?:/i);
  const capability = events.find(
    (event) => event.code === 'lifecycle' && event.metadata
  );
  assert.equal(capability.metadata.resourceTiming, true);
  assert.equal(capability.metadata.longTasks, false);
  assert.equal(capability.metadata.longAnimationFrames, true);
  const render = events.find((event) => event.code === 'render');
  assert.equal(render.metadata.longTasks, false);
  assert.equal(render.metadata.longAnimationFrames, true);
});

test('lost worker binding rejoins and retries one batch with unchanged identities', async () => {
  const run = setup(true, ['resource']);
  await run.join();
  const link = run.diag.begin();
  run.diag.record(link, 'fill', 'pending');
  run.loseBinding();
  await run.flush();
  const batches = run.messages.filter(
    (message) => message.action === 'diagnostics.events'
  );
  const joins = run.messages.filter(
    (message) => message.action === 'diagnostics.join'
  );
  assert.equal(joins.length, 2);
  assert.equal(batches.length, 2);
  assert.equal(JSON.stringify(batches[0]), JSON.stringify(batches[1]));
  assert.equal(
    batches[1].events.find((event) => event.code === 'fill').operationId,
    link.operationId
  );
  assert.equal(batches[1].contextId, joins[0].contextId);
  assert.equal(batches[1].contextId, joins[1].contextId);
  assert.equal(run.observers, 1);
});

test('rejected retry is not retried indefinitely', async () => {
  const run = setup();
  await run.join();
  run.diag.begin();
  run.rejectEvents();
  await run.flush();
  assert.equal(
    run.messages.filter((message) => message.action === 'diagnostics.join')
      .length,
    2
  );
  assert.equal(
    run.messages.filter((message) => message.action === 'diagnostics.events')
      .length,
    2
  );
});

test('performance limit is reported once and its observer is disconnected', async () => {
  const run = setup(true, ['longtask']);
  await run.join();
  run.emit(
    'longtask',
    Array.from({ length: 45 }, () => ({ duration: 60 }))
  );
  assert.equal(run.disconnects, 1);
  run.emit('longtask', [{ duration: 80 }]);
  await run.flush();
  await run.flush();
  const events = run.messages
    .filter((message) => message.action === 'diagnostics.events')
    .flatMap((message) => message.events);
  const limits = events.filter(
    (event) => event.code === 'lifecycle' && event.reason === 'overflow'
  );
  assert.equal(limits.length, 1);
  assert.equal(limits[0].metadata.count, 40);
  assert.equal(limits[0].metadata.longTasks, true);
  assert.equal(events.filter((event) => event.code === 'render').length, 40);
  assert.equal(run.disconnects, 1);
});
