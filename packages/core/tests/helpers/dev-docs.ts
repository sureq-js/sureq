import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The planning docs (docs/, ROADMAP.md, FEATURES.md) live only on development machines and are not
 * in the repository. Checks that compare code against them run only where they exist.
 */
export const repoRoot = resolve(import.meta.dirname, '../../../..');
export const devDocsRoot = repoRoot;
export const hasDevDocs = existsSync(join(devDocsRoot, 'docs/features')) && existsSync(join(devDocsRoot, 'ROADMAP.md'));

const walk = (dir: string): string[] =>
  !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (name === 'node_modules') return [];
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
      });

/** The workspace packages and examples, as absolute paths. */
export const workspaceDirs = (): string[] =>
  ['packages', 'examples'].flatMap((top) => readdirSync(join(repoRoot, top)).map((name) => join(repoRoot, top, name)));

/** Every TypeScript file that declares tests: each workspace's tests and the conformance groups. */
export const repoTestFiles = (): string[] => workspaceDirs().flatMap((dir) => [...walk(join(dir, 'tests')), ...walk(join(dir, 'src/groups'))]);
