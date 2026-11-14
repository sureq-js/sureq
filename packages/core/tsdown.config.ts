import { defineConfig } from 'tsdown';

// Two entries (the package and its producer subpath) sharing chunks, ESM + CJS, .d.ts + .d.cts, sourcemaps, Node 22 target.
export default defineConfig({
  entry: ['src/index.ts', 'src/producer.ts'],
  format: ['esm', 'cjs'],
  platform: 'node',
  target: 'node22',
  // "type": "module" package: ESM → .js/.d.ts, CJS → .cjs/.d.cts, matching the exports map.
  fixedExtension: false,
  // Declarations leave out everything tagged @internal: it stays usable from src (tests) but is not public.
  dts: { compilerOptions: { stripInternal: true } },
  sourcemap: true,
  clean: true,
  // The Node platform is the only module allowed Node built-ins; its own chunk lets the neutral-output scan skip it by name.
  outputOptions: { codeSplitting: { groups: [{ name: 'platform-node', test: /[\\/]src[\\/]platform[\\/]node\.ts$/ }] } },
});
