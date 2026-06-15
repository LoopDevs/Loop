# Cold Audit 2026-06-15 — Infra / CI / Dependencies / Build / Deploy (vertical: x-infra)

Branch: `fix/stranded-order-hardening`. Checklist §7 (infra/deploy), §8 (build/CI), §10 (deps/supply-chain).
All file:line refs are absolute-repo-relative.

---

## Coverage

| Area          | Artifacts read                                                                                                                               | Status |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Dockerfiles   | `apps/backend/Dockerfile`, `apps/web/Dockerfile` (full)                                                                                      | done   |
| fly.toml      | `apps/backend/fly.toml`, `apps/web/fly.toml` (full)                                                                                          | done   |
| CI workflows  | `.github/workflows/ci.yml` (full, 12 jobs), `codeql.yml`, `e2e-real.yml`, `pr-automation.yml`, `pr-review.yml` (listed; ci.yml read in full) | done   |
| Audit policy  | `scripts/check-audit-policy.mjs` (full), live `npm audit --json`, `npm audit fix --dry-run`                                                  | done   |
| Verify/hooks  | `scripts/verify.sh`, `.husky/pre-push`, `.husky/pre-commit`                                                                                  | done   |
| Dependencies  | per-package `package.json` (root/backend/web/shared/mobile), `npm ls`, capacitor web↔mobile parity, hono/zod peer reality                    | done   |
| Licenses      | `docs/third-party-licenses.md` vs installed versions                                                                                         | done   |
| Deploy state  | `flyctl apps list` (both apps deployed), `scripts/preflight-tranche-1.sh`, branch-protection via `gh api`                                    | done   |
| Standards doc | `docs/standards.md` §15 (audit policy, branch protection)                                                                                    | done   |

Not covered (out of vertical / delegated elsewhere): per-route rate-limit values, OpenAPI schema bodies, migration SQL content, e2e test internals.

---

## Findings

### P0-INFRA-01 — `Security audit` required check is RED; all merges to `main` are blocked

- **Severity:** P0
- **Evidence:** `npm run audit` exits **1** (verified: `audit exit code: 1`). `scripts/check-audit-policy.mjs:67-68` fails on any high>0; live `npm audit` reports `high=7, critical=0`. `Security audit` is one of the 5 required merge-gating checks (`gh api repos/LoopDevs/Loop/branches/main/protection` → contexts include `"Security audit"`; `docs/standards.md:584`).
- **Impact:** Every PR's required `audit` job (ci.yml:269-280) fails → no PR can merge until resolved. This is a hard release/iteration blocker.
- **Root cause:** The high count rose from the previously-documented 5 to **7**. New since the policy was last reviewed: `esbuild` GHSA-gv7w-rqvm-qjhr ("Missing binary integrity verification in Deno module enables RCE via NPM_CONFIG_REGISTRY", **HIGH**) widened the affected range to `<=0.28.0`, which now also pulls `@react-router/dev`, `tsup`, `tsx`, `vite`, `vite-node`, `drizzle-kit` into the HIGH bucket. All are dev-chain only (no esbuild ships to runtime — confirmed: builds use tsup→bundle, prod image is `npm ci --omit=dev`).
- **Fix (pick one):** (a) Add a justified **high-accept allowlist path** to `check-audit-policy.mjs` mirroring the existing `ACCEPTED_MODERATE_VULNS` map — the script today has _no_ high-accept mechanism (`scripts/check-audit-policy.mjs:67` is an unconditional fail), so the documented "fail hard on high, but pin accepted set" policy only exists for moderate. This is the structural gap the prompt flagged. (b) `tsx` has a non-major fix (`4.22.4`); `drizzle-kit`/`tsup` fixes are semver-major. A scoped upgrade of `tsx` + the drizzle-kit major would clear the bulk; vite/@react-router/dev have `fixAvailable:false` (await upstream). Recommend (a) as the immediate unblock + (b) as follow-up, since the chain is dev-only and not runtime-exploitable.
- **Ref:** checklist §8 "npm audit policy gate state (currently failing)", §10 "accepted-advisory list justified & current".

### P1-INFRA-02 — Audit-policy + standards rationale cite a non-existent peer-dep blocker (`@hono/zod-openapi`)

