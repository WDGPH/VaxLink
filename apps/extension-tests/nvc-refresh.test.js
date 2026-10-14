import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBackgroundHarness } from './helpers/clinic-sim.js';
import { formatNVCRefreshMessage, renderNVCStatus } from '../extension/popup-ui.js';

function bundle(...codes) {
  return { entry: [
    { resource: { resourceType: 'CodeSystem', id: 'nvc-vaccine-lot-id', concept: codes.map(code => ({ code })) } },
    { resource: { resourceType: 'CodeSystem', id: 'tradename', concept: [{ code: 'not-a-lot' }] } }
  ] };
}

function harness(previous, payload) {
  return createBackgroundHarness(previous, {
    fetch: async () => ({ ok: true, json: async () => payload })
  });
}

test('refresh counts distinct new lot records and the available total', async () => {
  const next = bundle('A', 'B', 'C', 'C');
  const bg = harness(bundle('A', 'REMOVED'), next);
  const result = await bg.sendMessage({ action: 'refreshNVCBundle' });
  assert.equal(result.success, true);
  assert.equal(result.addedLotCount, 2);
  assert.equal(result.lotCount, 3);
  assert.equal(result.firstRefresh, false);
  assert.deepEqual(bg.storageData.get('nvc_bundle_override'), next);
  assert.equal(formatNVCRefreshMessage(result), 'NVC refresh successful — 2 new lots added. 3 lots available.');

  const repeat = await bg.sendMessage({ action: 'refreshNVCBundle' });
  assert.equal(repeat.addedLotCount, 0);
  assert.equal(formatNVCRefreshMessage(repeat), 'NVC data is already up to date — 3 lots available.');
});

test('first refresh reports the available total', async () => {
  const result = await harness(null, bundle('A')).sendMessage({ action: 'refreshNVCBundle' });
  assert.equal(result.success, true);
  assert.equal(result.firstRefresh, true);
  assert.equal(result.lotCount, 1);
  assert.equal(formatNVCRefreshMessage(result), 'NVC refresh successful — 1 lot available.');
});

test('metadata shortcut returns the cached total without downloading the bundle', async () => {
  const previous = bundle('A', 'B');
  const hash = createHash('sha256').update(JSON.stringify(previous)).digest('hex');
  const bg = createBackgroundHarness(previous, {
    storage: { nvc_bundle_sha256: hash },
    fetch: async () => ({ ok: true, json: async () => ({ bundleUrl: 'https://example.test/bundle', sha256: hash }) })
  });
  await bg.sendMessage({ action: 'getNVCUpdateStatus' });
  bg.storageData.set('nvc_bundle_last_check_at', '2000-01-01T00:00:00.000Z');
  // Explicitly invoke the automatic refresh path after the cached check expires.
  const result = await bg.sendMessage({ action: 'checkNVCBundleUpdates' });
  // A manual check uses the same non-forced refresh as an automatic check.
  assert.equal(result.success, true);
  assert.equal(result.unchanged, true);
  assert.equal(result.addedLotCount, 0);
  assert.equal(result.lotCount, 2);
});

test('invalid refresh preserves the cached bundle and reports failure', async () => {
  const previous = bundle('A');
  const bg = harness(previous, { invalid: true });
  const result = await bg.sendMessage({ action: 'refreshNVCBundle' });
  assert.equal(result.success, false);
  assert.match(result.error, /Expected either an NVC bundle/);
  assert.equal(result.lotCount, undefined);
  assert.deepEqual(bg.storageData.get('nvc_bundle_override'), previous);
});

test('notification handles a single new lot and an empty catalog', () => {
  assert.equal(formatNVCRefreshMessage({ addedLotCount: 1, lotCount: 1 }),
    'NVC refresh successful — 1 new lot added. 1 lot available.');
  assert.equal(formatNVCRefreshMessage({ addedLotCount: 0, lotCount: 0 }),
    'NVC data is already up to date — 0 lots available.');
});

test('API release details appear after refresh and when reopening the popup', async () => {
  const next = bundle('A', 'B');
  next.meta = { lastUpdated: '2026-10-08T15:02:36Z' };
  Object.assign(next.entry[0].resource, { version: '1.133', date: '2026-10-08' });
  // Other resources can have different versions; use the vaccine lot CodeSystem.
  next.entry[1].resource.version = '7.2';
  const bg = harness(bundle('A'), next);
  const result = await bg.sendMessage({ action: 'refreshNVCBundle' });
  assert.equal(result.releaseVersion, '1.133');
  assert.equal(result.releaseDate, '2026-10-08');
  assert.equal(result.bundleLastUpdated, next.meta.lastUpdated);
  assert.equal(formatNVCRefreshMessage(result),
    'NVC refresh successful — 1 new lot added. 2 lots available. NVC v1.133 — Released 2026-10-08.');

  const status = await bg.sendMessage({ action: 'getNVCUpdateStatus' });
  assert.equal(status.releaseVersion, '1.133');
  assert.equal(status.releaseDate, '2026-10-08');
  assert.equal(status.lotCount, 2);
  const container = { innerHTML: '' };
  renderNVCStatus(status, container);
  assert.match(container.innerHTML, /NVC v1\.133/);
  assert.match(container.innerHTML, /2 lots available/);
  assert.match(container.innerHTML, /<dt>Released<\/dt><dd>2026-10-08<\/dd>/);
  assert.match(container.innerHTML, /Catalog updated/);
  assert.match(container.innerHTML, /Last successful refresh/);
});

test('cached API bundles supply release details before another refresh', async () => {
  const cached = bundle('A');
  Object.assign(cached.entry[0].resource, { version: '1.132', date: '2026-10-01' });
  const bg = harness(cached, cached);
  const status = await bg.sendMessage({ action: 'getNVCUpdateStatus' });
  assert.equal(status.releaseVersion, '1.132');
  assert.equal(status.releaseDate, '2026-10-01');
  assert.equal(status.lotCount, 1);
});

test('missing release metadata remains usable without inventing a version or date', async () => {
  const status = await harness(null, null).sendMessage({ action: 'getNVCUpdateStatus' });
  assert.equal(status.releaseVersion, null);
  assert.equal(status.releaseDate, null);
  assert.equal(status.lotCount, null);
  const container = { innerHTML: '' };
  renderNVCStatus(status, container);
  assert.doesNotMatch(container.innerHTML, /NVC v|<dt>Released|lots available|Catalog updated/);
});
