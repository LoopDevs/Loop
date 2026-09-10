import { defineConfig } from 'tsup';

export default defineConfig({
  // `instrument.ts` must load before `index.ts` via `--import` so OTel patches http/https before requests land
  entry: ['src/index.ts', 'src/instrument.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: ['@loop/shared'],
});
