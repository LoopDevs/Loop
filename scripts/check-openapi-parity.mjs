#!/usr/bin/env node
/**
 * check-openapi-parity.mjs — route-mount ↔ OpenAPI-registration parity.
 *
 * Codifies the review-finding class behind the 2026-06 audit's spec
 * bugs (admin endpoints documenting 403 where `requireAdmin` returns
 * 404 by design, missing 429s, spec/handler drift): instead of
 * patching each finding one-off, statically cross-check EVERY route
 * mount against EVERY OpenAPI registration on every `npm run verify`
 * / CI quality run.
 *
 * Sources scanned (no execution — pure static text analysis, so the
 * gate runs without a DB or env):
 *   - mounts:        apps/backend/src/app.ts +
 *                    apps/backend/src/routes/**.ts
 *                    (`app.get/post/put/delete('<path>', …)`)
 *   - registrations: apps/backend/src/openapi.ts +
 *                    apps/backend/src/openapi/*.ts
 *                    (`registry.registerPath({ method, path, responses })`)
 *
 * Rules:
 *   missing-registration  every mounted route must have a registration
 *   orphan-registration   every registration must have a mount
 *   missing-429           a mount wrapped in rateLimit() must declare 429
 *   admin-missing-404     /api/admin/* must declare 404 — `requireAdmin`
 *                         masks non-admin access as 404 (see
 *                         src/auth/require-admin.ts), so every admin
 *                         path can return it
 *   admin-403             /api/admin/* must NOT declare 403 — nothing on
 *                         the admin middleware stack (requireAuth 401,
 *                         requireAdmin 404, step-up 401/503, kill-switch
 *                         503) emits 403; a declared 403 documents a
 *                         response that cannot happen
 *
 * Allowlist (`scripts/openapi-parity-allowlist.json`): violations the
 * branch deliberately does not fix yet. Entries match on
 * `{ rule, method, path }` and require a `reason`. Stale entries (no
 * longer violated) FAIL the run so the list only ever ratchets down.
 *
 * Exit codes: 0 clean (allowlisted hits reported as warnings),
 * 1 unallowlisted violations or stale allowlist entries, 2 parse error.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND_SRC = path.join(ROOT, 'apps', 'backend', 'src');
const ALLOWLIST_PATH = path.join(ROOT, 'scripts', 'openapi-parity-allowlist.json');

/** Recursively list .ts files under a directory, skipping tests. */
function tsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('__tests__')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * From `source[openParen] === '('`, return the index just past the
 * matching close paren. String- and comment-aware so parens inside
 * literals/comments don't unbalance the scan.
 */
