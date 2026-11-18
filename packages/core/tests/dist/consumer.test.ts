// Consumer smoke: the packed tarball, unpacked into a fresh project, works for import,
// require and tsc. The tarball is unpacked with tar rather than `npm install`, so no registry is used.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/dev-docs.js';

const root = resolve(import.meta.dirname, '../..');
const tsc = join(repoRoot, 'node_modules/typescript/bin/tsc');

const ADD_AND_RUN = `
  const q = new Queue('smoke', { logger: false });
  q.process(() => 'ran');
  q.on('completed', async ({ result }) => { console.log(result); await q.close(); });
  q.add({ hello: 'world' });
`;

describe('consumer smoke', { timeout: 120_000 }, () => {
  it('pkg: packed tarball works for import, require and tsc', () => {
    const packDir = mkdtempSync(join(tmpdir(), 'sureq-pack-'));
    // npm prints a list (npm 10), one object (npm 11) or an object keyed by package name (npm 12): accept all three
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: root, encoding: 'utf8' })) as unknown;
    const report = (Array.isArray(packed) ? packed[0] : 'filename' in (packed as object) ? packed : Object.values(packed as object)[0]) as { filename: string };
    const tarball = join(packDir, report!.filename);

    const app = mkdtempSync(join(tmpdir(), 'sureq-consumer-'));
    const target = join(app, 'node_modules/@sureq/core');
    mkdirSync(target, { recursive: true });
    execFileSync('tar', ['-xzf', tarball, '-C', target, '--strip-components=1']);
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));

    const run = (args: string[]) => execFileSync(process.execPath, args, { cwd: app, encoding: 'utf8' }).trim();
    expect(run(['--input-type=module', '-e', `import { Queue } from '@sureq/core';${ADD_AND_RUN}`])).toBe('ran');
    expect(run(['--input-type=commonjs', '-e', `const { Queue } = require('@sureq/core');${ADD_AND_RUN}`])).toBe('ran');

    const fixture = readFileSync(join(root, 'tests/fixtures/getting-started.ts'), 'utf8');
    for (const [variant, compilerOptions] of [
      ['node16', { module: 'node16', moduleResolution: 'node16' }],
      ['nodenext', { module: 'nodenext', moduleResolution: 'nodenext' }],
      ['bundler', { module: 'esnext', moduleResolution: 'bundler' }],
    ] as const) {
      const dir = join(app, variant);
      mkdirSync(dir, { recursive: true });
      // .mts so top-level await is ESM under every module setting.
      writeFileSync(join(dir, 'index.mts'), fixture);
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'es2022', lib: ['es2022', 'dom'], types: [], skipLibCheck: false, ...compilerOptions }, files: ['index.mts'] }),
      );
      try {
        execFileSync(process.execPath, [tsc, '-p', dir], { cwd: app, encoding: 'utf8' });
      } catch (e) {
        throw new Error(`tsc failed for ${variant}:\n${(e as { stdout?: string }).stdout ?? String(e)}`);
      }
    }
    copyFileSync(tarball, join(app, 'packed.tgz')); // keep the tarball next to the project for debugging
  });
});