- **Severity:** P1 (incorrect documented blocker → wrong remediation deferred indefinitely)
- **Evidence:** `scripts/check-audit-policy.mjs:32` and `docs/standards.md` §15 both state the hono moderate advisories can't be fixed because `hono@4.12.18+` "lies outside the `@hono/zod-openapi` peer-dep range." **`@hono/zod-openapi` is not a dependency** — `ls node_modules/@hono/` shows only `node-server`. The backend uses `@asteasolutions/zod-to-openapi@8.5.0`, whose only peer dep is `zod ^4.0.0` (verified) — it has **no hono peer constraint at all**. hono is currently `4.12.16` (declared `4.12.16`, no caret).
- **Impact:** The stated reason for not bumping hono past the advisory range is false. The bump is unblocked at the peer-dep level; the team is deferring a fixable advisory based on a phantom constraint. Also a doc↔code-truth failure across two source-of-truth files.
- **Fix:** Re-test a hono bump to a non-vulnerable release against `@hono/node-server`, `@sentry/hono`, and `@asteasolutions/zod-to-openapi` peer ranges; if green, bump and drop `hono` from `ACCEPTED_MODERATE_VULNS`. Correct the rationale text in both files regardless.
- **Ref:** checklist §10 "peer-dep conflicts (hono ↔ @hono/zod-openapi)" — the conflict named in the checklist itself does not exist.

### P2-INFRA-03 — GeoLite2 mmdb has no refresh cadence; goes stale between deploys

- **Severity:** P2
- **Evidence:** The mmdb is baked **only at image build time** via Dockerfile build-secrets (`apps/backend/Dockerfile:33-47`). The only scheduled workflow in the repo is `codeql.yml` (`grep -rln "schedule:" .github/workflows` → codeql only). No cron re-bakes/re-deploys the DB. MaxMind publishes GeoLite2-Country updates ~weekly; the geo first-guess (ADR 033/034) silently drifts until the next manual deploy.
- **Impact:** Degraded `/api/public/geo` accuracy over time → wrong country first-guess at `/`. Non-fatal (handler degrades to US default), but the orphaned-work register lists "GeoLite2 cadence" as open and it remains unaddressed.
- **Fix:** Add a scheduled workflow (weekly) that triggers a `flyctl deploy` with the maxmind build-secrets, or a sidecar that pulls the mmdb at runtime on an interval. Document the chosen cadence in deployment docs.
- **Ref:** checklist §7 "GeoLite2 mmdb refresh cadence/staleness".

### P3-INFRA-04 — Bundle-budget doc drift: AGENTS/CI say different MAX_SSR_KB values vs the script default

- **Severity:** P3
- **Evidence:** `scripts/check-bundle-budget.sh:41` default `MAX_SSR_KB=3300`; its own header comment line 20 says `2500`; `CLAUDE.md:117` says `3300`; `ci.yml:553-556` comment says `2500`. The script default (3300) is what actually runs in CI (the `build` job calls `npm run check:bundle-budget` with no env override).
- **Impact:** Three different stated budgets across docs/comments; a reviewer can't tell the real gate. Pure doc-integrity nit (the gate functions at 3300).
- **Fix:** Reconcile to one value; update the script header comment + ci.yml comment + AGENTS to match the effective `3300` (or deliberately lower the default and update all four sites).
- **Ref:** checklist §5 (docs match code), §8 (bundle-budget gate).

### P3-INFRA-05 — License doc version drift (`@capgo/inappbrowser`)

