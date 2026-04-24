import { defineConfig } from 'tsup';

export default defineConfig({
  // A2-407: `migrate-cli.ts` is a second entry point for Fly's
  // `[deploy] release_command`. Bundled alongside the main server so
  // the production image ships both without a second build step.
  entry: ['src/index.ts', 'src/migrate-cli.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle @loop/shared into the output so no monorepo path issues at runtime
  noExternal: ['@loop/shared'],
});
