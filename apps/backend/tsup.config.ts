import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle @loop/shared into the output so no monorepo path issues at runtime
  noExternal: ['@loop/shared'],
});
