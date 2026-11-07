import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';
import {
  formatNVCRefreshMessage,
  renderNVCStatus
} from '../extension/popup-ui.js';

const officialUrl = 'https://nvc-cnv.canada.ca/fhir/v2/Bundle/NVC';
function catalogue(codes = ['A'], version = '1.137', date = '2026-11-05') {
  const data = makeTestNvcBundle(codes[0]);
  const lots = data.entry[1].resource;
  lots.concept = codes.map((code) => ({
    ...structuredClone(lots.concept[0]),
    code,
    property: [{ code: 'lotNumber', valueString: code }]
  }));
  Object.assign(lots, { version, date });
  return data;
}
function harness(cached, next) {
  return createBackgroundHarness(cached, {
    fetch: async (url) => {
      if (url !== officialUrl) throw new Error('icon unavailable');
      const data = next();
      if (data instanceof Error) throw data;
      return {
        url,
        status: data === 304 ? 304 : 200,
        ok: true,
        headers: { get: () => null },
        json: async () => data
      };
    }
  });
}
const refresh = (bg) => bg.sendMessage({ action: 'refreshNVCBundle' });
const status = (bg) => bg.sendMessage({ action: 'getNVCUpdateStatus' });

test('catalogue counts use distinct normalized lot codes and count only newly added codes', async () => {
  const bg = harness(catalogue(['A', 'REMOVED']), () =>
    catalogue(['A', ' b ', 'B', 'C', '', ' ', 'BAD CODE', '\u0001'])
  );
  const result = await refresh(bg);
  assert.equal(result.success, true);
  assert.equal(result.lotCount, 3);
  assert.equal(result.addedLotCount, 2);
  assert.equal(result.firstRefresh, false);
  assert.equal(
    formatNVCRefreshMessage(result),
    'NVC catalogue updated — 2 new lot codes; 3 total.'
  );
  assert.equal((await status(bg)).lotCount, 3);
});

test('refresh feedback separates first download, changed data, and confirmed unchanged data', async () => {
  const data = catalogue();
  const changed = catalogue(['A'], '1.138');
  const replies = [data, data, changed, 304];
  const bg = harness(null, () => replies.shift());
  for (const [firstRefresh, unchanged, message] of [
    [true, false, 'NVC catalogue loaded successfully — 1 distinct lot code.'],
    [false, true, 'NVC catalogue checked — no changes detected.'],
    [false, false, 'NVC catalogue updated — no new lot codes.'],
    [false, true, 'NVC catalogue checked — no changes detected.']
  ]) {
    const result = await refresh(bg);
    assert.equal(result.success, true);
    assert.equal(result.firstRefresh, firstRefresh);
    assert.equal(result.unchanged, unchanged);
    assert.equal(formatNVCRefreshMessage(result), message);
  }
  assert.equal((await status(bg)).releaseVersion, '1.138');
});

test('accepted publication metadata survives reopening and popup HTML escapes upstream text', async () => {
  const bg = harness(catalogue(), () =>
    catalogue(['A', 'B'], '<img src=x onerror=alert(1)>')
  );
  assert.equal((await refresh(bg)).success, true);
  const accepted = await status(bg);
  const reopened = createBackgroundHarness(
    bg.storageData.get('nvc_bundle_override'),
    {
      storage: Object.fromEntries(bg.storageData)
    }
  );
  const restored = await status(reopened);
  assert.equal(restored.releaseVersion, accepted.releaseVersion);
  assert.equal(restored.releaseDate, '2026-11-05');
  assert.equal(restored.lotCount, 2);
  assert.notEqual(restored.updatedAt, restored.releaseDate);
  const container = { innerHTML: '' };
  renderNVCStatus(restored, container);
  assert.match(container.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(container.innerHTML, /<img/);
  assert.match(
    container.innerHTML,
    /2 distinct lot codes in the NVC catalogue/
  );
  assert.match(container.innerHTML, /Published:<\/dt><dd>2026-11-05/);
  assert.match(container.innerHTML, /Last checked by VaxLink/);
  const missing = await status(
    createBackgroundHarness(catalogue(['A'], null, null))
  );
  assert.equal(missing.releaseDate, null);
  assert.equal(missing.releaseVersion, null);
  renderNVCStatus(missing, container);
  assert.match(container.innerHTML, /NVC version unavailable/);
  assert.match(container.innerHTML, /Published:<\/dt><dd>Unavailable/);
});

test('popup lookups follow accepted updates and failed refreshes keep accepted metadata', async () => {
  const changed = catalogue(['A'], '1.138', '2026-11-06');
  changed.entry[0].resource.compose.include[0].concept[0].display =
    'Updated vaccine name';
  const replies = [changed, new Error('offline')];
  const bg = harness(catalogue(), () => replies.shift());
  const source = readFileSync(
    new URL('../extension/popup.js', import.meta.url),
    'utf8'
  );
  const lookup = vm.runInNewContext(
    `(${source.match(/^async function lookupVaccineInfo\([^]*?^}/m)[0]})`,
    {
      sendRuntimeMessage: (request) => bg.sendMessage(request)
    }
  );
  assert.equal((await lookup('A')).tradename, 'Test vaccine');
  assert.equal((await refresh(bg)).success, true);
  assert.equal((await lookup('A')).tradename, 'Updated vaccine name');
  const accepted = await status(bg);
  const failed = await refresh(bg);
  assert.equal(
    formatNVCRefreshMessage(failed),
    'Unable to refresh NVC. Previously downloaded catalogue remains available.'
  );
  const after = await status(bg);
  for (const key of [
    'lotCount',
    'releaseVersion',
    'releaseDate',
    'updatedAt',
    'sha256'
  ]) {
    assert.equal(after[key], accepted[key]);
  }
  const container = { innerHTML: '' };
  renderNVCStatus(after, container);
  assert.match(
    container.innerHTML,
    /Previously downloaded catalogue remains available/
  );
  assert.equal(
    formatNVCRefreshMessage({ success: false, usable: false }),
    'Unable to refresh NVC. No usable catalogue is available.'
  );
  const statusArea = { textContent: 'NVC is loading.' };
  const loadStatus = vm.runInNewContext(
    `(${source.match(/^function loadNVCStatus\([^]*?^}/m)[0]})`,
    {
      chrome: {
        runtime: {
          lastError: { message: 'worker unavailable' },
          sendMessage: (_request, done) => done()
        }
      },
      nvcStatusDiv: statusArea
    }
  );
  loadStatus();
  assert.match(statusArea.textContent, /NVC status could not be checked/);
});
