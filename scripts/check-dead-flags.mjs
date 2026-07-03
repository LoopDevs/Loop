#!/usr/bin/env node
/**
 * Dead-flag detector (hardening C5, 2026-07 plan).
 *
 * Every env var declared in `apps/backend/src/env.ts`'s zod schema
 * must be READ somewhere in backend source outside env.ts — either
 * through the validated `env.<NAME>` object or via a documented live
 * `process.env['<NAME>']` read (the test-reload pattern). A declared-
 * but-never-read var is dead configuration: an operator can set it,
 * the boot validates it, and nothing ever changes behaviour — the
 * worst kind of config drift because it LOOKS wired.
 *
 * Static text analysis in the same spirit as check-openapi-parity:
 * cheap, zero-dependency, and ratcheting via the explicit allowlist
 * below (every entry needs a reason).
 *
 * Runs in `npm run verify` and the CI quality job.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_TS = join(ROOT, 'apps/backend/src/env.ts');
const SRC_DIR = join(ROOT, 'apps/backend/src');

/**
 * Declared vars that are legitimately never read via `env.X` /
 * `process.env` in backend source. Every entry needs a reason —
 * adding one is a review conversation.
 */
const ALLOWLIST = new Map([
  [
    'LOOP_STELLAR_OPERATOR_SECRET_PREVIOUS',
    'Rotation-window slot (A2-652 / docs/runbooks/stellar-operator-rotation.md): the rotation is operator-side signer-weight changes on the Stellar account, so code never reads the previous secret — the var exists so ops has a validated place to park it and logger.ts redacts it.',
  ],
]);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(p, files);
    } else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) {
      files.push(p);
    }
  }
  return files;
}

// 1. Collect declared schema keys: lines shaped `  NAME: z.` or
//    `  NAME: envBoolean` etc. D2 split — the EnvSchema fields moved
//    out of env.ts into per-domain section modules
//    (env/sections/*.ts); each exports a `{ NAME: ..., }` field map
//    that env.ts spreads. Scan those section files for the declarations.
const SECTIONS_DIR = join(SRC_DIR, 'env', 'sections');
const sectionSource = readdirSync(SECTIONS_DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => readFileSync(join(SECTIONS_DIR, f), 'utf8'))
  .join('\n');
const declared = [...sectionSource.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);

if (declared.length < 30) {
  console.error(
    `check-dead-flags: only found ${declared.length} declared env vars — the env.ts parse heuristic broke; fix the script before trusting it.`,
  );
  process.exit(2);
}

// 2. Scan all backend source for reads, EXCEPT env.ts (the composer +
//    parseEnv) and the env/sections/*.ts declaration files — those
//    DECLARE the vars, they don't count as consuming reads.
const envSource = readFileSync(ENV_TS, 'utf8');
const haystacks = walk(SRC_DIR)
  .filter((p) => p !== ENV_TS && !p.includes(join('env', 'sections')))
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');

const dead = [];
for (const name of declared) {
  const readViaEnv = haystacks.includes(`env.${name}`);
  const readViaProcess =
    haystacks.includes(`process.env['${name}']`) ||
    haystacks.includes(`process.env.${name}`) ||
    haystacks.includes(`process.env[\`${name}\`]`);
  // env.ts itself consuming a var in a cross-field boot guard (parseEnv)
  // counts as a real read — those vars exist purely to gate the boot.
  const readInBootGuards = envSource.includes(`parsed.data.${name}`);
  if (!readViaEnv && !readViaProcess && !readInBootGuards && !ALLOWLIST.has(name)) {
    dead.push(name);
  }
}

if (dead.length > 0) {
  console.error(
    `check-dead-flags: ${dead.length} env var(s) declared in env.ts but never read anywhere in apps/backend/src:\n` +
      dead.map((n) => `  - ${n}`).join('\n') +
      `\n\nEither wire the var up, delete it (with the doc updates AGENTS.md requires), or add it to the allowlist in scripts/check-dead-flags.mjs with a reason.`,
  );
  process.exit(1);
}

console.log(
  `check-dead-flags: OK — all ${declared.length} declared env vars are read somewhere (${ALLOWLIST.size} allowlisted).`,
);
