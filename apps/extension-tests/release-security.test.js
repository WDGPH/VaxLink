import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

test('alpha and production packaging exclude catalogue snapshots and development material', (t) => {
  const source = fileURLToPath(new URL('../..', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'vaxlink-package-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Copy the real extension and seed excluded files without changing the worktree.
  for (const path of ['apps/extension', 'scripts/package-extension.sh', 'package.json']) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(source, path), join(root, path), { recursive: true });
  }
  const excluded = ['nvc_bundle.json', 'tests/probe.js', 'test/probe.js',
    '__tests__/probe.js', 'fixtures/probe.json', 'node_modules/probe/index.js',
    '.claude/probe.md', '__pycache__/probe.pyc', '.DS_Store', '.gitignore',
    'README.md', 'probe.test.js', 'shared/probe.spec.js'];
  for (const path of excluded) {
    const target = join(root, 'apps/extension', path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'packaging exclusion probe');
  }
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version.split('-')[0];
  for (const channel of ['alpha', 'prod']) {
    execFileSync('bash', ['scripts/package-extension.sh', channel], { cwd: root });
    const names = JSON.parse(execFileSync('python3', ['-c',
      `import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))`,
      `dist/vaxlink-${channel}-${version}.zip`], { cwd: root, encoding: 'utf8' }));
    assert.ok(names.includes('manifest.json'), channel);
    assert.ok(names.includes('content.js'), channel);
    for (const path of excluded) assert.equal(names.includes(path), false, `${channel}: ${path}`);
    assert.equal(names.some((name) => /(?:^|\/)(?:tests?|__tests__|fixtures|node_modules)(?:\/|$)|\.(?:test|spec)\.js$/.test(name)), false, channel);
  }
});

test('all release asset paths publish checksums for their final ZIPs', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/release-please.yml', import.meta.url), 'utf8');
  assert.equal((workflow.match(/sha256sum vaxlink-prod-\*\.zip > SHA256SUMS/g) || []).length, 2);
  assert.equal((workflow.match(/sha256sum vaxlink-alpha-\*\.zip > SHA256SUMS/g) || []).length, 1);
  assert.equal((workflow.match(/dist\/SHA256SUMS(?: --clobber)?$/gm) || []).length, 3);
  assert.equal((workflow.match(/--clobber/g) || []).length, 1);
  assert.match(workflow, /repair-stable-assets:[\s\S]*?Attach repaired stable package[\s\S]*?dist\/SHA256SUMS --clobber/);
});
