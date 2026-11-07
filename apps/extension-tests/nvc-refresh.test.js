import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';
import { describeNVCHealth } from '../extension/popup-ui.js';

const officialUrl = 'https://nvc-cnv.canada.ca/fhir/v2/Bundle/NVC';
const bundle = makeTestNvcBundle;
const refresh = (harness) =>
  harness.sendMessage({ action: 'refreshNVCBundle' });
const lookup = (harness, lot = 'LOT1') =>
  harness.sendMessage({ action: 'lookupVaccineInfo', lot });
const status = (harness) =>
  harness.sendMessage({ action: 'getNVCUpdateStatus' });
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const response = (
  data,
  {
    url = officialUrl,
    status = 200,
    lastModified = null,
    redirected = false
  } = {}
) => ({
  url,
  status,
  redirected,
  ok: status >= 200 && status < 300,
  headers: { get: (name) => (name === 'Last-Modified' ? lastModified : null) },
  json: async () => data
});
const fetchCatalogue = (callback) => async (url, init) => {
  if (url !== officialUrl) throw new Error('icon unavailable');
  return callback(init);
};

test('NVC restricts downloads to its official source and rejects redirects', async () => {
  for (const reply of [
    { url: 'https://evil.example/NVC' },
    { url: officialUrl + '?other=1' },
    { redirected: true }
  ]) {
    let requests = 0;
    const harness = createBackgroundHarness(bundle('LOT1'), {
      fetch: fetchCatalogue((init) => {
        requests++;
        assert.equal(init.redirect, 'error');
        return response(bundle('LOT2'), reply);
      })
    });
    assert.equal(
      (
        await harness.sendMessage({
          action: 'refreshNVCBundle',
          sourceUrl: 'https://evil.example/NVC'
        })
      ).errorCategory,
      'source'
    );
    assert.equal(requests, 0);
    assert.equal((await refresh(harness)).errorCategory, 'source');
    assert.equal((await lookup(harness)).lot_number, 'LOT1');
  }
});

test('invalid data and failed writes preserve accepted catalogue, indexes, and health dates', async () => {
  const malformed = bundle('LOT2');
  malformed.entry[1].resource.concept[0].extension = [null];
  const noUsableNames = bundle('LOT2');
  noUsableNames.entry[0].resource.compose.include[0].concept[0].code = ' ';
  const unlinked = bundle('LOT2');
  delete unlinked.entry[1].resource.concept[0].extension;
  const unnamed = bundle('LOT2');
  delete unnamed.entry[0].resource.compose.include[0].concept[0].display;
  for (const scenario of [
    'empty',
    'malformed',
    'unusable',
    'unlinked',
    'unnamed',
    'write'
  ]) {
    const previous = bundle('LOT1');
    let lookupDuringWrite;
    let harness;
    harness = createBackgroundHarness(previous, {
      storage: { nvc_bundle_updated_at: '2026-09-22T00:00:00Z' },
      fetch: fetchCatalogue(() =>
        response(
          scenario === 'empty'
            ? { resourceType: 'Bundle', entry: [] }
            : scenario === 'malformed'
              ? malformed
              : scenario === 'unusable'
                ? noUsableNames
                : scenario === 'unlinked'
                  ? unlinked
                  : scenario === 'unnamed'
                    ? unnamed
                    : bundle('LOT2')
        )
      ),
      failStorageSet: (values) => {
        if (
          scenario !== 'write' ||
          !Object.hasOwn(values, 'nvc_bundle_override')
        )
          return false;
        lookupDuringWrite = lookup(harness);
        return true;
      }
    });
    const before = await status(harness);
    assert.equal(
      (await refresh(harness)).errorCategory,
      scenario === 'write' ? 'storage' : 'invalid'
    );
    if (lookupDuringWrite)
      assert.equal((await lookupDuringWrite).lot_number, 'LOT1');
    assert.equal(harness.storageData.get('nvc_bundle_override'), previous);
    assert.equal((await lookup(harness)).lot_number, 'LOT1');
    assert.equal((await lookup(harness, 'LOT2')).errorCategory, 'not_found');
    const after = await status(harness);
    assert.equal(after.updatedAt, before.updatedAt);
    assert.equal(after.lastCheckAt, before.lastCheckAt);
    assert.equal(after.freshnessDegraded, true);
    assert.equal(after.usingCache, true);
    assert.match(
      describeNVCHealth(after),
      /Previously downloaded catalogue remains available/
    );
    const restarted = createBackgroundHarness(previous, {
      storage: Object.fromEntries(harness.storageData)
    });
    assert.equal((await status(restarted)).lastError, after.lastError);
  }
});

