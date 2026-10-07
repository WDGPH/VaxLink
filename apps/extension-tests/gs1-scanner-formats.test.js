/**
 * Real-scanner output formats seen in clinics (issues #16/#9 "vaccine did not
 * scan"). Hardware 2D scanners commonly prepend an AIM symbology identifier
 * ("]" + letter + digit: ]C1 GS1-128, ]d2 GS1 DataMatrix, ]Q3 GS1 QR, ]e0
 * GS1 DataBar) and append CR/LF. GS1 AI(17) dates may use day "00" meaning
 * "last day of the month".
 *
 * GTIN-led payloads used to survive AIM prefixes only by accident (the parser
 * re-anchors on the first "01"); lot-only payloads — the HB lot-only clinic
 * flow — have no "01" and threw outright until the prefix strip was
 * generalized beyond ]C1.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseGS1Barcode, parseInputData, formatDate } from '../extension/popup-parser.js';

const GS = String.fromCharCode(0x1d);
// 01 + GTIN, 17 + expiry, 10 + lot (lot last, no GS needed).
const GTIN_LED = `01006284510000201726123110ABCD34`;

test('AIM prefixes on GTIN-led barcodes parse identically', () => {
  const plain = parseGS1Barcode(GTIN_LED);
  for (const prefix of [']C1', ']d2', ']Q3', ']e0']) {
    const parsed = parseGS1Barcode(`${prefix}${GTIN_LED}`);
    assert.deepEqual(parsed, plain, `prefix ${prefix} must not change the parse`);
  }
  assert.equal(plain.gtin, '00628451000020');
  assert.equal(plain.lot, 'ABCD34');
});

test('lot-only scans parse even when the lot contains "01"', () => {
  // The 01 re-anchor heuristic used to fire on the "01" inside Y016312 and
  // truncate the payload to "016312" → "AI(01) GTIN incomplete".
  assert.equal(parseGS1Barcode('10Y016312').lot, 'Y016312');
  assert.equal(parseGS1Barcode('10AB01CD').lot, 'AB01CD');
});

test('AI-like text inside a final lot does not create serial or expiry fields', () => {
  for (const lot of ['AHAVC219AC', 'Z012217', 'LOT17270827X']) {
    for (const prefix of ['', ']d2', '010062845100002017280531']) {
      for (const suffix of ['', GS, '\r\n']) {
        const parsed = parseInputData(`${prefix}10${lot}${suffix}`);
        assert.equal(parsed.lot, lot);
        assert.equal(parsed.serial, null);
        assert.equal(parsed.expiry, prefix.startsWith('01') ? '05/31/2028' : null);
      }
    }
  }
});

test('a separator terminates an AI-like lot before a real serial or expiry', () => {
  for (const lot of ['AHAVC219AC', 'Z012217']) {
    for (const separator of [GS, '\t']) {
      const parsed = parseInputData(`010062845100002010${lot}${separator}17280827${separator}21SER123`);
      assert.equal(parsed.lot, lot);
      assert.equal(parsed.expiry, '08/27/2028');
      assert.equal(parsed.serial, 'SER123');
    }
  }
});

test('AIM-prefixed lot-only barcode parses (HB lot-only flow)', () => {
  for (const prefix of [']d2', ']Q3', ']C1']) {
    const parsed = parseGS1Barcode(`${prefix}10Y016312`);
    assert.equal(parsed.lot, 'Y016312', `lot-only scan with ${prefix} prefix must parse`);
  }
});

test('AIM-prefixed expiry+lot barcode parses', () => {
  const parsed = parseGS1Barcode(`]d217271200${GS}10Y020519`);
  assert.equal(parsed.lot, 'Y020519');
  assert.equal(parsed.expiry, '12/31/2027');
});

test('trailing CR/LF scanner suffix does not corrupt the lot', () => {
  const parsed = parseGS1Barcode(`${GTIN_LED}\r\n`);
  assert.equal(parsed.lot, 'ABCD34');
});

test('garbage prefix before a full GTIN still re-anchors', () => {
  const parsed = parseGS1Barcode(`XX${GTIN_LED}`);
  assert.equal(parsed.gtin, '00628451000020');
  assert.equal(parsed.lot, 'ABCD34');
});

test('GS1 day-00 expiry resolves to the last day of the month', () => {
  assert.equal(formatDate('270200'), '02/28/2027');
  assert.equal(formatDate('280200'), '02/29/2028'); // leap year
  assert.equal(formatDate('261100'), '11/30/2026');
  const parsed = parseGS1Barcode(`010062845100002017270200${GS}10ABC123`);
  assert.equal(parsed.expiry, '02/28/2027');
});

test('parseInputData routes an AIM-prefixed scan to the GS1 parser', () => {
  const parsed = parseInputData(`]d2${GTIN_LED}`);
  assert.equal(parsed.gtin, '00628451000020');
  assert.equal(parsed.lot, 'ABCD34');
});
