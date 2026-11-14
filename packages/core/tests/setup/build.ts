import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Build dist/ exactly once, before any test file runs. Tests that read dist/ (pkg, smoke,
// the built-output suite) run in parallel, so no test file may rebuild it itself.
export default function setup(): void {
  execFileSync('npm', ['run', 'build'], { stdio: 'ignore', cwd: resolve(import.meta.dirname, '../..') });
}