function matchParen(source, openParen, open = '(', close = ')') {
  let depth = 0;
  let i = openParen;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
    } else if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
    } else if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  throw new Error(`unbalanced ${open}${close} starting at index ${openParen}`);
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/** Hono `:param` → OpenAPI `{param}`. */
function honoToOpenApi(p) {
  return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

// ── Collect route mounts ─────────────────────────────────────────────────────
const mountFiles = [path.join(BACKEND_SRC, 'app.ts'), ...tsFiles(path.join(BACKEND_SRC, 'routes'))];
const mounts = [];
for (const file of mountFiles) {
  const source = readFileSync(file, 'utf8');
  const re = /\bapp\.(get|post|put|delete)\s*\(/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const openParen = m.index + m[0].length - 1;
    const end = matchParen(source, openParen);
    const args = source.slice(openParen + 1, end - 1);
    const pathMatch = args.match(/^\s*['"`]([^'"`]+)['"`]/);
    if (pathMatch === null || !pathMatch[1].startsWith('/')) continue;
    mounts.push({
      method: m[1].toUpperCase(),
      path: honoToOpenApi(pathMatch[1]),
      hasRateLimit: /\brateLimit\s*\(/.test(args),
      where: `${path.relative(ROOT, file)}:${lineOf(source, m.index)}`,
    });
  }
}

// ── Collect OpenAPI registrations ────────────────────────────────────────────
const specFiles = [
  path.join(BACKEND_SRC, 'openapi.ts'),
  ...tsFiles(path.join(BACKEND_SRC, 'openapi')),
];
const registrations = [];
for (const file of specFiles) {
  const source = readFileSync(file, 'utf8');
  const re = /\bregisterPath\s*\(/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const openParen = m.index + m[0].length - 1;
    const end = matchParen(source, openParen);
    const body = source.slice(openParen + 1, end - 1);
    const methodMatch = body.match(/\bmethod:\s*['"](\w+)['"]/);
    const pathMatch = body.match(/\bpath:\s*['"]([^'"]+)['"]/);
    if (methodMatch === null || pathMatch === null) {
      console.error(
        `PARSE ERROR: registerPath without literal method/path at ${path.relative(ROOT, file)}:${lineOf(source, m.index)}`,
      );
      process.exit(2);
    }
    const responsesIdx = body.search(/\bresponses:\s*\{/);
    const statuses = new Set();
    if (responsesIdx !== -1) {
      const braceIdx = body.indexOf('{', responsesIdx);
      const responsesEnd = matchParen(body, braceIdx, '{', '}');
      const responsesBlock = body.slice(braceIdx, responsesEnd);
      // Only object-literal keys at any depth: `200: {` / `'404': {`.
      for (const s of responsesBlock.matchAll(/[{,]\s*'?(\d{3})'?\s*:/g)) {
        statuses.add(Number(s[1]));
      }
    }
    registrations.push({
      method: methodMatch[1].toUpperCase(),
      path: pathMatch[1],
      statuses,
      where: `${path.relative(ROOT, file)}:${lineOf(source, m.index)}`,
    });
  }
}

// ── Cross-check ──────────────────────────────────────────────────────────────
const regByKey = new Map(registrations.map((r) => [`${r.method} ${r.path}`, r]));
const mountByKey = new Map(mounts.map((r) => [`${r.method} ${r.path}`, r]));
const violations = [];

for (const mount of mounts) {
  const key = `${mount.method} ${mount.path}`;
  const reg = regByKey.get(key);
  if (reg === undefined) {
    violations.push({
      rule: 'missing-registration',
      method: mount.method,
      path: mount.path,
      detail: `mounted at ${mount.where} but never registered in openapi`,
    });
    continue;
  }
  if (mount.hasRateLimit && !reg.statuses.has(429)) {
    violations.push({
      rule: 'missing-429',
      method: mount.method,
      path: mount.path,
      detail: `mount at ${mount.where} is rate-limited but ${reg.where} declares no 429`,
    });
  }
}

for (const reg of registrations) {
  const key = `${reg.method} ${reg.path}`;
  if (!mountByKey.has(key)) {
    violations.push({
      rule: 'orphan-registration',
      method: reg.method,
      path: reg.path,
      detail: `registered at ${reg.where} but no matching route mount exists`,
    });
    continue;
  }
  if (reg.path.startsWith('/api/admin')) {
    if (!reg.statuses.has(404)) {
      violations.push({
        rule: 'admin-missing-404',
        method: reg.method,
        path: reg.path,
        detail: `${reg.where}: requireAdmin returns 404 for non-admins by design — every /api/admin path must declare it`,
      });
    }
    if (reg.statuses.has(403)) {
      violations.push({
        rule: 'admin-403',
        method: reg.method,
        path: reg.path,
        detail: `${reg.where}: declares 403, but nothing on the admin stack emits 403 (requireAdmin masks as 404)`,
      });
    }
  }
}

// ── Allowlist ────────────────────────────────────────────────────────────────
const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
const usedEntries = new Set();
const failures = [];
const warnings = [];
for (const v of violations) {
  const entry = allowlist.find(
    (e) => e.rule === v.rule && e.method === v.method && e.path === v.path,
  );
  if (entry !== undefined) {
    usedEntries.add(entry);
    warnings.push(v);
  } else {
    failures.push(v);
  }
}
const stale = allowlist.filter((e) => !usedEntries.has(e));

// ── Report ───────────────────────────────────────────────────────────────────
console.log(
  `openapi-parity: ${mounts.length} mounts, ${registrations.length} registrations checked`,
);
if (warnings.length > 0) {
  console.log(`\n${warnings.length} allowlisted violation(s) (ratchet — fix and remove):`);
  for (const v of warnings) console.log(`  ~ [${v.rule}] ${v.method} ${v.path}`);
}
if (failures.length > 0) {
  console.error(`\nFAIL — ${failures.length} violation(s):`);
  for (const v of failures) {
    console.error(`  ✗ [${v.rule}] ${v.method} ${v.path}\n      ${v.detail}`);
  }
}
if (stale.length > 0) {
  console.error(
    `\nFAIL — ${stale.length} stale allowlist entr(y/ies) — remove from ${path.relative(ROOT, ALLOWLIST_PATH)}:`,
  );
  for (const e of stale) console.error(`  ✗ [${e.rule}] ${e.method} ${e.path}`);
}
if (failures.length > 0 || stale.length > 0) {
  console.error(
    '\nFix the spec/mount (see scripts/check-openapi-parity.mjs header for the rules) or,\n' +
      'for a violation class deliberately deferred, add { rule, method, path, reason } to\n' +
      'scripts/openapi-parity-allowlist.json.',
  );
  process.exit(1);
}
console.log('openapi-parity: OK');
