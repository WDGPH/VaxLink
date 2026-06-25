/**
 * Bundle-anchored segmentation search (apps/extension/shared/gs1-segmentation.js).
 *
 * HID keyboard-wedge scanners drop the FNC1/<GS> separator, so a lot whose value
 * contains digits that look like another AI is ambiguous. The reported failure:
 * lot "AHAVC219AC" — the embedded "21" makes the greedy parser split the lot and
 * mistake the tail for an AI(21) serial, truncating the lot to "AHAVC" so the
 * NVC lookup misses. The segmentation search enumerates every valid parse and,
 * anchored on the bundle, recovers the real lot.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseGS1Barcode } from '../extension/popup-parser.js';

// Classic script: requiring it attaches globalThis.VaxLinkGS1Segmentation.
const require = createRequire(import.meta.url);
require(path.resolve(fileURLToPath(import.meta.url), '../../extension/shared/gs1-segmentation.js'));
const SEG = globalThis.VaxLinkGS1Segmentation;

const GS = String.fromCharCode(0x1d);
const REPORTED_SCAN = '10AHAVC219AC17280531'; // lot AHAVC219AC, exp 2028-05-31
const knownAhavc = (lot) => String(lot || '').toLowerCase() === 'ahavc219ac';

test('the greedy parser truncates the reported lot (documents the bug)', () => {
  // Establishes why a plain NVC lookup misses: the lot is cut at the embedded 21.
  assert.equal(parseGS1Barcode(REPORTED_SCAN).lot, 'AHAVC');
});

test('enumerates every valid segmentation of the separator-less scan', () => {
  const parses = SEG.enumerateGS1Segmentations(REPORTED_SCAN);
  const lots = parses.map((p) => p.lot).sort();
  assert.deepEqual(lots, ['AHAVC', 'AHAVC', 'AHAVC219AC', 'AHAVC219AC17280531']);
  // The correct interpretation is one of the enumerated candidates.
  assert.ok(
    parses.some((p) => p.lot === 'AHAVC219AC' && p.expiry === '05/31/2028' && !p.serial),
    'expected lot AHAVC219AC + expiry candidate'
  );
});

test('recovers the real lot decisively when the bundle confirms it', () => {
  const best = SEG.resolveBestSegmentation(REPORTED_SCAN, knownAhavc);
  assert.equal(best.lot, 'AHAVC219AC');
  assert.equal(best.serial, null);
  assert.equal(best.expiry, '05/31/2028');
  assert.equal(best.lotKnown, true);
});

test('still prefers the correct lot offline via structural tiebreaks', () => {
  // No bundle (knownLot always false): maximal-munch lot + a coherent expiry
  // beats the early split, so the search degrades gracefully.
  const best = SEG.resolveBestSegmentation(REPORTED_SCAN, () => false);
  assert.equal(best.lot, 'AHAVC219AC');
  assert.equal(best.lotKnown, false);
});

test('does not override an already-correct GTIN-led barcode', () => {
  const scan = '01006284510000201726123110ABCD34';
  const best = SEG.resolveBestSegmentation(scan, () => false);
  assert.equal(best.gtin, '00628451000020');
  assert.equal(best.expiry, '12/31/2026');
  assert.equal(best.lot, 'ABCD34');
});

test('an explicit <GS> separator yields the same unambiguous lot', () => {
  const best = SEG.resolveBestSegmentation(`10AHAVC219AC${GS}17280531`, knownAhavc);
  assert.equal(best.lot, 'AHAVC219AC');
  assert.equal(best.expiry, '05/31/2028');
});

test('returns null for non-GS1 input rather than throwing', () => {
  assert.equal(SEG.resolveBestSegmentation('hello world', () => false), null);
  assert.equal(SEG.resolveBestSegmentation('', () => false), null);
});

test('lot-only scan with an embedded "01" is preserved (no false anchor)', () => {
  const best = SEG.resolveBestSegmentation('10Y016312', () => false);
  assert.equal(best.lot, 'Y016312');
});
