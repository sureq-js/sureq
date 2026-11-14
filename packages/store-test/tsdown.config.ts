import { defineConfig } from 'tsdown';

// One entry, ESM + CJS, .d.ts + .d.cts, sourcemaps, Node 22 target.
export default defineConfig({
  entry: ['src/index.ts'],
  tsconfig: 'tsconfig.build.json',
  format: ['esm', 'cjs'],
  platform: 'node',
  target: 'node22',
  // "type": "module" package: ESM → .js/.d.ts, CJS → .cjs/.d.cts, matching the exports map.
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  clean: true,
});
