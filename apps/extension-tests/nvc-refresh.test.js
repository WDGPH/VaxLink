import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createBackgroundHarness } from './helpers/clinic-sim.js';

const officialUrl = 'https://nvc-cnv.canada.ca/fhir/v2/Bundle/NVC';
const bundle = (code = 'LOT1') => ({
  resourceType: 'Bundle', type: 'collection', entry: [
    { resource: { resourceType: 'ValueSet', id: 'Tradename', compose: {
      include: [{ concept: [{ code: 'trade-1', display: 'Test vaccine' }] }]
    } } },
    { resource: { resourceType: 'CodeSystem', id: 'nvc-vaccine-lot-id',
      concept: [{ code, property: [{ code: 'lotNumber', valueString: code }] }] } }
  ]
});
const response = (data, { url = officialUrl, status = 200, lastModified = null } = {}) => ({
  url, status, ok: status >= 200 && status < 300,
  headers: { get: (name) => name === 'Last-Modified' ? lastModified : null },
  json: async () => data
});

test('NVC source is pinned to the official endpoint', () => {
  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(background, /const DEFAULT_NVC_SOURCE_URL = 'https:\/\/nvc-cnv\.canada\.ca\/fhir\/v2\/Bundle\/NVC'/);
});

test('NVC rejects custom sources and cross-origin responses without replacing cache', async () => {
  const requests = [];
  const harness = createBackgroundHarness(bundle(), {
    fetch: async (url, init) => {
      if (url !== officialUrl) throw new Error('icon unavailable');
      requests.push({ url, init });
      return response(bundle('LOT2'), { url: 'https://evil.example/NVC' });
    }
  });
  const custom = await harness.sendMessage({ action: 'refreshNVCBundle', sourceUrl: 'https://evil.example/NVC' });
  assert.equal(custom.success, false);
  assert.equal(requests.length, 0);
  const redirected = await harness.sendMessage({ action: 'refreshNVCBundle' });
  assert.equal(redirected.success, false);
  assert.equal(requests[0].url, officialUrl);
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(harness.storageData.get('nvc_bundle_override').entry[1].resource.concept[0].code, 'LOT1');
});

test('NVC validates catalogue shape, keeps known good on failure and changes fingerprint with content', async () => {
  const malformed = bundle('LOT_BAD');
  malformed.entry[1].resource.concept.push(null);
  const nestedMalformed = bundle('LOT_BAD');
  nestedMalformed.entry[1].resource.concept[0].extension = [null];
  const replies = [response({ resourceType: 'Bundle', entry: [] }), response(malformed), response(nestedMalformed), response(bundle('LOT2')),
    response(bundle('LOT3'))];
  const harness = createBackgroundHarness(bundle(), { fetch: async (url) => {
    if (url !== officialUrl) throw new Error('icon unavailable');
    return replies.shift();
  } });
  const bad = await harness.sendMessage({ action: 'refreshNVCBundle' });
  assert.equal(bad.success, false);
  const nestedBad = await harness.sendMessage({ action: 'refreshNVCBundle' });
  assert.equal(nestedBad.success, false);
  const lookupBad = await harness.sendMessage({ action: 'refreshNVCBundle' });
  assert.equal(lookupBad.success, false);
  assert.equal(harness.storageData.get('nvc_bundle_override').entry[1].resource.concept[0].code, 'LOT1');
  const previousLookup = await harness.sendMessage({ action: 'lookupVaccineInfo', lot: 'LOT1' });
  assert.equal(previousLookup.lot_number, 'LOT1');
  const first = await harness.sendMessage({ action: 'refreshNVCBundle' });
  const second = await harness.sendMessage({ action: 'refreshNVCBundle' });
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(first.sha256, second.sha256);
  assert.equal(harness.storageData.get('nvc_bundle_override').entry[1].resource.concept[0].code, 'LOT3');
});

test('automatic NVC check uses Last-Modified and handles unchanged response', async () => {
  const requests = [];
  const modified = 'Wed, 23 Sep 2026 10:00:00 GMT';
  const harness = createBackgroundHarness(bundle(), {
    storage: { nvc_bundle_last_check_at: '2020-01-01T00:00:00Z',
      nvc_bundle_last_modified: modified, nvc_bundle_updated_at: '2026-09-22T00:00:00Z' },
    fetch: async (url, init) => {
      if (url !== officialUrl) throw new Error('icon unavailable');
      requests.push(init); return response(null, { status: 304 });
    }
  });
  const result = await harness.sendMessage({ action: 'checkNVCBundleUpdates' });
  assert.equal(result.unchanged, true);
  assert.equal(requests[0].headers['If-Modified-Since'], modified);
  assert.equal(harness.storageData.get('nvc_bundle_updated_at'), '2026-09-22T00:00:00Z');
});

test('failed NVC cache write restores the previous indexed catalogue', async () => {
  const previous = bundle('LOT1');
  const harness = createBackgroundHarness(previous, {
    fetch: async (url) => {
      if (url !== officialUrl) throw new Error('icon unavailable');
      return response(bundle('LOT2'));
    },
    failStorageSet: (values) => Object.hasOwn(values, 'nvc_bundle_override')
  });
  const result = await harness.sendMessage({ action: 'refreshNVCBundle' });
  assert.equal(result.success, false);
  assert.equal(harness.storageData.get('nvc_bundle_override'), previous);
  const lookup = await harness.sendMessage({ action: 'lookupVaccineInfo', lot: 'LOT1' });
  assert.notEqual(lookup?.error, 'Failed to load NVC database');
});

test('first install fetches a usable catalogue even with a recent legacy check time', async () => {
  const harness = createBackgroundHarness(null, {
    fetch: async (url) => {
      if (url !== officialUrl) throw new Error('icon unavailable');
      return response(bundle('NEWLOT'));
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.storageData.get('nvc_bundle_override').entry[1].resource.concept[0].code, 'NEWLOT');
  const lookup = await harness.sendMessage({ action: 'lookupVaccineInfo', lot: 'NEWLOT' });
  assert.notEqual(lookup?.error, 'Failed to load NVC database');
});

test('invalid cached indexes trigger an unconditional recovery fetch', async () => {
  const invalid = bundle('BADLOT');
  invalid.entry[1].resource.concept[0].property = [null];
  const requests = [];
  const harness = createBackgroundHarness(invalid, {
    storage: { nvc_bundle_last_modified: 'Wed, 23 Sep 2026 10:00:00 GMT',
      nvc_bundle_updated_at: '2026-09-23T10:00:00Z' },
    fetch: async (url, init) => {
      if (url !== officialUrl) throw new Error('icon unavailable');
      requests.push(init);
      return init.headers['If-Modified-Since']
        ? response(null, { status: 304 }) : response(bundle('NEWLOT'));
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers['If-Modified-Since'], undefined);
  assert.equal(harness.storageData.get('nvc_bundle_override').entry[1].resource.concept[0].code, 'NEWLOT');
  const lookup = await harness.sendMessage({ action: 'lookupVaccineInfo', lot: 'NEWLOT' });
  assert.equal(lookup.lot_number, 'NEWLOT');
});
