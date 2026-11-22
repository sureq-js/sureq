import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Build both packages' dist/ once, before any test file runs: the Jest smoke run loads the built
// @sureq/core and @sureq/store-test, since Jest runs plain CommonJS. Core is built first, because the
// store-test build reads its types.
export default function setup(): void {
  execFileSync('npm', ['run', 'build', '-w', '@sureq/core', '-w', '@sureq/store-test'], {
    stdio: 'ignore',
    cwd: resolve(import.meta.dirname, '../../../..'),
  });
}
