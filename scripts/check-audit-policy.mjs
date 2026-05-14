#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

/**
 * A3-029: make the dependency-audit policy explicit.
 *
 * We still fail hard on any high/critical advisory, but we also pin the
 * currently-accepted moderate set so the gate doesn't silently ignore new
 * moderate findings. If the moderate set changes in either direction, this
 * script fails and forces an explicit review/update of the policy.
 */
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
    'drizzle-kit',
    'Direct package affected through the deprecated esbuild-kit chain; audited major upgrade deferred.',
  ],
  [
    'esbuild',
    'Only the deprecated drizzle-kit sub-tree lands on the vulnerable range; repo policy tracks it explicitly.',
  ],
  [
    'ip-address',
    'XSS in Address6 HTML-emitting methods. Transitive via @cyclonedx/cyclonedx-npm → libxmljs2 → node-gyp → … → socks → ip-address; only used at build-time for SBOM generation, the vulnerable HTML emitters are never invoked at runtime. Revisit when a fixed ip-address version (>10.1.0) propagates through the socks dependency chain.',
  ],
  [
    'hono',
    'Three moderate advisories on hono <=4.12.17: (a) CSS Declaration Injection via Style Object Values in JSX SSR — Loop does not use Hono JSX SSR; web SSR runs via React Router v7. (b) Improper NumericDate-claim validation in Hono JWT verify() — Loop uses its own verifier at apps/backend/src/auth/tokens.ts with explicit iat/exp/iss/aud checks; Hono JWT is never imported. (c) Cache Middleware Vary-header gap — Loop does not mount Hono Cache Middleware. None of the three reach an exploitable code path. Fix requires hono@4.12.18+ which lies outside the @hono/zod-openapi peer-dep range; revisit when that peer constraint relaxes.',
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

if ((metadata.high ?? 0) > 0 || (metadata.critical ?? 0) > 0) {
  fail(`npm audit policy failed: high=${metadata.high ?? 0}, critical=${metadata.critical ?? 0}.`);
}

const vulnerabilities = report.vulnerabilities ?? {};
const observedModerates = Object.entries(vulnerabilities)
  .filter(([, vuln]) => vuln?.severity === 'moderate')
  .map(([name]) => name)
  .sort();
const acceptedModerates = [...ACCEPTED_MODERATE_VULNS.keys()].sort();

const unexpectedModerates = observedModerates.filter((name) => !ACCEPTED_MODERATE_VULNS.has(name));
const staleAcceptedModerates = acceptedModerates.filter(
  (name) => !observedModerates.includes(name),
);

if (unexpectedModerates.length > 0 || staleAcceptedModerates.length > 0) {
  const lines = ['npm audit policy mismatch.'];
  if (unexpectedModerates.length > 0) {
    lines.push(`Unexpected moderate advisories: ${unexpectedModerates.join(', ')}`);
  }
  if (staleAcceptedModerates.length > 0) {
    lines.push(`Accepted-but-absent advisories: ${staleAcceptedModerates.join(', ')}`);
  }
  lines.push('Review `scripts/check-audit-policy.mjs` and docs/standards.md §15.');
  fail(lines.join('\n'));
}

console.log('npm audit policy passed.');
console.log(`Accepted moderate advisories (${observedModerates.length}):`);
for (const name of observedModerates) {
  const rationale = ACCEPTED_MODERATE_VULNS.get(name);
  console.log(`- ${name}: ${rationale}`);
}
