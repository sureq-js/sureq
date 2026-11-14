// Package-shape checks: publint, then "are the types wrong" on the packed tarball.
// Exits non-zero on any problem.
import { execFileSync } from 'node:child_process';

const bin = (name) => new URL(`../node_modules/.bin/${name}`, import.meta.url).pathname;
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

run(bin('publint'), ['--strict']);
run(bin('attw'), ['--pack', '.', '--profile', 'node16']);
