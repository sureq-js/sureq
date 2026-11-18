import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STORE_CONTRACT_VERSION } from '../../src/store/contract.js';
import { repoRoot } from '../helpers/dev-docs.js';
import { readSkill } from '../helpers/skill-files.js';

/** The body of `export interface Store` in the contract source. */
const storeInterface = (): string => {
  const source = readFileSync(join(repoRoot, 'packages/core/src/store/contract.ts'), 'utf8');
  const start = source.indexOf('export interface Store {');
  const end = source.indexOf('\n}\n', start);
  return start >= 0 && end > start ? source.slice(start, end) : '';
};

/** The method members of `Store`, each with whether it is optional. */
const members = (): { name: string; optional: boolean }[] =>
  [...storeInterface().matchAll(/^ {2}(\w+)(\?)?\(/gm)].map((m) => ({ name: m[1]!, optional: m[2] === '?' }));

/** The required methods of `Store`, in source order. */
const contractMethods = (): string[] => members().filter((m) => !m.optional).map((m) => m.name);

/** The optional methods of `Store` (today only `subscribe`). */
const optionalMethods = (): string[] => members().filter((m) => m.optional).map((m) => m.name);

const page = (): string => readSkill('references/custom-store.md');

describe('skill: custom store', () => {
  it('skill: custom-store.md names every Store method', () => {
    const text = page();
    expect(contractMethods().length).toBeGreaterThan(30);
    expect(optionalMethods()).toEqual(['subscribe']);
    for (const name of [...contractMethods(), ...optionalMethods()]) expect(text, name).toContain(`\`${name}\``);
  });

  it('skill: custom-store.md states the current contract version', () => {
    const text = page();
    expect(text).toContain('`STORE_CONTRACT_VERSION`');
    expect(text).toMatch(new RegExp(`\`STORE_CONTRACT_VERSION\`[^\\n]*\\b${STORE_CONTRACT_VERSION}\\b`));
  });

  it('skill: custom-store.md states the method count', () => {
    const text = page();
    const required = contractMethods().length;
    expect(text).toContain(`${required + optionalMethods().length} methods`);
    expect(text).toContain(`${required} required`);
  });

  it('skill: custom-store.md names the conformance kit entry point', () => {
    expect(page()).toContain('runStoreConformance');
  });

  it('skill: the template path is a real folder', () => {
    const folder = join(repoRoot, 'examples/store-template/src');
    expect(existsSync(folder) && statSync(folder).isDirectory()).toBe(true);
    expect(page()).toMatch(/\]\((\.\.\/)+examples\/store-template(\/src)?\/?\)/);
  });
});
