// Type-test harness; more type tests live beside this file
// (`pkg: Queue<Data, Result> infers handler and event payload types`, `pkg: invalid option types fail to compile`).
import { expectTypeOf, test } from 'vitest';
import type * as Sureq from '../../src/index.js';

test('pkg: public types are importable and unknown names fail to compile', () => {
  expectTypeOf<InstanceType<typeof Sureq.SureQError>['code']>().toEqualTypeOf<string>();
  // @ts-expect-error: no such export
  type _Missing = typeof Sureq.DoesNotExist;
});