- **Severity:** P3
- **Evidence:** `docs/third-party-licenses.md:97` pins `@capgo/inappbrowser@8.6.1`; installed + declared in both web and mobile is `8.6.2`. All other attributed packages (sharp 0.34.5, leaflet 1.9.4, postgres 3.4.9, claude-code 2.1.126) are present and correctly attributed. License _coverage_ is complete (MPL-2.0, LGPL, BSD-2, MIT, Unlicense, Anthropic commercial all listed).
- **Impact:** Minor stale version string in the attribution doc; the MPL-2.0 obligation itself is satisfied.
- **Fix:** Bump the doc version to 8.6.2 (or use "8.6.x"); add a license-parity lint (the doc itself notes at line 154 that `lint-docs.sh` doesn't lint dep licenses — that follow-on is still open).
- **Ref:** checklist §10 "license compliance".

---

## Things verified GOOD (no finding)

- **Dockerfile↔Dockerfile parity:** Both use the **same** SHA256-pinned base digest (`node:22-alpine@sha256:8ea2…683f`), identical multi-stage layout, identical `npm ci --ignore-scripts && npm rebuild esbuild` supply-chain posture, both run as non-root `node` user with `chown -R node:node /app`, both have node-builtin-http HEALTHCHECK (30s/5s/3-retry). No drift of the kind PRs #149/#150 fixed. (`apps/backend/Dockerfile`, `apps/web/Dockerfile`)
- **fly.toml↔fly.toml parity:** Both `primary_region=iad`, `force_https=true`, `min_machines_running=1`, identical concurrency (hard 250/soft 200), identical `[[http_service.checks]]` (15s/5s/30s grace, GET /). Resource sizing differs intentionally (backend 512mb, web 256mb — appropriate). Backend has `[deploy] release_command` for migrations (web has none — correct, web is stateless). Both Sentry-arg-baked correctly (web `[build.args]` mirror Dockerfile ARGs per A4-072).
- **Migrations on deploy:** `release_command = node …/migrate-cli.js` runs pre-traffic in a one-shot machine (`apps/backend/fly.toml:13-14`); boot-time `runMigrations()` is the idempotent belt-and-braces. Build job pins migrations-ship-in-dist invariant (ci.yml:531-541). 35 migrations present.
- **CI required checks gate:** Live `gh api` confirms the 5 required contexts exactly match docs (Quality / Unit tests / Security audit / Build verification / E2E tests (mocked CTX)). Branch protection live.
- **CI permissions:** workflow default `permissions: contents: read` (ci.yml:15-16); `sbom` job scopes `id-token: write` + `attestations: write` only where needed. All third-party actions SHA-pinned (checkout, setup-node, cache, flyctl, trivy, gitleaks, cosign, attest-build-provenance). gitleaks/trivy via SHA-pinned images.
- **SBOM/provenance/cosign:** `sbom` job generates CycloneDX 1.6 (--omit dev), SLSA provenance attestation, cosign keyless. A4-044 (attests SBOM not deploy image) documented as open in-line.
- **Advisory vs gating clarity:** sbom/secret-scan/container-cve-scan run on every PR but are **not** in the required-checks set (advisory pre-launch) — correctly documented; no confusion in code.
- **CI↔local parity:** `.husky/pre-push` runs `scripts/verify.sh` (typecheck/lint/format/docs/type-parity/openapi-parity/env-perms/test/audit) — mirrors the Quality+audit CI jobs. Bundle-budget + migration-parity correctly CI-only (slow / need postgres). AGENTS `verify` description (CLAUDE.md:105) is accurate.
- **Dependency hygiene:** Zero cross-package version drift (programmatic diff of all 5 manifests). Capacitor plugins web↔mobile at identical versions for every shared plugin (`@capacitor/*` 8.x, `@aparajita/*`, `@capgo/inappbrowser` 8.6.2). Mobile-only `@capacitor/{android,ios,cli,splash-screen}` correctly absent from web. Exact pinning (no `^`/`~`) per standards §15. Node engine `>=22.0.0` consistent across all 5 packages; CI uses node 22 (no `.nvmrc`/`.node-version` file, but engines + CI string agree — minor, not flagged).
- **e2e determinism:** mocked + flywheel suites self-contained (own postgres service, isolated port 5433→5432), run on push+PR; real-CTX e2e PR-only with `needs:[quality,test-unit,build]`. Backend dist reused from `build` artifact (no double-compile).
- **Deploy state:** Both `loopfinance-api` and `loopfinance-web` are **deployed** (Fly, Jun 12 2026) — the orphaned "web deploy not performed" item is now closed. `preflight-tranche-1.sh` enforces required-secret presence (DATABASE_URL, LOOP_JWT_SIGNING_KEY, stellar set, RESEND_API_KEY, METRICS/OPENAPI bearer) before deploy; SENTRY_DSN is RECOMMENDED-not-required (acceptable for Tranche-1).

---

## Summary

- **Findings: 5** — P0: 1, P1: 1, P2: 1, P3: 2.
- **P0-INFRA-01:** `Security audit` (a required merge gate) is RED — `npm run audit` exits 1 on high=7 (new esbuild HIGH RCE widened the dev-chain range). `check-audit-policy.mjs` has **no high-accept allowlist path**, so merges are blocked until the count drops or a justified high-accept mechanism is added. Chain is dev-only, not runtime-exploitable.
- **P1-INFRA-02:** The documented blocker for the hono fix (`@hono/zod-openapi` peer range) is **phantom** — that package isn't a dep; the real openapi lib (`@asteasolutions/zod-to-openapi`) has no hono peer. hono is bumpable; the deferral rests on a false premise in both the script and standards.md.
- **P2/P3:** GeoLite2 has no refresh cadence (stale geo over time); bundle-budget value stated three different ways; one license-doc version-string drift.
- **Strong points:** Dockerfile/fly.toml parity is clean (the historical drift class is absent), CI permissions/SHA-pinning/SBOM/signing are exemplary, deps have zero cross-package drift + capacitor parity holds, both Fly apps are deployed. The infra surface is in good shape _except_ the audit gate is mechanically blocking merges right now.
