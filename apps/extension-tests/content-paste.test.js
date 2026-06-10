import assert from 'node:assert/strict';
import test from 'node:test';

import '../extension/shared/gs1-parser.js';

const { hasNumericGtin, isCandidateGS1Text, parseGS1Barcode } = globalThis.VaxLinkGS1Parser;

// Returns true if the paste would be intercepted (preventDefault called), or
// false if the paste is allowed to reach the target element normally.
function wouldInterceptPaste(text) {
  const SCAN_MIN_LENGTH = 8;
  if (!text || text.length < SCAN_MIN_LENGTH) return false;
  if (!isCandidateGS1Text(text)) return false;
  return hasNumericGtin(text);
}

// ── Tests ──────────────────────────────────────────────────────────────────

test('real GS1 vaccine barcode (GTIN + lot + expiry) is intercepted', () => {
  const barcode = '010001234567890510LOT-ABC17240101';
  assert.ok(wouldInterceptPaste(barcode));
  const result = parseGS1Barcode(barcode);
  assert.equal(result.gtin, '00012345678905');
  assert.equal(result.lot, 'LOT-ABC');
  assert.equal(result.expiry, '01/01/2024');
});

test('GS1 barcode with only GTIN (no lot/expiry) is intercepted', () => {
  const gtinOnly = '0100012345678905';
  assert.ok(wouldInterceptPaste(gtinOnly));
  const result = parseGS1Barcode(gtinOnly);
  assert.equal(result.gtin, '00012345678905');
});

test('GS1 barcode with GS separator before variable AI is intercepted', () => {
  const GS = String.fromCharCode(0x1d);
  const barcode = `0100012345678905${GS}17251201`;
  assert.ok(wouldInterceptPaste(barcode));
  const result = parseGS1Barcode(barcode);
  assert.equal(result.gtin, '00012345678905');
  assert.ok(result.expiry);
});

test('client ID starting with "10" is NOT intercepted', () => {
  // "10" is GS1 AI(10) (lot number) — parses with gtin=null, must not intercept
  assert.ok(!wouldInterceptPaste('1012345678901'));
  assert.ok(!wouldInterceptPaste('10987654321098'));
});

test('date string "01/01/2024" is NOT intercepted', () => {
  assert.ok(!wouldInterceptPaste('01/01/2024'));
});

test('natural language containing "01" is NOT intercepted', () => {
  assert.ok(!wouldInterceptPaste('Administered 01 dose of vaccine today'));
  assert.ok(!wouldInterceptPaste('Chart note: visit #0156, dose #01'));
});

test('date of birth with "01" prefix is NOT intercepted', () => {
  assert.ok(!wouldInterceptPaste('DOB: 01-15-1985, health card 01234'));
});

test('patient ID starting with "01" but too short for GTIN is NOT intercepted', () => {
  assert.ok(!wouldInterceptPaste('0123456789'));
});

test('phone number starting with "01" is NOT intercepted', () => {
  assert.ok(!wouldInterceptPaste('Phone: 0123456789012'));
});

test('short text below SCAN_MIN_LENGTH is NOT intercepted', () => {
  assert.ok(!wouldInterceptPaste('01AB'));
});

test('empty and null paste are NOT intercepted', () => {
  assert.ok(!wouldInterceptPaste(''));
  assert.ok(!wouldInterceptPaste(null));
});
