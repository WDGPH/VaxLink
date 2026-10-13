import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

test('production packaging excludes catalogue snapshots and development material', () => {
  const script = readFileSync(new URL('../../scripts/package-extension.sh', import.meta.url), 'utf8');
  assert.match(script, /"nvc_bundle\.json"/);
  assert.match(script, /"tests"/);
  const root = new URL('../..', import.meta.url).pathname;
  execFileSync('bash', ['scripts/package-extension.sh', 'alpha'], { cwd: root });
  const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version.split('-')[0];
  const names = JSON.parse(execFileSync('python3', ['-c',
    `import json,zipfile; print(json.dumps(zipfile.ZipFile('dist/vaxlink-alpha-${version}.zip').namelist()))`],
    { cwd: root, encoding: 'utf8' }));
  assert.equal(names.some((name) => /(?:^|\/)nvc_bundle\.json$|(?:^|\/)(?:tests?|__tests__|fixtures|node_modules|README\.md)(?:\/|$)|\.(?:test|spec)\.js$/.test(name)), false);
});

test('all release asset paths publish checksums for their final ZIPs', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/release-please.yml', import.meta.url), 'utf8');
  assert.equal((workflow.match(/sha256sum vaxlink-prod-\*\.zip > SHA256SUMS/g) || []).length, 2);
  assert.equal((workflow.match(/sha256sum vaxlink-alpha-\*\.zip > SHA256SUMS/g) || []).length, 1);
  assert.equal((workflow.match(/dist\/SHA256SUMS --clobber/g) || []).length, 3);
});
