#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

/**
 * A3-029 / audit-2026-06-15 CF-04: dependency-audit policy, by severity tier.
 *
 * Tiering (pre-launch posture — consistent with the trivy/gitleaks/sbom jobs):
 *   - `critical` → ALWAYS hard-fail. Never auto-accepted.
 *   - `high` → hard-fail on any advisory NOT in `ACCEPTED_HIGH_VULNS` (a new
 *     high forces a human to evaluate runtime-reachability and fix-or-accept).
 *     An accepted entry no longer observed only WARNS — the npm advisory feed
 *     flaps live (the same tree returned 7→5→6 highs within minutes on
 *     2026-06-15 as GHSA ratings shifted), so failing on disappearance would
 *     re-break `main` on every registry update for no security benefit.
 *   - `moderate` → ADVISORY only: surfaced here + by Dependabot, never blocks.
 *     `ACCEPTED_MODERATE_VULNS` carries rationale for the long-standing ones.
 *     **Tighten moderate to a hard gate before public launch.**
 *
 * The accepted-high set is the esbuild dev-server / build-toolchain advisory
 * chain (dev/build-only — never in the deployed runtime: the backend ships
 * compiled `dist`, the web client is prebuilt) plus `form-data` (a runtime
 * transitive already at the patched version — a registry false-positive). None
 * is reachable by a deployed surface. Real fixes are semver-major (vite,
 * esbuild, drizzle-kit, @react-router/dev) or a non-major `tsx` bump, tracked
 * as a follow-up.
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
  [
    'form-data',
    'GHSA-fjxv-7rqg-78g4 (form-data <4.0.4 unsafe boundary RNG). Installed version is 4.0.5 — at/above the patched 4.0.4 — so this is a registry/range false-positive; it is transitive via @stellar/stellar-sdk→axios and Loop issues no multipart form-data on any code path. Not separately resolvable without an SDK bump; accepted. Note (2026-06-30 cold audit): a *different* form-data advisory (GHSA-hmw2-7cc7-3qxx, CRLF injection, range >=4.0.0 <4.0.6) also matches the installed 4.0.5 — the accept-by-package-name policy masks this; tracked as a follow-up to accept-by-advisory-ID instead of by-name.',
  ],
  [
    'undici',
    'Multiple 2026-06 advisories (TLS/SOCKS5 proxy bypass, Set-Cookie header injection/downgrade, WebSocket DoS, cache poisoning). Two independent dev/test-only chains pull it in: jsdom@29.1.1 (apps/web devDependency, test-environment only, never in the built web bundle or the SSR runtime) and @sentry/cli@3.4.1 (root devDependency, release-tooling CLI invoked at build time, not imported by any runtime code). Not reachable from any deployed surface; accepted pending a jsdom/@sentry/cli major bump.',
  ],
  [
    '@cyclonedx/cyclonedx-npm',
    'GHSA-v75r-vx73-82pj (shell injection via unsanitized --workspace argument, range 2.1.0-4.2.1). Root devDependency invoked once, in CI only, by .github/workflows/ci.yml to generate the SBOM — never runs with untrusted/user-controlled arguments (the workflow invokes it with a fixed, repo-authored argument list, not external input), so the injection vector is not reachable. Fix is semver-major (5.0.0); deferred as a tracked follow-up rather than risking breaking the SBOM step mid-audit-remediation.',
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
]);
// `hono` was here (moderate, <=4.12.17) until the 2026-06-30 cold audit's
// CF-04 fix bumped it to 4.12.27, which resolves every advisory in this
// package's chain (including the ones re-rated to `high` that redded the
// gate) — see git history for the prior rationale if the entry needs to
// come back after a future hono release regresses.

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
 * Gates the `high` tier against `ACCEPTED_HIGH_VULNS`: a **new** high advisory
 * not on the accept-list is a hard fail (a human must evaluate + accept or
 * fix it). An accepted entry that is no longer observed only **warns** — the
 * npm advisory DB is a live, frequently-flapping feed (the same dependency
 * tree returned 7→5→6 highs within minutes on 2026-06-15 as GHSA ratings
 * shifted), so failing on disappearance would re-break `main` on every
 * registry update for no security benefit. Keeping extra accepted entries is
 * therefore safe and intentional. Returns the observed list for the summary.
 */
function gateHigh(acceptedMap) {
  const observed = observedAt('high');
  const unexpected = observed.filter((name) => !acceptedMap.has(name));
  if (unexpected.length > 0) {
    fail(
      [
        'npm audit policy failed (high).',
        `Unaccepted high advisories: ${unexpected.join(', ')}`,
        'Evaluate each (runtime-reachable?) and either fix or add to ACCEPTED_HIGH_VULNS with rationale.',
        'See docs/standards.md §15.',
      ].join('\n'),
    );
  }
  const stale = [...acceptedMap.keys()].sort().filter((name) => !observed.includes(name));
  if (stale.length > 0) {
    console.warn(
      `[audit] note: accepted high advisories no longer observed (registry flap): ${stale.join(', ')}`,
    );
  }
  return observed;
}

const observedHighs = gateHigh(ACCEPTED_HIGH_VULNS);

// Moderate tier: ADVISORY (pre-launch posture, consistent with the trivy /
// gitleaks / sbom jobs). Surfaced here + by Dependabot, never blocks a merge.
// Tighten to a hard gate before public launch (docs/standards.md §15).
const observedModerates = observedAt('moderate');

console.log('npm audit policy passed (critical=0; no unaccepted high advisories).');
console.log(`Accepted high advisories observed (${observedHighs.length}):`);
for (const name of observedHighs) {
  const rationale = ACCEPTED_HIGH_VULNS.get(name) ?? '(accepted)';
  console.log(`- ${name}: ${rationale}`);
}
console.log(`Moderate advisories (${observedModerates.length}, advisory-only pre-launch):`);
for (const name of observedModerates) {
  const rationale = ACCEPTED_MODERATE_VULNS.get(name);
  console.log(`- ${name}${rationale ? `: ${rationale}` : ' (surfaced; tighten before launch)'}`);
}
