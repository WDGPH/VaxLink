import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createBackgroundHarness } from './helpers/clinic-sim.js';
import { parseInputData } from '../extension/popup-parser.js';
import { buildParsedOutputMarkup, outputTypeForScan } from '../extension/popup-ui.js';
import '../extension/shared/scan-issues.js';

const { lookupIssue, malformedBarcodeMessage } = globalThis.VaxLinkScanIssues;
const bundle = { resourceType: 'Bundle', entry: [{ resource: {
  resourceType: 'CodeSystem', id: 'nvc-vaccine-lot-id', concept: [{
    code: 'KNOWN_[1]', property: [{ code: 'lotNumber', valueString: 'KNOWN' }]
  }]
} }] };

test('valid barcode with an absent lot reports NVC not found, not a parsing error', async () => {
  const parsed = parseInputData('01001234567890121727123110MISSING');
  assert.equal(parsed.lot, 'MISSING');
  const bg = createBackgroundHarness(bundle);
  const result = await bg.sendMessage({ action: 'lookupVaccineInfo', lot: parsed.lot });
  assert.equal(result.errorCode, 'nvc_not_found');
  assert.match(result.error, /Lot MISSING was read successfully but was not found in NVC/);
  assert.match(result.error, /enter the missing details manually in the chart/);
  assert.doesNotMatch(result.error, /refresh/i);
  assert.doesNotMatch(result.error, /Malformed/);
  const markup = buildParsedOutputMarkup({ ...parsed, lookup_error: result.error });
  assert.match(markup, /MISSING/);
  assert.match(markup, /not found in NVC/);
});

test('missing cached catalog reports unavailable rather than claiming the lot is absent', async () => {
  const result = await createBackgroundHarness(null).sendMessage({ action: 'lookupVaccineInfo', lot: 'MISSING' });
  assert.equal(result.errorCode, 'nvc_unavailable');
  assert.match(result.error, /Refresh NVC Data/);
  assert.doesNotMatch(result.error, /not found/);
});

test('known lot lookup continues to return vaccine data', async () => {
  const result = await createBackgroundHarness(bundle).sendMessage({ action: 'lookupVaccineInfo', lot: 'KNOWN' });
  assert.equal(result.lot_number, 'KNOWN');
  assert.equal(result.error, undefined);
});

test('malformed scans identify incomplete or invalid fields with rescan guidance', () => {
  for (const [raw, reason] of [
    ['01123', /GTIN incomplete/],
    ['01ABCDEFGHIJKLMN10LOT', /GTIN must contain 14 digits/],
    ['01001234567890121727', /expiry date incomplete/],
    ['1727133110LOT', /expiry date is invalid/],
    ['1727023010LOT', /expiry date is invalid/],
    ['not-a-vaccine-barcode', /Expected a GS1 AI sequence/],
    ['{"lot":}', /JSON/]
  ]) {
    assert.throws(() => parseInputData(raw), error => {
      assert.equal(error.code, 'malformed_barcode');
      assert.match(error.message, reason);
      assert.match(malformedBarcodeMessage(error), /^Malformed barcode:/);
      assert.match(malformedBarcodeMessage(error), /Scan the full vaccine GS1 DataMatrix barcode/);
      return true;
    });
  }
});

test('valid day-zero and leap-day expiry dates remain accepted', () => {
  assert.equal(parseInputData('1727020010LOT').expiry, '02/28/2027');
  assert.equal(parseInputData('1728022910LOT').expiry, '02/29/2028');
});

test('GTIN-only scans distinguish missing lot data from malformed input', () => {
  const parsed = parseInputData('0100123456789012');
  assert.equal(parsed.gtin, '00123456789012');
  assert.equal(parsed.lot, null);
  const issue = lookupIssue('missing_lot');
  assert.match(issue.error, /No lot number/);
  assert.match(issue.error, /enter the lot manually/);
  assert.doesNotMatch(issue.error, /Malformed/);
});

test('lookup warning preserves expiry error severity and escapes lot text in output', () => {
  const lookup_error = lookupIssue('nvc_not_found', '<img src=x onerror=alert(1)>').error;
  assert.equal(outputTypeForScan({ lookup_error }), 'warning');
  assert.equal(outputTypeForScan({ lookup_error, expiry: '2020-01-01' }), 'error');
  const markup = buildParsedOutputMarkup({ lookup_error });
  assert.match(markup, /&lt;img/);
  assert.doesNotMatch(markup, /<img/);
});

test('scanner queues retain readable fields and the actionable NVC issue', async () => {
  const bg = createBackgroundHarness(bundle, { storage: { vaxlink_workflow_mode_v1: 'multiple' } });
  await bg.sendMessage({ action: 'scannerScanCaptured', scan: {
    type: 'vaxlink.scan', rawText: '01001234567890121727123110MISSING', source: 'web-serial'
  } });
  const [record] = bg.storageData.get('multiple_inject_queue_v1');
  assert.equal(record.lot, 'MISSING');
  assert.equal(record.inventory_expiry, '12/31/2027');
  assert.match(record.lookup_error, /not found in NVC/);
  assert.match(record.lookup_error, /manually in the chart/);
});

test('content scanner lookup preserves background errors instead of discarding them', async () => {
  const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
  const start = source.indexOf('function lookupVaccineInfoByLot(');
  const end = source.indexOf('\nfunction getLocalStorage(', start);
  const context = vm.createContext({
    VaxLinkScanIssues: globalThis.VaxLinkScanIssues,
    chrome: { runtime: { sendMessage(_request, callback) { callback(lookupIssue('nvc_not_found', 'MISSING')); } } }
  });
  vm.runInContext(source.slice(start, end), context);
  await assert.rejects(context.lookupVaccineInfoByLot('MISSING'), /not found in NVC/);
});
