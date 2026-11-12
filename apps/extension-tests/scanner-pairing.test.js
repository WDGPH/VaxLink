import assert from 'node:assert/strict';
import test from 'node:test';

test('pairing needs a click, preserves cancellation, and waits for connection handoff', async () => {
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  const nodes = Object.fromEntries(
    ['chooseScannerBtn', 'closePairingBtn', 'pairingStatus'].map((id) => [
      id,
      {
        dataset: {},
        addEventListener(_type, listener) {
          this.click = listener;
        }
      }
    ])
  );
  let portError, releaseCommand, commandStarted;
  let requestCount = 0,
    closeCount = 0;
  const commands = [];
  const info = { usbVendorId: 1504, usbProductId: 1 };
  globalThis.document = { getElementById: (id) => nodes[id] };
  globalThis.window = {
    location: { search: '?profile=zebra-ds8178-usb-cdc' },
    close() {
      closeCount++;
    }
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      serial: {
        async requestPort(options) {
          requestCount++;
          assert.deepEqual(options, { filters: [{ usbVendorId: 1504 }] });
          if (portError) throw portError;
          return { getInfo: () => info };
        }
      }
    }
  });
  globalThis.chrome = {
    runtime: {
      sendMessage(message, done) {
        commands.push(message);
        releaseCommand = done;
        commandStarted();
      }
    }
  };
  try {
    await import('../extension/scanner-pairing.js');
    assert.equal(
      requestCount,
      0,
      'loading the window must not open the chooser'
    );
    nodes.closePairingBtn.click();
    assert.equal(closeCount, 1);
    closeCount = 0;

    portError = new DOMException(
      'No port selected by the user.',
      'NotFoundError'
    );
    await nodes.chooseScannerBtn.click();
    assert.equal(
      commands.length,
      0,
      'cancelling must not change saved scanner settings'
    );
    assert.equal(closeCount, 0);
    assert.equal(nodes.chooseScannerBtn.disabled, false);
    assert.equal(nodes.pairingStatus.dataset.error, 'false');
    assert.match(nodes.pairingStatus.textContent, /No scanner selected/);

    portError = undefined;
    for (const failure of ['background', 'transport', null]) {
      const started = new Promise((resolve) => {
        commandStarted = resolve;
      });
      const pending = nodes.chooseScannerBtn.click();
      // requestPort is called before the click handler first yields.
      assert.equal(requestCount, commands.length + 2);
      await started;
      assert.equal(nodes.chooseScannerBtn.disabled, true);
      assert.equal(
        closeCount,
        0,
        'keep the window until the background accepts'
      );
      assert.deepEqual(commands.at(-1), {
        action: 'scannerDaemon.connectGranted',
        profileId: 'zebra-ds8178-usb-cdc',
        preferredPortInfo: info,
        enableAutostart: true,
        trigger: 'pairing_permission_granted'
      });
      if (failure === 'transport')
        chrome.runtime.lastError = { message: 'Background unavailable' };
      releaseCommand(
        failure
          ? { success: false, error: 'Connection request failed' }
          : { success: true, accepted: true }
      );
      delete chrome.runtime.lastError;
      await pending;
      if (failure) {
        assert.equal(closeCount, 0);
        assert.equal(nodes.chooseScannerBtn.disabled, false);
        assert.equal(nodes.pairingStatus.dataset.error, 'true');
        assert.match(
          nodes.pairingStatus.textContent,
          /Connection request failed|Background unavailable/
        );
      } else assert.equal(closeCount, 1);
    }
  } finally {
    for (const key of ['document', 'window', 'navigator', 'chrome']) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
      else delete globalThis[key];
    }
  }
});
