// Fails when a published package has a licence outside the allow-list, a runtime dependency, or a peer
// dependency outside @sureq. The published packages have no runtime dependencies, so there is nothing
// installed to scan; this keeps it that way. Dev dependencies are never published and are not checked.
//
//   node scripts/check-licenses.mjs [packages-dir]
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ALLOWED = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause']);
const dir = process.argv[2] ? pathToFileURL(`${resolve(process.argv[2])}/`) : new URL('../packages/', import.meta.url);
let checked = 0;
const problems = readdirSync(dir).flatMap((name) => {
  const pkg = JSON.parse(readFileSync(new URL(`${name}/package.json`, dir), 'utf8'));
  if (pkg.private) return [];
  checked++;
  return [
    ...(ALLOWED.has(pkg.license) ? [] : [`${pkg.name}: licence ${pkg.license} is not allowed`]),
    ...Object.keys(pkg.dependencies ?? {}).map((d) => `${pkg.name}: runtime dependency ${d} is not allowed`),
    ...Object.keys(pkg.peerDependencies ?? {})
      .filter((d) => !d.startsWith('@sureq/'))
      .map((d) => `${pkg.name}: peer dependency ${d} is not allowed`),
  ];
});
if (checked === 0) problems.push(`no published package found in ${dir.pathname}`);
if (problems.length > 0) {
  console.error(`check-licenses:\n${problems.join('\n')}`);
  process.exit(1);
}
