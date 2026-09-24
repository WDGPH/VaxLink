import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const extension = new URL('../extension/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', extension), 'utf8'));

test('extension permissions and hosts stay within the supported boundary', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'idle', 'offscreen', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['https://nvc-cnv.canada.ca/*']);
  assert.equal(JSON.stringify(manifest).includes('<all_urls>'), false);

  const matches = manifest.content_scripts.flatMap((script) => script.matches);
  assert.deepEqual(matches, [
    'https://www.panorama.prod.ehealthontario.ca/*/ImmsWeb/pages/recordImms/*',
    'https://panorama.prod.ehealthontario.ca/*/ImmsWeb/pages/recordImms/*',
    'https://inputhealth.com/*',
    'https://*.inputhealth.com/*'
  ]);
  for (const pattern of matches.slice(0, 2)) {
    assert.match(pattern, /\/recordImms\/\*$/);
    assert.doesNotMatch(pattern, /phsdsm/);
  }
  assert.doesNotMatch(readFileSync(new URL('popup.js', extension), 'utf8'), /chrome\.scripting/);
});
