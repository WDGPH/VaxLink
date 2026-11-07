import { execFileSync } from 'node:child_process';
import { getFileInfo, check, resolveConfig } from 'prettier';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--base')) {
  console.error('Usage: npm run format:check -- [--base COMMIT]');
  process.exit(2);
}

const git = (...gitArgs) =>
  execFileSync('git', gitArgs, { maxBuffer: 32 * 1024 * 1024 });
try {
  if (!args.length) {
    const settings = git(
      'ls-files',
      '--modified',
      '--others',
      '--exclude-standard',
      '-z'
    )
      .toString()
      .split('\0')
      .filter((file) =>
        /(^|\/)(package\.json|\.prettierignore|\.prettierrc(?:\..*)?|prettier\.config\..*)$/.test(
          file
        )
      );
    if (settings.length) {
      throw new Error(
        `Stage or restore formatting settings first: ${settings.join(', ')}`
      );
    }
  }
  let diffArgs = ['diff', '--cached'];
  if (args.length) {
    const base = git(
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${args[1]}^{tree}`
    )
      .toString()
      .trim();
    diffArgs = ['diff', base, 'HEAD'];
  }
  const files = git(
    ...diffArgs,
    '--name-only',
    '-z',
    '--diff-filter=ACMR',
    '--'
  )
    .toString()
    .split('\0')
    .filter(Boolean);
  let failed = false;
  for (const file of files) {
    const { ignored, inferredParser } = await getFileInfo(file, {
      ignorePath: '.prettierignore'
    });
    if (ignored || !inferredParser) continue;
    const content = git(
      'show',
      args.length ? `HEAD:${file}` : `:${file}`
    ).toString();
    const options = (await resolveConfig(file)) || {};
    if (!(await check(content, { ...options, filepath: file }))) {
      console.error(`Needs formatting: ${file}`);
      failed = true;
    }
  }
  if (failed) {
    console.error(
      'Run npm run format -- <file>, review and stage your changes, then try again.'
    );
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Formatting check failed: ${error.message}`);
  process.exitCode = 1;
}
