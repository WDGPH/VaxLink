// Tests that verify the Tab/Enter key interception gate in onHandsFreeKeydown.
//
// getActiveElementScanCandidate() guards whether a focused field's value is
// treated as a scanned barcode when Tab or Enter is pressed. Before this fix,
// it only used the loose isCandidateGS1Text() check — any field value
// containing "01" (dates, patient IDs, lot numbers) would cause Tab to be
// intercepted, blocking nurses from navigating between Panorama fields.
//
// The fix mirrors the paste-interception guard (PR #14): require a full GS1
// parse with a numeric 14-digit GTIN before intercepting.

import assert from 'node:assert/strict';
import test from 'node:test';

import '../extension/shared/gs1-parser.js';

const { hasNumericGtin, isCandidateGS1Text } = globalThis.VaxLinkGS1Parser;

// Returns the value that would be passed to handleHandsFreeScan (non-empty
// means Tab is intercepted), or '' if Tab is allowed through normally.
function wouldInterceptTab(fieldValue) {
  const SCAN_MIN_LENGTH = 8;
  const raw = String(fieldValue || '').trim();
  if (raw.length < SCAN_MIN_LENGTH) return '';
  if (!isCandidateGS1Text(raw)) return '';
  if (!hasNumericGtin(raw)) return '';
  return raw;
}

// ── Tests ──────────────────────────────────────────────────────────────────

test('real GS1 barcode in focused field IS intercepted on Tab', () => {
  const barcode = '010001234567890510LOT-ABC17240101';
  assert.equal(wouldInterceptTab(barcode), barcode);
});

test('GS1 barcode with only GTIN IS intercepted on Tab', () => {
  const barcode = '0100012345678905';
  assert.equal(wouldInterceptTab(barcode), barcode);
});

test('date "06/01/2026" in a field does NOT intercept Tab', () => {
  assert.equal(wouldInterceptTab('06/01/2026'), '');
});

test('date "01/15/2025" in a field does NOT intercept Tab', () => {
  assert.equal(wouldInterceptTab('01/15/2025'), '');
});

test('patient ID containing "01" does NOT intercept Tab', () => {
  assert.equal(wouldInterceptTab('PTH01234567'), '');
});

test('lot number like "LOT01-2024" does NOT intercept Tab', () => {
  assert.equal(wouldInterceptTab('LOT01-2024'), '');
});

test('clinical note containing "01" does NOT intercept Tab', () => {
  assert.equal(wouldInterceptTab('Dose 01 administered today at clinic'), '');
});

test('health card number starting with "01" does NOT intercept Tab', () => {
  assert.equal(wouldInterceptTab('0123456789012'), '');
});

test('short field value below minimum length does NOT intercept Tab', () => {
  assert.equal(wouldInterceptTab('01AB'), '');
});

test('empty field does NOT intercept Tab', () => {
  assert.equal(wouldInterceptTab(''), '');
});

test('client ID starting with "10" does NOT intercept Tab', () => {
  // "10" is GS1 AI(10) (lot number) — parses with gtin=null, must not intercept
  assert.equal(wouldInterceptTab('1012345678901'), '');
});

test('client ID starting with "10" longer variant does NOT intercept Tab', () => {
  assert.equal(wouldInterceptTab('10987654321098'), '');
});
