import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const checker = join(root, 'scripts/check-commit-title.js');

test('CLI accepts release/maintenance titles and rejects ignored squash subjects', (t) => {
  for (const title of [
    'fix: preserve vaccine lot numbers', 'feat(scanner): add scan capture',
    'fix(scanner)!: change framing', 'feat!: change the workflow',
    'ci: check packaging', 'docs: explain setup',
    'chore(alpha): release 1.1.6-alpha', 'revert: undo a workflow change'
  ]) {
    assert.equal(spawnSync(process.execPath, [checker, title]).status, 0, title);
  }
  for (const title of [
    'Restore Alpha releases and improve release integrity (#62)',
    '', 'fix:', 'fix:   ', 'Fix: wrong case', 'fix(scope: malformed',
    'fix: first line\nsecond line', 'fix: trailing newline\n'
  ]) {
    const result = spawnSync(process.execPath, [checker, title], { encoding: 'utf8' });
    assert.equal(result.status, 1, JSON.stringify(title));
    assert.match(result.stderr, /Conventional Commit title/);
  }
  const temp = mkdtempSync(join(tmpdir(), 'vaxlink-message-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const message = join(temp, 'message with spaces.txt');
  writeFileSync(message, 'fix: handle scanner framing\r\n\r\nDetails and rationale.\r\n');
  assert.equal(spawnSync(process.execPath, [checker, '--file', message]).status, 0);
});

test('installed hook prevents an invalid commit, accepts a valid one, and allows Git merges', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'vaxlink-hook-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  for (const folder of ['scripts', '.githooks']) mkdirSync(join(temp, folder));
  cpSync(checker, join(temp, 'scripts/check-commit-title.js'));
  cpSync(join(root, '.githooks/commit-msg'), join(temp, '.githooks/commit-msg'));
  writeFileSync(join(temp, 'package.json'), '{"type":"module"}');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Hook test', GIT_COMMITTER_NAME: 'Hook test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const git = (...args) => spawnSync('git', ['-c', 'commit.gpgsign=false', ...args],
    { cwd: temp, env, encoding: 'utf8' });
  const ok = (...args) => {
    const result = git(...args);
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  ok('init', '-b', 'main');
  ok('config', 'core.hooksPath', '.githooks');
  const rejected = git('commit', '--allow-empty', '-m', 'Restore Alpha releases');
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Conventional Commit title/);
  assert.notEqual(git('rev-parse', '--verify', 'HEAD').status, 0, 'invalid commit must not exist');
  ok('commit', '--allow-empty', '-m', 'ci: enable commit checks');
  ok('switch', '-c', 'feature');
  ok('commit', '--allow-empty', '-m', 'fix: exercise feature commits');
  ok('switch', 'main');
  ok('commit', '--allow-empty', '-m', 'docs: exercise main commits');
  ok('merge', '--no-ff', 'feature');
  assert.equal(ok('log', '-1', '--format=%P').stdout.trim().split(' ').length, 2);
});
