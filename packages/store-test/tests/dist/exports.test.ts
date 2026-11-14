import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const cwd = resolve(import.meta.dirname, '../..');
const run = (args: string[]) => execFileSync(process.execPath, args, { cwd, encoding: 'utf8' }).trim();

describe('built store-test package', () => {
  it('pkg: built store-test package exports runStoreConformance in ESM and CJS', () => {
    expect(run(['--input-type=module', '-e', "import {runStoreConformance as r, SUITE_VERSION as v} from '@sureq/store-test'; console.log(typeof r, v)"])).toBe('function 1');
    expect(run(['-e', "const {runStoreConformance:r, SUITE_VERSION:v}=require('@sureq/store-test'); console.log(typeof r, v)"])).toBe('function 1');
  });
});
