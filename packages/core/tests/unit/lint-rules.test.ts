import { join } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/dev-docs.js';

const eslint = new ESLint({ cwd: repoRoot });
const restricted = async (importPath: string, file: string) => {
  const [result] = await eslint.lintText(`import * as x from '${importPath}';\nexport { x };\n`, { filePath: join(repoRoot, file) });
  return result!.messages.filter((m) => m.ruleId === 'no-restricted-imports');
};
const memoryFile = 'packages/core/src/store/memory/x.ts';

describe('lint rules', () => {
  it.each(['../../queue/queue.js', '../types.js', '../../job/states.js', '../../../x.js', '@sureq/core', 'fs', 'node:crypto'])(
    'lint: the memory store may import only the contract, capabilities, errors and util: bans %s',
    async (p) => {
      expect(await restricted(p, memoryFile)).not.toHaveLength(0);
    },
  );

  it.each(['../contract.js', '../capabilities.js', '../../errors/catalog.js', '../../util/duration.js', './format.js'])(
    'lint: the memory store may import only the contract, capabilities, errors and util: allows %s',
    async (p) => {
      expect(await restricted(p, memoryFile)).toHaveLength(0);
    },
  );

  it('lint: the memory store rule is scoped to the memory store folder', async () => {
    expect(await restricted('../../queue/queue.js', 'packages/core/src/queue/x.ts')).toHaveLength(0);
  });

  it.each(['packages/core/src/queue/x.ts', 'packages/core/src/store/memory/x.ts'])('lint: %s may not import node: built-ins', async (file) => {
    expect(await restricted('node:crypto', file)).not.toHaveLength(0);
  });

  it('lint: the Node platform module may import node: built-ins', async () => {
    expect(await restricted('node:crypto', 'packages/core/src/platform/node.ts')).toHaveLength(0);
  });
});
