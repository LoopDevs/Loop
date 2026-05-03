import { defineConfig } from 'tsup';

export default defineConfig({
  // A2-407: `migrate-cli.ts` is a second entry point for Fly's
  // `[deploy] release_command`. Bundled alongside the main server so
  // the production image ships both without a second build step.
  // `instrument.ts` is a third entry — Sentry's `init()` runs in
  // this file and must be loaded BEFORE `index.ts` via Node's
  // `--import` flag (see Dockerfile CMD + backend `start` script)
  // so OpenTelemetry's auto-instrumentation patches http/https
  // before any request lands. Required by @sentry/hono ≥ 10.51's
  // split-init pattern.
  entry: ['src/index.ts', 'src/migrate-cli.ts', 'src/instrument.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle @loop/shared into the output so no monorepo path issues at runtime
  noExternal: ['@loop/shared'],
});
