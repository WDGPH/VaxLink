import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

test('background creates exactly one persistent WORKERS offscreen document', async () => {
  const harness = createBackgroundHarness(makeTestNvcBundle());

  const first = await harness.sendMessage({ action: 'scannerDaemon.ensure' });
  const second = await harness.sendMessage({ action: 'scannerDaemon.ensure' });

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(harness.offscreenCreations.length, 1);
  assert.deepEqual(Array.from(harness.offscreenCreations[0].reasons), [
    'WORKERS'
  ]);
  assert.match(
    harness.offscreenCreations[0].justification,
    /scanner connection active/i
  );
});

test('status inspection does not create a scanner daemon', async () => {
  const writes = [];
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    storage: {
      vaxlink_scanner_daemon_enabled_v1: true,
      vaxlink_serial_scanner_profile_v1: 'zebra-ds8178-usb-cdc',
      vaxlink_scanner_status_snapshot_v1: {
        state: 'connected',
        lastCaptureAt: '2026-07-28T12:00:00.000Z'
      }
    },
    failStorageSet(values) {
      writes.push(...Object.keys(values));
      return false;
    }
  });
  const result = await harness.sendMessage({
    action: 'scannerDaemon.getStatus'
  });
  assert.equal(result.source, 'cached');
  assert.equal(result.status.lastKnownCaptureAt, '2026-07-28T12:00:00.000Z');
  assert.equal(harness.offscreenCreations.length, 0);
  assert.deepEqual(
    writes.filter((key) => key.startsWith('vaxlink_scanner_')),
    []
  );
});

test('new worker capture counts are kept separate from historical capture times', async () => {
  const key = 'vaxlink_scanner_status_snapshot_v1';
  const old = '2026-07-28T12:00:00.000Z';
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    storage: {
      [key]: { state: 'connected', captureCount: 4, lastCaptureAt: old }
    }
  });
  const result = await harness.sendMessage({
    target: 'scannerDaemonBackground',
    action: 'scannerDaemon.statusUpdate',
    status: { state: 'connected', captureCount: 0, lastCaptureAt: '' }
  });
  assert.equal(result.success, true);
  assert.equal(result.status.captureCount, 0);
  assert.equal(result.status.lastCaptureAt, '');
  assert.equal(result.status.lastKnownCaptureAt, old);
  const status = await harness.sendMessage({
    action: 'scannerDaemon.getStatus'
  });
  assert.equal(status.status.captureCount, 0);
  assert.equal(status.status.lastCaptureAt, '');
  assert.equal(status.status.lastKnownCaptureAt, old);
  assert.equal(status.captureSource, 'cached');
});

test('selection-required status disables autostart and survives a background restart', async () => {
  const key = 'vaxlink_scanner_status_snapshot_v1';
  const enabled = 'vaxlink_scanner_daemon_enabled_v1';
  const first = createBackgroundHarness(makeTestNvcBundle(), {
    storage: { [enabled]: false }
  });
  const update = await first.sendMessage({
    target: 'scannerDaemonBackground',
    action: 'scannerDaemon.statusUpdate',
    status: { state: 'error', selectionRequired: true }
  });
  assert.equal(update.success, true);
  assert.equal(first.storageData.get(enabled), false);
  assert.equal(first.storageData.get(key).selectionRequired, true);
  const restarted = createBackgroundHarness(makeTestNvcBundle(), {
    storage: {
      [enabled]: true,
      vaxlink_serial_scanner_profile_v1: 'generic-usb-cdc',
      [key]: first.storageData.get(key)
    }
  });
  await restarted.sendMessage({ action: 'scannerDaemon.getStatus' });
  assert.equal(restarted.offscreenCreations.length, 0);
  const selected = await restarted.sendMessage({
    action: 'scannerDaemon.connectGranted',
    profileId: 'generic-usb-cdc',
    enableAutostart: true,
    trigger: 'setup_permission_granted'
  });
  assert.equal(selected.success, true);
  assert.equal(restarted.offscreenCreations.length, 1);
});

for (const event of ['startup', 'install']) {
  test(`${event} initializes scanner capture and lock state`, async () => {
    let reportLock;
    let reportCreate;
    const created = new Promise((resolve) => {
      reportCreate = resolve;
    });
    const lockWritten = new Promise((resolve) => {
      reportLock = resolve;
    });
    const harness = createBackgroundHarness(makeTestNvcBundle(), {
      storage: {
        vaxlink_scanner_daemon_enabled_v1: true,
        vaxlink_serial_scanner_profile_v1: 'generic-usb-cdc'
      },
      onOffscreenCreate: reportCreate,
      failStorageSet(values) {
        if ('vaxlink_scanner_lock_state_v1' in values) reportLock();
        return false;
      }
    });
    harness[event]();
    await Promise.all([lockWritten, created]);
    assert.equal(harness.offscreenCreations.length, 1);
    assert.equal(
      harness.storageData.get('vaxlink_scanner_lock_state_v1'),
      'active'
    );
  });
}

