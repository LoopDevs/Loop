import { cpSync, existsSync } from 'node:fs';
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
  // A4-023: copy drizzle migrations into dist alongside the bundled JS
  // so `node dist/migrate-cli.js` resolves `./migrations` relative to
  // the running script (Drizzle's `migrationsFolder` is path-based).
  // The Dockerfile previously did the copy in the production stage,
  // but a local `npm run build` then `node dist/migrate-cli.js` would
  // throw `_journal.json not found`. Doing the copy here keeps prod
  // and local-dev runtimes symmetric and gives CI a single artifact
  // to assert against.
  onSuccess: async () => {
    const src = 'src/db/migrations';
    const dest = 'dist/migrations';
    if (!existsSync(src)) {
      throw new Error(`tsup onSuccess: migrations source ${src} missing`);
    }
    cpSync(src, dest, { recursive: true });
  },
});
