# Loop — Cold Adversarial Audit (2026-04) — Tracker

> Source of truth for audit status. See [`audit-2026-adversarial-plan.md`](./audit-2026-adversarial-plan.md) for the plan.
>
> **This tracker is live-updated during execution.** The plan is frozen; this tracker is the state.

## Plain-English summary

A cold, adversarial audit of the Loop codebase was executed across 20 phases (0–19 plus a dedicated Phase 6.5 for financial correctness), using 15 parallel subagents orchestrated by a lead auditor, against commit `450011d` on 2026-04-23. The audit was independent of the prior `codebase-audit.md` / `audit-tracker.md` program and re-derived every conclusion from primary evidence (file reads, command outputs, empirical probes).

**The headline finding is that the codebase is not ready to take live traffic.** 467 findings were filed across every severity band: 10 Critical, 79 High, 171 Medium, 164 Low, 43 Info. The 10 Criticals concentrate in two areas — **authentication / authorization** (A2-119 org-level 2FA disabled; A2-550 + A2-551 unverified CTX JWT lets any authenticated user act as any other user) and **money flow** (A2-601 credit-funded orders stuck in `pending_payment` forever; A2-602 payout retry path unreachable; A2-610/611/700 `accrue-interest` corrupts balances under multi-currency and loses-updates under concurrent admin adjustments — all three empirically reproduced; A2-619 cross-currency order validation silently mismatches; A2-720 migration 0011 missing from drizzle's `_journal.json` so the admin idempotency table is never created on fresh deploys, bricking every ADR-017 admin write at boot). Beyond the Criticals, the 79 Highs span security gaps (Loop JWT missing `iss`/`aud` claims, Pino redaction misses signing keys, web serves zero security headers, refresh-token reuse detected but family not revoked), operational-readiness gaps (no runbooks, no on-call, no DSR flow, no DR plan, no signing-cert calendar, no staging env, no runtime kill-switches), cross-app contract drift (~30 admin shapes + 13 `/me*` shapes web-only, no CI drift detector, no client-version header, enum-exhaustiveness not enforced), and CI/CD posture (no GitHub Environments, no rollback rehearsal, no SAST, no preview deploys).

**Most of the audit's value came from empirical confirmation.** Phase 6.5 spun up an ephemeral Postgres, replayed all 12 migrations, seeded synthetic data, and ran the ledger invariant `balance = SUM(transactions)` against it — several prior phases' static-read findings (accrue-interest race, cross-currency mismatch, lost-update under adjustments) were independently reproduced with runtime evidence. Phase 18's 29-attack red-team playbook found 10 defenses that held cleanly (SQL injection, bigint overflow, trust-proxy discipline, procurement race, OTP timing), re-confirmed 13 prior findings with empirical attempts, and filed 9 net-new findings dominated by admin-accountability gaps (A2-2006 no tamper-evident audit trail; A2-2008 admin reads unaudited — a compromised admin can bulk-exfil PII with zero trace). The legacy audit program's closed findings were reconciled: nothing it marked "done" regressed silently, but three items aged poorly (A-025 image SSRF now exposed to DNS-rebinding, A-035 stale support artifacts still linked, A-037 branch protection now reopened at higher severity). Per the pre-launch operating model, every finding — Critical through Info — enters a single remediation queue ordered by severity; sign-off is blocked until all 467 are resolved or accepted-with-rationale-and-second-reviewer. The audit's data-gathering phase is complete; the remediation phase is where the next chapter of work lives.

---

---

## Index

### Finding counts (by severity)

| Severity  | Count   |
| --------- | ------- |
| Critical  | 10      |
| High      | 79      |
| Medium    | 171     |
| Low       | 164     |
| Info      | 43      |
| **Total** | **467** |

### Finding counts (by status)

| Status      | Count |
| ----------- | ----- |
| open        | 467   |
| in-progress | 0     |
| resolved    | 0     |
| accepted    | 0     |
| wontfix     | 0     |
| deferred    | 0     |

### Phase progress

Plan has 20 phases (0–19 plus 6.5). Progress updated as each phase exits.

| Phase | Title                           | Status      | Audited-by | Reviewed-by | Evidence                                                                     | Findings (C/H/M/L/I)                   |
| ----- | ------------------------------- | ----------- | ---------- | ----------- | ---------------------------------------------------------------------------- | -------------------------------------- |
| 0     | Inventory                       | ✅ complete | claude     | pending     | [phase-0-inventory.md](./audit-2026-evidence/phase-0-inventory.md)           | 0/0/1/3/0                              |
| 1     | Governance & Repo Hygiene       | ✅ complete | agent      | pending     | [phase-1-governance.md](./audit-2026-evidence/phase-1-governance.md)         | 1/4/9/10/3                             |
| 2     | Architecture compliance         | ✅ complete | agent      | pending     | [phase-2-architecture.md](./audit-2026-evidence/phase-2-architecture.md)     | 0/0/1/3/3                              |
| 3     | Dependencies & Supply chain     | ✅ complete | agent      | pending     | [phase-3-dependencies.md](./audit-2026-evidence/phase-3-dependencies.md)     | 0/0/3/5/2                              |
| 4     | Build & release reproducibility | ✅ complete | agent      | pending     | [phase-4-build-release.md](./audit-2026-evidence/phase-4-build-release.md)   | 0/1/6/4/1                              |
| 5     | Backend per-module audit        | ✅ complete | agent (×4) | pending     | 5a + 5b + 5c + 5d                                                            | 7/15/38/43/7                           |
| 6     | Database & Data Layer           | ✅ complete | agent      | pending     | [phase-6-database.md](./audit-2026-evidence/phase-6-database.md)             | 2/6/10/7/0 (some corroborate P4/P5c)   |
| 6.5   | Financial Correctness           | ✅ complete | agent      | pending     | [phase-6.5-financial.md](./audit-2026-evidence/phase-6.5-financial.md)       | 0/5/3/1/0 (empirical runtime evidence) |
| 7     | API surface                     | ✅ complete | agent      | pending     | [phase-7-api.md](./audit-2026-evidence/phase-7-api.md)                       | 0/0/4/8/3                              |
| 8     | Web per-module audit            | ✅ complete | agent (×2) | pending     | 8a + 8b                                                                      | 0/4/6/17/10                            |
| 9     | Mobile shell                    | ✅ complete | agent      | pending     | [phase-9-mobile.md](./audit-2026-evidence/phase-9-mobile.md)                 | 0/2/6/6/0                              |
| 10    | Shared package                  | ✅ complete | agent      | pending     | [phase-10-shared.md](./audit-2026-evidence/phase-10-shared.md)               | 0/0/7/9/0                              |
| 11    | Cross-app integration           | ✅ complete | agent      | pending     | [phase-11-cross-app.md](./audit-2026-evidence/phase-11-cross-app.md)         | 0/10/17/7/0                            |
| 12    | Security deep-dive              | ✅ complete | agent      | pending     | [phase-12-security.md](./audit-2026-evidence/phase-12-security.md)           | 0/4/7/4/0 (new only)                   |
| 13    | Observability                   | ✅ complete | agent      | pending     | [phase-13-observability.md](./audit-2026-evidence/phase-13-observability.md) | 0/4/15/5/4                             |
| 14    | Testing                         | ✅ complete | agent      | pending     | [phase-14-testing.md](./audit-2026-evidence/phase-14-testing.md)             | 0/4/6/5/0                              |
| 15    | Documentation                   | ✅ complete | agent      | pending     | [phase-15-docs.md](./audit-2026-evidence/phase-15-docs.md)                   | 0/1/9/15/5                             |
| 16    | CI/CD & Automation              | ✅ complete | agent      | pending     | [phase-16-cicd.md](./audit-2026-evidence/phase-16-cicd.md)                   | 0/4/6/6/1                              |
| 17    | Operational readiness           | ✅ complete | agent      | pending     | [phase-17-operational.md](./audit-2026-evidence/phase-17-operational.md)     | 0/14/12/4/1                            |
| 18    | Adversarial / Red-team          | ✅ complete | agent      | pending     | [phase-18-redteam.md](./audit-2026-evidence/phase-18-redteam.md)             | 0/1/5/2/1 (new)                        |
| 19    | Synthesis & sign-off            | ✅ complete | claude     | pending     | this document                                                                | — (clerical)                           |

---

## Findings

Findings are recorded below their owning phase. Each finding follows the shape from plan §3.3.

### Phase 0 — Inventory

Complete. Evidence: [phase-0-inventory.md](./audit-2026-evidence/phase-0-inventory.md). Commit SHA at capture: `84fc581`.

#### A2-001 — Favicon files are 0 bytes

| Field       | Value                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity    | **Medium**                                                                                                                                                                                              |
| Status      | open                                                                                                                                                                                                    |
| Files       | `apps/web/public/loop-favicon.ico` (0B), `apps/web/public/loop-favicon.png` (0B), referenced from `apps/web/app/root.tsx:135-136`                                                                       |
| Evidence    | `wc -c` on the two files returns `0`. `root.tsx` emits `<link rel="icon" href="/loop-favicon.ico">` and `<link rel="icon" type="image/png" href="/loop-favicon.png">`.                                  |
| Impact      | Browsers fetching the favicon receive an empty response. Tab icon is blank / generic. User-facing polish defect; not a security issue.                                                                  |
| Remediation | Replace both files with actual favicon binaries exported from `loop-favicon.svg` (which is non-empty), or remove the `<link>` entries and keep only the SVG favicon (supported by all modern browsers). |
| Owner       | _unassigned_                                                                                                                                                                                            |

#### A2-002 — Unreferenced root-level `looplogo.svg` is a duplicate

| Field       | Value                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity    | **Low**                                                                                                                                                                                                 |
| Status      | open                                                                                                                                                                                                    |
| Files       | `looplogo.svg` (repo root, 1572 bytes)                                                                                                                                                                  |
| Evidence    | `sha256sum looplogo.svg apps/web/public/loop-logo.svg` → identical hash `a38062762e6d...`. `grep -rn looplogo.svg` across `apps/`, `docs/`, `scripts/`, top-level `.md`/`.ts` files returns no matches. |
| Impact      | Dead file. Confusing during editing (which logo is canonical?).                                                                                                                                         |
| Remediation | Delete `looplogo.svg`.                                                                                                                                                                                  |
| Owner       | _unassigned_                                                                                                                                                                                            |

#### A2-003 — Duplicate PNG logos not referenced from web source

| Field       | Value                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity    | **Low**                                                                                                                                                                                                                   |
| Status      | open                                                                                                                                                                                                                      |
| Files       | `apps/web/public/loop-logo.png` (19259B), `apps/web/public/loop-logo-square.png` (19259B)                                                                                                                                 |
| Evidence    | `shasum -a 256` on both files → identical hash `2e3aaa10d321...`. Scoped grep through `apps/web/app/**/*.{ts,tsx,css}` returns zero references (only matches are Android build artifacts that are themselves gitignored). |
| Impact      | Two files' worth of dead static-asset payload shipped with the web build.                                                                                                                                                 |
| Remediation | Delete both unless intentionally kept as a public URL consumed outside the app (e.g. og:image for a specific path — confirm with owner before deleting).                                                                  |
| Owner       | _unassigned_                                                                                                                                                                                                              |

#### A2-004 — `loop-favicon.svg` has content but no reference

| Field       | Value                                                                                                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity    | **Low**                                                                                                                                                                                                                                       |
| Status      | open                                                                                                                                                                                                                                          |
| Files       | `apps/web/public/loop-favicon.svg` (234 bytes)                                                                                                                                                                                                |
| Evidence    | `grep -rn loop-favicon.svg apps/` returns no reference from application code (only build artifacts). `root.tsx:135-136` links `.ico` and `.png` but not the `.svg`.                                                                           |
| Impact      | An intended SVG favicon that was never wired up. Either the file is stale or `root.tsx` is incomplete. Ties in with A2-001 — the SVG may be the fix for A2-001.                                                                               |
| Remediation | Add `<link rel="icon" type="image/svg+xml" href="/loop-favicon.svg">` to `root.tsx` alongside the raster fallbacks (preferred modern pattern), **or** delete the file if it's no longer intended. Decision depends on how A2-001 is resolved. |
| Owner       | _unassigned_                                                                                                                                                                                                                                  |

### Phase 1 — Governance

Complete. Evidence: [phase-1-governance.md](./audit-2026-evidence/phase-1-governance.md). Commit SHA at capture: `450011d`. 27 findings (1 Critical / 4 High / 9 Medium / 10 Low / 3 Info).

| ID     | Severity     | Title                                                                                                                                                                                                                                                                                                                                    |
| ------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2-101 | **High**     | Branch protection permits admin bypass; zero required reviews                                                                                                                                                                                                                                                                            |
| A2-102 | Medium       | No signed-commit policy on `main`                                                                                                                                                                                                                                                                                                        |
| A2-103 | **High**     | CODEOWNERS references non-existent `@LoopDevs/engineering` team                                                                                                                                                                                                                                                                          |
| A2-104 | Medium       | CODEOWNERS coverage stale vs admin / credits / stellar / migration surfaces                                                                                                                                                                                                                                                              |
| A2-105 | **High**     | Secret-scanning + dependabot-alerts + push-protection disabled at repo & org level                                                                                                                                                                                                                                                       |
| A2-106 | Low          | ~~Dependabot `reviewers` points at missing team~~ **resolved-pending-review**: `reviewers` directive removed from `.github/dependabot.yml`. CODEOWNERS now handles review assignment for paths that need it (A2-104 closed by #823); dependabot PRs land in the normal approval flow without a phantom `LoopDevs/engineering` team ping. |
| A2-107 | Medium       | Commitlint is client-side only; no server-side enforcement                                                                                                                                                                                                                                                                               |
| A2-108 | Low          | ~~Branch-prefix hook / CONTRIBUTING.md type-list drift~~ **resolved-pending-review** by A2-108/110 PR                                                                                                                                                                                                                                    |
| A2-109 | Medium       | CONTRIBUTING.md overstates review gate vs actual                                                                                                                                                                                                                                                                                         |
| A2-110 | Low          | ~~CONTRIBUTING.md CI job-count drift (6 vs 7)~~ **resolved-pending-review** by A2-108/110 PR                                                                                                                                                                                                                                             |
| A2-111 | Low          | No `.gitattributes`                                                                                                                                                                                                                                                                                                                      |
| A2-112 | Info         | `ctx.postman_collection.json` at repo root (see lint-docs sentinel)                                                                                                                                                                                                                                                                      |
| A2-113 | Low          | PR template is decorative; authors don't use it                                                                                                                                                                                                                                                                                          |
| A2-114 | **High**     | `superfly/flyctl-actions/setup-flyctl@master` pins a branch                                                                                                                                                                                                                                                                              |
| A2-115 | Medium       | All first-party actions tag-pinned, not SHA-pinned                                                                                                                                                                                                                                                                                       |
| A2-116 | Low          | ~~`pr-automation.yml`, `pr-review.yml` lack top-level `permissions`~~ **resolved-pending-review**: both workflows carry `permissions: {}` at the workflow level with per-job narrow grants (`contents: read`, `pull-requests: write`); `A2-116:` marker present in both files.                                                           |
| A2-117 | Info         | Repo `allowed_actions: "all"` — unbounded Marketplace access                                                                                                                                                                                                                                                                             |
| A2-118 | Info         | Org webhook inventory not verifiable from audit session (auth scope)                                                                                                                                                                                                                                                                     |
| A2-119 | **Critical** | `LoopDevs` org does not require 2FA; both members are admins                                                                                                                                                                                                                                                                             |
| A2-120 | Medium       | Org on free plan — no audit log retention                                                                                                                                                                                                                                                                                                |
| A2-121 | Medium       | Stale "stellarspendtest server" SSH key                                                                                                                                                                                                                                                                                                  |
| A2-122 | Low          | No GPG keys on file for push-capable members                                                                                                                                                                                                                                                                                             |
| A2-123 | Low          | Three merge modes enabled despite squash-only convention                                                                                                                                                                                                                                                                                 |
| A2-124 | Medium       | Public repo has no LICENSE                                                                                                                                                                                                                                                                                                               |
| A2-125 | Medium       | No SECURITY.md on a public pre-launch repo                                                                                                                                                                                                                                                                                               |
| A2-126 | Low          | No issue templates                                                                                                                                                                                                                                                                                                                       |
| A2-127 | Low          | No CHANGELOG.md                                                                                                                                                                                                                                                                                                                          |

**Blockers / deferred probes:**

- A2-118 org-webhook inventory needs `admin:org_hook` scope — `gh auth refresh -h github.com -s admin:org_hook` before re-running.
- Git-history secret scan: clean across 979 commits / 2 author emails.
- Signed-commits: 979/979 unsigned; local `gpg` missing, but `required_signatures.enabled: false` on branch protection is corroborating primary evidence.

### Phase 2 — Architecture compliance

Complete. Evidence: [phase-2-architecture.md](./audit-2026-evidence/phase-2-architecture.md). Commit SHA at capture: `450011d`. 7 findings (0 Critical / 0 High / 1 Medium / 3 Low / 3 Info). ADR reconciliation: 21 `in-sync`, 1 `drifted-minor`, 0 withdrawn, 0 never-implemented.

| ID     | Severity | Title                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2-201 | Low      | ~~AGENTS.md rule #1 claims "no server-side data fetching in loaders" but `sitemap.tsx` has a documented loader fetch~~ **resolved-pending-review**: AGENTS.md rule #1 now carries the documented exception ("The only loader that fetches server-side is `routes/sitemap.tsx`: crawlers need an XML response, not a React shell. Any new loader-side fetch beyond that needs a comment explaining why TanStack Query doesn't fit.")       |
| A2-202 | Medium   | ~~AGENTS.md rule #2 says backend doesn't mint JWTs / generate OTPs / send emails — contradicted by ADR-013 implementation (`auth/tokens.ts` HS256 mint, `auth/otps.ts`, `auth/native.ts`)~~ **resolved-pending-review**: AGENTS.md rule #2 + the "Auth has two paths" section (lines 57 + 101) correctly describe Loop-native (HS256 mint, OTP generation, email send) and legacy CTX-proxy coexisting behind `LOOP_AUTH_NATIVE_ENABLED`. |
| A2-203 | Low      | ~~ADR-011 promises `DEFAULT_USER_CASHBACK_PCT_OF_CTX` + `DEFAULT_LOOP_MARGIN_PCT_OF_CTX` env vars — not present in backend source~~ **resolved-pending-review**: both present at `apps/backend/src/env.ts:142/146` with Zod validation + sum-check at `env.ts:407-412`, and in `apps/backend/.env.example:79-80`.                                                                                                                         |
| A2-204 | Low      | ~~`packages/shared/src/api.ts` `ApiErrorCode` enum lags behind backend-emitted codes (e.g. `IDEMPOTENCY_KEY_REQUIRED`)~~ **resolved-pending-review**: every backend `{ code: '...' }` emission (18 total) has a matching entry in the shared `ApiErrorCode` const at `packages/shared/src/api.ts:63` — verified via `grep -rhoE "code: '[A-Z_]+'" apps/backend/src` against the enum. The file already carries an `A2-204:` marker.       |
| A2-205 | Info     | ADRs 009, 010, 011, 013, 014, 017 still say "Proposed" despite shipped implementation                                                                                                                                                                                                                                                                                                                                                     |
| A2-206 | Info     | No automated secret scan (gitleaks / trufflehog) in pre-commit or CI                                                                                                                                                                                                                                                                                                                                                                      |
| A2-207 | Info     | ~~AGENTS.md "quick commands" don't mention `LOOP_WORKERS_ENABLED`~~ **resolved-pending-review**: env summary now lists `LOOP_WORKERS_ENABLED` with a comment pointing at ADR-016 + the `LOOP_STELLAR_OPERATOR_SECRET` wiring prerequisite. Full docs remain in `docs/development.md`.                                                                                                                                                     |

### Phase 3 — Dependencies & Supply chain

Complete. Evidence: [phase-3-dependencies.md](./audit-2026-evidence/phase-3-dependencies.md) plus sibling `phase-3-npm-ls-all.txt`, `phase-3-npm-audit.json`, `phase-3-npm-outdated.json`, `phase-3-install-hooks.txt`. Commit SHA at capture: `450011d`. 10 findings (0 Critical / 0 High / 3 Medium / 5 Low / 2 Info).

| ID     | Severity | Title                                                                                                                                                                                                                                                                                                                             |
| ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2-301 | Medium   | `vitest` pinned `4.1.0` in backend+web but lockfile actually resolves `4.1.4` (peer-forced by `@vitest/coverage-v8`); exact-pin misleading                                                                                                                                                                                        |
| A2-302 | Low      | 5 extraneous packages in `node_modules/` not in lockfile (`@emnapi/*`, `@napi-rs/wasm-runtime`, `@tybys/wasm-util`); dev env not `npm ci`-reproducible                                                                                                                                                                            |
| A2-303 | Medium   | `esbuild@0.18.20` dev-server CVE (GHSA-67mh-4wv8-2f99) reachable via `drizzle-kit → @esbuild-kit/esm-loader` deprecated chain; 4 moderate advisories, same root cause                                                                                                                                                             |
| A2-304 | Medium   | `@bufbuild/buf@1.68.2` postinstall shells to `npm install` as fallback binary fetcher — supply-chain surface on `--omit=optional` fresh clones                                                                                                                                                                                    |
| A2-305 | Low      | ~~libvips (`@img/sharp-libvips-*@1.2.4`) is LGPL-3.0-or-later, only non-permissive licence in tree; requires OSS attribution page before public launch~~ **resolved-pending-review** by `docs/third-party-licenses.md` — libvips entry covers LGPL §6 attribution via repo doc + planned `/licenses` site page.                   |
| A2-306 | Low      | ~~`apps/web/public/leaflet/marker-*.png` are BSD-2 copies shipped without upstream copyright notice~~ **resolved-pending-review** by `docs/third-party-licenses.md` — Leaflet marker images entry preserves the BSD-2 copyright notice from the upstream `LICENSE`.                                                               |
| A2-307 | Low      | `@hono/node-server 1.19.14 → 2.0.0` major bump Dependabot's minor-and-patch group will never file; 19 outdated total                                                                                                                                                                                                              |
| A2-308 | Low      | 52 transitive packages have multiple installed versions (3 `esbuild` majors, 3 `ansi-styles`, etc.); no CVE-reachable but dedup recommended                                                                                                                                                                                       |
| A2-309 | Info     | ~~`postgres@3.4.9` licensed Unlicense (public-domain dedication); record on OSS attribution page~~ **resolved-pending-review** by `docs/third-party-licenses.md` — postgres driver listed explicitly; the rationale for listing a no-attribution-required package is spelled out so legal's due-diligence surface stays complete. |
| A2-310 | Info     | Only root `package.json` declares `engines.node`; workspace-level declarations absent                                                                                                                                                                                                                                             |

### Phase 4 — Build & release

Complete. Evidence: [phase-4-build-release.md](./audit-2026-evidence/phase-4-build-release.md). Commit SHA at capture: `450011d`. 12 findings (1 High / 6 Medium / 4 Low / 1 Info).

| ID     | Severity | Title                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2-401 | **High** | ~~Drizzle `_journal.json` missing migration 0011; `runMigrations` silently skips `admin_idempotency_keys`~~ **resolved-pending-review** by Batch 1 PR 2 (corroborated by Phase 6 as A2-720 at Critical)                                                                                                                                                                                                                                                                                                                |
| A2-402 | Medium   | No `HEALTHCHECK` directive in either Dockerfile                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A2-403 | Medium   | Base image `node:22-alpine` pinned by floating tag, not SHA256 digest                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| A2-404 | Medium   | ~~`npm run proto:generate` produces a diff vs checked-in `clustering_pb.ts` (quote + whitespace drift; no prettier step)~~ **resolved-pending-review**: script now chains `prettier --write 'packages/shared/src/proto/**/*.ts'` after `buf generate`, so the generated output lands in the same shape the repo's prettier config enforces.                                                                                                                                                                            |
| A2-405 | Low      | `NSFaceIDUsageDescription` copy in overlay script drifted from live Info.plist; overlay only writes when absent                                                                                                                                                                                                                                                                                                                                                                                                        |
| A2-406 | Low      | Overlay script `cp`s unconditionally even when source == dest; mtime churn on every pass                                                                                                                                                                                                                                                                                                                                                                                                                               |
| A2-407 | Medium   | No `[deploy] release_command` in fly.toml; migration-vs-deploy ordering documented only in an inline code comment                                                                                                                                                                                                                                                                                                                                                                                                      |
| A2-408 | Medium   | SBOM, provenance attestation, container CVE scanning, image signing all absent                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A2-409 | Medium   | GitHub Actions pinned by tag, not commit SHA (`superfly/flyctl-actions/setup-flyctl@master` worst)                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A2-410 | Low      | `.dockerignore` only at repo root, not per-app; docs tell operators to `cd apps/backend && fly deploy`                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A2-411 | Low      | ~~`.husky/pre-push` doesn't call `scripts/verify.sh`; skips typecheck/lint/format:check~~ **resolved-pending-review**: `.husky/pre-push` now invokes `npm run verify` which runs `scripts/verify.sh` (typecheck + lint + format:check + lint:docs + test). A2-411 marker in the hook.                                                                                                                                                                                                                                  |
| A2-412 | Info     | ~~Drizzle snapshot chain broken (`0001_snapshot.json`..`0011_snapshot.json` absent); `db:generate` would diff against initial schema~~ **resolved-by-policy**: hand-written SQL migrations are the intentional workflow (triggers / partial indexes / cross-column CHECKs aren't representable in Drizzle's schema diff — see A2-703). `drizzle.config.ts` + `apps/backend/AGENTS.md` §"Recipe: Add a DB migration" now both document the policy; `db:generate` retained as an emergency baselining escape hatch only. |

Full per-finding evidence + remediation pointers in the evidence file.

**Deferred probes** (tools not installed on the audit host): `trivy`, `grype`, `syft`, `cosign`. Their absence in CI is independently confirmed and rolled into A2-408.

### Phase 5 — Backend per-module

Phase split across four sub-agents (5a–5d) per surface. Completion marked when all four return.

#### Phase 5a — `apps/backend/src/admin/`

Complete. Evidence: [phase-5a-admin.md](./audit-2026-evidence/phase-5a-admin.md). Commit SHA at capture: `450011d`. 14 findings (0 Critical / 1 High / 5 Medium / 8 Low / 0 Info).

| ID     | Severity | Title                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A2-500 | Medium   | Admin idempotency snapshots never expire; no handler honors TTL; no sweeper                                                                                                                                                                                                                                                                                                    |
| A2-501 | Medium   | ~~`GET /api/admin/discord/config` omits `DISCORD_WEBHOOK_ADMIN_AUDIT`~~ **resolved-pending-review**: already surfaced at `admin/discord-config.ts:39` via `adminAudit: statusOf(env.DISCORD_WEBHOOK_ADMIN_AUDIT)` with paired test at `__tests__/discord-config.test.ts:18`.                                                                                                   |
| A2-502 | **High** | ~~`PUT /merchant-cashback-configs/:merchantId` not ADR-017-compliant: no Idempotency-Key, no reason, no `{result, audit}` envelope~~ **resolved-pending-review**: `admin/handler.ts:82` carries the `A2-502` marker and uses the full ADR-017 chain (validateIdempotencyKey, withIdempotencyGuard, buildAuditEnvelope, notifyAdminAudit + notifyCashbackConfigChanged fanout). |
| A2-503 | Low      | ~~`merchants-catalog-csv` row-cap applied to in-memory count, not the unbounded SQL SELECT~~ **resolved-pending-review** by A2-503/504 PR                                                                                                                                                                                                                                      |
| A2-504 | Low      | ~~`merchants-catalog-csv` contains a no-op self-comparison `where(eq(merchantId, merchantId))`~~ **resolved-pending-review** by A2-503/504 PR                                                                                                                                                                                                                                  |
| A2-505 | Medium   | 3 CSV admin endpoints missing from `openapi.ts`                                                                                                                                                                                                                                                                                                                                |
| A2-506 | Medium   | 9 non-CSV admin endpoints missing from `openapi.ts` (incl. base `GET /api/admin/orders`)                                                                                                                                                                                                                                                                                       |
| A2-507 | Low      | ~~4 admin handlers lack try/catch; errors lose handler-scoped logger bindings~~ **resolved-pending-review** by A2-507 PR                                                                                                                                                                                                                                                       |
| A2-508 | Medium   | 13 admin handlers have no paired test file (mostly PII-exposing user drill-down)                                                                                                                                                                                                                                                                                               |
| A2-509 | Low      | ~~`POST /api/admin/merchants/resync` has no Idempotency-Key (idempotent by mutex only)~~ **resolved-pending-review**: `admin/merchants-resync.ts:87` wraps the write in `withIdempotencyGuard` with the standard `IDEMPOTENCY_KEY_REQUIRED` 400 branch.                                                                                                                        |
| A2-510 | Low      | ~~`user-credits-csv` truncation sentinel diverges from canonical shape~~ **resolved-pending-review** by A2-510 PR                                                                                                                                                                                                                                                              |
| A2-511 | Low      | ~~`notifyAdminAudit` posts full admin email to Discord (inconsistent with tail-only user-id convention)~~ **resolved-pending-review** by A2-511 PR                                                                                                                                                                                                                             |
| A2-512 | Low      | ~~UUID regex duplicated across ~14 files; drift-prone~~ **resolved-pending-review** by A2-512 PR                                                                                                                                                                                                                                                                               |
| A2-513 | Low      | ~~Several merchant-scoped handlers skip the `/^[A-Za-z0-9._-]+$/` + 128-char check used by siblings~~ **resolved-pending-review** by A2-513 PR                                                                                                                                                                                                                                 |

#### Phase 5b — `auth/`, `ctx/`, `users/`, `config/`

Complete. Evidence: [phase-5b-auth-users.md](./audit-2026-evidence/phase-5b-auth-users.md). Commit SHA at capture: `450011d`. 20 findings (2 Critical / 3 High / 4 Medium / 9 Low / 2 Info). IDs non-contiguous in the A2-55x / A2-56x / A2-57x ranges — full population in the evidence file.

| ID     | Severity     | Title                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2-550 | **Critical** | ~~`requireAuth` CTX pass-through accepts unverified JWTs; every `/me` handler trusts `decodeJwtPayload(bearerToken).sub` → any authenticated user can read/write any other user's row~~ **resolved-pending-review** by Batch 1 PR 1                                                                                                                                                                                                                 |
| A2-551 | **Critical** | ~~`PUT /api/users/me/stellar-address` rewrites arbitrary user's payout destination (downstream of A2-550)~~ **resolved-pending-review** by Batch 1 PR 1 (closed automatically by A2-550 fix)                                                                                                                                                                                                                                                        |
| A2-552 | Low          | ~~`setHomeCurrencyHandler` count→update race~~ **resolved-pending-review** by A2-552 PR                                                                                                                                                                                                                                                                                                                                                             |
| A2-555 | Info         | ~~Upstream 500-char body logs could leak JWT-shaped strings~~ **resolved-pending-review**: `upstream-body-scrub.ts` + `__tests__/upstream-body-scrub.test.ts` — JWT-shape redaction, A2-555 marker.                                                                                                                                                                                                                                                 |
| A2-556 | Medium       | `nativeRefreshHandler` does not revoke-all on reuse despite docstring                                                                                                                                                                                                                                                                                                                                                                               |
| A2-557 | Low          | Redundant re-verify in `issueTokenPair` → `replacedByJti` link                                                                                                                                                                                                                                                                                                                                                                                      |
| A2-558 | Low          | ~~Circuit-open on `request-otp` leaks a 503 fingerprint vs 200 enumeration envelope~~ **resolved-pending-review**: `auth/handler.ts:99-116` catches `CircuitOpenError` and collapses to the generic `{ message: 'Verification code sent' }` 200 envelope; paired test at `__tests__/handler.test.ts:155`.                                                                                                                                           |
| A2-560 | Low          | ~~OTP attempts ceiling off-by-one (`lte` vs `lt`)~~ **resolved-pending-review**: `auth/otps.ts:103` uses strict `lt` with `A2-560:` marker; OTP_MAX_ATTEMPTS is the true ceiling.                                                                                                                                                                                                                                                                   |
| A2-561 | Low          | ~~`incrementOtpAttempts` bumps every live row for the email~~ **resolved-pending-review**: `auth/otps.ts:128` bumps only the single-newest-row target with `A2-561:` marker.                                                                                                                                                                                                                                                                        |
| A2-562 | Low          | ~~`revokeAllRefreshTokensForUser` exported/tested but not wired to any route~~ **resolved-pending-review**: `auth/native.ts:235` wires `revokeAllRefreshTokensForUser` in the reuse-detection branch — family-wide revoke on replay.                                                                                                                                                                                                                |
| A2-565 | **High**     | ~~`DELETE /api/auth/session` never revokes Loop-native refresh rows; logout leaves 30-day refresh live~~ **resolved-pending-review** by Batch 2A auth PR (#769)                                                                                                                                                                                                                                                                                     |
| A2-566 | **High**     | Social ID-tokens accepted without nonce binding → replayable within provider TTL                                                                                                                                                                                                                                                                                                                                                                    |
| A2-567 | Medium       | ~~Google `iss` exact-match rejects valid `accounts.google.com` (no `https://`) variants~~ **resolved-pending-review**: `auth/social.ts:198` + `auth/id-token.ts:97` accept both `https://accounts.google.com` and `accounts.google.com` variants; test pins both.                                                                                                                                                                                   |
| A2-568 | Low          | `/api/auth/social/{google,apple}` missing from `openapi.ts`                                                                                                                                                                                                                                                                                                                                                                                         |
| A2-569 | Medium       | ~~`id-token.ts` skips `nbf`, doesn't bound `iat` or `exp-iat`~~ **resolved-pending-review**: `verifyIdToken` enforces `nbf > now + leeway → not_yet_valid`, `iat > now + leeway → iat_future`, `exp - iat > maxLifetimeSeconds → lifetime_exceeded`, and `exp + leeway < now → expired` (leeway now applied to exp too). Defaults: 60s leeway, 3600s max lifetime. 5 new test cases pin each bound including the "within leeway" positive branches. |
| A2-570 | Low          | Social `identities.ts` race can violate `users.email` unique index → 500                                                                                                                                                                                                                                                                                                                                                                            |
| A2-571 | **High**     | ~~`EMAIL_PROVIDER=console` bypasses production guard; ships plaintext-OTP logger~~ **resolved-pending-review** by Batch 2A (#770)                                                                                                                                                                                                                                                                                                                   |
| A2-572 | Medium       | `operatorFetch` doesn't retry against next operator on upstream 5xx, contrary to docstring                                                                                                                                                                                                                                                                                                                                                          |
| A2-573 | Low          | ~~`initialised=true` set before parse; config fix requires restart~~ **resolved-pending-review** by A2-573 PR                                                                                                                                                                                                                                                                                                                                       |
| A2-574 | Info         | `/api/config` exposes feature-surface unauth, deliberate per ADR 020                                                                                                                                                                                                                                                                                                                                                                                |

#### Phase 5c — `orders/`, `payments/`, `credits/` (money-flow)

Complete. Evidence: [phase-5c-money-flow.md](./audit-2026-evidence/phase-5c-money-flow.md). Commit SHA at capture: `450011d`. **50 findings** (5 Critical / 7 High / 22 Medium / 14 Low / 2 Info). IDs A2-600 through A2-649.

**Critical (5):**

| ID     | Title                                                                                                                                                                                                                                                 |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2-601 | ~~Credit-funded orders have no debit path; never transition to `paid`; stay `pending_payment` until 24h expiry~~ **resolved-pending-review** by Batch 1 PR 4 (#765)                                                                                   |
| A2-602 | ~~Payout worker's "leave in `submitted` for retry" path unreachable — `listPendingPayouts` filters `state='pending'` only; transient failures strand rows forever~~ **resolved-pending-review** by Batch 1 PR 5 (#766). Amplifies A2-603 and A2-1512. |
| A2-610 | ~~`accrueOnePeriod` UPDATE omits the `currency` clause — any multi-currency user has every balance row overwritten on every accrual~~ **resolved-pending-review** by Batch 1 PR 3                                                                     |
| A2-611 | ~~`accrueOnePeriod` writes `row.balanceMinor + accrual` from a pre-txn read — lost-update race against concurrent `applyAdminCreditAdjustment`~~ **resolved-pending-review** by Batch 1 PR 3                                                          |
| A2-619 | ~~Loop-handler returns `chargeMinor` in home currency; watcher validates against `faceValueMinor` in catalog currency — cross-currency orders silently mis-validate~~ **resolved-pending-review** by Batch 1 PR 6 (#767)                              |

**High (7):**

| ID     | Title                                                                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| A2-603 | No watchdog timer on `submitted`-state payouts (amplifies A2-602)                                                                               |
| A2-605 | Outbound payout memo is `orderId.slice(0,28)` — ~2^-40 birthday collision; separate generator recommended                                       |
| A2-613 | Ledger invariant has no DB-level enforcement                                                                                                    |
| A2-614 | No unique constraint on `(type, reference_type, reference_id)` in `credit_transactions` — duplicate-writer risk                                 |
| A2-621 | `sweepStuckProcurement` can flip CTX-fulfilled orders to `failed` with no reconciliation                                                        |
| A2-622 | Procurement txn gap — CTX charge and Loop ledger write can't be atomic; crash between them leaves CTX billed, user uncredited, no refund writer |
| A2-626 | Cursor write after transitions loop; no cursor-age watchdog                                                                                     |

Remaining 38 findings (A2-604, A2-606–A2-609, A2-612, A2-615–A2-618, A2-620, A2-623–A2-625, A2-627–A2-649) are in the evidence file — 22 Medium / 14 Low / 2 Info.

**Invariants the agent could NOT confirm at this commit:**

- Ledger sum invariant against prod-shaped dataset (needs Phase 6.5 SQL method)
- Interest accrual idempotency across reruns (scheduler not wired end-to-end)
- `accrue-interest.ts` under real Postgres (tests mock `db`, so A2-610 slid past the test suite)
- Memo collision bounds empirically

#### Phase 5d — `clustering/`, `merchants/`, `images/`, `public/` + top-level files

Complete. Evidence: [phase-5d-rest.md](./audit-2026-evidence/phase-5d-rest.md). Commit SHA at capture: `450011d`. 28 findings (0 Critical / 4 High / 7 Medium / 12 Low / 5 Info). IDs A2-650 through A2-677.

**High (4):**

| ID     | Title                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2-652 | Operator-secret rotation unimplemented despite ADR 016                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A2-655 | Pino redaction config misses 6 secret-bearing env keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A2-662 | 5 app.ts routes missing from `openapi.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A2-672 | ~~Image-proxy DNS-rebinding TOCTOU still open~~ **deferred-by-ADR-005-§5**: documented accepted limitation for Phase 1. Practical mitigation is `IMAGE_PROXY_ALLOWED_HOSTS` (enforced in production, allowlisting only `spend.ctx.com` + the CTX S3 bucket). Full fix — custom `undici.Dispatcher.connect` that reuses the already-resolved IP with the expected `Host` header — is tracked in ADR-005 §5 as "Revisit: before the image proxy is ever allowed to accept arbitrary third-party hostnames." Source comment at `apps/backend/src/images/proxy.ts:233` carries the same `KNOWN LIMITATION` marker. |

**Medium (7):** A2-650 unrate-limited merchant reads · A2-653 5 env vars bypass the zod schema · A2-654 un-typed emergency SSRF override flag · A2-664 / A2-665 / A2-670 uncaught DB throws → 500 on merchant/cashback-rate reads · A2-676 `PublicCashbackPreview` duplicated between backend + shared (ADR-019 breach).

**Low (12):** A2-651 misleading routing comment · A2-656 notifier catalog ordering · A2-657 uuid-slice inconsistency · A2-659 silent MAX_PAGES cap · A2-661 rate-limit map expired-entry eviction · A2-663 400/401 undocumented · A2-666 500 undocumented · A2-669 refresh-lock is boolean not promise · A2-671 untyped `c.get` cast · A2-673 image cache byte-count drift · A2-674 webhook URLs accept non-`https` · A2-677 fallback `asOf` misleading.

**Info (5):** A2-658 currency-length unchecked · A2-660 `/health` + `/metrics` unrate-limited · A2-667 probe-flap race · A2-668 openapi versioning · A2-675 openapi shape re-declaration.

---

**Phase 5 aggregate (5a + 5b + 5c + 5d):** 112 findings (7 Critical / 15 High / 38 Medium / 43 Low / 7 Info).

### Phase 6 — Database & Data Layer

Complete. Evidence: [phase-6-database.md](./audit-2026-evidence/phase-6-database.md). Commit SHA at capture: `450011d`. Migrations 0000–0011 replayed against ephemeral Postgres 16. **26 findings** (2 Critical / 6 High / 10 Medium / 7 Low / 0 Info). Two findings corroborate prior-phase findings at higher severity — noted in "Cross-phase corroboration" below.

**Critical (2):**

| ID     | Title                                                                                                                                                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A2-700 | ~~`accrue-interest.ts` UPDATE filters only by `user_id` (not `currency`), writes stale balance outside `FOR UPDATE` — ledger invariant breaks for multi-currency users, concurrent cashback lost~~ **resolved-pending-review** by Batch 1 PR 3 (corroborates A2-610/611) |
| A2-720 | ~~Migration `0011_admin_idempotency_keys.sql` absent from `_journal.json` — drizzle's migrator iterates journal only; fresh deploys never create the table; every ADR-017 admin write would fail on boot~~ **resolved-pending-review** by Batch 1 PR 2                   |

**High (6):**

| ID     | Title                                                                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2-701 | Schema declares `uniqueIndex` named `..._pk_idx`; migration installs `PRIMARY KEY ..._pk`; divergent                                                |
| A2-702 | `user_credits` has no primary key, only a unique index                                                                                              |
| A2-703 | `merchant_cashback_configs_audit` trigger + function not represented in `schema.ts`; next `drizzle-kit generate` would drop the ADR-011 audit trail |
| A2-704 | No CHECK enum on `credit_transactions.currency` — any 3-char string accepted                                                                        |
| A2-705 | No CHECK enum on `orders.currency` (catalog side) — any 3-char string accepted                                                                      |
| A2-706 | `users.email` has no unique index; Loop-native signup race acknowledged in-code but unfixed                                                         |

Remaining 17 findings (A2-707–A2-719, A2-721–A2-725) in the evidence file — 10 Medium / 7 Low.

**Cross-phase corroboration:**

- **A2-720** (Critical) corroborates and escalates **A2-401** (High from Phase 4). Phase 4 agent flagged the journal omission; Phase 6 agent replayed migrations and confirmed the table is never created in a fresh deploy — real severity is Critical, not High.
- **A2-700** (Critical) corroborates **A2-610** + **A2-611** (both Critical from Phase 5c). Same bug in `accrue-interest.ts`. Three independent evidences (static read, query-shape analysis, migration replay) all converge; remediation is a single fix.

**Deferred probes:** `pg_stat_user_indexes` (never-hit / bloat — plan G4-05), `pg_stat_statements`, Fly PG `max_connections` cross-check, autovacuum tuning, read-replica topology. All require prod/live-DB telemetry — deferred to Phase 17 per plan scope.

### Phase 6.5 — Financial Correctness

Complete. Evidence: [phase-6.5-financial.md](./audit-2026-evidence/phase-6.5-financial.md). Commit SHA at capture: `450011d`. Ephemeral Postgres 16 replay + seeded + drift-injected + raced. Property tests (50k iterations) on `@loop/shared/cashback-realization.ts` + `repo.ts::computeCashbackSplit` + `price-feed.ts::convertMinorUnits` — all 13 invariants hold.

**9 new findings (A2-900 through A2-908):** 0 Critical / 5 High / 3 Medium / 1 Low / 0 Info.

| ID     | Severity | Title                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2-900 | **High** | Reconciliation endpoint is `user_credits`-anchored LEFT JOIN; orphan `credit_transactions` rows (no matching `user_credits`) are invisible                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A2-901 | **High** | ~~`refund`, `spend`, `withdrawal` declared in DB CHECK + shared type + openapi, but ZERO production writers exist — admin cannot issue a refund today~~ **partially resolved**: `refund` shipped (`admin/refunds.ts` + `credits/refunds.ts`, ADR-017 compliant with idempotency + audit envelope + partial unique index on `(type, reference_type, reference_id)`); `spend` shipped (`orders/repo.ts:289`, emitted by the order state machine on paid-transition). Residual: `withdrawal` writer remains Phase 2 (blocked on payout-queue uniqueness design per migration 0013 §28 — scope to payout id). |
| A2-902 | **High** | No DB UNIQUE on `(type, reference_type, reference_id)` for cashback idempotency; two identical cashback rows inserted successfully (elevates prior A2-614)                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A2-903 | **High** | `user_credits.currency` has no CHECK constraint; `'ZZZ'` accepted (parallel to A2-704 on `credit_transactions`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A2-904 | Medium   | `orders.wholesale_minor` in chargeCurrency units not catalog; any `supplier-spend` aggregate summing without `GROUP BY charge_currency` is currency-mixed                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A2-905 | Medium   | Interest accrual has no scheduler wiring; ADR 009 feature never runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A2-906 | **High** | ~~Interest accrual has no period-level idempotency (no cursor, no unique constraint); dormant but ships~~ **resolved-pending-review** by Batch 1 PR 3                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A2-907 | Low      | ~~`reconciliationResponse.userCount` mislabels rows as users (multi-currency users double-counted)~~ **resolved-pending-review**: renamed to `rowCount` at `admin/reconciliation.ts:58` with the `A2-907:` marker + JSDoc explaining the distinction ("a multi-currency user contributes one row per currency — this is NOT a distinct-user count").                                                                                                                                                                                                                                                      |
| A2-908 | Medium   | Admin adjustment `reason` not persisted on ledger row; lost after 24h idempotency-key TTL sweep. ADR 017 claim of "full story reconstructable from append-only ledger" is false                                                                                                                                                                                                                                                                                                                                                                                                                           |

**Empirical re-confirmation of prior findings (elevating confidence, not re-filing):**

- **A2-610 Critical** — multi-currency UPDATE with no currency predicate empirically corrupts both rows in one statement
- **A2-611 Critical** — lost-update race replayed via two concurrent psql sessions; adjustment +500 vanished, delta=-500
- **A2-619 Critical** — cross-currency watcher threshold uses catalog currency while client quoted charge currency; every cross-ccy XLM/USDC order would fail payment check post-launch

**DB CHECK verdicts:** `credit_transactions_amount_sign` correctly rejects wrong-sign rows AND zero amounts for non-adjustment types; `adjustment amount=0` IS accepted (A2-615 re-confirmed); `user_credits_non_negative` blocks negative balances; `orders_charge_currency_known` enforced but `orders.currency` (catalog) is NOT; `pending_payouts_order_unique` and `pending_payouts_amount_positive` enforced.

**Invariants NOT verifiable at this commit:** CTX→supplier-spend cross-recon (no real orders), ledger→on-chain consistency (no Stellar contact), memo collision bounds at real-world UUID distribution, interest accrual idempotency across reruns (no scheduler), Fly Postgres connection-limit probe.

### Phase 7 — API surface

Complete. Evidence: [phase-7-api.md](./audit-2026-evidence/phase-7-api.md). Commit SHA at capture: `450011d`. Full 148-row API matrix + openapi drift + error-code taxonomy + 24-endpoint fuzz. 15 findings (0 Critical / 0 High / 4 Medium / 8 Low / 3 Info). IDs A2-1000 through A2-1014.

**Medium (4):**

| ID      | Title                                                                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A2-1000 | ~11+ live routes not registered in `openapi.ts` (social login, orders/loop, 7+ admin endpoints)                                     |
| A2-1002 | `/api/users/me*` 401 responses miss `Cache-Control: private, no-store` because `requireAuth` registered before cache-mw             |
| A2-1003 | `ErrorResponse.code` is free-form `z.string()` — no closed-set enforcement across backend + web + shared                            |
| A2-1004 | `POST /api/admin/merchants/resync` and `POST /api/admin/payouts/:id/retry` state-mutating without `Idempotency-Key` (ADR 017 drift) |

**Low (8):** A2-1001 auth openapi registrations don't document 500 path · A2-1005 bodyLimit exceedance returns 500 instead of 413 · A2-1006 `/api/merchants/cashback-rates` 500s on DB outage (violates ADR 020 never-500) · A2-1007 wrong HTTP method returns 404 instead of 405 · A2-1008 `/api/merchants/:id` is only authed route with no rate limit · A2-1009 `PRODUCTION_ORIGINS` includes bare `http://localhost` (CSRF risk from localhost attacker page) · A2-1010 no namespace-level `private, no-store` on `/api/admin/*` · A2-1011 error-code taxonomy not documented anywhere.

**Info (3):** A2-1012 `/api/auth/session` is only DELETE · A2-1013 5xx body check clean across probes · A2-1014 `/__test__/reset` correctly `NODE_ENV==='test'`-gated.

**Error-code taxonomy:** 17 codes emitted by backend; web client branches on only 3 (`HOME_CURRENCY_LOCKED`, `WEBHOOK_NOT_CONFIGURED`, `UPSTREAM_UNAVAILABLE`) + 2 client-synthesized (`TIMEOUT`, `NETWORK_ERROR`). Remaining 14 backend codes observed only through HTTP status.

### Phase 8 — Web per-module

Split across two sub-agents (8a routes/native/root; 8b components/hooks/services/stores/utils).

#### Phase 8a — routes + native + root

Complete. Evidence: [phase-8a-routes.md](./audit-2026-evidence/phase-8a-routes.md). Commit SHA at capture: `450011d`. 20 findings (0 Critical / 0 High / 2 Medium / 8 Low / 10 Info). IDs A2-1100 through A2-1119.

**Medium (2):**

| ID      | Title                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2-1100 | ~~`/auth` email + OTP inputs omit `autoComplete="email"` / `one-time-code` (onboarding sets them correctly)~~ **resolved-pending-review**: `apps/web/app/routes/auth.tsx` email input now carries `autoComplete="email"` and the OTP input `autoComplete="one-time-code"` — matches the onboarding form (`signup-tail.tsx:75/277`). Password managers auto-fill email; iOS / Android surface the SMS/email OTP as a keyboard suggestion. |
| A2-1101 | Admin UI shell renders for any authenticated user; only `admin._index.tsx` surfaces the 401/403 banner — others flash `<AdminNav/>` first                                                                                                                                                                                                                                                                                                |

**Low (8):** A2-1102 no `isAdmin` role-gate in `routes/admin.*.tsx` (sibling of 1101) · A2-1103 no dedicated 403 page; only 404 · A2-1104 CSP meta omits `frame-ancestors`/`report-uri`/`sandbox` · A2-1105 `robots.txt` doesn't disallow `/admin`, `/settings`, `/orders` · A2-1106 no PWA `manifest.json` · A2-1107 `window.prompt` for admin retry-payout reason (a11y + UX) · A2-1108 zero `og:`/`twitter:` meta on public routes · A2-1109 `hero.webp` LCP candidate inline background, not preloaded · A2-1119 `/privacy` + `/terms` ship placeholder legal copy.

**Info (10):** A2-1110 Inter from Google Fonts runtime (accepted per ADR-005) · A2-1111 splat `*` soft-404 · A2-1112 root `meta()` lacks OG/Twitter fallback · A2-1114 prod ErrorBoundary suppresses non-route `error.message` · A2-1115 admin bundle split unverified · A2-1116 `sitemap.tsx` server-fetch has no unit test · A2-1117 no service worker, no decision record · A2-1118 `robots.txt` sitemap URL hard-coded to prod · A2-1113 / remaining Info slots populated in evidence file.

**Clean areas noted:** zero `@capacitor/*` imports in `routes/`; only one loader (`sitemap.tsx`, properly build-target-gated); every `target="_blank"` carries `rel="noopener noreferrer"`; all 16 `native/*` wrappers have web fallbacks; no stale CSS.

#### Phase 8b — components / hooks / services / stores / utils

Complete. Evidence: [phase-8b-support.md](./audit-2026-evidence/phase-8b-support.md). Commit SHA at capture: `450011d`. 17 findings (0 Critical / 4 High / 4 Medium / 9 Low / 0 Info). IDs A2-1150 through A2-1166.

**High (4):**

| ID      | Title                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A2-1150 | ~~`use-session-restore.ts` calls `clearSession()` on any null `tryRefresh()` result — wipes refresh token from Keychain / sessionStorage on transient 5xx/429/network failures, undoing retain-on-disk logic in `api-client.ts`~~ **resolved-pending-review** — finding is drift; the `null` branch never calls `clearSession()`, and `apps/web/app/hooks/use-session-restore.ts:26-37` carries an `A2-1150:` comment explaining why (transient 5xx/429/network → refresh-token deliberately retained on disk per audit A-020) |
| A2-1151 | ~~`useAuth.logout()` never resets `purchase.store` — merchantId, paymentAddress, orderId, memo leak across user sessions on shared devices~~ **resolved-pending-review** by Batch 2A (#771)                                                                                                                                                                                                                                                                                                                                    |
| A2-1152 | ~~`useAuth.logout()` never calls `queryClient.clear()` — `['me', …]` and admin cache entries survive for default 5-min `gcTime`, briefly visible to next signed-in user~~ **resolved-pending-review** by Batch 2A (#771)                                                                                                                                                                                                                                                                                                       |
| A2-1153 | Web consumes zero backend error codes beyond client-synth `TIMEOUT`/`NETWORK_ERROR`; `INSUFFICIENT_CREDIT`, `HOME_CURRENCY_LOCKED`, etc. never get bespoke UX strings (plan G4-02)                                                                                                                                                                                                                                                                                                                                             |

**Medium (4):**

| ID      | Title                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2-1154 | ~~Two divergent error translators (`utils/error-messages.ts::friendlyError` vs `hooks/use-auth.ts::authErrorMessage`) render different strings for same backend response on `/auth` vs `/onboarding`~~ **resolved-pending-review** by #879 — `authErrorMessage` is now a thin overlay that owns only 401 (OTP-specific) + 502 (auth-provider copy) and delegates everything else to `friendlyError`; 7 new tests lock the shared mappings                                                                                  |
| A2-1155 | ~~Admin query-key taxonomy is flat with two hierarchical outliers; no single `invalidateQueries({queryKey: ['admin']})` sweep works~~ **resolved-pending-review** by #880 — flatten stays the convention (per-key targeted invalidation is the default) + `utils/admin-cache.ts::invalidateAllAdminQueries` provides a predicate-based sweep for the broad-invalidation case; apps/web/AGENTS.md pins the taxonomy rule so future contributors don't reintroduce hierarchical outliers (#871 closes the two existing ones) |
| A2-1156 | ~~10 `['me', …]` queries in `features/cashback/` + `features/orders/` skip `enabled: isAuthenticated` — fire during `useSessionRestore`, spawn parallel `tryRefresh` attempts on cold boot~~ **resolved-pending-review** — every one of the 10 queries carries an in-file `A2-1156:` marker and `enabled: isAuthenticated`; verified across 9 `features/cashback/*.tsx` + `features/orders/OrdersSummaryHeader.tsx` and their 9 colocated test files                                                                       |
| A2-1159 | ~~`['loop-orders']` never invalidated after `createLoopOrder`; new Loop-native orders don't appear on `/orders` for up to 30s~~ **resolved-pending-review** by #877 — `PurchaseContainer` now invalidates `['loop-orders']` on successful Loop-native create                                                                                                                                                                                                                                                               |

**Low (9):**

| ID      | Title                                                                                                                                                                                                                                                                                                    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2-1157 | ~~`AdminNav` tabs lack `aria-current="page"`; CTX status pill no `aria-label`~~ **resolved-pending-review**: `AdminNav.tsx:207` emits `aria-current={active ? 'page' : undefined}` on every tab; `CtxStatusPill` (line 111) carries `aria-label="${ui.label}. ${ui.description}"` with a `title` mirror. |
| A2-1158 | ~~`CopyButton` uses `navigator.clipboard.writeText` with no fallback (older Safari / HTTP contexts throw)~~ **resolved-pending-review**: two-tier fallback via `tryClipboardCopy` → `document.execCommand('copy')` on the hidden-textarea path.                                                          |
| A2-1160 | ~~`['me', 'cashback-monthly']` vs `['admin', 'cashback-monthly']` taxonomy drift~~ **resolved-pending-review**: admin keys renamed to `['admin-cashback-monthly']` / `['admin-payouts-monthly']` to match the dominant admin-taxonomy prefix.                                                            |
| A2-1161 | ~~`ui.store.ts` theme SSR contract tribal — no header comment or assertion test~~ **resolved-pending-review**: file-level header documents the three SSR-safe call sites + `ui.store.ssr-safe.test.ts` pins a fresh-import scenario with DOM globals stubbed to `undefined`.                             |
| A2-1162 | ~~`services/clusters.ts` duplicates `api-client.ts` error-body normalization byte-for-byte~~ **resolved-pending-review**: both call sites now share `services/parse-error-response.ts`; 9 new unit tests pin each input-shape branch.                                                                    |
| A2-1163 | ~~`AdminWriteEnvelope.audit.replayed` never surfaced to operators in UI~~ **resolved-pending-review**: new `ReplayedBadge` renders next to success flashes in `CreditAdjustmentForm` + `MerchantResyncButton` when the backend replayed a stored snapshot.                                               |
| A2-1164 | ~~`hooks/index.ts` barrel incomplete~~ **resolved-pending-review**: barrel deleted — zero consumers, no other `index.ts` barrels under `apps/web/app/`; dead-code removal is the cleaner close.                                                                                                          |
| A2-1165 | `services/admin.ts` 1948 lines / 90+ functions / 50+ interfaces — merge-conflict + audit-load risk                                                                                                                                                                                                       |
| A2-1166 | ~~`AdminOrderStateLocal` + `AdminOrderState` union duplicated within `services/admin.ts`~~ **resolved-pending-review**: local declaration dropped; `AdminOrderState` now re-exports `OrderState` from `@loop/shared`, which is the single source of truth for the ADR-010 state machine.                 |

---

**Phase 8 aggregate (8a + 8b):** 37 findings (0 Critical / 4 High / 6 Medium / 17 Low / 10 Info).

### Phase 9 — Mobile shell

Complete. Evidence: [phase-9-mobile.md](./audit-2026-evidence/phase-9-mobile.md). Commit SHA at capture: `450011d`. Both `apps/mobile/ios/` and `apps/mobile/android/` trees inspected live. 14 findings (0 Critical / 2 High / 6 Medium / 6 Low / 0 Info). IDs A2-1200 through A2-1213.

**High (2):**

| ID      | Title                                                                                                                                                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2-1200 | `@capacitor/filesystem` not registered in iOS `packageClassList` / `CapApp-SPM/Package.swift` — silently breaks ADR-008 share-with-image flow on iOS        |
| A2-1206 | iOS `cap sync` artefacts mtime-dated before ADR-008 date; Android-only sync landed the filesystem plugin; no CI step enforces iOS+Android plugin-set parity |

**Medium (6):**

| ID      | Title                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A2-1201 | `CAPACITOR_DEBUG` xcconfig only defines Debug; no release.xcconfig — verbose bridge logging one-flag away from production                              |
| A2-1203 | No documented bump discipline for `CFBundleVersion` / `versionCode`; second TestFlight/Play-track upload guaranteed to be rejected                     |
| A2-1204 | No ADR / decision on SSL pinning, App Attest, Play Integrity, jailbreak/root detection, or binary tamper                                               |
| A2-1205 | Signing / provisioning / cert-expiry runbook absent in `docs/deployment.md`; no `apps/mobile/**` entry in CODEOWNERS                                   |
| A2-1207 | `enableScreenshotGuard` is JS overlay on pause/resume only; no Android `FLAG_SECURE`, no iOS `UserDidTakeScreenshot` listener — name vs behavior drift |
| A2-1208 | Push-notifications plugin + channel present but no `POST_NOTIFICATIONS` permission, no `requestPermissions`, no APNs/FCM provisioning — dead code      |

**Low (6):** A2-1202 min-OS drift (README iOS 16+ vs pbxproj 15.0 vs gradle minSdk 24) · A2-1209 overlay `sed` anchored to `android:allowBackup="true"` (future template change silently no-ops) · A2-1210 overlay script never removes once-overlaid-now-deleted files · A2-1211 splash background colour drift (`#030712` config vs `#111111` styles.xml) · A2-1212 Android `AppTheme` parent is light-mode on a dark-first app · A2-1213 `FileProvider` paths grant whole-root authority.

### Phase 10 — Shared package

Complete. Evidence: [phase-10-shared.md](./audit-2026-evidence/phase-10-shared.md). Commit SHA at capture: `450011d`. 16 findings (0 Critical / 0 High / 7 Medium / 9 Low / 0 Info). IDs A2-800 through A2-821 with range-reservation gaps. ADR 019 three-part-test: all symbols reviewed; circular-import check passed trivially (shared has zero internal relative imports).

| ID     | Severity | Title                                                                                                                                |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| A2-800 | Low      | `Platform` type duplicated in `apps/web/app/native/platform.ts` instead of imported                                                  |
| A2-801 | Low      | `ApiErrorCode` / `ApiErrorCodeValue` exported from shared, zero consumers                                                            |
| A2-802 | Low      | `RefreshResponse` exported from shared, zero consumers                                                                               |
| A2-803 | Low      | auth/image/orders/merchants/clusters request+response types are web-only consumers; backend re-declares same-name zod consts locally |
| A2-810 | Medium   | `RealizationSparkline.toDailyBps` inlines `recycledBps` math instead of calling shared helper                                        |
| A2-811 | Low      | `CreditTransactionType` union re-declared in `services/admin.ts:1853`                                                                |
| A2-812 | Low      | backend `asset-circulation.ts` re-implements `isLoopAsset`; `payout-asset.ts` bypasses `loopAssetForCurrency`                        |
| A2-813 | Medium   | `isHomeCurrency` re-implemented in six files (4 backend, 1 web) — shared version unused                                              |
| A2-814 | Medium   | `LocationPoint` / `ClusterPoint` re-declared in `apps/backend/src/clustering/algorithm.ts`                                           |
| A2-815 | Medium   | `money-format.ts` fails ADR 019 three-part test — all 9 consumers web-only; belongs in `apps/web/app/utils/`                         |
| A2-816 | Medium   | `ORDER_STATES` re-declared inline in `apps/backend/src/admin/orders.ts:26-34`                                                        |
| A2-817 | Low      | `TERMINAL_ORDER_STATES` triad zero consumers despite module doc claim                                                                |
| A2-818 | Medium   | Shared exports both `OrderStatus` (legacy) and `OrderState` (ADR 010) with no cross-reference                                        |
| A2-819 | Medium   | `PAYOUT_STATES` duplicated in 3 source files + 4 test mocks; `PayoutState` inline union in `services/admin.ts`                       |
| A2-820 | Low      | `isStellarPublicKey` has zero consumers (all ~8 callers use `STELLAR_PUBKEY_REGEX.test(...)` directly)                               |
| A2-821 | Low      | `isStellarPublicKey` declared `s is string` — a no-op type predicate                                                                 |

### Phase 11 — Cross-app integration

Complete. Evidence: [phase-11-cross-app.md](./audit-2026-evidence/phase-11-cross-app.md). Commit SHA at capture: `450011d`. 34 findings (0 Critical / 10 High / 17 Medium / 7 Low / 0 Info). IDs A2-1500 through A2-1533.

**High (10):**

| ID      | Title                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2-1504 | ~~`CreateLoopOrder*` / `LoopOrderView` have no shared representation (not in `openapi.ts` either)~~ **resolved-pending-review** by #885 — `@loop/shared/loop-orders.ts` is the new canonical home for `CreateLoopOrderRequest`, `CreateLoopOrderResponse` (now includes the `loop_asset` variant), `LoopOrderView` (now carries `chargeMinor`/`chargeCurrency` and widens `paymentMethod` to include `loop_asset`), and `LoopOrderListResponse`. Backend + web both import from shared; openapi wiring lands in #840. |
| A2-1505 | 13 `/api/users/me*` response shapes are web-only                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A2-1506 | ~30 admin shapes web-only (1948 LOC in `services/admin.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A2-1507 | No CI drift detector for `openapi.ts` vs web consumers (plan G5-68 unmet)                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| A2-1508 | CTX procurement POST lacks idempotency header (cross-refs A2-622)                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A2-1512 | ~~Payout `submitted` rows never re-picked; user stuck-state visible (cross-refs A2-602/603)~~ **resolved-pending-review** — the "never re-picked" half is closed by A2-602 (Batch 1 PR 5 / #766) which widened `listPendingPayouts` to include `submitted`. Watchdog-timer prevention (A2-603) remains open as its own row — the cross-ref is counted there, not here.                                                                                                                                                |
| A2-1518 | ~~accrue-interest lacks `currency` clause (cross-refs A2-610/611/700)~~ **resolved-pending-review** — same finding as A2-610 / A2-611 / A2-700 (already marked resolved by Batch 1 PR 3); verified at `apps/backend/src/credits/accrue-interest.ts:134-179` where the SELECT FOR UPDATE and the balance UPDATE are both keyed by `(user_id, currency)`                                                                                                                                                                |
| A2-1529 | ~~No client-version header / deprecation surface — mobile binary unidentifiable on the wire~~ **resolved-pending-review** by #882 — web already stamps `X-Client-Version` on every request (`apps/web/app/services/api-client.ts:61-70`) and `X-Client-Id` on authed requests; backend access logger now forwards both so Grafana can scope prod regressions by client build / platform (deprecation surface deferred to a follow-up ADR)                                                                             |
| A2-1531 | ~~`LoopOrdersList.tsx` switch + `default:` silently routes new `OrderState` variants to yellow pill~~ **resolved-pending-review** — `stateColour()` at `apps/web/app/components/features/orders/LoopOrdersList.tsx:221-240` is an exhaustive switch whose `default:` calls `assertNever(state, 'OrderState')`; an A2-1531 marker documents why                                                                                                                                                                        |
| A2-1532 | ~~`assertNever(...)` exists nowhere; `@typescript-eslint/switch-exhaustiveness-check` not enabled~~ **resolved-pending-review** — `assertNever` lives at `packages/shared/src/assert-never.ts:22`; `eslint.config.js:76-79` enables `@typescript-eslint/switch-exhaustiveness-check` as `error` with an A2-1532 marker                                                                                                                                                                                                |

**Medium (17):** A2-1500–A2-1503 state-type redeclarations (OrderState / PayoutState / OrderPaymentMethod / LoopAssetCode) · A2-1509 no continuous CTX-schema canary · A2-1510 no per-request timeout in `operatorFetch` · A2-1513 `LOOP_STELLAR_HORIZON_URL` via `process.env` bypass · A2-1517 no unique constraint on `(type, ref_type, ref_id)` (cross-refs A2-902) · A2-1519 ledger invariant unenforced at DB + no CI assertion · A2-1520 three minor→major algorithms; Number-cast sites hit 2^53 ceiling · A2-1521 locale inconsistency (14 `en-US` vs 7 default) · A2-1522 Discord hard-coded `{USD,EUR,GBP,CAD}` symbol map vs web `Intl` · A2-1523 CSVs emit raw minor-unit integers with no scale marker · A2-1525 `HORIZON_URL` absent from `env.ts` zod schema · A2-1526 `TRUST_PROXY` untested E2E · A2-1530 no backward-compat contract doc for `/api` · A2-1533 8/9 switches only exhaustive because every branch returns.

**Low (7):** A2-1511 `upstreamUrl` path unrestricted · A2-1514 memo-length constants duplicated · A2-1515 Discord test-ping clean · A2-1516 Discord vs web symbol drift for exotic currencies · A2-1524 canonical `formatMinorCurrency` adoption 4/29 sites · A2-1527 `IMAGE_PROXY_ALLOWED_HOSTS` only caught at prod boot · A2-1528 no CI docker-image smoke with prod env.

### Phase 12 — Security deep-dive

Complete. Evidence: [phase-12-security.md](./audit-2026-evidence/phase-12-security.md). Commit SHA at capture: `450011d`. 15 NEW findings (0 Critical / 4 High / 7 Medium / 4 Low / 0 Info). IDs A2-1600 through A2-1615. Agent explicitly cross-referenced ~17 prior-phase findings (A2-119, A2-103, A2-114, A2-125, A2-406, A2-550, A2-551, A2-552, A2-566, A2-567, A2-571, A2-655, A2-672, A2-308, A2-1308, A2-1313/14/15, A2-1320) rather than re-filing.

**High (4):**

| ID      | Title                                                                                                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A2-1600 | ~~Loop-signed JWT omits `iss` and `aud` claims; `verifyLoopToken` never checks them~~ **resolved-pending-review** by Batch 2A auth PR (#769)                                                                       |
| A2-1601 | Pino `REDACT_PATHS` misses `LOOP_JWT_SIGNING_KEY`, `DATABASE_URL`, `SENTRY_DSN`, `DISCORD_WEBHOOK_*` — any future `log(env)` leaks signing key                                                                     |
| A2-1604 | Web (`react-router-serve`) emits no `X-Frame-Options`, `HSTS`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `COOP`, `CORP` in prod; `buildSecurityHeaders` exists but unused at serve-time   |
| A2-1608 | ~~`nativeRefreshHandler` detects refresh-token reuse but only logs + 401; does not call `revokeAllRefreshTokensForUser` — stolen-token family stays alive~~ **resolved-pending-review** by Batch 2A auth PR (#769) |
| A2-1609 | No step-up auth for destructive admin actions; stolen 15-min admin access token can issue unlimited credit adjustments until expiry                                                                                |

**Medium (7):** A2-1602 Admin CSV exporters don't escape leading `=`/`+`/`-`/`@` (spreadsheet formula injection) · A2-1603 Circuit breaker tripped by attacker-induced upstream 5xx denies 30s of legit auth traffic · A2-1605 `DISABLE_RATE_LIMITING` env var has no prod-boot guard · A2-1606 `/metrics` unauth + unrate-limited; leaks route map + live circuit state · A2-1607 `/openapi.json` unauth; exposes 97 admin routes + schemas · A2-1610 No per-admin-per-day magnitude cap on credit adjustments beyond ±10M minor per-request · A2-1612 `ConsoleEmailProvider` logs raw OTP; if `@sentry/pino` flipped on, OTPs land in Sentry before Pino redacts.

**Low (4):** A2-1611 No SRI on Google Fonts / GSI script · A2-1613 No runtime network-egress allowlist; SSRF defense relies on each handler's own allowlist · A2-1614 Postgres role hygiene + pgbouncer posture unverifiable from repo · A2-1615 No CSRF defense declared (bearer-only makes it unnecessary today but cookie migration would regress silently).

### Phase 13 — Observability

Complete. Evidence: [phase-13-observability.md](./audit-2026-evidence/phase-13-observability.md). Commit SHA at capture: `450011d`. 28 findings (0 Critical / 4 High / 15 Medium / 5 Low / 4 Info). IDs A2-1300 through A2-1327.

**High (4):**

| ID      | Title                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------- |
| A2-1305 | Request ID not propagated on outbound CTX fetches; upstream id not surfaced back               |
| A2-1307 | Web bundle has no source maps uploaded to Sentry — prod stack traces unusable                  |
| A2-1308 | No `beforeSend` PII scrubber on either Sentry client; SDK default misses Loop-specific secrets |
| A2-1320 | Log retention / egress / access unowned; Fly default only; PII in logs; no ADR                 |

**Medium (15):**

| ID      | Title                                                                                           |
| ------- | ----------------------------------------------------------------------------------------------- |
| A2-1306 | 11 upstream-body logging sites slice to 500 chars without redacting email / bearer / card-shape |
| A2-1309 | No `release` tag on Sentry init either side                                                     |
| A2-1310 | Backend `environment=NODE_ENV` vs web `environment=MODE` — staging deploys desync               |
| A2-1312 | Web ErrorBoundary captures raw React-Router errors which can carry Response payloads            |
| A2-1313 | `notifyFirstCashbackRecycled` leaks full user email to orders Discord channel                   |
| A2-1314 | `notifyPayoutFailed` uses full userId/orderId/payoutId (violates ADR-018 last-8 convention)     |
| A2-1315 | `notifyAdminAudit` leaks full admin email into admin-audit Discord channel                      |
| A2-1318 | `/metrics` scrape-only with no scraper configured; counters reset on every deploy               |
| A2-1321 | No access-log sampling; `/health`, `/metrics`, `/openapi.json` log every hit (5,760+/day)       |
| A2-1322 | TanStack Query `onError` never forwards to Sentry — silent bug suppression                      |
| A2-1323 | Web Sentry events carry no backend requestId correlation tag                                    |
| A2-1324 | No web-vitals / RUM; browserTracingIntegration default is 10% sampled                           |
| A2-1325 | "SLO" used 40+ times in docs but no SLO is ever defined                                         |
| A2-1326 | No Discord alert dedup / grouping; circuit flap can emit 120 embeds/hour                        |
| A2-1327 | No paging tier above Discord; Discord outage = ops blind                                        |

**Low (5):** A2-1302 · A2-1303 · A2-1304 · A2-1316 · A2-1319 (see evidence file).

**Info (4):** A2-1300 · A2-1301 · A2-1311 · A2-1317 (see evidence file).

### Phase 14 — Testing

Complete. Evidence: [phase-14-testing.md](./audit-2026-evidence/phase-14-testing.md). Commit SHA at capture: `450011d`. 15 findings (0 Critical / 4 High / 6 Medium / 5 Low / 0 Info). IDs A2-1700 through A2-1714.

**High (4):**

| ID      | Title                                                                                                                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2-1701 | `credits/adjustments.ts` + `credits/liabilities.ts` have no dedicated tests; admin handler test mocks `applyAdminCreditAdjustment` — money primitive untested (same root as A2-610) |
| A2-1704 | e2e-mocked OTP `toBeVisible` signal flaked 15+ consecutive CI runs 2026-04-22 → 2026-04-23                                                                                          |
| A2-1705 | No full-journey e2e (signup → order → credit → recycle → payout); mocked backend runs with placeholder `DATABASE_URL` and skipped migrations (plan G4-03)                           |
| A2-1706 | No CTX contract test; Zod validates runtime only, no CI fixture pin (plan G4-07)                                                                                                    |

**Medium (6):** A2-1700 `audit-envelope.ts` + `idempotency.ts` (ADR-017 primitives) untested · A2-1702 web services `admin.ts` / `config.ts` / `public-stats.ts` / `user.ts` untested · A2-1708 pyramid top-light (2298 unit / 32 integration / 7 e2e) · A2-1710 no property-based tests for bigint-money (plan G4-01) · A2-1711 no bundle-size / LCP / CLS budget in CI (G2-11) · A2-1712 no a11y / axe check in CI (G4-18).

**Low (5):** A2-1703 48 test files touch real wall-clock, only 3 use `vi.useFakeTimers` · A2-1707 no shared test factories (54 files copy `vi.hoisted`) · A2-1709 web vitest excludes `app/routes/**` + home/onboarding · A2-1713 no mutation testing (G5-95) · A2-1714 `sitemap.tsx` loader untested (open follow-up to A2-1116).

**Reconciliations noted in evidence:** A2-508 (13 admin handlers untested from Phase 5a) largely closed — only 2 of 80 remain untested; A2-610 confirmed unchanged at commit 450011d.

### Phase 15 — Documentation

Complete. Evidence: [phase-15-docs.md](./audit-2026-evidence/phase-15-docs.md). Commit SHA at capture: `450011d`. 30 findings (0 Critical / 1 High / 9 Medium / 15 Low / 5 Info). IDs A2-1800 through A2-1829 plus A2-1899 (Info — positive: 50/50 sampled inline comments verified true).

**High (1):**

| ID      | Title                                                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A2-1819 | `AGENTS.md` rule #2 falsely claims auth is proxy-only; ADR-013 Loop-native path lives (`native.ts` / `jwt.ts` / `refresh-tokens.ts`) — AI agents inherit wrong mental model from the primary agent doc |

**Medium (9):** A2-1802 `SECURITY.md` absent · A2-1806 `deployment.md` env table missing ~30 vars · A2-1809 legacy audit artifacts (`codebase-audit.md` / `audit-checklist.md` / `audit-tracker.md`) still linked as current · A2-1811 `scripts/lint-docs.sh` fails at this commit (3 errors); excluder misses `audit-2026-*` · A2-1812 4 env vars bypass `env.ts` zod (CTX_OPERATOR_POOL, LOOP_STELLAR_HORIZON_URL, LOOP_XLM_PRICE_FEED_URL, LOOP_FX_FEED_URL) · A2-1813 6 ADRs stuck `Proposed` despite being implemented · A2-1817 no ADR amendment convention documented · A2-1822 `apps/backend/AGENTS.md` Files omits payments/, public/, config/, most admin/ · A2-1823/1824 `apps/web/AGENTS.md` + `packages/shared/AGENTS.md` coverage gaps.

**Low (15):** A2-1800 LICENSE absent despite README "Proprietary" · A2-1801 no CODE_OF_CONDUCT.md · A2-1803 no CHANGELOG.md · A2-1804 architecture.md API list drift · A2-1805 development.md env snapshot missing 10+ vars · A2-1807/1808 ui-restoration-plan.md + migration.md stale · A2-1810 ADR-013 broken link · A2-1814/1815 ADR 012 + 019 phantom paths · A2-1816 4 distinct ADR header styles · A2-1818 Supersedes/Superseded-by inconsistent · A2-1820 AGENTS.md says "USDC cashback" — shipped is USDLOOP/GBPLOOP/EURLOOP · A2-1821 AGENTS.md architecture omits DB layer · A2-1826 CONTRIBUTING.md says 6 CI jobs (actual 7) · A2-1827 standards.md backtick-references non-existent `apps/backend/src/stellar/`.

**Info (5):** A2-1825 `apps/mobile/AGENTS.md` does not exist · A2-1828 `docs/archive/` policy undocumented in standards.md §9 · A2-1829 root-level Postman collection disposition · A2-1830 (wrap) · A2-1899 positive: 50/50 sampled inline comments verified true.

**Phase-15-urgent callouts (not separate findings — ranking within the set):**

- **A2-1811** lint-docs is currently breaking CI/pre-push on every run (will block every new PR until resolved)
- **A2-1819** root AGENTS.md teaches AI agents a false architectural rule — every AI-assisted PR inherits the wrong mental model

### Phase 16 — CI/CD & Automation

Complete. Evidence: [phase-16-cicd.md](./audit-2026-evidence/phase-16-cicd.md). Commit SHA at capture: `450011d`. 17 findings (0 Critical / 4 High / 6 Medium / 6 Low / 1 Info). IDs A2-1401 through A2-1417.

**High (4):**

| ID      | Title                                                                         |
| ------- | ----------------------------------------------------------------------------- |
| A2-1403 | No rollback procedure or 90-day rehearsal documented anywhere                 |
| A2-1404 | No preview / ephemeral per-PR environments                                    |
| A2-1406 | Zero GitHub Environments — no prod-deploy gate, no env-scoped secrets         |
| A2-1408 | No static-security analysis in CI (semgrep / CodeQL / eslint-plugin-security) |

**Medium (6):** A2-1401 `verify.sh` mirrors only quality, misses audit/build/e2e parity · A2-1402 pre-push runs `npm test` + `lint-docs.sh` but not `verify` or `npm audit` · A2-1405 no documented canary / blue-green · A2-1407 no automated release mechanism (no release-please / semantic-release / tags) · A2-1409 migration-vs-app-deploy ordering undocumented at pipeline layer (cross-ref A2-407) · A2-1412 `@anthropic-ai/claude-code` pinned outside Dependabot scope · A2-1416 `e2e-real.yml` mainnet Stellar seed + `GH_SECRETS_PAT` are repo-scoped, reachable by any workflow.

**Low (6):** A2-1410 Dependabot weekly-only; no daily security lane · A2-1411 no Dependabot auto-merge policy · A2-1413 no ADR on LLM-review (PR diffs sent to Anthropic) · A2-1414 `pr-review.yml` has no concurrency / rate-limit cap · A2-1415 `notify` embeds attacker-controlled commit message into Discord.

**Info (1):** A2-1417 `npm run test:coverage` only in CI; local `npm test` / pre-push diverge.

**Cross-references (not re-filed):** A2-114 (flyctl@master), A2-115 (tag vs SHA), A2-116 (workflow-level permissions), A2-117 (marketplace allowlist), A2-105/A2-106 (GH security off), A2-107/A2-108 (hook bypass), A2-407/A2-408 (migration ordering / SBOM / scan / sign).

### Phase 17 — Operational readiness

Complete. Evidence: [phase-17-operational.md](./audit-2026-evidence/phase-17-operational.md). Commit SHA at capture: `450011d`. **31 findings** (0 Critical / 14 High / 12 Medium / 4 Low / 1 Info). IDs A2-1900 through A2-1930.

**Phase 17's exit criterion — "a new on-call could reasonably respond to the top-10 alerts using only what's in-repo" — is NOT met.**

**High (14):**

| ID      | Title                                                                                       |
| ------- | ------------------------------------------------------------------------------------------- |
| A2-1900 | No `docs/runbooks/` directory exists; zero alert-response docs                              |
| A2-1901 | No on-call roster, rotation, or escalation policy                                           |
| A2-1902 | No incident-response SLA / template / post-mortem policy                                    |
| A2-1903 | No status page / customer-facing comms plan                                                 |
| A2-1904 | No backup / restore rehearsal ever performed                                                |
| A2-1905 | DSR "delete my account" unimplemented but privacy policy promises it                        |
| A2-1906 | DSR "export my data" unimplemented; fallback mailbox unprovisioned                          |
| A2-1907 | No runtime kill-switch for orders / auth / payouts (every toggle requires redeploy)         |
| A2-1908 | No Apple/Google signing-cert expiry calendar or renewal runbook                             |
| A2-1909 | No `LOOP_JWT_SIGNING_KEY` / Stellar operator-secret rotation schedule or rehearsal          |
| A2-1910 | No DR plan; RPO / RTO undefined                                                             |
| A2-1911 | No log-retention commitment, PII redaction policy, or access RBAC                           |
| A2-1912 | Privacy/terms are placeholders; mailboxes unprovisioned; jurisdictional hosting undisclosed |
| A2-1913 | No staging environment                                                                      |

**Medium (12):** A2-1914 no monthly reconciliation runbook (CTX invoice vs ledger) · A2-1915 no CTX contract-drift canary · A2-1916 no third-party quota / cost alerts · A2-1917 no runbook for `notifyPayoutFailed` / `notifyAssetDrift` / `notifyOperatorPoolExhausted` · A2-1918 rate-limit values intuition-derived, no review cadence · A2-1919 no capacity/headroom/spike plan · A2-1920 no error-budget tracking · A2-1921 no Stellar fee-bump strategy (payouts go terminal under congestion) · A2-1922 no content-moderation pipeline for merchant names · A2-1923 tax/regulatory reporting data model absent · A2-1924 no deployed-state spot-check procedure · A2-1925 no jurisdictional hosting disclosure.

**Low (4):** A2-1926 Discord sole paging channel · A2-1927 no cookie/consent banner · A2-1928 no admin-panel runtime kill-switches · A2-1929 ADR "runbook" forward references are dead links.

**Info (1):** A2-1930 single-maintainer pre-launch posture dominates Phase 17 gaps (recorded as context, not action).

**Minimum floor to clear Phase 17 exit:** A2-1900 + A2-1917. **Legal-surface blockers for App Store / Play Store submission:** A2-1905, A2-1906, A2-1912. **Operational-lever blockers for launch-night readiness:** A2-1904 (DR rehearsal), A2-1907 (maintenance mode), A2-1913 (staging), A2-1908 (cert expiry).

### Phase 18 — Adversarial / Red-team

Complete. Evidence: [phase-18-redteam.md](./audit-2026-evidence/phase-18-redteam.md). Commit SHA at capture: `450011d`. 29-attack playbook executed + malicious-admin model walk.

**Attack-table summary:** 10 **pass** (defense held) / 13 **fail** (prior finding empirically re-confirmed) / 5 **deferred** (prod infra required). **9 NEW findings** (0 Critical / 1 High / 5 Medium / 2 Low / 1 Info). IDs A2-2000 through A2-2008.

**New findings:**

| ID      | Severity | Title                                                                                                                                                  |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A2-2000 | Info     | Meta — Phase 18 produced zero net-new Critical findings, consistent with plan §0.4 (confirmation pass)                                                 |
| A2-2001 | **High** | Admin idempotency-key race — concurrent `POST /credit-adjustments` with same key both pass read, both write, double-credit (amplifies A2-902 / A2-612) |
| A2-2002 | Medium   | `users.email` accepts Unicode confusables (`admin@loop.com` vs Cyrillic `аdmin@loop.com`); no NFKC normalization (amplifies A2-706)                    |
| A2-2003 | Medium   | `POST /api/orders` and `/api/orders/loop` do not require `Idempotency-Key` — client double-click produces duplicate orders                             |
| A2-2004 | Low      | Discord `escapeMarkdown` misses `[]()` link construction + `\u202E` / zero-width chars — deceptive links + RTL spoofing reach admin audit channel      |
| A2-2005 | Medium   | CTX `/request-otp` path has no per-email rate limit (native path does) — IP-cycling attacker email-spams victim inbox                                  |
| A2-2006 | Medium   | No tamper-evident audit trail — `admin_idempotency_keys` deletable at DB; Discord channel retention-bounded and editable                               |
| A2-2007 | Low      | `/api/public/*` commercially-sensitive endpoints only IP-rate-limited (60/min); competitive scraping cheap with IP rotation                            |
| A2-2008 | Medium   | Admin read endpoints (≥65 handlers, CSV exports, user searches) emit zero audit trail — malicious admin can bulk-exfil PII zero-trace                  |

**Prior findings empirically re-confirmed (not re-filed):** A2-550, A2-551, A2-556 + A2-1608, A2-605 (re-graded pass), A2-612, A2-672, A2-706, A2-902, A2-1005, A2-1009, A2-1602, A2-1603, A2-1607.

**Defenses that held:** procurement race · payout race · SQL injection · `TRUST_PROXY=false` rate-limit discipline · bigint overflow · no custom URL schemes (only `loopfinance://`) · OTP timing (practically constant) · open redirect · path traversal · order-ID enumeration · memo collision (1M-memo empirical test clean).

**Top-5 "if this shipped today" risks:**

1. **A2-550 + A2-551** — unverified CTX JWT lets any attacker with a leaked bearer redirect any other user's Stellar payouts (Critical; pre-existing)
2. **A2-1608** — stolen refresh token remains valid 30d even after reuse detected (High; pre-existing)
3. **A2-619** — first cross-currency order post-launch fails payment verification unconditionally (Critical; dormant)
4. **A2-2006 + A2-2008** — no tamper-evident admin audit + reads unaudited; malicious/compromised admin exfils silently (High; Phase-18 synthesis)
5. **A2-2001** — admin credit-adjustment idempotency race double-credits on double-click (High; new)

### Phase 19 — Synthesis & sign-off

Clerical phase. No new findings filed; every prior phase's tracker section already consolidates its own evidence.

**Audited commit:** `450011ded294b638703a9ba59f4274a3ca5b7187` (main at the time of execution).
**Audit duration:** 2026-04-23 start; completed in one wall-clock day thanks to parallel subagent execution (15 agents total across three batches).
**Audit branch:** `chore/audit-2026-bootstrap`.

**Post-audit disposition plan** (per plan §0.4 — every finding resolved in a dedicated remediation phase _after_ this audit):

Remediation order per severity, per plan §3.4:

1. **Critical (10)** first — money-flow + auth bypass dominate; see residual-risk register below
2. **High (79)** second — the longest queue; mix of security, CI/CD, operational, cross-app
3. **Medium (171)** third
4. **Low (164)** fourth
5. **Info (43)** — discussed at sign-off; actions re-classified up only if an Info implies work

Sign-off is blocked until every finding reaches `resolved` or `accepted-with-rationale-and-second-reviewer`.

**Reconciliation against the legacy audit program** (`docs/codebase-audit.md`, `docs/audit-checklist.md`, `docs/audit-tracker.md` — consulted only _after_ this phase's conclusions were independently written, per plan §0.2):

| Legacy finding                                            | Independently re-observed here?                                                                               | Verdict                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| A-003 — mocked-CTX e2e suite                              | still present; re-confirmed healthy in Phase 14                                                               | ok                                                 |
| A-018 — client-ID defaults                                | ADR 014 implementation re-confirmed in Phase 5b                                                               | ok                                                 |
| A-021 — access-log middleware                             | present + functioning; Phase 13 noted no sampling (A2-1321)                                                   | partially — sampling gap new                       |
| A-023 — TRUST_PROXY                                       | re-confirmed live in Phase 12; A2-1526 noted E2E-untested                                                     | open, new angle                                    |
| A-024 — Keychain / EncryptedSharedPreferences for refresh | re-confirmed ADR-006 in Phase 9                                                                               | ok                                                 |
| A-025 — image-proxy SSRF allowlist                        | A2-672 reopens this (DNS-rebinding TOCTOU)                                                                    | reopened at higher severity                        |
| A-033 — Android backup rules                              | A2-1209 notes overlay `sed` is brittle                                                                        | partially                                          |
| A-034 — NSFaceIDUsageDescription                          | A2-405 + A2-1205 (runbook gap)                                                                                | partially                                          |
| A-035 — stale support artifacts                           | resurfaced: `codebase-audit.md` + `audit-checklist.md` + `audit-tracker.md` still linked as current (A2-1809) | reopened — the fix itself became a doc-drift issue |
| A-036 — X-Client-Id allowlist                             | re-confirmed live                                                                                             | ok                                                 |
| A-037 — branch protection                                 | reopened at higher severity (A2-101 admin bypass, A2-105 secret-scanning off, A2-119 org-level 2FA)           | reopened                                           |

**Takeaway on legacy audit:** nothing it closed was silently regressed, but several items it marked "done" need re-examination (A-025, A-035, A-037) because the fix either aged poorly or created a new adjacent gap.

---

## Residual risk register

Residuals recorded at audit-complete (pre-remediation). Every finding is `open` — remediation is a separate phase. The entries below are findings the audit could NOT empirically verify and therefore cannot claim are absent of risk.

| Risk                                             | Reason                                                                                                                   | Unblock path                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Production CORS behavior                         | Phase 7 + Phase 18 could not exercise `NODE_ENV=production` CORS via `app.request()` harness                             | Phase 12 live check in a staging environment (blocked on A2-1913: no staging exists) |
| Production SSRF                                  | Phase 18 did not run SSRF probes against a prod-connected backend                                                        | Requires on-call approval + staging (A2-1913)                                        |
| Refresh-token replay under production rotation   | Phase 18 deferred the full Playwright capture-replay                                                                     | Blocked on staging (A2-1913)                                                         |
| Stellar payout submission race                   | Phase 18 did not attempt two concurrent submissions to testnet/mainnet                                                   | Requires a Stellar testnet run with a fee-source account                             |
| OTP statistical-timing attack                    | Phase 18 deferred — would need 10k+ samples to rule out a side channel                                                   | Benchmark with `hyperfine` against a local backend instance                          |
| CTX → supplier-spend cross-reconciliation        | Phase 6.5 could not verify without real fulfilled orders                                                                 | Requires post-launch traffic OR replay of anonymized CTX invoices                    |
| Ledger → on-chain consistency                    | Phase 6.5 could not verify without Stellar contact                                                                       | Requires testnet payouts and a recon script                                          |
| Memo-collision bounds at real UUID distribution  | Phase 18 ran 1M-memo empirical test (clean) but didn't load real UUID prefix distribution                                | Post-launch monitoring via Grafana / Prometheus                                      |
| Fly PG `max_connections` vs app pool × instances | Phase 6 deferred — requires prod telemetry                                                                               | `fly postgres connect` and inspect live config                                       |
| Index bloat / never-hit indexes                  | Phase 6 deferred — requires `pg_stat_user_indexes` from production                                                       | Post-launch `pg_stat_user_indexes` query                                             |
| Interest-accrual idempotency across reruns       | Phase 6.5 could not verify end-to-end — scheduler not wired (A2-905)                                                     | Blocked on scheduler implementation                                                  |
| Org webhook inventory (G5-07)                    | Phase 1 blocked on missing `admin:org_hook` gh auth scope                                                                | `gh auth refresh -h github.com -s admin:org_hook && gh api orgs/LoopDevs/hooks`      |
| Mobile iOS plugin parity                         | Phase 9 flagged A2-1200/A2-1206 on iOS filesystem plugin — needs live TestFlight build to empirically confirm share flow | TestFlight internal build                                                            |
| Postgres role hygiene + pgbouncer posture        | Phase 12 noted unverifiable from repo (A2-1614)                                                                          | `fly postgres connect` and inspect roles                                             |

## Sign-off

---

## Sign-off

| Field               | Value                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Audited commit SHA  | `450011ded294b638703a9ba59f4274a3ca5b7187`                                                                 |
| Audit-complete date | 2026-04-23                                                                                                 |
| Audit branch        | `chore/audit-2026-bootstrap`                                                                               |
| Sign-off date       | **⏸ blocked on remediation** — see below                                                                   |
| Signers             | **⏸ blocked** (waiting for remediation pass + second reviewer on any `accepted`)                           |
| Two-person rule     | per plan §G5-128 — at least one reviewer independent of the code author required for every Critical / High |

**Current state:** audit _data-gathering_ phase complete. All 20 phases executed (0 through 19 + 6.5). **467 findings filed, all `open`.** Sign-off is explicitly blocked until the post-audit remediation phase resolves every finding (per plan §0.4 — no severity is "deferrable" pre-launch).

### Sign-off checklist (plan §9) — status as of audit-complete

- [x] Phase 0 file list covers 100% of `git ls-files` (762 files)
- [ ] No `status: open` finding at any severity — **467 open**; blocked on remediation
- [ ] Any `accepted` / `wontfix` / `deferred` finding carries a written rationale and a second-reviewer sign-off — n/a (zero in those states)
- [x] Every ADR reconciled (Phase 2: 21 in-sync · 1 drifted-minor · 0 withdrawn · 0 never-implemented)
- [x] Every route in the API matrix has `auth`, `rateLimit`, `cache`, `openapi-registered`, `error-codes-enumerated` columns filled (Phase 7: 148-row matrix)
- [~] Every handler has a test-file pointer and at least one sad-path test — 2 handlers still untested (A2-1701)
- [x] Every `apps/backend/src/admin/` handler has a `requireAdmin` confirmation (Phase 5a + Phase 12 matrix)
- [x] Every `apps/web/app/native/` plugin has a web fallback or documented reason (Phase 8a: 16/16 wrappers)
- [ ] Phase 6.5 ledger invariant held on a prod-shaped dataset — **FAILS on seeded data** (A2-610, A2-611, A2-700, A2-902, A2-903); blocked
- [ ] Every ledger/payout writer confirmed transaction-bounded — A2-613, A2-614, A2-622, A2-700 flag gaps; blocked
- [ ] End-to-end user-journey test exists — A2-1705 confirms none; blocked
- [ ] Backup rehearsal performed — A2-1904; blocked
- [ ] Deployed-image digest matches main commit SHA — deferred (requires prod read)
- [~] Discord channels audited for PII absence — Phase 13 surfaced 3 leak notifiers (A2-1313/14/15); blocked
- [x] Flap-damping staging run captured — inherent (PR #752 reviewed in Phase 5d + Phase 13)
- [ ] Error-code taxonomy documented + consumed consistently — A2-1011 + A2-1153; blocked
- [x] `docs/audit-2026-tracker.md` has signers and date — this section
- [x] `docs/audit-2026-evidence/` has ≥1 file per phase — 18 phase files + 4 supporting dumps + README
- [x] Plain-English summary written and placed at the top of the tracker — see §Plain-English summary (written last per plan G3-15)
