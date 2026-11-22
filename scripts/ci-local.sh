#!/bin/sh
# Runs every step of every job in .github/workflows/ci.yml, in the same order, on this machine.
# Stops at the first failure. Used by .husky/pre-push, so a push that would fail on GitHub fails here first.
#
# Covered: test, conformance, stress and types (TypeScript 5.0 and 7.0) jobs. It always runs all of them;
# on GitHub a pull request that changes only documentation runs the docs job instead (a subset of these).
# Not covered here: the Node 24 leg of the matrix (this runs on the local Node), and Linux.
# Those still run on GitHub, and a Node or OS difference can still fail there.
#
# Takes about 25 minutes, most of it the stress and conformance suites.

set -e
cd "$(dirname "$0")/.."

step() { echo ""; echo "==> $*"; "$@"; }

echo "ci-local: mirroring .github/workflows/ci.yml"

# test job
step npm run build
step npm run lint
step npm run typecheck
step npm run coverage
step npm test -w store-template
step npm run test:dist
step npm run check:pkg
step npm run check:licenses
step npm run api:check

# conformance job
step npm run test:conformance

# stress job
step npm run test:stress

# types job: each TypeScript version is installed without saving, then the lockfile's versions are restored
for ts in 5.0 7.0; do
  echo ""
  echo "==> types job, TypeScript $ts"
  step npm install --no-save "typescript@$ts"
  step npm run test:types
  step npm run typecheck
  step npm exec -w @sureq/core -- vitest run tests/skill/samples.test.ts
done
step npm ci

echo ""
echo "ci-local: all CI steps passed"
