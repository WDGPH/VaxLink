import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

function packageProject(t) {
  const source = fileURLToPath(new URL('../..', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'vaxlink-package-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [
    'apps/extension',
    'scripts/package-extension.sh',
    'package.json'
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(source, path), join(root, path), { recursive: true });
  }
  return root;
}

function buildPackage(root, channel, version) {
  execFileSync('bash', ['scripts/package-extension.sh', channel], {
    cwd: root,
    stdio: 'pipe'
  });
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        `import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    print(json.dumps({'names': z.namelist(), 'manifest': json.loads(z.read('manifest.json'))}))`,
        `dist/vaxlink-${channel}-${version}.zip`
      ],
      { cwd: root, encoding: 'utf8' }
    )
  );
}

test('alpha and production packaging exclude catalogue snapshots and development material', (t) => {
  const root = packageProject(t);
  // Seed excluded files without changing the worktree.
  const excluded = [
    'nvc_bundle.json',
    'tests/probe.js',
    'test/probe.js',
    '__tests__/probe.js',
    'fixtures/probe.json',
    'node_modules/probe/index.js',
    '.claude/probe.md',
    '__pycache__/probe.pyc',
    '.DS_Store',
    '.gitignore',
    'README.md',
    'probe.test.js',
    'shared/probe.spec.js'
  ];
  for (const path of excluded) {
    const target = join(root, 'apps/extension', path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'packaging exclusion probe');
  }
  const version = '1.1.5';
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
  for (const channel of ['alpha', 'prod']) {
    const { names, manifest } = buildPackage(root, channel, version);
    assert.equal(manifest.version, version);
    assert.equal(
      manifest.name,
      channel === 'prod' ? 'VaxLink' : 'VaxLink Alpha'
    );
    assert.ok(names.includes('manifest.json'), channel);
    assert.ok(names.includes('content.js'), channel);
    for (const path of excluded)
      assert.equal(names.includes(path), false, `${channel}: ${path}`);
    assert.equal(
      names.some((name) =>
        /(?:^|\/)(?:tests?|__tests__|fixtures|node_modules)(?:\/|$)|\.(?:test|spec)\.js$/.test(
          name
        )
      ),
      false,
      channel
    );
  }
});

test('all release asset paths publish checksums for their final ZIPs', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/release-please.yml', import.meta.url),
    'utf8'
  );
  assert.equal(
    (workflow.match(/sha256sum vaxlink-prod-\*\.zip > SHA256SUMS/g) || [])
      .length,
    2
  );
  assert.equal(
    (workflow.match(/sha256sum vaxlink-alpha-\*\.zip > SHA256SUMS/g) || [])
      .length,
    1
  );
  assert.equal(
    (workflow.match(/dist\/SHA256SUMS(?: --clobber)?$/gm) || []).length,
    3
  );
  assert.equal((workflow.match(/--clobber/g) || []).length, 1);
  assert.match(
    workflow,
    /repair-stable-assets:[\s\S]*?Attach repaired stable package[\s\S]*?dist\/SHA256SUMS --clobber/
  );
});

test('successive Alpha prereleases have increasing Chrome versions and cannot ship as production', (t) => {
  const root = packageProject(t);
  for (const [version, numeric] of [
    ['1.1.6-alpha', '1.1.6.0'],
    ['1.1.6-alpha.1', '1.1.6.1'],
    ['1.1.6-alpha.2', '1.1.6.2']
  ]) {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
    const { manifest } = buildPackage(root, 'alpha', version);
    assert.equal(manifest.version, numeric);
    assert.equal(manifest.version_name, version);
    assert.throws(
      () =>
        execFileSync('bash', ['scripts/package-extension.sh', 'prod'], {
          cwd: root,
          stdio: 'pipe'
        }),
      /Production packages require a stable package version/
    );
  }
});

test('Alpha automation targets alpha with advancing prerelease versions', () => {
  const read = (path) =>
    readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const workflow = read('.github/workflows/release-please.yml');
  const config = JSON.parse(read('release-please-alpha-config.json'));
  assert.match(workflow, /refs\/heads\/alpha/);
  assert.match(workflow, /target-branch: alpha/);
  assert.match(workflow, /config-file: release-please-alpha-config\.json/);
  assert.doesNotMatch(workflow, /refs\/heads\/dev|target-branch: dev/);
  assert.equal(config.prerelease, true);
  assert.equal(config.versioning, 'prerelease');
  assert.equal(config['prerelease-type'], 'alpha');
  assert.equal(config['release-as'], undefined);
  assert.equal(config['last-release-sha'], undefined);
  assert.match(
    read('.github/workflows/extension-ci.yml'),
    /branches: \[alpha, main\]/
  );
});
