import assert from 'node:assert/strict';
import test from 'node:test';

test('pairing needs a click, preserves cancellation, and waits for connection handoff', async () => {
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  const nodes = Object.fromEntries(
    [
      'chooseScannerBtn',
      'testScannerBtn',
      'closePairingBtn',
      'pairingStatus',
      'setupHint'
    ].map((id) => [
      id,
      {
        dataset: {},
        addEventListener(_type, listener) {
          this.click = listener;
        }
      }
    ])
  );
  let portError, releaseCommand, commandStarted, pagehide;
  let requestCount = 0,
    closeCount = 0;
  const commands = [];
  const info = { usbVendorId: 1504, usbProductId: 1 };
  globalThis.document = { getElementById: (id) => nodes[id] };
  globalThis.window = {
    location: { search: '?profile=zebra-ds8178-usb-cdc' },
    addEventListener(type, listener) {
      if (type === 'pagehide') pagehide = listener;
    },
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
          assert.deepEqual(options, {});
          if (portError) throw portError;
          return { getInfo: () => info };
        },
        getPorts: async () => [{ getInfo: () => info }]
      }
    }
  });
  globalThis.chrome = {
    storage: {
      local: {
        get(_key, done) {
          done({ vaxlink_serial_scanner_profile_v1: 'zebra-ds8178-usb-cdc' });
        }
      }
    },
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(message, done) {
        commands.push(message);
        if (message.action === 'scannerDaemon.getStatus') {
          done({
            success: true,
            source: 'live',
            status: { testing: true, state: 'connected' }
          });
          return;
        }
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
        action: 'scannerDaemon.select',
        profileId: 'zebra-ds8178-usb-cdc',
        preferredPortInfo: info
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
    assert.equal(nodes.testScannerBtn.hidden, false);
    const begin = nodes.testScannerBtn.click();
    assert.equal(commands.at(-1).action, 'scannerDaemon.startTest');
    releaseCommand({ success: true });
    await begin;
    assert.equal(nodes.closePairingBtn.textContent, 'Finish test');
    assert.match(nodes.pairingStatus.textContent, /Test scans stay out/);
    pagehide();
    assert.equal(commands.at(-1).action, 'scannerDaemon.endTest');
    releaseCommand({ success: true });

    const finish = nodes.closePairingBtn.click();
    assert.equal(commands.at(-1).action, 'scannerDaemon.endTest');
    assert.equal(closeCount, 1);
    releaseCommand({ success: true });
    await finish;
    assert.equal(closeCount, 2);
  } finally {
    for (const key of ['document', 'window', 'navigator', 'chrome']) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
      else delete globalThis[key];
    }
  }
});
