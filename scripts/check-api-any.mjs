// Fails when a committed API report under etc/ uses `any` as a type: the public types must not.
//
//   node scripts/check-api-any.mjs
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../etc/', import.meta.url);
const reports = readdirSync(dir).filter((f) => f.endsWith('.api.md'));
if (reports.length === 0) {
  console.error('check-api-any: no API reports in etc/; run `npm run api:update`');
  process.exit(1);
}
const hits = reports.flatMap((f) =>
  readFileSync(new URL(f, dir), 'utf8').split('\n').flatMap((line, i) => (/\bany\b/.test(line) ? [`etc/${f}:${i + 1}: ${line.trim()}`] : [])),
);
if (hits.length > 0) {
  console.error(`check-api-any: the public API uses \`any\`; give these a real type (or \`unknown\`):\n${hits.join('\n')}`);
  process.exit(1);
}
