import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const popupHtml = readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8');
const popupJs = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');

test('popup exposes native scanner status controls', () => {
  assert.match(popupHtml, /id="nativeScannerStatus"/);
  assert.match(popupHtml, /id="checkNativeScannerBtn"/);
  assert.match(popupHtml, /id="drainNativeScannerBtn"/);
  assert.match(popupHtml, /id="openNativeScannerHelpBtn"/);
  assert.match(popupJs, /getNativeScannerStatus/);
  assert.match(popupJs, /drainNativeScannerScans/);
});

test('popup copy does not tell users to scan keyboard-wedge input into chart fields', () => {
  assert.doesNotMatch(popupHtml, /scan directly on the live chart page/i);
  assert.doesNotMatch(popupJs, /scan directly on the live chart page/i);
  assert.doesNotMatch(popupHtml, /keyboard wedge/i);
  assert.doesNotMatch(popupJs, /keyboard wedge/i);
});
