// Fails when Node-only APIs appear outside the Node platform module.
//
//   node scripts/check-neutral.mjs <dir>...
//
// Scans every .ts/.mts/.cts/.js/.mjs/.cjs file under each dir (skipping node_modules and .map files)
// and prints `file:line: text` for each hit, exiting 1 if there are any. Files whose path contains
// `platform/node` (source) or `platform-node` (the bundled chunk) are skipped.
//
// Flagged: a `node:` specifier or a bare Node built-in (`'fs'`, `'os'`, ...) in import/export/require,
// and the identifiers `Buffer`, `process.`, `require(`, `__dirname`, `__filename`, `setImmediate`.
// A `require('x')` with a literal specifier is judged by its specifier alone, because bundled CJS
// output loads its own chunks and peer packages that way.
//
// This is a regex scan, not a parser. Comments are blanked first, and string contents are blanked
// before the identifier checks, so mentions in comments and strings are not reported. Limits:
// regex literals containing quotes, slashes or backticks can mislead the comment/string masking
// for the rest of that line; template literals are treated as one string, so code inside `${...}`
// is not checked; and a member such as `x.Buffer` or `{ process: 1 }` is still reported.
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';

const builtins = new Set(builtinModules);
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"]+)\1/g;
const IDENTIFIERS = [
  /\bBuffer\b/,
  /\bprocess\s*\./,
  /\brequire\s*\((?!\s*['"])/,
  /\b__dirname\b/,
  /\b__filename\b/,
  /\bsetImmediate\b/,
];

/** Two copies of `src` with newlines kept: comments blanked, and comments plus string contents blanked. */
function mask(src) {
  let code = '';
  let bare = '';
  let state = 'code'; // 'code', 'line', 'block', or the quote character of the open string
  const both = (ch) => {
    code += ch;
    bare += ch;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const blank = c === '\n' ? '\n' : ' ';
    if (state === 'code') {
      if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
        state = src[i + 1] === '/' ? 'line' : 'block';
        both(' ');
      } else {
        if (c === "'" || c === '"' || c === '`') state = c;
        both(c);
      }
    } else if (state === 'line' || state === 'block') {
      if (state === 'line' && c === '\n') state = 'code';
      if (state === 'block' && c === '*' && src[i + 1] === '/') {
        both('  ');
        i++;
        state = 'code';
      } else {
        both(blank);
      }
    } else if (c === '\\' && i + 1 < src.length) {
      // an escape inside a string: keep it in `code`, blank it in `bare`
      code += c + src[i + 1];
      bare += ' ' + (src[i + 1] === '\n' ? '\n' : ' ');
      i++;
    } else {
      // a newline ends an unterminated quote string, so one stray quote spoils at most a line
      if (c === state || (c === '\n' && state !== '`')) state = 'code';
      code += c;
      bare += c === '\n' || state === 'code' ? c : ' ';
    }
  }
  return { code, bare };
}

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') yield* files(path);
    } else if (/\.[cm]?[jt]s$/.test(entry.name)) {
      yield path;
    }
  }
}

const hits = [];
for (const dir of process.argv.slice(2)) {
  for (const file of files(dir)) {
    const rel = relative(dir, file).split(/[\\/]/).join('/');
    if (rel.includes('platform/node') || rel.includes('platform-node')) continue;
    const text = readFileSync(file, 'utf8');
    const { code, bare } = mask(text);
    const lines = text.split('\n');
    const codeLines = code.split('\n');
    const bareLines = bare.split('\n');
    lines.forEach((line, i) => {
      const nodeSpecifier = [...codeLines[i].matchAll(SPECIFIER)].some(([, , spec]) => spec.startsWith('node:') || builtins.has(spec));
      if (nodeSpecifier || IDENTIFIERS.some((re) => re.test(bareLines[i]))) hits.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
}

if (hits.length > 0) {
  console.log(hits.join('\n'));
  console.log(`\n${hits.length} Node-only API use(s) outside the platform layer.`);
  process.exit(1);
}
