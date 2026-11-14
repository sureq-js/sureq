import { expectTypeOf, test } from 'vitest';
import type { JobContext } from '../../src/worker/context.js';

test('unrecoverable: ctx.fail returns never and the fail record is not public', () => {
  expectTypeOf<JobContext['fail']>().returns.toBeNever();
  expectTypeOf<JobContext>().not.toHaveProperty('getFailRecord');
});