test('missing or invalid cache shares initialization with lookups and reports bounded waiting', async () => {
  const invalid = bundle('BAD');
  invalid.entry[1].resource.concept[0].property = [null];
  for (const cached of [null, invalid]) {
    const started = deferred();
    const download = deferred();
    let requests = 0;
    const harness = createBackgroundHarness(cached, {
      storage: { nvc_bundle_last_modified: 'Wed, 23 Sep 2026 10:00:00 GMT' },
      fetch: fetchCatalogue((init) => {
        requests++;
        assert.equal(init.headers['If-Modified-Since'], undefined);
        started.resolve();
        return download.promise;
      })
    });
    const pendingLookup = lookup(harness, 'NEWLOT');
    await started.promise;
    assert.equal((await status(harness)).state, 'refreshing');
    assert.equal((await status(harness)).usable, false);
    const manual = refresh(harness);
    download.resolve(response(bundle('NEWLOT')));
    assert.equal((await manual).success, true);
    assert.equal((await pendingLookup).lot_number, 'NEWLOT');
    assert.equal(requests, 1);
    assert.equal((await status(harness)).state, 'ready');
  }

  const waitTimer = deferred();
  const networkTimer = deferred();
  const started = deferred();
  const download = deferred();
  const harness = createBackgroundHarness(null, {
    setTimeout: (callback, ms) => {
      (ms === 5000 ? waitTimer : networkTimer).resolve(callback);
      return 0;
    },
    fetch: fetchCatalogue(() => {
      started.resolve();
      return download.promise;
    })
  });
  const pendingLookup = lookup(harness);
  await started.promise;
  (await waitTimer.promise)();
  assert.equal((await pendingLookup).errorCategory, 'initializing');
  const pendingRefresh = refresh(harness);
  (await networkTimer.promise)();
  assert.equal((await pendingRefresh).errorCategory, 'timeout');
  assert.equal((await lookup(harness)).errorCategory, 'unavailable');
  assert.equal((await status(harness)).state, 'unavailable');
  download.resolve(response(bundle('TOO_LATE')));
  assert.equal(
    (await lookup(harness, 'TOO_LATE')).errorCategory,
    'unavailable'
  );
});

test('conditional refresh accepts 304 only with usable cache and keeps download date', async () => {
  const modified = 'Wed, 23 Sep 2026 10:00:00 GMT';
  const harness = createBackgroundHarness(bundle('LOT1'), {
    storage: {
      nvc_bundle_last_modified: modified,
      nvc_bundle_updated_at: '2026-09-22T00:00:00Z'
    },
    fetch: fetchCatalogue((init) => {
      assert.equal(init.headers['If-Modified-Since'], modified);
      return response(null, { status: 304 });
    })
  });
  const result = await refresh(harness);
  assert.equal(result.unchanged, true);
  assert.equal((await status(harness)).updatedAt, '2026-09-22T00:00:00Z');
  assert.equal((await status(harness)).lastCheckAt, result.checkedAt);
  assert.equal((await lookup(harness)).lot_number, 'LOT1');
  const missing = createBackgroundHarness(null, {
    fetch: fetchCatalogue(() => response(null, { status: 304 }))
  });
  assert.equal((await refresh(missing)).errorCategory, 'invalid');
  assert.equal((await lookup(missing)).errorCategory, 'invalid');
});

test('simultaneous refreshes share results, retain ready lookups, and recover after failure', async () => {
  const partial = bundle('LOT1');
  partial.entry[1].resource.concept.push({
    code: 'INCOMPLETE',
    property: [{ code: 'lotNumber', valueString: 'INCOMPLETE' }]
  });
  const started = deferred();
  const download = deferred();
  let requests = 0;
  const harness = createBackgroundHarness(partial, {
    fetch: fetchCatalogue(() => {
      requests++;
      if (requests === 1) {
        started.resolve();
        return download.promise;
      }
      if (requests === 2) return response(bundle('LOT2'));
      throw new Error('Network exception with private detail');
    })
  });
  const first = refresh(harness);
  await started.promise;
  const second = refresh(harness);
  const auto = harness.sendMessage({ action: 'checkNVCBundleUpdates' });
  assert.equal((await status(harness)).state, 'refreshing');
  assert.equal((await lookup(harness)).lot_number, 'LOT1');
  assert.equal(
    (await lookup(harness, 'INCOMPLETE')).errorCategory,
    'incomplete'
  );
  download.resolve(response(null, { status: 503 }));
  const results = await Promise.all([first, second, auto]);
  assert.equal(requests, 1);
  assert.ok(results.every((result) => result.errorCategory === 'http'));
  assert.equal((await refresh(harness)).success, true);
  const accepted = await status(harness);
  assert.match(accepted.sha256, /^[a-f0-9]{64}$/);
  assert.equal(accepted.lastError, null);
  assert.equal((await lookup(harness, 'LOT2')).lot_number, 'LOT2');
  assert.equal((await refresh(harness)).errorCategory, 'network');
  const degraded = await status(harness);
  assert.equal(degraded.sha256, accepted.sha256);
  assert.equal(degraded.updatedAt, accepted.updatedAt);
  assert.doesNotMatch(JSON.stringify(degraded), /private detail/);
  assert.equal((await lookup(harness, 'LOT2')).lot_number, 'LOT2');
});
