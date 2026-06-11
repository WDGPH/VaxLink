import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadScannerEvents() {
  const source = readFileSync(new URL('../extension/scanner/scanner-events.js', import.meta.url), 'utf8');
  const context = {};
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.VaxLinkScannerEvents;
}

test('scanner event normalization rejects empty rawText', () => {
  const events = loadScannerEvents();
  assert.throws(() => events.normalizeScanEvent({ rawText: '' }), /rawText is required/);
});

test('scanner event normalization preserves native queue ID', () => {
  const events = loadScannerEvents();
  const scan = events.normalizeScanEvent({
    rawText: '01000614141999981726010110ABC123',
    source: 'native-serial',
    capturedAt: '2026-06-11T14:03:22.123Z',
    nativeQueueId: 'queue-1',
    rawBytesHex: '30313030',
    device: {
      profileId: 'zebra-ds8178-usb-cdc',
      port: 'COM4',
      vendorId: '05E0'
    }
  });

  assert.equal(scan.type, 'vaxlink.scan');
  assert.equal(scan.rawText, '01000614141999981726010110ABC123');
  assert.equal(scan.source, 'native-serial');
  assert.equal(scan.nativeQueueId, 'queue-1');
  assert.equal(scan.rawBytesHex, '30313030');
  assert.deepEqual(JSON.parse(JSON.stringify(scan.device)), {
    profileId: 'zebra-ds8178-usb-cdc',
    port: 'COM4',
    vendorId: '05E0'
  });
});

test('content script has no scanner DOM capture listeners', () => {
  const contentSource = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
  assert.doesNotMatch(contentSource, /addEventListener\(['"]keydown['"]/);
  assert.doesNotMatch(contentSource, /addEventListener\(['"]paste['"]/);
  assert.doesNotMatch(contentSource, /addEventListener\(['"]input['"]/);
});

test('content script handles explicit vaxlinkScanCaptured messages', () => {
  const contentSource = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
  assert.match(contentSource, /request\.action === ['"]vaxlinkScanCaptured['"]/);
  assert.match(contentSource, /handleHandsFreeScan\(scan\.rawText, scan\.source \|\| ['"]native-serial['"]\)/);
});
