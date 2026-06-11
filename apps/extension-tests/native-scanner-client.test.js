import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const backgroundSource = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../extension/native/native-scanner-client.js', import.meta.url), 'utf8');

test('extension requests nativeMessaging permission', () => {
  assert.ok(manifest.permissions.includes('nativeMessaging'));
});

test('background loads native scanner client and exposes drain actions', () => {
  assert.match(backgroundSource, /native\/native-scanner-client\.js/);
  assert.match(backgroundSource, /request\.action === ['"]getNativeScannerStatus['"]/);
  assert.match(backgroundSource, /request\.action === ['"]drainNativeScannerScans['"]/);
});

test('native scanner client uses the registered host name and protocol commands', () => {
  assert.match(clientSource, /ca\.wdgph\.vaxlink_scanner_agent/);
  assert.match(clientSource, /chrome\.runtime\.sendNativeMessage/);
  assert.match(clientSource, /type: ['"]status\.get['"]/);
  assert.match(clientSource, /type: ['"]scan\.poll['"]/);
  assert.match(clientSource, /type: ['"]queue\.ack['"]/);
});