test('selecting a replacement waits for the old reader before saving and starting normal capture', async () => {
  const profileKey = 'vaxlink_serial_scanner_profile_v1';
  const portKey = 'vaxlink_serial_scanner_port_info_v1';
  const enabledKey = 'vaxlink_scanner_daemon_enabled_v1';
  const oldPort = { usbVendorId: 1504, usbProductId: 1 };
  const nextPort = { usbVendorId: 1504, usbProductId: 2 };
  let stop;
  let reportStop;
  let stopping = new Promise((resolve) => {
    reportStop = resolve;
  });
  const readerCalls = [];
  const harness = createBackgroundHarness(makeTestNvcBundle(), {
    storage: {
      [profileKey]: 'zebra-ds8178-usb-cdc',
      [portKey]: oldPort,
      [enabledKey]: true,
      vaxlink_workflow_mode_v1: 'inventory'
    },
    runtimeSendMessage(message, reply) {
      if (message.target === 'scannerDaemon') readerCalls.push(message);
      if (message.action === 'scannerDaemon.disconnect') {
        stop = reply;
        reportStop();
      } else {
        if (message.action === 'scannerDaemon.connectGranted') {
          assert.equal(harness.storageData.get(portKey).usbProductId, 2);
        }
        reply({ success: true });
      }
    }
  });
  await harness.sendMessage({ action: 'scannerDaemon.ensure' });
  const select = () =>
    harness.sendMessage(
      {
        action: 'scannerDaemon.select',
        profileId: 'zebra-ds8178-usb-cdc',
        preferredPortInfo: nextPort
      },
      {
        id: 'vaxlink-test',
        url: 'chrome-extension://vaxlink-test/scanner-pairing.html'
      }
    );
  const failed = select();
  await stopping;
  assert.deepEqual(harness.storageData.get(portKey), oldPort);
  stop({ success: false, error: 'Close failed' });
  assert.equal((await failed).success, false);
  assert.equal(readerCalls.length, 1);

  stopping = new Promise((resolve) => {
    reportStop = resolve;
  });
  const replacement = select();
  await stopping;
  assert.deepEqual(harness.storageData.get(portKey), oldPort);
  stop({ success: true });
  assert.equal((await replacement).success, true);
  assert.equal(readerCalls.length, 3);
  assert.equal(readerCalls.at(-1).action, 'scannerDaemon.connectGranted');
  assert.equal(harness.storageData.get(enabledKey), true);
  assert.equal(harness.storageData.has('inventory_scan_batch_v1'), false);

  const firstScan = '01001234567890121727123110FIRSTLOT';
  const result = await harness.sendMessage({
    action: 'scannerScanCaptured',
    scan: { rawText: firstScan, source: 'web-serial' }
  });
  assert.equal(result.success, true);
  assert.deepEqual(
    Array.from(
      harness.storageData.get('inventory_scan_batch_v1'),
      (row) => row.raw_barcode
    ),
    [firstScan]
  );
  stopping = new Promise((resolve) => {
    reportStop = resolve;
  });
  const disconnect = harness.sendMessage({
    action: 'scannerDaemon.disconnect'
  });
  await stopping;
  assert.equal(harness.storageData.get(enabledKey), false);
  stop({ success: false, error: 'Close failed' });
  assert.equal((await disconnect).success, false);
  assert.equal(harness.storageData.get(portKey).usbProductId, 2);

  const forget = await harness.sendMessage({ action: 'scannerDaemon.forget' });
  assert.equal(forget.success, true);
  assert.equal(readerCalls.at(-1).portInfo.usbProductId, 2);
  assert.equal(harness.storageData.get(enabledKey), false);
  assert.equal(harness.storageData.get(profileKey), '');
  assert.equal(harness.storageData.get(portKey), null);
});

test('test exits restore only the previous capture preference, even before a sample', async () => {
  const enabledKey = 'vaxlink_scanner_daemon_enabled_v1';
  const tabId = 19;
  const sender = {
    id: 'vaxlink-test',
    url: 'chrome-extension://vaxlink-test/scanner-pairing.html',
    tab: { id: tabId }
  };
  for (const enabled of [false, true]) {
    for (const windowClose of [false, true]) {
      const commands = [];
      const harness = createBackgroundHarness(makeTestNvcBundle(), {
        tabs: [{ id: tabId }],
        storage: {
          [enabledKey]: enabled,
          vaxlink_serial_scanner_profile_v1: 'zebra-ds8178-usb-cdc'
        },
        runtimeSendMessage(message, reply) {
          if (message.target === 'scannerDaemon') commands.push(message);
          reply({ success: true });
        }
      });
      const start = await harness.sendMessage(
        { action: 'scannerDaemon.startTest' },
        sender
      );
      assert.equal(start.success, true);
      assert.equal(commands.at(-1).testing, true);
      const reconnect = await harness.sendMessage({
        action: 'scannerDaemon.connectGranted',
        enableAutostart: true
      });
      assert.match(reconnect.error, /Finish or close the scanner test/);
      const disconnect = await harness.sendMessage({
        action: 'scannerDaemon.disconnect'
      });
      assert.match(disconnect.error, /Finish or close the scanner test/);
      assert.equal(harness.storageData.get(enabledKey), enabled);
      assert.equal(commands.length, 2);

      const end = () =>
        harness.sendMessage({ action: 'scannerDaemon.endTest' }, sender);
      if (windowClose) harness.removeTab(tabId);
      assert.equal((await end()).success, true);
      if (!windowClose) harness.removeTab(tabId);
      await end();
      assert.equal(
        commands.filter(
          (message) => message.action === 'scannerDaemon.disconnect'
        ).length,
        2
      );
      assert.equal(
        commands.filter(
          (message) =>
            message.action === 'scannerDaemon.connectGranted' &&
            !message.testing
        ).length,
        Number(enabled)
      );
      assert.equal(harness.storageData.get(enabledKey), enabled);
    }
  }
});
