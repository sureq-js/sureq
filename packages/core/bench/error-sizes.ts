// serialize realistic errors at the default caps and report their size.
// Run: npx tsx bench/error-sizes.ts
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { serializeError } from '../src/serialize/error.js';

const opts = { maxErrorBytes: 16_384, storeStacks: true };

async function samples(): Promise<Array<[string, unknown]>> {
  const out: Array<[string, unknown]> = [];
  const refused = await new Promise<Error>((resolve) => connect(1, '127.0.0.1').on('error', resolve));
  out.push(['ECONNREFUSED wrapped in TypeError', new TypeError('fetch failed', { cause: refused })]);
  out.push(['fs ENOENT', await readFile('/no/such/file').catch((e: unknown) => e)]);
  out.push(['AggregateError of three', new AggregateError([new RangeError('a'), new TypeError('b'), new SyntaxError('c')], 'all failed')]);
  try {
    JSON.parse('{bad');
  } catch (e) {
    out.push(['JSON.parse SyntaxError', e]);
  }
  let chain: Error = new Error('root cause');
  for (let i = 1; i <= 10; i++) chain = new Error(`wrapper ${i}`, { cause: chain });
  out.push(['10-deep wrapped cause chain', chain]);
  return out;
}

for (const [label, err] of await samples()) {
  const s = serializeError(err, opts);
  console.log(`${label.padEnd(36)} ${String(Buffer.byteLength(JSON.stringify(s))).padStart(6)} bytes  truncated=${s.truncated === true}`);
}
