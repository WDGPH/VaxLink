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
import { runInNewContext } from 'node:vm';
import {
  createBackgroundHarness,
  makeTestNvcBundle
} from './helpers/clinic-sim.js';

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
    print(json.dumps({'names': z.namelist(), 'manifest': json.loads(z.read('manifest.json')), 'identity': z.read('build-identity.js').decode('utf-8')}))`,
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
    assert.equal(manifest.action.default_title, manifest.name);
    assert.deepEqual(
      manifest.content_scripts.flatMap((script) => script.matches),
      [
        'https://www.panorama.prod.ehealthontario.ca/*',
        'https://panorama.prod.ehealthontario.ca/*',
        'https://trpanoramadhir.prod.ehealthontario.ca/*'
      ]
    );
    assert.deepEqual(manifest.host_permissions, [
      'https://nvc-cnv.canada.ca/*'
    ]);
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

test('packaged diagnostics capability is selected by channel', (t) => {
  const root = packageProject(t);
  const version = '1.1.5';
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
  for (const path of [
    'diagnostics/probe.js',
    'diagnostics.html',
    'diagnostics.js'
  ]) {
    const target = join(root, 'apps/extension', path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'diagnostic asset');
  }
  for (const channel of ['alpha', 'prod']) {
    const { names } = buildPackage(root, channel, version);
    const source = execFileSync(
      'python3',
      [
        '-c',
        'import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).read("capability.js").decode())',
        `dist/vaxlink-${channel}-${version}.zip`
      ],
      { cwd: root, encoding: 'utf8' }
    );
    const context = {
      chrome: { storage: { local: { diagnosticsEnabled: true } } }
    };
    runInNewContext(source, context);
    assert.equal(context.VaxLinkDiagnostics.enabled, channel === 'alpha');
    assert.equal(Object.isFrozen(context.VaxLinkDiagnostics), true);
    assert.equal(context.VaxLinkDiagnostics.record(), undefined);
    for (const path of [
      'diagnostics/probe.js',
      'diagnostics.html',
      'diagnostics.js'
    ]) {
      assert.equal(
        names.includes(path),
        channel === 'alpha',
        `${channel}: ${path}`
      );
    }
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

test('package identity reflects the staged runtime files and cannot change after load', (t) => {
  const root = packageProject(t);
  const version = '1.1.6';
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
  const load = (source) => {
    const context = {};
    runInNewContext(source, context);
    assert.equal(Object.isFrozen(context.VaxLinkBuildIdentity), true);
    return context.VaxLinkBuildIdentity;
  };
  const first = load(buildPackage(root, 'alpha', version).identity);
  assert.match(first.id, /^[a-f0-9]{64}$/);
  assert.equal(first.channel, 'alpha');
  assert.equal(
    load(buildPackage(root, 'alpha', version).identity).id,
    first.id
  );
  const content = join(root, 'apps/extension/content.js');
  writeFileSync(
    content,
    readFileSync(content, 'utf8') + '\n// changed runtime source\n'
  );
  assert.notEqual(
    load(buildPackage(root, 'alpha', version).identity).id,
    first.id
  );
  const production = load(buildPackage(root, 'prod', version).identity);
  assert.equal(production.channel, 'prod');
  assert.notEqual(production.id, first.id);
});

test('actual packaged workers exclude production recording even with forged settings and messages', async (t) => {
  const root = packageProject(t);
  const version = '1.1.6';
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
  const sender = {
    id: 'vaxlink-test',
    url: 'chrome-extension://vaxlink-test/popup.html'
  };
  for (const channel of ['alpha', 'prod']) {
    const { names, manifest } = buildPackage(root, channel, version);
    const extracted = join(root, channel);
    execFileSync('python3', [
      '-c',
      'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',
      join(root, `dist/vaxlink-${channel}-${version}.zip`),
      extracted
    ]);
    const harness = createBackgroundHarness(makeTestNvcBundle(), {
      extensionDirectory: extracted,
      manifest,
      storage: {
        vaxlink_diagnostics_enabled: true,
        vaxlink_workflow_mode_v1: 'multiple'
      }
    });
    const start = await harness.sendMessage(
      { action: 'diagnostics.start', enabled: true, channel: 'alpha' },
      sender
    );
    if (channel === 'prod') {
      assert.equal(start.success, false);
      for (const action of ['read', 'export', 'clear', 'stop']) {
        assert.equal(
          (
            await harness.sendMessage(
              { action: `diagnostics.${action}`, sessionId: 'forged' },
              sender
            )
          ).success,
          false
        );
      }
      assert.equal(
        names.some((name) => name.startsWith('diagnostics/')),
        false
      );
      assert.equal(names.includes('diagnostics.html'), false);
      assert.equal(names.includes('diagnostics.js'), false);
      assert.equal(
        manifest.content_scripts
          .flatMap((entry) => entry.js)
          .some((name) => name.startsWith('diagnostics/')),
        false
      );
      assert.equal(harness.sessionData.size, 0);
    } else {
      assert.equal(start.success, true);
      assert.equal(names.includes('diagnostics/panorama.js'), true);
      const recorded = harness.waitForDiagnostic((session) =>
        session?.events?.some(
          (event) => event.code === 'queue' && event.outcome === 'queued'
        )
      );
      const capture = await harness.sendMessage({
        action: 'scannerScanCaptured',
        scan: { rawText: '10TESTLOT', source: 'web-serial' }
      });
      assert.equal(capture.queuedToWorkflow, true);
      await recorded;
      const exported = await harness.sendMessage(
        { action: 'diagnostics.export', sessionId: start.session.id },
        sender
      );
      assert.equal(exported.success, true);
      const events = exported.data.session.events;
      assert.equal(
        new Set(Array.from(events, (event) => event.operationId)).size,
        1
      );
      assert.equal(JSON.stringify(exported).includes('TESTLOT'), false);
      assert.equal(JSON.stringify(exported).includes('rawText'), false);
      assert.equal(
        events.every((event) => Number.isFinite(event.receivedAt)),
        true
      );
      await harness.sendMessage(
        { action: 'diagnostics.stop', sessionId: start.session.id },
        sender
      );
    }
    // The same clinical ingress remains usable in both packages.
    assert.equal(
      (
        await harness.sendMessage({
          action: 'scannerScanCaptured',
          scan: { rawText: '10ANOTHERLOT', source: 'web-serial' }
        })
      ).success,
      true
    );
  }
});
