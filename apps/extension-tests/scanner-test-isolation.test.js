import test from 'node:test';
import assert from 'node:assert/strict';
import { createScannerTest } from '../extension/diagnostics/scanner-test.js';

function setup(overrides = {}) {
  const updates = [];
  let handlers;
  let expire;
  let closed = 0;
  let released = 0;
  const port = { getInfo: () => ({ usbVendorId: 1, usbProductId: 2 }) };
  const controller = createScannerTest({
    acquire: async () => ({ success: true, released: true, lease: 'lease' }),
    release: async () => {
      released++;
      return { success: true };
    },
    getSelection: async () => ({
      profile: {},
      preferredPortInfo: port.getInfo()
    }),
    getPorts: async () => [port],
    open: async (_port, _profile, callbacks) => {
      handlers = callbacks;
      return {
        close: async () => {
          closed++;
        }
      };
    },
    parse: () => ({ gtin: '09999000000008', lot: 'VAXLINKTEST' }),
    update: (value) => updates.push(value),
    setTimer: (callback, ms) => {
      assert.equal(ms, 60000);
      expire = callback;
      return 1;
    },
    clearTimer: () => {},
    ...overrides
  });
  return {
    controller,
    updates,
    get handlers() {
      return handlers;
    },
    expire: () => expire(),
    get closed() {
      return closed;
    },
    get released() {
      return released;
    }
  };
}

test('only coarse checkpoints leave an active test and later scans are ignored', async () => {
  const h = setup();
  await h.controller.start();
  h.handlers.onBytes(4);
  h.handlers.onScan({ rawText: 'sensitive example' });
  assert.deepEqual(h.updates.at(-1), {
    state: 'active',
    port: true,
    bytes: true,
    frame: true,
    parsed: true
  });
  assert.ok(!JSON.stringify(h.updates).includes('sensitive example'));
  await h.controller.stop();
  const count = h.updates.length;
  h.handlers.onScan({ rawText: 'late' });
  assert.equal(h.updates.length, count);
  assert.equal(h.closed, 1);
  assert.equal(h.released, 1);
});

test('unconfirmed scanner release prevents opening a test port', async () => {
  let opened = false;
  const h = setup({
    acquire: async () => ({ success: true, released: false }),
    open: async () => {
      opened = true;
    }
  });
  await h.controller.start();
  assert.equal(opened, false);
  assert.equal(h.updates.at(-1).state, 'paused');
});

test('close failure keeps the lease and reports paused', async () => {
  const h = setup({
    open: async () => ({
      close: async () => {
        throw new Error('close failed');
      }
    })
  });
  await h.controller.start();
  await h.controller.stop();
  assert.equal(h.released, 0);
  assert.equal(h.updates.at(-1).state, 'paused');
});

test('expiry closes the port and releases the lease', async () => {
  const h = setup();
  await h.controller.start();
  h.expire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.closed, 1);
  assert.equal(h.released, 1);
  assert.equal(h.updates.at(-1).state, 'stopped');
});

test('elapsed deadline discards a late frame even when the timer is delayed', async () => {
  let clock = 0;
  const h = setup({ now: () => clock });
  await h.controller.start();
  h.handlers.onBytes(0);
  assert.equal(h.updates.at(-1).bytes, false);
  clock = 60000;
  h.handlers.onScan({ rawText: 'late' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.updates.at(-1).frame, false);
  assert.equal(h.updates.at(-1).state, 'stopped');
});

test('stopping during a pending open closes it before releasing the lease', async () => {
  let finishOpen;
  let closed = false;
  let releasedAfterClose = false;
  const h = setup({
    open: () =>
      new Promise((resolve) => {
        finishOpen = resolve;
      }),
    release: async () => {
      releasedAfterClose = closed;
      return { success: true };
    }
  });
  const starting = h.controller.start();
  while (!finishOpen) await Promise.resolve();
  const stopping = h.controller.stop();
  finishOpen({
    close: async () => {
      closed = true;
    }
  });
  await Promise.all([starting, stopping]);
  assert.equal(releasedAfterClose, true);
});
