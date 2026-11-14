import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const scan = (...dirs: string[]) =>
  spawnSync(process.execPath, [join(root, 'scripts/check-neutral.mjs'), ...dirs], { encoding: 'utf8' });

describe('runtime: neutral output', () => {
  it('runtime: built dist contains no node: specifier outside platform/node', () => {
    const r = scan(join(root, 'packages/core/dist'));
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('runtime: the scan catches a planted violation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sureq-neutral-'));
    try {
      writeFileSync(join(dir, 'side-effect.ts'), "import 'node:fs';\n");
      writeFileSync(join(dir, 'bare.ts'), "import { readFileSync } from 'fs';\n");
      writeFileSync(join(dir, 'buffer.ts'), "export const b = Buffer.from('x');\n");
      writeFileSync(join(dir, 'env.ts'), "export const e = process.env;\n");
      writeFileSync(join(dir, 'clean.ts'), "// process.env and Buffer.from( in a comment\nexport const s = 'process.env Buffer setImmediate';\n");
      mkdirSync(join(dir, 'platform'));
      writeFileSync(join(dir, 'platform/node.ts'), "import { hostname } from 'node:os';\n");
      const r = scan(dir);
      expect(r.stdout).not.toContain('node.ts');
      expect(r.status).not.toBe(0);
      for (const f of ['side-effect.ts:1', 'bare.ts:1', 'buffer.ts:1', 'env.ts:1']) expect(r.stdout).toContain(f);
      expect(r.stdout).not.toContain('clean.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
