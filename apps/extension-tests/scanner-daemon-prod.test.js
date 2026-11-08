import assert from 'node:assert/strict';
import test from 'node:test';

test('production scanner connects without consulting Alpha test storage', async () => {
  const listeners = [];
  const messages = [];
  globalThis.Worker = class {
    addEventListener() {}
    postMessage(message) {
      messages.push(message);
    }
  };
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ name: 'VaxLink' }),
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener: (listener) => listeners.push(listener) },
      sendMessage: (_message, callback) => callback?.()
    },
    storage: {
      local: {
        get: () => {
          throw new Error('Production read Alpha lease');
        }
      }
    }
  };
  try {
    await import('../extension/scanner-daemon.js?prod-test');
    let response;
    listeners[0](
      { target: 'scannerDaemon', action: 'scannerDaemon.connectGranted' },
      {},
      (result) => {
        response = result;
      }
    );
    assert.equal(response.accepted, true);
    assert.equal(messages.at(-1).type, 'connectGranted');
  } finally {
    delete globalThis.Worker;
    delete globalThis.chrome;
  }
});
