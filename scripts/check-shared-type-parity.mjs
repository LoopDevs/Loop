#!/usr/bin/env node
/**
 * check-shared-type-parity.mjs — ADR 019 contract-parity detector.
 *
 * Flags exported `interface` / `type` / `enum` declarations whose NAME
 * appears on BOTH sides of the web↔backend boundary:
 *
 *   apps/web/app/services/**   (the web API-client layer)
 *   apps/backend/src/**        (the API itself)
 *
 * The same name declared on both sides almost always means the same
 * wire shape has been hand-copied instead of living in @loop/shared —
 * the exact drift class consolidated in the ADR 019 contract-parity
 * remediation (favorites, recently-purchased, public loop-assets /
 * flywheel-stats, SocialLoginResponse, cashback-rate responses, …).
 * Re-exports (`export type { X } from '@loop/shared'`) do NOT count —
 * only declarations do, so the approved "re-export for existing import
 * sites" pattern stays green.
 *
 * Allowlist: scripts/shared-type-parity-allowlist.json
 *   - `distinct`      — same name, legitimately different shapes
 *                       (e.g. backend-internal bigint result vs web
 *                       string wire view). Justify each.
 *   - `grandfathered` — known pre-existing duplicates pending
 *                       consolidation. RATCHET: never add to this
 *                       list — move the type to packages/shared
 *                       instead. Entries are removed as they get
 *                       consolidated.
 *
 * Stale allowlist entries (name no longer collides) are an error too,
 * so the ratchet only tightens.
 *
 * Usage: node scripts/check-shared-type-parity.mjs   (exit 1 on drift)
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'apps/web/app/services');
const BACKEND_DIR = path.join(ROOT, 'apps/backend/src');
const ALLOWLIST_PATH = path.join(ROOT, 'scripts/shared-type-parity-allowlist.json');

const SKIP_DIRS = new Set(['node_modules', '__tests__', 'proto', 'dist', 'build']);
const SKIP_FILE_RE = /(\.test\.ts|\.spec\.ts|\.d\.ts)$/;
// Declarations only — `export type { X }` re-exports intentionally do
// not match (the brace fails the identifier character class).
const DECL_RE = /^export\s+(?:interface|type|enum|const\s+enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;

/** @returns {string[]} absolute paths of .ts files under dir */
function tsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...tsFiles(path.join(dir, entry.name)));
    } else if (entry.name.endsWith('.ts') && !SKIP_FILE_RE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** @returns {Map<string, string[]>} declared exported type name → rel file paths */
function declaredTypes(dir) {
  const byName = new Map();
  for (const file of tsFiles(dir)) {
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(DECL_RE)) {
      const name = match[1];
      const rel = path.relative(ROOT, file);
      const files = byName.get(name) ?? [];
      if (!files.includes(rel)) files.push(rel);
      byName.set(name, files);
    }
  }
  return byName;
}

const allowlistRaw = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
const allowed = new Map([
  ...Object.entries(allowlistRaw.distinct ?? {}),
  ...Object.entries(allowlistRaw.grandfathered ?? {}),
]);

const web = declaredTypes(WEB_DIR);
const backend = declaredTypes(BACKEND_DIR);

const collisions = [...web.keys()].filter((name) => backend.has(name)).sort();

const violations = collisions.filter((name) => !allowed.has(name));
const stale = [...allowed.keys()].filter((name) => !collisions.includes(name)).sort();

let failed = false;

if (violations.length > 0) {
  failed = true;
  console.error(
    `\nADR 019 contract-parity violation — ${violations.length} exported type name(s) ` +
      'declared on BOTH sides of the web↔backend boundary:\n',
  );
  for (const name of violations) {
    console.error(`  ${name}`);
    for (const f of web.get(name)) console.error(`    web:     ${f}`);
    for (const f of backend.get(name)) console.error(`    backend: ${f}`);
  }
  console.error(
    '\nFix: move the declaration to packages/shared/ (one source of truth) and\n' +
      'have both sides import it — `export type { X } from "@loop/shared"` keeps\n' +
      'existing import sites resolving. Only if the two types are LEGITIMATELY\n' +
      'different shapes, add the name to scripts/shared-type-parity-allowlist.json\n' +
      'under "distinct" with a justification. Do NOT add to "grandfathered".',
  );
}

if (stale.length > 0) {
  failed = true;
  console.error(
    `\nStale allowlist entr${stale.length === 1 ? 'y' : 'ies'} in ` +
      'scripts/shared-type-parity-allowlist.json (name no longer declared on both\n' +
      'sides — remove it so the ratchet stays tight):\n',
  );
  for (const name of stale) console.error(`  ${name}`);
}

if (failed) process.exit(1);

console.log(
  `shared-type-parity: OK — ${collisions.length} allowlisted collision(s), ` +
    `${web.size} web / ${backend.size} backend exported type names scanned.`,
);
