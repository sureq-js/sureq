import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './dev-docs.js';

/** The agent skill's folder, as an absolute path. */
export const skillRoot = join(repoRoot, 'skills/sureq');

/** The skill's Markdown files, relative to `skillRoot`. */
export const skillFiles = ['SKILL.md', 'references/options.md', 'references/recipes.md', 'references/custom-store.md'] as const;

/** Reads a skill file by its path relative to `skillRoot`. */
export const readSkill = (path: string): string => readFileSync(join(skillRoot, path), 'utf8');
