#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

/**
 * A3-029 / audit-2026-06-15 CF-04: make the dependency-audit policy explicit
 * per severity tier.
 *
 * `critical` always fails hard. For `high` and `moderate` we pin an
 * explicitly-justified accepted set: the gate fails on any advisory at that
 * tier that is NOT accepted (a genuinely new finding) AND on any accepted
 * entry that is no longer observed (so the allowlist can't rot). A package's
 * advisory tier can shift over time (the esbuild dev-server advisory was
 * re-rated moderate→high on 2026-06; esbuild + drizzle-kit moved tiers), so an
 * entry lives in whichever map matches its CURRENT observed severity.
 *
 * The accepted-high set below is the esbuild dev-server / build-toolchain
 * advisory chain. It is dev/build-only — never in the production runtime
 * (the backend ships compiled `dist`; the web client is built ahead of
 * deploy), so the dev-server-SSRF / NPM_CONFIG_REGISTRY-RCE vectors are not
 * reachable by any deployed surface. Fixes are semver-major (vite, esbuild,
 * drizzle-kit, @react-router/dev) or carry a non-major bump (tsx) tracked as
 * a follow-up; we accept the chain explicitly rather than block every merge.
 */
const ACCEPTED_HIGH_VULNS = new Map([
  [
    'esbuild',
    'GHSA-67mh-4wv8-2f99 + GHSA-gv7w-rqvm-qjhr (esbuild <=0.28.0): dev-server lets any site send requests to it / Deno NPM_CONFIG_REGISTRY RCE. Dev/build-time only — esbuild is never in the deployed runtime (backend runs compiled dist; web is prebuilt). Fix is semver-major; accepted.',
  ],
  [
    'vite',
    'Transitive via esbuild (build/dev tool only, not in the deployed runtime). Fix is semver-major; tracked behind the esbuild bump.',
  ],
  [
    'vite-node',
    'Transitive via vite→esbuild (vitest runner, dev/test only). Not in any deployed surface.',
  ],
  [
    'tsx',
    'Transitive via esbuild (used as the backend dev/test runner via tsx watch). Not in the deployed runtime; a non-major fix exists and is the tracked follow-up.',
  ],
  [
    'tsup',
    'Transitive via esbuild (build tool only). Fix is semver-major; not in the deployed runtime.',
  ],
  [
    'drizzle-kit',
    'Transitive via the deprecated esbuild-kit/esbuild chain (migration-generation CLI, dev only — never imported by the runtime). Re-rated moderate→high with the esbuild advisory; audited major upgrade deferred.',
  ],
  [
    '@react-router/dev',
    'Transitive via vite-node→esbuild (the React Router dev/build toolchain). Not in the deployed runtime; fix is semver-major, tracked behind the esbuild bump.',
  ],
]);

const ACCEPTED_MODERATE_VULNS = new Map([
  [
    '@esbuild-kit/core-utils',
    'Transitive via drizzle-kit deprecated loader chain; fix requires a major drizzle-kit move.',
  ],
  [
    '@esbuild-kit/esm-loader',
    'Transitive via drizzle-kit deprecated loader chain; fix requires a major drizzle-kit move.',
  ],
  [
    'hono',
    'Three moderate advisories on hono <=4.12.17: (a) CSS Declaration Injection via Style Object Values in JSX SSR — Loop does not use Hono JSX SSR; web SSR runs via React Router v7. (b) Improper NumericDate-claim validation in Hono JWT verify() — Loop uses its own verifier at apps/backend/src/auth/tokens.ts with explicit iat/exp/iss/aud checks; Hono JWT is never imported. (c) Cache Middleware Vary-header gap — Loop does not mount Hono Cache Middleware. None of the three reach an exploitable code path. The openapi layer is @asteasolutions/zod-to-openapi (peer: zod ^4 only — no hono constraint), so hono is bumpable; the deferral is a deliberate choice not to take a minor hono bump mid-audit, revisit on the next dependency sweep.',
  ],
]);

function runAuditJson() {
  try {
    return execFileSync('npm', ['audit', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'stdout' in error &&
      typeof error.stdout === 'string'
    ) {
      return error.stdout;
    }
    throw error;
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const raw = runAuditJson();
const report = JSON.parse(raw);
const metadata = report.metadata?.vulnerabilities;
if (metadata === undefined) {
  fail('npm audit output missing metadata.vulnerabilities');
}

// `critical` is never accepted — always a hard fail.
if ((metadata.critical ?? 0) > 0) {
  fail(
    `npm audit policy failed: critical=${metadata.critical ?? 0}. Critical advisories are never auto-accepted.`,
  );
}

const vulnerabilities = report.vulnerabilities ?? {};
const observedAt = (severity) =>
  Object.entries(vulnerabilities)
    .filter(([, vuln]) => vuln?.severity === severity)
    .map(([name]) => name)
    .sort();

/**
 * Checks one severity tier's observed advisories against its accepted map:
 * fails on any observed-but-unaccepted (a new finding) and any
 * accepted-but-absent (a stale allowlist entry). Returns the sorted observed
 * list for the success summary.
 */
function reconcileTier(severity, acceptedMap) {
  const observed = observedAt(severity);
  const unexpected = observed.filter((name) => !acceptedMap.has(name));
  const stale = [...acceptedMap.keys()].sort().filter((name) => !observed.includes(name));
  if (unexpected.length > 0 || stale.length > 0) {
    const lines = [`npm audit policy mismatch (${severity}).`];
    if (unexpected.length > 0)
      lines.push(`Unexpected ${severity} advisories: ${unexpected.join(', ')}`);
    if (stale.length > 0)
      lines.push(`Accepted-but-absent ${severity} advisories: ${stale.join(', ')}`);
    lines.push('Review `scripts/check-audit-policy.mjs` and docs/standards.md §15.');
    fail(lines.join('\n'));
  }
  return observed;
}

const observedHighs = reconcileTier('high', ACCEPTED_HIGH_VULNS);
const observedModerates = reconcileTier('moderate', ACCEPTED_MODERATE_VULNS);

console.log('npm audit policy passed (critical=0; high + moderate within accepted sets).');
console.log(`Accepted high advisories (${observedHighs.length}):`);
for (const name of observedHighs) console.log(`- ${name}: ${ACCEPTED_HIGH_VULNS.get(name)}`);
console.log(`Accepted moderate advisories (${observedModerates.length}):`);
for (const name of observedModerates)
  console.log(`- ${name}: ${ACCEPTED_MODERATE_VULNS.get(name)}`);
