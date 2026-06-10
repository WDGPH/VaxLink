import assert from 'node:assert/strict';
import test from 'node:test';

import '../extension/shared/gs1-parser.js';

const { hasNumericGtin, isCandidateGS1Text } = globalThis.VaxLinkGS1Parser;

function isFocusedFieldNumericGtinCandidate(fieldValue) {
  const SCAN_MIN_LENGTH = 8;
  const raw = String(fieldValue || '').trim();
  if (raw.length < SCAN_MIN_LENGTH) return '';
  if (!isCandidateGS1Text(raw)) return '';
  if (!hasNumericGtin(raw)) return '';
  return raw;
}

test('real GS1 barcode in a focused field is a numeric GTIN candidate', () => {
  const barcode = '010001234567890510LOT-ABC17240101';
  assert.equal(isFocusedFieldNumericGtinCandidate(barcode), barcode);
});

test('GS1 barcode with only GTIN in a focused field is a numeric GTIN candidate', () => {
  const barcode = '0100012345678905';
  assert.equal(isFocusedFieldNumericGtinCandidate(barcode), barcode);
});

test('date "06/01/2026" in a field is not a numeric GTIN candidate', () => {
  assert.equal(isFocusedFieldNumericGtinCandidate('06/01/2026'), '');
});

test('date "01/15/2025" in a field is not a numeric GTIN candidate', () => {
  assert.equal(isFocusedFieldNumericGtinCandidate('01/15/2025'), '');
});

test('patient ID containing "01" is not a numeric GTIN candidate', () => {
  assert.equal(isFocusedFieldNumericGtinCandidate('PTH01234567'), '');
});

test('lot number like "LOT01-2024" is not a numeric GTIN candidate', () => {
  assert.equal(isFocusedFieldNumericGtinCandidate('LOT01-2024'), '');
});

test('clinical note containing "01" is not a numeric GTIN candidate', () => {
  assert.equal(isFocusedFieldNumericGtinCandidate('Dose 01 administered today at clinic'), '');
});

test('health card number starting with "01" is not a numeric GTIN candidate', () => {
  assert.equal(isFocusedFieldNumericGtinCandidate('0123456789012'), '');
});

test('short field value below minimum length is not a numeric GTIN candidate', () => {
  assert.equal(isFocusedFieldNumericGtinCandidate('01AB'), '');
});

test('empty field is not a numeric GTIN candidate', () => {
  assert.equal(isFocusedFieldNumericGtinCandidate(''), '');
});

test('client ID starting with "10" is not a numeric GTIN candidate', () => {
  assert.equal(isFocusedFieldNumericGtinCandidate('1012345678901'), '');
});

test('client ID starting with "10" longer variant is not a numeric GTIN candidate', () => {
  assert.equal(isFocusedFieldNumericGtinCandidate('10987654321098'), '');
});
