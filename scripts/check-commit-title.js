import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
let title;
if (args.length === 2 && args[0] === '--file') {
  title = readFileSync(args[1], 'utf8').split(/\r?\n/, 1)[0];
} else if (args.length === 1) {
  title = args[0];
} else {
  console.error(
    'Usage: node scripts/check-commit-title.js <title> | --file <commit-message-file>'
  );
  process.exit(2);
}

const conventional =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([^()\r\n]+\))?!?: \S[^\r\n]*$/;
if (!conventional.test(title)) {
  console.error(
    'Use a Conventional Commit title: type(scope): description (scope is optional).'
  );
  console.error(
    'Types: build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test.'
  );
  console.error(
    'Examples: "fix: preserve vaccine lot numbers" or "ci: check release workflows".'
  );
  process.exitCode = 1;
}
