# Loop — Cold Adversarial Codebase Audit (2026-04)

> **New audit program.** Independent of `docs/codebase-audit.md`, `docs/audit-checklist.md`, and `docs/audit-tracker.md` — those are prior artifacts, not evidence. This program treats the codebase as untrusted and re-derives every conclusion from primary sources.

---

## 0. Preamble

### 0.1 Purpose

Produce a defensible answer to _"is this codebase fit for the cashback pivot as advertised — correct, secure, operable, maintainable, and honestly documented?"_ — derived from primary evidence, not from the previous audit's sign-off.

### 0.2 Why cold

The existing `codebase-audit.md` / `audit-tracker.md` closed with the repo declared ready. A large amount of work has landed since — ADRs 009–023, loop-native auth, stablecoin topology, admin panel, CSV exports, Discord notifier catalog, merchant flows, flap-damping, Phase-2 Stellar rails. The prior audit cannot be trusted to cover this surface, and its status lines are not evidence that anything is currently in a good state.

**Rule:** the auditor shall not consult `docs/codebase-audit.md`, `docs/audit-checklist.md`, or `docs/audit-tracker.md` while gathering evidence. Those files may be read _only after_ a section's conclusions are independently written, to reconcile deltas. Prior "resolved" statuses do not discharge anything.

### 0.3 Non-goals

- Not a rewrite plan. Findings propose remediation but do not redesign.
- Not a product review. Whether the cashback pivot is the right business strategy is out of scope — whether the code executes that strategy correctly is in scope.
- Not a performance benchmark. Perf regressions are findings; absolute throughput targets are not set here.

### 0.4 Success criteria

The audit is **complete** when:

- every file listed in Phase 0 has a recorded disposition (audited / excluded with reason / deleted as dead)
- every phase has a dated "findings closed" marker (findings _logged_, not yet resolved — remediation is a separate post-audit phase)
- **the audit itself runs all phases through to completion without stopping to fix anything.** Pre-launch context: no live customers, no outage risk, so no mid-audit pause is ever warranted. Fixing during the audit would cause later phases to observe a moving target and undermine evidence integrity.
- **every finding, at every severity, is resolved in the post-audit remediation phase** (Critical → High → Medium → Low order). No severity is "not worth fixing." `accepted` / `wontfix` / `deferred` are not default dispositions; if used at all they need an explicit written rationale (e.g. "blocked on external vendor") that another reviewer signs off on.
- every ADR has a reconciliation line (code matches / code drifted / ADR withdrawn)
- the sign-off checklist at §19 is fully green with references

---

## 1. Threat Model

### 1.1 Adversary profiles

| Adversary                        | Capabilities                                                                        | Goal                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Unauthenticated internet user    | HTTP requests to any public endpoint; unlimited forged headers except TCP source IP | Exfiltrate data, enumerate users, exhaust resources, SSRF via `/api/image`                                 |
| Authenticated user (non-admin)   | Valid CTX-proxied access+refresh tokens                                             | Read other users' data, forge cashback credits, bypass rate limits, trigger unauthorized state transitions |
| Malicious admin                  | Admin bit set, valid tokens                                                         | Silent balance manipulation, cover tracks, replay writes, leak PII beyond need                             |
| Compromised CTX operator account | Stolen operator credentials from the pool                                           | Forge orders attributed to other users, drain value                                                        |
| Compromised upstream CTX         | Returns malicious/malformed responses                                               | Inject XSS via cached merchant data, poison the order ledger, ship bad proto payloads                      |
| On-path attacker                 | Read/modify TLS-terminated traffic post-edge                                        | Replay, downgrade, steal tokens in transit past the edge                                                   |
| Insider with repo access         | Can open PRs, can push to non-`main` branches                                       | Smuggle malicious code past review                                                                         |
| Supply-chain attacker            | Controls a transitive npm dependency                                                | RCE at `npm install`, exfiltrate secrets at build/test                                                     |
| Mobile-device adversary          | Installed malicious sibling app on the device                                       | Exfiltrate refresh tokens from shared storage, hook Capacitor plugins                                      |
| Disgruntled ex-employee          | Known service-account keys, retained repo checkout                                  | Lateral pivot through leaked secrets, push destructive commits                                             |

### 1.2 Assets

- User credentials (email/OTP, refresh tokens)
- Stellar private keys (device-generated, never leave device)
- CTX operator credentials (backend env)
- User PII (email, home currency, balance, purchase history)
- Credit-ledger integrity (`credit_transactions` + `user_credits` materialized balance)
- Merchant catalog & pricing (commercially sensitive cashback-split configs)
- Ops secrets (Sentry DSN, Discord webhooks, database credentials, Loop JWT signing keys)
- Audit tail integrity (`admin_audit`, reconciliation data)

### 1.3 Trust boundaries

```
Client (web/mobile) ── TLS ──▶ Fly edge ── HTTP ──▶ Hono backend ── TLS ──▶ CTX upstream
                                                          │
                                                          ├── TLS ──▶ Horizon (Stellar)
                                                          ├── TLS ──▶ Discord webhooks
                                                          └── TCP ──▶ Postgres (Fly private network)
```

Each boundary gets explicit audit treatment in Phase 12.

### 1.4 Attack surfaces (enumerated)

| Surface                                                             | Touch-points   |
| ------------------------------------------------------------------- | -------------- |
| HTTP public endpoints (`/api/public/*`, `/health`, `/openapi.json`) | Phase 7, 12    |
| HTTP authenticated endpoints (`/api/users/*`, `/api/orders`)        | Phase 7, 12    |
| HTTP admin endpoints (`/api/admin/*`)                               | Phase 7, 12    |
| Image proxy (SSRF)                                                  | Phase 5, 12    |
| Stellar payment submission path                                     | Phase 5, 12    |
| Upstream CTX proxy path                                             | Phase 5, 12    |
| Static file serving (web SSR + mobile static export)                | Phase 8, 9, 12 |
| Capacitor plugin IPC                                                | Phase 9, 12    |
| Discord webhook egress                                              | Phase 5, 12    |
| Database access                                                     | Phase 6, 12    |
| CI/CD secrets                                                       | Phase 16, 12   |
| Build artifacts (Docker images, mobile bundles)                     | Phase 4, 12    |

---

## 2. Scope

### 2.1 In scope

Every file, directory, workflow, configuration, and doc reachable from the repo root, specifically:

- `apps/backend/**` (source, tests, config, Dockerfile, fly.toml, SQL migrations, openapi)
- `apps/web/**` (source, tests, config, Dockerfile, fly.toml)
- `apps/mobile/**` (Capacitor config, native overlays script, iOS/Android generated projects)
- `packages/shared/**`
- `.github/**` (workflows, CODEOWNERS, dependabot, PR template, labeler)
- `docs/**` (architecture, development, deployment, testing, standards, roadmap, ADRs, migration, UI restoration plan, mobile-native-ux)
- `scripts/**` (verify, lint-docs, postgres-init, e2e-real)
- `tests/**` (e2e specs)
- Root files: `package.json`, `package-lock.json`, `tsconfig.base.json`, `playwright*.config.ts`, `eslint.config.js`, `commitlint.config.js`, `docker-compose.yml`, `README.md`, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`
- Branch-protection config on GitHub (via `gh api`)
- Dependabot config + open/recently-closed bot PRs
- CI run history (last 30 days)
- Git history: commits, tags, branches, reflog patterns, signed-commits policy

### 2.2 Explicitly out of scope

- CTX's own code and infra (treated as an adversarial external system)
- Stellar network consensus behavior (treated as a black box)
- Fly.io platform itself (only our config for it)
- Apple/Google app-review process (only our bundling correctness)
- Product strategy

### 2.3 Deliverables

- `docs/audit-2026-tracker.md` — new tracker, created by this program (existing one not reused)
- Per-phase evidence logs under `docs/audit-2026-evidence/` (one file per phase; kept in-repo)
- Findings list with severity, owner, status, remediation (in the tracker)
- Sign-off section at the bottom of the tracker with date and signer

---

## 3. Evidence Standard

### 3.1 What counts as evidence

- Direct file reads with line numbers + a short paraphrase of what the code does
- `grep`/`rg` outputs showing all call sites of a symbol or pattern
- Test run outputs (stdout) with a hash of the run
- CI job URLs and outcome
- `gh api` outputs for branch protection, secrets, webhooks
- `psql`/migration review of the actual schema (not just the migration files)
- Build artifacts (bundle sizes, docker image digests)
- Manual reproduction notes with explicit step lists

### 3.2 What does NOT count

- "It probably works" / "I remember this was fixed"
- A prior ADR or audit tracker marking something as done
- A commit message claiming a behavior
- A test name without reading what it asserts
- `package.json` claiming a script exists without running it

### 3.3 Finding shape

Every finding in the tracker must carry:

| Field                   | Content                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| ID                      | `A2-NNN`, monotonic, 3-digit                                              |
| Title                   | Short, imperative                                                         |
| Severity                | Critical / High / Medium / Low / Info                                     |
| Surface                 | Which Phase §§ uncovered it                                               |
| Files                   | Concrete `path/to/file.ext:line` references                               |
| Evidence                | Verbatim or linked snippet demonstrating the defect                       |
| Exploitability / impact | What goes wrong, who sees it, how likely                                  |
| Proposed remediation    | Concrete change; may reference other findings                             |
| Owner                   | GitHub handle                                                             |
| Status                  | `open` / `in-progress` / `resolved` / `accepted` / `wontfix` / `deferred` |
| Resolved-by             | PR # or commit SHA                                                        |
| Accepted rationale      | If `accepted`, the one-liner why                                          |
| Deferred-until          | Date if deferred                                                          |

### 3.4 Severity rubric

Severity communicates _magnitude of the problem_, not _whether it will be fixed_. In this codebase's pre-launch context every finding gets addressed; severity orders the remediation queue that runs **after** the audit.

**The audit does not pause to remediate, at any severity.** Findings are logged and we continue. Remediation happens in a dedicated post-audit phase (after Phase 19 synthesis), in this order: Critical → High → Medium → Low. Mid-audit fixes are forbidden because they would cause later phases to audit a moving target.

- **Critical** — defect that would cause data loss/corruption, a security breach, regulatory exposure, or an outage _once traffic is live_. First in the post-audit remediation queue.
- **High** — latent defect with clear path to harm once live; missing security control; integrity invariant at risk. Second in the queue.
- **Medium** — correctness/quality issue likely to cause incidents; non-trivial tech debt with blast radius. Third.
- **Low** — cosmetic, stylistic, dead code, minor doc drift. Fourth, but still resolved.
- **Info** — observation worth recording (e.g. "SBOM not generated today"). If the observation implies an action, re-classified up; pure observations stay Info but are discussed at sign-off.

`accepted` / `wontfix` / `deferred` are not default dispositions; they require an explicit rationale signed off by a reviewer different from the finding's author.

---

## 4. Tracker Format

- New file: `docs/audit-2026-tracker.md`
- Columns: ID, Title, Severity, Phase, Status, Owner, Resolved-by, Notes
- Separate section per phase with its own heading, so findings cluster where they were found
- Top-of-file index: count by severity and by status (kept manually current)
- At the bottom: sign-off section with named signers and date

---

## 5. Methodology Primitives

Reusable micro-procedures cited by phases below.

### 5.1 Per-file audit template

For every non-generated source file:

1. Read the file end-to-end.
2. Identify stated purpose (filename + header comment + first exported symbol doc).
3. Identify actual purpose (what exports, what it depends on, who imports it).
4. Scope check: does actual == stated? If not, note drift.
5. Dependency inventory: what does it import, what imports it (grep).
6. Quality axes: nullability, error paths, resource lifecycle, concurrency, performance.
7. Test-coverage pointer: which test file covers it; read one assertion to verify truthfulness.
8. Comments-truthfulness: every non-trivial comment must still reflect reality.
9. Record a per-file disposition: `audited-clean` / `audited-findings-N` / `dead` / `generated` / `excluded-reason`.

### 5.2 Per-endpoint audit template

For every HTTP route:

1. Route: method, path, handler symbol, middleware chain.
2. Rate limit: limit + window; cross-reference `AGENTS.md` middleware table.
3. Auth gate: public / authed / admin (requireAuth / requireAdmin).
4. Input validation: zod schema; unknown-field policy; coercion direction.
5. Output shape: matches `openapi.ts` registration; matches shared types; matches web client consumer.
6. Status-code inventory: every code path's HTTP status; openapi documents each.
7. Cache-Control: appropriate for sensitivity.
8. Error-envelope consistency: `{ code, message }` shape.
9. Idempotency: if a write, is it idempotent and keyed?
10. Side-effects: Discord notify? audit-envelope write? ledger write? Confirmed inside txn or documented to be after.
11. Test coverage: unit + integration; at least one failure-mode test.
12. Bypass attempts: can it be called with forged headers, missing body, null param, integer overflow, Unicode edge input?

### 5.3 Per-ADR reconciliation

For every `docs/adr/NNN-*.md`:

1. Summarize the decision in one sentence (from the ADR itself).
2. Find the implementation (files, symbols).
3. Read the implementation.
4. Record: `in-sync` / `drifted-<how>` / `withdrawn` / `never-implemented`.
5. If drifted, file a finding or update the ADR.

### 5.4 Cross-file interaction probe

For each boundary pair `(A, B)` where A calls B:

1. Identify the contract between A and B (types, nulls, error shapes).
2. Is B used anywhere else? If so, does A's use match B's design intent?
3. Change-impact: if B's signature changes, is there a single compile error or a silent behavior shift?
4. Error propagation: does A translate B's errors faithfully?

### 5.5 Grep-all-call-sites

For every exported symbol from `packages/shared`:

1. `grep -rn` for the symbol across `apps/`.
2. Count call sites; confirm each matches the symbol's documented invariants.
3. Note any caller that bypasses shared and re-implements locally.

---

## 6. Phases

Each phase lists: **Scope**, **Method**, **Evidence**, **Exit**, **Out-of-scope bleed** (what we explicitly don't cover here so another phase must).

### Phase 0 — Inventory (prerequisite)

**Scope:** every file in the repo (≈1100). No exclusions.

**Method:**

1. `git ls-files` → canonical file list. Classify each as `source / test / config / doc / generated / asset`.
2. For `generated`: confirm it's listed in `.gitignore` or has a generation command documented and reproducible.
3. Directory purpose map: one paragraph per top-level directory stating its role (derived from `AGENTS.md` + actual contents).
4. Import graph build: `tsc --listFiles` + `ripgrep` imports; produce a module adjacency list (stored as evidence).
5. Dead-code candidates: any `source` file with zero inbound references.
6. Orphan assets: images, SVGs, protos not referenced anywhere.
7. Duplicate-content check: diff-based search for files with near-identical bodies (concern = divergent copies).

**Evidence:** `docs/audit-2026-evidence/phase-0-inventory.md` containing:

- file-list with classification
- dir-purpose map
- dead-file candidates
- orphan assets
- duplicates

**Exit:** every file accounted for; no file in an unknown bucket.

### Phase 1 — Governance & Repo Hygiene

**Scope:**

- Branch protection (GitHub API state, enforced checks, review requirements, signed-commit policy, force-push lock)
- CODEOWNERS accuracy (every path owned; owners still exist)
- Dependabot config: scope, grouping, allowed-updates-types, ignore list, schedule
- Commitlint + branch-prefix hooks: coverage, bypassability
- CONTRIBUTING.md vs actual PR merge behavior
- `.gitignore` coverage: every generation command's output listed
- `.gitattributes` (if present) / line-ending policy
- PR template + labeler: fields are load-bearing (not just decorative)
- GitHub Actions workflow permissions (principle of least privilege)
- Secret inventory (repo-level, env-level, organization-level) vs what's actually used

**Method:**

1. `gh api repos/LoopDevs/Loop/branches/main/protection` → dump.
2. `gh api repos/LoopDevs/Loop/actions/secrets` → list of secret names (values not pulled).
3. Walk every `.github/workflows/*.yml`, list trigger events, tokens, checkout settings (shallow?), action SHA pins.
4. `git log -p --all -- **/.env*` + `git log -p --all -S'BEGIN RSA'` etc. to look for secrets in history.
5. `grep -r "no-verify\|--no-verify"` in scripts/hooks/docs.
6. Read CODEOWNERS, confirm every referenced user exists on the org.

**Evidence:** dumps of all the above, one file per workflow, plus a secret-inventory table.

**Exit:** branch protection is enforced as documented in `AGENTS.md`; no secrets in git history; all workflows minimally privileged.

### Phase 2 — Architecture compliance

**Scope:**

- Each architectural rule in `AGENTS.md` §"Critical architecture rules": (1) web is pure API client, (2) auth is proxied, (3) Capacitor plugin isolation, (4) static-export constraint, (5) protobuf usage, (6) no-any policy, (7) Zod-validated upstream
- ADRs 001–023: each reconciled via §5.3
- Package boundaries: `apps/web` does NOT import `apps/backend`; `packages/shared` has no runtime deps beyond protobuf; no node-only APIs in `packages/shared`
- Loader purity: no server-only data fetching in loaders

**Method:**

1. `grep -rn "loader\s*=\s*async\|export async function loader"` in `apps/web/app/routes/` — each match read to confirm it only produces layout/meta.
2. `grep -rn "@capacitor/" apps/web/app --exclude-dir=native` → must return zero.
3. `grep -rn "from '@loop/backend\|from '\.\./\.\./backend" apps/web` → zero.
4. `grep -rn "\bany\b" apps/backend/src apps/web/app packages/shared/src --include="*.ts" --include="*.tsx"` → each match inspected.
5. `grep -rn "fetch(" apps/backend/src` filter to non-`circuit-breaker` paths → each justified (e.g. `/health` probe).
6. §5.3 reconciliation for all 23 ADRs.

**Evidence:** per-rule grep output + per-ADR reconciliation table.

**Exit:** no violations, or each is a recorded finding.

### Phase 3 — Dependencies & Supply chain

**Scope:**

- Every direct dependency in every `package.json` (root + 4 workspaces)
- Transitive graph: top-20 by install size, top-20 by maintainer-count (single-maintainer risk)
- Outdated / deprecated / abandoned packages
- Security advisories (npm audit, GitHub advisory, OSV)
- License inventory + compatibility with project license
- Lockfile integrity: no duplicate versions of security-sensitive packages (e.g. `ws`, `undici`)
- Pin strategy: exact vs caret vs tilde — consistent?
- Bundled-asset license audit (any third-party SVG/PNG/font)

**Method:**

1. `npm ls --all` → full tree; grep for duplicated version ranges.
2. `npm outdated --json` → list.
3. `npm audit --json` → list; each advisory read, not just counted.
4. `license-checker` (or equivalent) on each workspace.
5. Scan every image/font under `apps/web/public/`, `apps/mobile/resources/` for licensing notes in repo.
6. Check dependabot's "ignore" set; ensure nothing security-critical is pinned old.

**Evidence:** dep list with advisories, license summary, duplicate report.

**Exit:** no known-CVE deps unaddressed; no license conflict; pin strategy documented.

### Phase 4 — Build & release reproducibility

**Scope:**

- `apps/backend/Dockerfile`: base image pinned by digest, multi-stage, runtime surface minimal
- `apps/web/Dockerfile`: same
- `apps/backend/fly.toml`, `apps/web/fly.toml`: parity, health-check wiring (§ flap-damping fix merged recently), autoscale, memory
- Mobile build: `npx cap sync`; `apply-native-overlays.sh` idempotency; iOS plist + Android manifest actually contain what ADRs 006/008 claim
- `tsup` backend config; `vite` web config; `react-router` config
- Playwright configs: mocked vs real
- `docker-compose.yml`: local dev parity to prod
- `scripts/verify.sh`: what it runs; does it actually gate a push?
- Proto generation reproducibility: re-run `buf generate`, diff output; must match `packages/shared/src/proto/`

**Method:**

1. `docker build` each image; capture image digest; compare to CI-built digest.
2. `flyctl config validate` both fly.toml files.
3. `scripts/apply-native-overlays.sh` — run twice, diff the native project tree; must be a no-op the second time.
4. `npm run proto:generate` and diff.
5. Scan Dockerfiles for `RUN ... sudo` / COPY with wildcards / root user / missing healthcheck.

**Evidence:** build logs, digests, diffs.

**Exit:** reproducible builds; overlays idempotent; proto gen idempotent.

### Phase 5 — Backend per-module audit

**Scope (enumerated by directory):**

- `apps/backend/src/app.ts` — full middleware chain, route registration, rate-limit map, error boundary, graceful shutdown
- `apps/backend/src/index.ts` — bootstrap, env validation, background jobs, shutdown hooks
- `apps/backend/src/env.ts` — zod schema; every var in `.env.example` present; every used env var declared
- `apps/backend/src/logger.ts` — pino config, redaction keys, level envs, child-logger patterns
- `apps/backend/src/upstream.ts` — URL construction, header injection, proxy discipline
- `apps/backend/src/circuit-breaker.ts` — state machine, probe semantics, reset API, test seams
- `apps/backend/src/discord.ts` — every notifier; DISCORD_NOTIFIERS catalog parity; escape + truncate coverage
- `apps/backend/src/openapi.ts` — every handler registered; every status code handler emits is documented
- `apps/backend/src/admin/**` — ~60 handlers; each via §5.2
- `apps/backend/src/auth/**` — OTP proxy, verify, refresh rotation, logout, social (Google/Apple), JWT issuance, require-admin
- `apps/backend/src/clustering/**` — algorithm (zoom tiers, bbox expansion), proto negotiation, data store hot-swap
- `apps/backend/src/config/**` — handler, history, admin-writer
- `apps/backend/src/credits/**` — pending-payouts, reconciliation primitives
- `apps/backend/src/ctx/**` — operator pool, per-operator breakers, exhaustion semantics (recently added alert)
- `apps/backend/src/db/**` — client, schema, migrations (SQL-level + typing), users, identities, idempotency
- `apps/backend/src/images/**` — proxy SSRF, resize limits, cache
- `apps/backend/src/merchants/**` — sync, handler, cache-replacement, startup-race
- `apps/backend/src/orders/**` — handler, loop-handler, procurement, repo, state machine
- `apps/backend/src/payments/**` — horizon balances, stellar SDK wrapper, payout submit, retry, idempotency (ADR 016)
- `apps/backend/src/public/**` — stats, cashback-stats, flywheel-stats, merchant, loop-assets, cashback-preview, top-cashback-merchants
- `apps/backend/src/users/**` — `/me`, home-currency, stellar-address, cashback-history (+ .csv), cashback-by-merchant, cashback-monthly, pending-payouts, payment-method-share, orders-summary, flywheel-stats, stellar-trustlines, cashback-summary

**Method:** §5.1 per file + §5.2 per endpoint. For state machines (orders, payouts), an explicit enumeration of states and allowed transitions; every non-allowed transition must have a reject path and a test.

**Evidence:** per-file disposition list; per-endpoint review notes.

**Exit:** every file `audited-*`; every endpoint has a review note.

### Phase 6 — Database & Data Layer

**Scope:**

- SQL migrations 0000–0011 (currently): every CREATE/ALTER/INDEX/CONSTRAINT
- Current production schema (pull via `pg_dump --schema-only` in a safe env)
- Drizzle `schema.ts` vs actual schema: parity
- Referential integrity: every FK; ON DELETE / ON UPDATE policy
- NOT NULL + CHECK constraints coverage for invariants (e.g. `amount_minor >= 0`, enums)
- Index coverage: every WHERE / ORDER BY / JOIN filter has an index where it matters (based on query patterns in code)
- Seed / fixtures: none should leak to prod
- Backup / restore: is the process documented; has it been tested?
- Migration rollback: each migration has a rollback plan (not necessarily a `down.sql` but a documented procedure)
- PII columns: identified; encrypted-at-rest status; log-redaction coverage
- Timezone handling: all `timestamptz`; no `timestamp without time zone`
- Decimal precision: `bigint` minor-unit fields (never float for money)

**Method:**

1. Replay migrations against a fresh Postgres; `\d+ tablename` each table; compare to Drizzle schema.
2. Grep code for every WHERE clause; build query pattern list; check EXPLAIN plans (or at least matching-index presence).
3. `SELECT * FROM information_schema.check_constraints` on a seeded DB.
4. Read `backup`/`restore` sections of `docs/deployment.md`; rehearse the restore flow in a test env.

**Evidence:** schema diff report; index coverage matrix; backup rehearsal log.

**Exit:** schema/code parity; every business invariant backed by a DB constraint where feasible; backup rehearsed.

### Phase 7 — API surface

**Scope:**

- Every route in `apps/backend/src/app.ts` (≈150+ routes)
- `openapi.ts` registrations: 1:1 with handlers; every status code documented
- `packages/shared` types vs handler response shapes
- Web client consumers (`apps/web/app/services/`) consume the same shapes
- Rate-limit coverage matrix
- Cache-Control header matrix
- CORS behavior: production + native origins; preflight correctness per route

**Method:**

1. Generate an OpenAPI JSON at runtime (`GET /openapi.json`), diff against handler reality (symbolic walk).
2. For each route, a row in the API matrix: `method, path, auth, rateLimit, cache, idempotent, openapi-registered, consumer-type-synced`.
3. Fuzz: per endpoint, fire malformed body + excess body + type-confusion body → behavior table.

**Evidence:** API matrix (one row per route), fuzz results.

**Exit:** matrix has no blanks; openapi drift = zero; all handlers auth-classified.

### Phase 8 — Web per-module audit

**Scope:**

- `apps/web/app/root.tsx` — meta, error boundary, providers, hydration
- `apps/web/app/routes.ts` — file-system or programmatic routes; every path claimed exists
- `apps/web/app/routes/**` (35 files) — each via §5.1; each route has a loader/meta/component; SSR-safety
- `apps/web/app/components/**` — dumb vs smart; prop contracts; any that duplicate logic from `services/`
- `apps/web/app/hooks/**` — SWR semantics; dependency arrays; SSR-unsafe APIs
- `apps/web/app/native/**` — Capacitor plugin wrappers; web fallbacks; lazy import safety
- `apps/web/app/services/**` — API client contract; error translation; query keys; `shouldRetry` integration
- `apps/web/app/stores/**` — Zustand: invariants, reset, persistence scope
- `apps/web/app/utils/**` — purity; no DOM access at import time
- `apps/web/app/app.css` — no stale classes; Tailwind purge-safe
- Public assets under `apps/web/public/` — actually used
- Error / empty / loading states for every data-driven screen
- A11y pass per component: focusable controls, aria, keyboard paths, color contrast
- Dark mode pass per component

**Method:**

1. `grep -rn "const.*useLoaderData\|clientLoader\|loader:" apps/web/app/routes/` — each route's loader reviewed for static-export safety.
2. `grep -rn "@capacitor/" apps/web/app --include="*.ts*"` — must all live in `native/`.
3. `grep -rn "window\.\|document\." apps/web/app/utils apps/web/app/hooks` → each must be guarded or called client-only.
4. Build with `BUILD_TARGET=mobile`, inspect the static output for dynamic-import pitfalls.
5. Use Playwright to walk every route smoke test; note any screens missing empty/loading state.
6. Run axe-core in Playwright on representative screens.

**Evidence:** route-by-route notes; a11y report; build-target-mobile smoke log.

**Exit:** every route audited; no Capacitor leak outside `native/`; a11y findings filed.

### Phase 9 — Mobile shell

**Scope:**

- `apps/mobile/capacitor.config.ts`
- `apps/mobile/ios/` and `apps/mobile/android/` generated projects (ADR 007)
- `apps/mobile/scripts/apply-native-overlays.sh`: idempotency, exact edits to `Info.plist`, `AndroidManifest.xml`, backup rules
- Plugin inventory vs usage in `apps/web/app/native/`
- Signing / provisioning profile policy (doc-only; actual secrets not in scope)
- App-lock flow (cold-start vs resume; ADR documented the move to cold-start)
- Clipboard plugin usage; paste limits; security posture
- Share flow (ADR 008); filesystem permissions
- Static-export output size; mobile bundle diff vs web bundle

**Method:**

1. Apply overlays twice; `git diff` after each; verify round-2 empty.
2. Inspect `Info.plist` for NSFaceIDUsageDescription, NSPhotoLibraryAddUsageDescription, ATS exceptions.
3. Inspect `AndroidManifest.xml` for backup rules, exported intents, permission list.
4. `cap sync` then diff; confirm overlays survived.
5. Run the web app in a simulated Capacitor webview and exercise app-lock + share flows.

**Evidence:** overlay idempotency log; plist / manifest excerpts; flow logs.

**Exit:** overlays idempotent; plist + manifest match ADRs 006/008.

### Phase 10 — Shared package

**Scope:**

- Every file in `packages/shared/src/` (21 today)
- ADR 019 compliance: three-part test, re-export rule, phased adoption
- No runtime dep beyond `@bufbuild/protobuf`
- No node-only APIs
- Proto generation output: present, checked in, regenerable, identical after regen
- Each exported symbol grep'd (§5.5) to confirm consumers match invariants

**Method:** §5.1 per file + §5.5 per export.

**Evidence:** symbol × consumer matrix.

**Exit:** no shared-package export is unused or misused.

### Phase 11 — Cross-app integration

**Scope:**

- web → backend: every `apps/web/app/services/*` function → backend handler → `packages/shared` type. Triangle must commute.
- backend → upstream CTX: every `operatorFetch` / `upstreamUrl` call → documented CTX endpoint.
- backend → Stellar (Horizon): every call → documented semantics (ADR 015/016).
- backend → Discord: every notify call site → catalog entry → webhook env var.
- backend → database: every `db.` call → schema column → migration.
- CI → production: every deploy-time assumption matches runtime env.

**Method:** §5.4 per boundary pair. Build a "who calls whom" matrix for each pair.

**Evidence:** pair-level contract tables.

**Exit:** every contract has either a compile-time guarantee or a test.

### Phase 12 — Security deep-dive

**Scope (OWASP + Loop-specific):**

- AuthN: OTP + social-login correctness (replay, enumeration, rate-limit on all ingress paths, timing-attack resilience)
- AuthZ: every admin-gated route confirmed admin-gated; `requireAdmin` covers every intended route; no per-route drift
- Token handling: refresh rotation (ADR 013), secure-storage on native, memory-only access tokens, logout revocation path
- Loop JWT signing: key rotation window, previous-key acceptance, key length, signing alg
- Input validation: every user-supplied field validated before it reaches DB/upstream
- SQL injection: no raw string interpolation; drizzle templated; every `sql\`\`` read
- XSS: every server-rendered string escaped; `dangerouslySetInnerHTML` grep
- CSRF: cookie usage; SameSite; CSRF tokens if needed
- SSRF: image proxy allowlist enforcement in prod (audit A-025 remediation); every outbound host enumerated
- Rate-limit: every ingress route classified; every trust-proxy decision (audit A-023)
- Secret redaction: logger redaction keys complete; Sentry beforeSend strip; Discord payload inspection
- Privacy: PII columns never in logs; never in Discord; never in Sentry event body
- Capacitor: deep-link filters, intent filters, URL schemes
- Stellar: private keys never logged, never leave device; signing happens on-device only
- CSP headers: if present, verified; if absent, risk noted
- HSTS / secure-headers middleware scope
- `/openapi.json` doesn't leak internal env
- Protobuf parsing: malformed bytes, over-sized messages, trailing-data
- Circuit breaker: can the breaker be tripped by a malicious client to DoS legit traffic?
- Webhook verification: any incoming webhook (Stellar network event listeners, CTX callbacks) — HMAC? replay?

**Method:**

1. Handler-by-handler auth matrix (from Phase 7) → filter to `admin`-labeled → grep for `requireAdmin` middleware — every one covered.
2. Static scan for `innerHTML`, `document.write`, `eval`, `new Function`, `setTimeout("string"`.
3. Zap-style fuzz subset via Playwright fixtures: malformed JSON bodies, over-sized bodies, Unicode injection (RTL override, zero-width), integer overflow (`Number.MAX_SAFE_INTEGER + 1`), bigint-as-string overflow, negative amounts, decimal precision exploits.
4. Explicitly test replay of a captured POST /orders with the same idempotency key.
5. Attempt `X-Forwarded-For` spoof with `TRUST_PROXY=false`; confirm rate limit cannot be bypassed.
6. Read `env.ts` for every secret; confirm `logger.ts` redacts it.
7. Enumerate every `allowed_mentions` / `dangerously_allow_*` / comment suggesting a safety toggle.
8. `npm audit` + `osv-scanner` + GitHub Advisories.
9. Branch protection dump (from Phase 1); confirm signed-commits or not — decision recorded.

**Evidence:** auth matrix; fuzz table; allowlist/redaction coverage; advisory list.

**Exit:** every OWASP Top-10 category has a per-section verdict.

### Phase 13 — Observability

**Scope:**

- Access log: every request → one log line; X-Request-Id present; PII-free
- Application log: info/warn/error classifications consistent; `logger.child` usage consistent
- Sentry: DSN configured; env tag set; before-send redaction; sample rate; performance tracing scope
- Discord webhooks: `orders`, `monitoring`, `admin-audit`; configurable per-env; test-ping endpoint intact
- Request-ID propagation: upstream calls carry our request id; we surface upstream request id
- Metrics: in-process counters (`metrics.rateLimitHitsTotal` etc.); any exported to a collector? If so, security of the endpoint
- Flap damping (just shipped): verify the /health debouncing works in staging before signing off
- Alert fatigue: review historical Discord message volume; any channel auto-mutes?

**Method:**

1. Tail staging logs for 30 minutes; confirm one access log per request.
2. Grep handlers for `log.info` / `log.warn` / `log.error`; verify a representative 20 match classification.
3. Trigger each of the 20+ Discord notifiers in a sandbox; confirm embed renders and no PII leaks.
4. Confirm `maybeNotifyHealthChange` cooldown works by forcing a flap with a stubbed upstream.

**Evidence:** log samples; Discord embed gallery; flap-damping staging run.

**Exit:** observability surfaces are usable by on-call, not just present.

### Phase 14 — Testing

**Scope:**

- Coverage matrix: handler × test file; every handler has ≥1 happy-path, ≥1 sad-path test
- Test quality: reading, not counting. Flag tests that only assert status codes; flag snapshot-only tests; flag tests that mock the system under test
- E2E: real suite (PR-only) + mocked suite (always) — what exactly differs?
- Flakiness: last 30 days of CI runs — any test with >5% failure rate
- Test isolation: shared state (module-scoped), teardown, deterministic clocks
- Fixtures vs factories: convention consistent
- Testing pyramid: unit / integration / e2e ratios appropriate
- Contract tests for CTX upstream: present?
- Property-based tests for bigint-money math?
- Performance tests: bundle-size budget in CI? LCP budget?

**Method:**

1. Build a handler × test-file map.
2. Pull last 30 days of CI runs (`gh run list`); grep failure messages to cluster flakes.
3. Run `vitest run --coverage`; read the per-file line numbers (not just %).
4. `ast-grep` or manual grep for `describe.skip`, `it.skip`, `.only`.

**Evidence:** coverage map; flake list; skipped-test list.

**Exit:** every handler covered; no `.skip` / `.only` in main; known flakes filed.

### Phase 15 — Documentation

**Scope:**

- Every doc in `docs/` (archive/ included — should files there be deleted or live?)
- `README.md` vs actual quickstart
- `AGENTS.md` + per-package `AGENTS.md`: currency vs actual code
- Every ADR: §5.3 reconciliation
- `CONTRIBUTING.md`: matches current PR process
- Inline comments: sample 50 comments randomly; verify each is still true
- `docs/development.md` env var list vs `.env.example` vs `env.ts` parity (scripts/lint-docs.sh checks this — re-verify)
- Every URL / link in docs: resolves
- Every file reference in docs (e.g. `apps/web/app/root.tsx`): exists at that path
- Dead docs: drafts, stale migration plans, `ui-restoration-plan.md` — still relevant?

**Method:**

1. `markdown-link-check` on every `.md`.
2. Grep docs for `apps/`/`packages/` paths; verify each resolves (script this).
3. ADR reconciliation (§5.3) × 23.
4. Sample 50 source comments via `grep -rn "\*\s*"` and read each.

**Evidence:** link-check output; path-resolution script result; ADR reconciliation table; comment sample notes.

**Exit:** no dead links; no phantom paths; every ADR reconciled; archive/ cleaned up.

### Phase 16 — CI/CD & Automation

**Scope:**

- `.github/workflows/ci.yml` — jobs, caches, matrix, permissions, action SHAs
- `.github/workflows/e2e-real.yml` — secrets, fail modes
- `.github/workflows/pr-automation.yml`, `pr-review.yml` — surface area, blast radius
- Dependabot: schedule, grouping strategy, auto-merge criteria if any
- Pre-commit, pre-push, commit-msg hooks: completeness, bypass path
- `scripts/verify.sh`: runs full local equivalent of CI?
- Automated release mechanism: present? if yes, audited; if no, documented
- Claude Code Review action + any LLM-backed tooling: prompt-injection handling

**Method:**

1. Read every workflow end-to-end; record permission set.
2. SHA-pin audit: every `uses:` line pinned to a commit SHA not a floating tag (supply-chain hardening).
3. Compare `scripts/verify.sh` steps vs `ci.yml` jobs; diff.
4. Confirm Dependabot respects the `dependabot/` branch prefix (known gotcha vs the pre-push hook we have).

**Evidence:** workflow dumps; permission matrix; SHA-pin report.

**Exit:** CI ~= local verify; all actions SHA-pinned; no ambient-token overreach.

### Phase 17 — Operational readiness

**Scope:**

- Runbooks for each alert channel: what to do when `monitoring` fires
- On-call roster: documented, reachable, rotating?
- Incident response: SLA, templates, post-mortem policy
- Status page / public comms plan
- Backup / restore rehearsal (Phase 6) result
- Data-subject request (GDPR) flow: delete-my-account, export-my-data — implemented, documented
- Financial reconciliation procedure: monthly CTX invoice vs our ledger (ADR 013/015)
- Kill switches: can we disable auth, orders, payouts independently without a deploy?
- Rate-limit tuning: documented vs measured from production
- Autoscaling vs headroom: spike plan
- Legal: PP + ToS linkage; jurisdictional hosting note

**Method:** primarily doc audit + stakeholder-interview substitute (read what's written + note gaps).

**Evidence:** runbook inventory; GDPR-flow trace; kill-switch enumeration.

**Exit:** a new on-call could reasonably respond to the top-10 alerts using only what's in-repo.

### Phase 18 — Adversarial / Red-team

**Scope:** explicit attack attempts derived from §1.

- **UserA tries to read UserB:** for each `/api/users/me/*` endpoint, forge a request that would address UserB's data; verify rejected
- **Admin-bit elevation:** attempt to flip `is_admin` via any write endpoint (config upsert, credit adjustment body, social-login callback)
- **Idempotency-key replay:** submit the same admin write twice; second must not duplicate; ADR 017 invariants
- **Negative-amount cashback / underflow:** post negative minor amounts through every write path
- **Unicode confusables in email:** register `admin@loop` vs `аdmin@loop` (Cyrillic); behavior
- **Refresh-token replay after rotation:** ADR-013 says rotation happens; verify old token rejected
- **Race: two procurement workers race on the same order** — state machine must reject duplicate fulfills
- **Race: two payouts race for the same pending row** — idempotency guard must hold
- **Race: concurrent POST /api/orders with same idempotency key** — one succeeds, one rejects with 409
- **SSRF via `/api/image`:** localhost, link-local (169.254.169.254 metadata), private ranges, scheme tricks (`file://`, `gopher://`), DNS rebinding
- **SQL injection probes:** every ILIKE/SUMS/GROUP BY endpoint — user-controlled fields
- **OpenAPI spec exfiltration:** does `/openapi.json` leak internal-only paths?
- **CORS preflight bypass:** weird origins, null origin, data: origin
- **Trust-proxy spoof with `TRUST_PROXY=false`:** rate-limit bypass attempt
- **Integer overflow on `bigint`-as-string:** `2^64` + 1 posted as a `*_minor` value; must reject
- **Oversized payload:** beyond 1MB body limit; must 413
- **Discord embed prompt injection:** merchant name containing `@everyone` / `[text](malicious-url)` — our escape coverage
- **Capacitor plugin hijack:** malicious sibling app claiming the same URL scheme; deep-link handler behavior

**Method:** Playwright + curl + psql scripted attacks; results tabulated.

**Evidence:** attack log per test; expected-reject / actual-reject for each.

**Exit:** every attack tabulated as pass/fail; every fail → finding.

### Phase 19 — Synthesis & sign-off

**Scope:**

- Merge all findings into `docs/audit-2026-tracker.md`
- Summary statistics (by severity, by phase, by surface)
- Explicit residual risk register
- Sign-off block: signers, date, commit SHA of audited state
- Post-audit disposition plan for each finding
- Reconciliation line against the old audit tracker — what did we agree with, what did we overturn

**Method:** clerical. No new evidence gathering.

**Exit:** tracker signed; residuals listed; dispositions scheduled.

---

## 7. Plan review passes

> This section records the adversarial reviews of the plan itself. Pass 1 is the draft above. Passes 2 and 3 are specific gap-sweeps.

### Pass 2 — gap-sweep on completeness

**Reviewer stance:** "find what a bored senior auditor would flag as missing."

Gaps identified and folded back into the phases above:

- **G2-01 — Time & clocks.** Added to Phase 12 (timing-attack), Phase 5 (timezone audit), Phase 6 (`timestamptz` check). Originally missing.
- **G2-02 — Unicode / locale.** Added to Phase 12 (confusables), Phase 8 (RTL / CJK rendering), Phase 14 (locale-sensitive tests).
- **G2-03 — Abandoned dependency risk.** Added to Phase 3 (maintainer-count + last-commit recency for top-20 deps).
- **G2-04 — GDPR / data-subject rights.** Added to Phase 17 (DSR flow exists? documented?).
- **G2-05 — Kill-switch / feature-flag presence.** Added to Phase 17 (can we disable a subsystem without a deploy?).
- **G2-06 — Legal headers / regulatory posture.** Added to Phase 17 (PP+ToS alignment with current features).
- **G2-07 — Proto regeneration idempotency.** Added to Phase 4 (diff after re-run).
- **G2-08 — Overlay script idempotency.** Added to Phase 4 and Phase 9 (run twice, diff).
- **G2-09 — Action SHA pinning vs floating tags.** Added to Phase 16.
- **G2-10 — Git-history secret scan.** Added to Phase 1 (not just `.env` today, but `git log -p` historical).
- **G2-11 — Bundle-size / a11y budgets in CI.** Added to Phase 14 and Phase 8.
- **G2-12 — Backup-restore rehearsal (not just docs).** Added to Phase 6 + Phase 17.
- **G2-13 — CORS preflight per-route vs global.** Added to Phase 7 + Phase 12.
- **G2-14 — Webhook replay / HMAC on inbound.** Added to Phase 12 (inbound webhooks enumerated).
- **G2-15 — Comment truthfulness sampling.** Added to Phase 15 (sample 50).
- **G2-16 — `gh run list` flake clustering.** Added to Phase 14.
- **G2-17 — Capacitor URL-scheme collision threat.** Added to Phase 18.
- **G2-18 — Alert fatigue / Discord volume audit.** Added to Phase 13.
- **G2-19 — Archive/ folder disposition.** Added to Phase 15 (delete or keep decision).
- **G2-20 — Docker image base pinned by digest, not tag.** Added to Phase 4.
- **G2-21 — Any Postman-style API collection file at repo root.** Added to Phase 0 (classify: asset? dead?); Phase 15 (doc? owner?).
- **G2-22 — `playwright-report/` + `test-results/` at repo root.** Added to Phase 0 (should be gitignored?).
- **G2-23 — Dependency pin strategy consistency.** Added to Phase 3.
- **G2-24 — Malicious-admin model.** Added to Phase 1 threat table; Phase 18 attack list.

### Pass 3 — meta-review: ordering, evidence, and "what would this plan still miss?"

**Reviewer stance:** "assume pass 2 passed — where does the plan still let something through?"

Additional concerns and fixes:

- **G3-01 — Phase ordering.** Phase 0 must be complete before any other phase; made prerequisite explicit. Phase 18 (red-team) must run last so it uses knowledge from every prior phase. Phase 15 (docs) must run _after_ Phase 2/5/8/9/10 (code) so docs are reconciled against the audited code, not concurrent with it.
- **G3-02 — Evidence persistence.** Required `docs/audit-2026-evidence/` folder. Every non-trivial claim in the tracker must link to a file under that folder. Prevents the "we looked but didn't record" failure mode.
- **G3-03 — Auditor bias.** The same person who wrote recent code shouldn't audit their own code without independent review. Record per-phase: `audited-by`, `reviewed-by` (must differ for Critical/High findings).
- **G3-04 — Definition of "cross-file interaction".** Phase 11 risked being a rehash of Phase 5 + Phase 8. Clarified: Phase 11 audits **pairs** (boundary contracts) only; single-module quality stays in 5/8. Updated §5.4 accordingly.
- **G3-05 — The "too many findings to action" failure.** Added: if a phase produces >20 findings, the phase lead triages before moving on. Prevents unbounded backlog sprawl.
- **G3-06 — Scope creep via ADR reconciliation.** An ADR reconciliation could spawn work larger than the audit. Rule: if reconciliation implies a code change, file a finding; do not change code during the audit pass.
- **G3-07 — Anchoring on the existing tracker late in the audit.** Added explicit rule in §0.2 that the old tracker may be consulted only **after** a section's independent conclusions are written. Made this binding.
- **G3-08 — Regression of findings during the audit.** Since code is actively evolving, every finding must be recorded with the commit SHA at the time of detection. Added to §3.3.
- **G3-09 — False negatives from `grep`.** Dynamic imports, string-built module specifiers, or indirection via re-exports can hide call sites. Required: `tsc --traceResolution` + `tsc --listFiles` snapshot captured in Phase 0, consulted during Phase 11.
- **G3-10 — Out-of-tree state.** Things not in the repo but relied on by it: Fly secrets, GitHub secrets, CTX credentials, Apple/Google signing, DNS records. Phase 17 must at minimum enumerate them; actual audit of their provisioning is out of scope but the _inventory_ is in scope.
- **G3-11 — Production vs source divergence.** Plan assumed git state == prod state. Reality: the deployed image may lag. Required: capture the deployed image digest + compare to `main` SHA in Phase 4.
- **G3-12 — Mobile app-store submission artifacts.** Signing certs, provisioning profiles, Apple review notes — inventory only, in Phase 9.
- **G3-13 — Negative-space audit.** Added an explicit sub-step to Phase 2: "what _should_ exist but doesn't?" — e.g. no pre-commit secret scan; no CSP header; no structured 4xx error taxonomy. Filed as Info-level findings so the gap is recorded even when not fixed.
- **G3-14 — Sign-off is not finality.** Added to §19: a re-audit cadence clause — this plan is revisited when any of (a) a Critical lands in the tracker, (b) 6 months pass, (c) architecture-level ADR (`docs/adr/`) is accepted.
- **G3-15 — Plain-English summary.** Required at the top of the tracker: a three-paragraph plain-English summary of the audit's overall verdict, so a non-expert can read the first page and know the state. Required to be the _last_ thing written (not the first).

### Pass 4 — final fresh-eyes sweep before freeze

**Reviewer stance:** "read the whole document straight through, pretend you've never seen it, ask what's still missing."

Significant gaps that survived passes 2 and 3:

- **G4-01 — Financial correctness as a first-class phase.** Passes 1–3 scattered the money-correctness surface across Phase 5 (orders, payments), Phase 6 (schema), Phase 12 (negative-amount probes) and Phase 18 (replay). That's wrong — it's the single most important property of the product and deserves its own phase. **Added Phase 6.5: Financial Correctness.**
- **G4-02 — Error-taxonomy consistency.** `{code, message}` shape is enforced, but the _catalog_ of `code` values (`VALIDATION_ERROR`, `RATE_LIMITED`, `CIRCUIT_OPEN`, `UNAUTHORIZED`, `INTERNAL_ERROR`, etc.) was never audited as a first-class thing. Is the set closed? Documented? Consistent with what `apps/web/app/services/**` translates to UX strings? Added to Phase 7 and Phase 8.
- **G4-03 — End-to-end user journeys.** Phase 14 covered handler × test coverage but not _journeys_ (signup → wallet-link → order → fulfillment → cashback-credit → recycle → payout). A full-lifecycle e2e is the only way to catch silent break-points between otherwise-correct modules. Added to Phase 14.
- **G4-04 — Database transaction isolation.** Phase 6 audited the schema but not the `BEGIN; ... COMMIT;` boundaries in code. Drizzle transactions default to `READ COMMITTED`; the ledger invariant `user_credits.balance_minor == SUM(credit_transactions.amount_minor)` requires either `SERIALIZABLE` or an explicit locking discipline on the writer paths. Added to Phase 6.
- **G4-05 — Index bloat audit.** Phase 6 checked for missing indexes, not redundant or never-hit ones. Redundant indexes slow writes + consume space. Added to Phase 6.
- **G4-06 — Non-blocking migration review.** Does every migration run safely on a loaded production table? e.g. `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT` can rewrite the whole table in older PG and lock out writers. Added to Phase 6.
- **G4-07 — CTX contract drift detection.** Phase 11 audited our contract assumptions at a point-in-time; Phase 14 mentioned contract tests. But there's no continuous detector — CTX can silently change a field and we'd find out in production. Added to Phase 17 (is there a canary or contract-test CI job?).
- **G4-08 — Third-party service quota & cost.** Sentry event volume, Discord webhook rate (429 from Discord), Horizon request rate, CTX rate limit on Loop's end. Exhaustion either costs money or breaks us silently. Added to Phase 17.
- **G4-09 — Secret rotation cadence.** `LOOP_JWT_SIGNING_KEY` has a `_PREVIOUS` dance for rotation, but there's no scheduled rotation. Added to Phase 17.
- **G4-10 — Staging parity.** Is there a staging env? Is its data representative (synthetic? scrubbed prod? none)? Is it synced on a schedule? Added to Phase 17.
- **G4-11 — Log retention & egress.** Where do Fly logs go? How long retained? Who can read them? PII retention window. Added to Phase 13 + Phase 17.
- **G4-12 — Mobile platform threat model extras.** Jailbreak/root detection? App-attest / Play Integrity? Binary tamper detection? Pin SSL? For a payments-adjacent app these are real. Added to Phase 9 + Phase 12.
- **G4-13 — Static analysis coverage.** We lint for code style but not for security issues (`eslint-plugin-security`, `semgrep`). Added to Phase 16.
- **G4-14 — Deployed-state spot check.** With explicit owner permission, query production read-only: any `stuck_orders` rows older than SLO; any `reconciliation` drift rows; any `pending_payouts` stuck past 24h. Different from a DB rehearsal — this checks the actual current state. Added to Phase 17.
- **G4-15 — i18n / multi-currency rendering consistency.** Home currencies are USD/GBP/EUR but gift card catalog currencies are broader. Every place we render money (web, Discord, CSV exports, PDFs if any) must handle `minor → major` consistently. Added to Phase 11 (cross-layer contract).
- **G4-16 — Error-page routing.** 404 / 500 / auth-required — does every unhappy path land on a sensible route? Every API-only endpoint returns JSON; the split-screen issue is when a user navigates to an API path directly and hits a JSON blob. Added to Phase 8.
- **G4-17 — Upstream schema version tolerance.** Our zod schemas validate CTX responses. Do they fail open (pass through unknown fields) or closed (reject new fields)? Either is fine but the choice should be explicit per schema. Added to Phase 5.
- **G4-18 — Admin UI accessibility.** Ops teams are at keyboards all day; admin UI a11y is ops productivity. Added to Phase 8.
- **G4-19 — Flap-damping is recent but unproven.** We just merged PR #752. In Phase 13 the plan says "verify works in staging" — elevated to **required** evidence item (captured log showing the streak gate firing and the cooldown suppressing).
- **G4-20 — Stellar fee strategy.** Under congestion, do we fee-bump? Is the fee-bump amount bounded? Is the fee-source account funded? Added to Phase 5 (payments module) + Phase 17 (operational readiness).

---

## 6.5 — Financial Correctness (elevated phase, runs after Phase 6, before Phase 11)

**Scope:**

- Ledger invariant: `user_credits.balance_minor == SUM(credit_transactions.amount_minor) GROUP BY user_id, currency`
- Reconciliation endpoint (`/api/admin/reconciliation`) behavior: verify it actually detects drift we inject
- Ledger → on-chain consistency: every `payouts_submitted` row has a matching Stellar transaction, every confirmed on-chain transaction has a ledger entry
- CTX-invoice → supplier-spend aggregate: cross-reconcile our `orders.wholesaleMinor` sum against what CTX says they billed us for a given window
- Cashback-config → actual split: for a sample of fulfilled orders, recompute the split using `merchant_cashback_configs` history and confirm `userCashbackMinor + loopMarginMinor == faceValueMinor - wholesaleMinor` (or whatever the invariant is — derive it)
- Round-trip precision: a user earns X, recycles X, ends at balance 0. No `ε` leakage through rounding.
- Currency boundaries: a fulfilled order with `chargeCurrency = USD` and `orders.currency = GBP` — where does the rate come from, where is the locked rate persisted, who does it round against
- Refund path: `credit_transactions.type='refund'` writers — only from documented paths? Negative balances possible?
- Interest accrual (ADR 009): computed when, rounded how, idempotent across reruns?
- Sign convention: positive credit, negative debit — enforced everywhere? `CHECK (amount_minor != 0)`?

**Method:**

1. Materialize the ledger invariant in SQL and run it against a prod-shaped dataset (staging seeded from scrubbed prod).
2. Inject a synthetic drift row; confirm reconciliation endpoint surfaces it.
3. Walk every writer to `credit_transactions`: `procurement.ts`, `admin/credit-adjustments.ts`, `admin/refund.ts`, interest-accrual cron (wherever lives). For each, assert: transaction-bounded with the balance update, sign convention enforced, idempotency key present (ADR 017).
4. Walk every writer to `pending_payouts`: same treatment.
5. Property-based tests for cashback math primitives in `@loop/shared` and `apps/backend/src/orders/`.
6. Cross-verify: for a sampled 1000-row window, reproduce `supplier-spend` from raw orders in a notebook; compare to the endpoint's output.

**Evidence:** SQL invariant scripts; injected-drift test log; property-test coverage report; notebook diff.

**Exit:** no invariant violated on a prod-shaped dataset; every ledger/payout writer explicitly transaction-bounded; idempotency keys audited for admin writes (ADR 017 spot check).

---

### Pass 5 — adversarial re-read after pass 4 declared freeze

**Reviewer stance:** "pass 4 claimed freeze. That's a red flag. Read the plan again like someone trying to prove the plan incomplete."

Substantial new gaps surfaced — freeze retracted.

**File-system granularity (Phase 0):**

- **G5-01** — Symlink inventory. `find . -type l` — any repo symlinks? If so, audited for cycles / escape from repo.
- **G5-02** — Executable-bit audit. `git ls-files --stage` — any file `100755` that shouldn't be? Any shell script `100644` that should be executable?
- **G5-03** — Large-file / binary inventory. Files > 1MB; all binaries (images, protos compiled, fonts) — every one has a traceable origin and license.
- **G5-04** — Regenerability of generated files beyond proto: `react-router typegen` output, `drizzle-kit` migration snapshot, `openapi.json` (if we ever cache it), iOS/Android generated projects. Each regenerator run; diff = 0 required.
- **G5-05** — Untracked-but-important files. `git status --ignored` review — anything accidentally ignored that shouldn't be? Any expected build artifact path that doesn't exist?

**Org-level / account hardening (Phase 1):**

- **G5-06** — GitHub org 2FA enforcement. `gh api orgs/LoopDevs` → `two_factor_requirement_enabled`.
- **G5-07** — Org webhook inventory. `gh api orgs/LoopDevs/hooks` → any unexpected integrations?
- **G5-08** — Deploy-key / service-account inventory. Every machine identity that can push or deploy; last-used timestamp.
- **G5-09** — GitHub audit log retention + review cadence — is anyone reading it?
- **G5-10** — SSH key inventory for the `main` push-capable users (indirect — via account review).

**Supply chain depth (Phase 3):**

- **G5-11** — Postinstall / preinstall / prepare script scan. `npm install` runs arbitrary code from every dep that declares these hooks. Enumerate every one in the tree; classify risk.
- **G5-12** — Native binary deps. `sharp`, `@stellar/stellar-sdk` may ship prebuilt binaries. Where from? Checksum verified? Locked version?
- **G5-13** — Root `package.json` scripts auditable — any script that runs `curl | sh` or fetches remote code.
- **G5-14** — Lockfile freshness vs `package.json` drift (`npm install` on a clean clone must not modify the lockfile; if it does, the file is inconsistent).

**Build / release hardening (Phase 4):**

- **G5-15** — SBOM generation — do we emit an SBOM (CycloneDX / SPDX) per build? If not, recorded as Info/Low.
- **G5-16** — Build-provenance attestation (GitHub's attest-build-provenance action) — present?
- **G5-17** — Container image vulnerability scanning (trivy / grype) in CI — present? Runs on every build?
- **G5-18** — Image signing (cosign / sigstore) — applicable for our deploy target?
- **G5-19** — Docker layer cache poisoning risk — are base-image digests pinned (G2-20 covered tag pinning, this is deeper — rebuild determinism with a poisoned cache)?
- **G5-20** — Build reproducibility in the strict sense: same source SHA + same build env → byte-identical image?
- **G5-21** — Migration-vs-deploy ordering. Are SQL migrations applied before or after the new app version? Documented?

**Runtime & process (Phase 5):**

- **G5-22** — Graceful shutdown on SIGTERM: drain in-flight requests, close DB pool, finish Discord webhooks in flight, exit 0. Concrete probe: send SIGTERM, measure drain time.
- **G5-23** — In-flight request behavior during deploy. Fly rolls instances — is there a load-balancer-aware drain? Any in-progress POST /orders: where does it land?
- **G5-24** — Background job durability. `procurement.ts` / payout submitter — if the process crashes mid-work, is state recoverable from the DB alone?
- **G5-25** — Cron / scheduler inventory. Interest accrual (ADR 009), merchant sync, location sync — what triggers them? single-instance safety? missed-run policy?
- **G5-26** — Unhandled promise rejection handler. `process.on('unhandledRejection', ...)` registered? crashing vs logging policy.
- **G5-27** — Heap growth under sustained load. At minimum, a 30-min soak-test procedure documented; ideally executed.
- **G5-28** — Upstream-schema version-tolerance policy explicit per zod schema (`z.object().passthrough()` vs `.strict()`) — already captured in G4-17, elevated: every zod schema in `apps/backend/src/**` tagged.

**Database depth (Phase 6):**

- **G5-29** — Connection pool size vs instance memory. `postgres` client pool size × instances × max per-connection memory — does it exceed DB connection limit?
- **G5-30** — Statement timeout set on DB session (`SET statement_timeout`)? A long-running admin aggregate shouldn't be able to monopolize a pool connection.
- **G5-31** — VACUUM / ANALYZE strategy. Autovacuum tuned? Long-lived transactions blocking vacuum?
- **G5-32** — Read replica topology. Any? Admin CSVs route there?
- **G5-33** — Prepared-statement lifecycle under pgbouncer (if applicable).
- **G5-34** — Long-query cancellation on client abort.

**Phase 6.5 additions:**

- **G5-35** — Currency conversion lock-in. For a USD-paying user buying a GBP gift card: when is the FX rate locked (order creation? procurement? fulfillment)? Where is the locked rate persisted? Recomputation must round the same way downstream.
- **G5-36** — Stellar memo uniqueness. Orders paid on-chain use `memo` for correlation (ADR 015/016). What if memo collides across orders? What happens at correlation time?
- **G5-37** — Double-entry bookkeeping invariant (implicit or explicit) — for every money movement, a corresponding opposing entry? Enforced by DB constraint or only by code?
- **G5-38** — Edge cases: user changes home currency mid-order, user deletes account with non-zero balance, merchant's cashback-config is updated while orders are in flight — explicit test path for each.

**API depth (Phase 7):**

- **G5-39** — HTTP method safety. Every GET is idempotent + safe; POST is not idempotent without an explicit key (ADR 017); DELETE is idempotent by contract.
- **G5-40** — 5xx response body leak. No stack traces, no SQL error text, no internal file paths in response bodies. Middleware check + sampled handlers.
- **G5-41** — ETag / Last-Modified usage consistency — any handler that sets these must do validator-correct.
- **G5-42** — Accept-header negotiation beyond protobuf (e.g. `Accept-Version` or API version header if we ever introduce versioning).
- **G5-43** — CDN interaction. If Fly / Cloudflare caches responses in front of us, every `Cache-Control` choice is checked against expected CDN behavior.
- **G5-44** — Error-code taxonomy is a closed set — no handler invents a new code string.

**Web depth (Phase 8):**

- **G5-45** — `robots.txt` content vs intent. Admin paths disallowed? Public crawlable surface limited?
- **G5-46** — `sitemap.xml` (if generated) contains only intended URLs.
- **G5-47** — `manifest.json` (PWA) accuracy — icons, scope, theme.
- **G5-48** — `<a rel="noopener noreferrer">` on every external link.
- **G5-49** — Service worker, if present — cache strategy, unregister path.
- **G5-50** — Analytics / third-party JS inventory. Any `<script src>` external; each audited for privacy.
- **G5-51** — Subresource integrity (SRI) for external scripts if any remain.
- **G5-52** — Open-graph / Twitter-card meta accuracy per route.
- **G5-53** — LCP candidate detection — hero image preloaded correctly?
- **G5-54** — Form autocomplete attributes: `autocomplete="email"` / `one-time-code` on OTP input.

**Mobile depth (Phase 9):**

- **G5-55** — iOS ATS (`NSAppTransportSecurity`) — exceptions scoped to specific domains, not global.
- **G5-56** — iOS background modes declared in `Info.plist` actually used; unused entries removed.
- **G5-57** — Universal links vs custom URL schemes — which do we use for deep links? Collision risk for custom schemes.
- **G5-58** — Android `android:allowBackup` — disabled (already covered by overlay script per ADR, re-verify).
- **G5-59** — Android intent-filter `android:autoVerify="true"` for https-based deep links.
- **G5-60** — Android `android:exported` set explicitly on every activity / service / receiver (API 31+ requirement).
- **G5-61** — iOS/Android version-bump discipline — `CFBundleShortVersionString`, `CFBundleVersion`, `versionCode`, `versionName` — bumped how? On every release?
- **G5-62** — Biometric fallback. If Face ID fails, what does the UI do? Accessibility when biometrics aren't available.
- **G5-63** — SSL pinning — for a payments-adjacent app, evaluate the decision. Not pinning is a trade-off; either direction, record the decision.
- **G5-64** — Jailbreak / root detection. Not a security boundary (client-side checks are bypassable) but some products record it. Decision: yes/no with rationale.
- **G5-65** — Capacitor plugin version skew. Old mobile binary + new web bundle installed via static export — what plugin APIs must remain backward compatible?

**Shared package (Phase 10):**

- **G5-66** — Circular import check (`madge --circular` or similar) across `packages/shared/src/`.
- **G5-67** — Public-API change detection in the last 30 days: what's exported now vs 30 days ago? Unintentional breaks?

**Cross-app (Phase 11):**

- **G5-68** — Continuous drift detector (not point-in-time): a CI job that compares openapi.ts output against `apps/web/app/services/**` consumer types and fails on drift. Present? If not, finding.
- **G5-69** — Client version skew tolerance. Old mobile binaries hitting newer backend: what breaks? backend version negotiation policy?
- **G5-70** — Exhaustive enum handling — every `switch(state)` over `OrderState`, `PayoutState`, `CreditTransactionType` has a `default` that asserts never, and lint-catches new variants.

**Security depth (Phase 12):**

- **G5-71** — Privilege escalation vectors. Enumerate: social-login callback can set `is_admin`? Config upsert body can include `is_admin`? `/me` PATCH can flip admin?
- **G5-72** — OTP rate-limit per email (not just per IP). An attacker can cycle IPs; per-email limit is the meaningful guard against brute force.
- **G5-73** — OTP timing side-channel. Constant-time compare on the OTP verify path.
- **G5-74** — Session fixation. Any scenario where a pre-auth identifier survives auth and becomes an authenticated identifier?
- **G5-75** — Step-up auth for destructive admin actions — is admin-bit alone sufficient for all admin actions or should some require re-auth?
- **G5-76** — Debug / diagnostic endpoints. `/status`, `/debug`, `/metrics`, `/openapi.json` — inventory, each access-controlled appropriately.
- **G5-77** — Clickjacking. `X-Frame-Options: DENY` or `Content-Security-Policy: frame-ancestors 'none'` on every HTML response.
- **G5-78** — Open-redirect vectors. Any handler that takes a URL and redirects to it (post-OTP success redirect? oauth callback `state` param?).
- **G5-79** — HTTP response splitting. User-controlled headers echoed in response (rare in modern frameworks; still check).
- **G5-80** — Path traversal. Any handler taking a filename / path / slug and constructing a filesystem path or an upstream URL from it.
- **G5-81** — Cache poisoning. Any cacheable response whose key includes a user-controllable header.
- **G5-82** — Mass scraping protection on public endpoints (`/api/public/top-cashback-merchants`, `/api/public/stats`). Rate limit present; enumerate scraping risk.
- **G5-83** — Referrer-policy header. Default is `strict-origin-when-cross-origin`; any override?
- **G5-84** — Cookie security flags if cookies exist (httpOnly, secure, sameSite).
- **G5-85** — Content-Type sniffing (`X-Content-Type-Options: nosniff`) — confirmed present via secure-headers middleware but verified per response.
- **G5-86** — CSP header — present? If not, recorded as a deliberate gap.
- **G5-87** — Strict-Transport-Security — confirmed + max-age appropriate.
- **G5-88** — Backend `SECURITY.md` file — contact info for vulnerability reports.

**Observability depth (Phase 13):**

- **G5-89** — Alert deduplication / grouping strategy. Discord has no native dedup — is there any grouping in our notifier?
- **G5-90** — On-call paging integration. Discord pings ≠ paging — is there a paging tier above Discord?
- **G5-91** — Log sampling. High-volume endpoints (image proxy, clusters) — sampled or full?
- **G5-92** — Frontend error reporting. Sentry-for-web configured? Stack trace symbolication enabled?
- **G5-93** — Real-user monitoring (LCP, CLS, INP) on public pages. Present?
- **G5-94** — SLI / SLO definition — documented or implicit?

**Testing depth (Phase 14):**

- **G5-95** — Mutation testing. Would our tests detect a flipped boolean or a removed line? Spot-check via `stryker` or similar on one critical module.
- **G5-96** — Snapshot-test brittleness audit. Every `toMatchSnapshot` inspected; any that snapshot user-visible strings that'd pass on regression?
- **G5-97** — Random / time seed determinism. Any test using `Date.now()` or `Math.random()` without a freeze?
- **G5-98** — Inter-test leakage. Shared state, test-order dependencies.
- **G5-99** — CI cache integrity. A poisoned cache scenario — what's the blast radius?
- **G5-100** — Test parallelism safety — vitest default is parallel; any shared resource (DB, env) unsafe under parallelism?

**Docs depth (Phase 15):**

- **G5-101** — `LICENSE` file presence + SPDX headers in source files if the project policy requires.
- **G5-102** — `CODE_OF_CONDUCT.md` presence.
- **G5-103** — `SECURITY.md` presence (G5-88 cross-cut).
- **G5-104** — `CHANGELOG.md` discipline — "keep-a-changelog" convention? Release notes?
- **G5-105** — ADR amendment convention — are ADRs immutable once accepted, or amended? If amended, is there a version history?

**CI/CD depth (Phase 16):**

- **G5-106** — Preview / ephemeral environments per PR — present? Required for UI-heavy PRs?
- **G5-107** — Canary / blue-green / rolling deploy strategy documented? Tested via a planned failed deploy?
- **G5-108** — Rollback procedure — one-click? Rehearsed in the last 90 days?
- **G5-109** — Schema migration vs app-deploy ordering — documented (G5-21 cross-cut).
- **G5-110** — Static analysis in CI beyond ESLint — semgrep / codeql / eslint-plugin-security — present?
- **G5-111** — Dependabot auto-merge policy for patch updates — off by default; any exceptions?

**Operational depth (Phase 17):**

- **G5-112** — Cost governance — alerts on unexpected Fly / Sentry / Discord / CTX spend?
- **G5-113** — DR plan — multi-region failover? Data loss bound (RPO)? Recovery time bound (RTO)?
- **G5-114** — Capacity plan — current peak load, headroom, next-level capacity cost.
- **G5-115** — Error budget tracking — if SLO defined, burn-rate alerting.
- **G5-116** — Runbook freshness — every runbook has a last-rehearsed-by-whom-when line.
- **G5-117** — Communication playbook for outages — status page, customer comms template, legal/regulatory notification thresholds.

**Red-team additions (Phase 18):**

- **G5-118** — Brute-force OTP — probe rate-limit-per-email (G5-72 attack test).
- **G5-119** — Mass merchant-slug scraping via `/api/merchants` pagination.
- **G5-120** — Protobuf fuzzing — malformed Cluster messages to `/api/clusters`.
- **G5-121** — Admin-audit tampering probe — can an admin's own actions be redacted from `admin_audit`?
- **G5-122** — Refresh-token replay after rotation (already G4 but elevated; execute via Playwright capture).
- **G5-123** — CSV export poisoning — formula injection (`=cmd|...`) in merchant name → CSV output.
- **G5-124** — Discord-embed link-injection — user-controlled text constructing a markdown link `[safe](evil)`.
- **G5-125** — Order-state enumeration — request orders by incrementing IDs; does backend leak existence?

**Meta / audit-self-risk (Phase 19 + §0):**

- **G5-126** — Probes that touch production must be enumerated up-front + owner-approved. Red-team probes on prod = incident risk. Separate "prod-touch" subset of Phase 18.
- **G5-127** — Tracker confidentiality. Findings document vulnerabilities — policy on who can read, where it's stored, whether it's public in the repo or moved to a private location once signed.
- **G5-128** — Sign-off authority — single signer or two-person rule? Documented.
- **G5-129** — Evidence retention — evidence files are not deleted after sign-off; policy on redaction if PII is captured during evidence gathering.
- **G5-130** — Legal hold considerations — some evidence types may need chain-of-custody if ever escalated.

### Pass 6 — did pass 5 miss anything?

**Reviewer stance:** "pass 5 found 130 items. That's a lot. What's left?"

Genuine additional gaps:

- **G6-01 — Diagnostic completeness for Stellar.** Every `@stellar/stellar-sdk` call audited for: timeouts, retry, network-confirmation wait, fee-bumping under congestion, submission-race behavior if two instances submit the same txn.
- **G6-02 — TOCTOU (time-of-check-time-of-use) on balance updates.** Does the balance-update path re-read the row inside the transaction before writing? Otherwise a concurrent update races.
- **G6-03 — Cron single-leader election.** If we deploy N instances, which one runs interest accrual? PG advisory locks? Random? What if two run?
- **G6-04 — Merchant catalog eviction (ADR 021).** Policy audited at admin-side; is the runtime behavior (a merchant disappearing from CTX mid-fetch) gracefully handled?
- **G6-05 — Email deliverability ownership.** CTX sends OTP emails. Our deliverability reputation is tied to theirs. Recorded, monitored.
- **G6-06 — Apple/Google signing cert expiry.** Certs expire; expiry date documented; renewal runbook.
- **G6-07 — Push-notification infrastructure.** None today? Documented decision; when/if added, auth considerations.
- **G6-08 — Mobile app minimum-OS policy.** iOS N and Android N minimum; documented per release.
- **G6-09 — Content moderation.** Merchant names are upstream-sourced; profanity / IP-infringement filter needed? Escalation path for a bad merchant entry.
- **G6-10 — Tax / regulatory reporting.** Gift cards have 1099-K thresholds in the US; VAT in EU. Does the data model support the reports a finance team would need?
- **G6-11 — Mobile data usage / offline behavior.** App on a plane — what works offline? Static export → routes load; any screen that calls `/api/*` on mount with no offline fallback?
- **G6-12 — App-review rejection history.** Any prior rejections logged; remediation notes.
- **G6-13 — Shader / GPU-accelerated paths (if any, e.g. map).** Fallback for low-end devices; verified.
- **G6-14 — Haptic use policy.** ADR-004 / `apps/web/app/native/haptics.ts` — used only in documented scenarios? No spammy haptics?
- **G6-15 — Keyboard avoidance / safe-area handling.** iOS inset behavior during OTP entry etc.
- **G6-16 — "Small screen" rendering (≤360px).** Admin UI often breaks here; audited explicitly.
- **G6-17 — Print CSS / stylesheet** (for admin reconciliation reports printed to PDF by ops).
- **G6-18 — Copy / paste discipline on secrets.** Does any UI surface a Stellar seed / private key / admin token via the clipboard? Policy: never.
- **G6-19 — Accessibility audit of error messages.** Screen-readers announce errors? `aria-live` regions?
- **G6-20 — Unsafe use of `localStorage` for auth data.** `sessionStorage` vs `localStorage` — explicit per data type.
- **G6-21 — IndexedDB state audit** (if web uses it — check).
- **G6-22 — Service-account key proximity.** Operator pool credentials — stored where in prod? TPM/KMS-wrapped or plain env?
- **G6-23 — Postgres role hygiene.** App role has `SUPERUSER`? `CREATEDB`? Expected: minimal privileges.
- **G6-24 — PgBouncer / connection pooler presence.** If present, transaction-mode vs session-mode — implications for prepared statements.
- **G6-25 — Network egress controls.** Backend egresses to Stellar, CTX, Discord, Sentry. Can it egress to arbitrary hosts (e.g. if SSRF hit)?
- **G6-26 — Backend inbound network policy.** Only Fly's edge can reach the app? No public IP on the app process.
- **G6-27 — Admin CSRF** (if cookies at all) — admin UI cross-site request forgery surface.
- **G6-28 — Time bombs / sentinel values.** Any `TODO(ash, 2025)` that's now past-due? Any hard-coded "temporary" values.
- **G6-29 — Hidden channels.** `sessionStorage` / `localStorage` keys inventory — any key with PII that isn't cleared on logout?
- **G6-30 — Logout completeness.** Tokens cleared from memory, sessionStorage, secure storage, server-side revocation of refresh token attempted.

### Pass 7 — final exhaustion sweep

**Reviewer stance:** "assume passes 1–6 covered the obvious. What's left is subtle, adjacent, or philosophical."

Additional gaps (smaller in scope; if this pass were empty we'd stop sooner):

- **G7-01 — Entropy source for `Memo` / idempotency keys.** `crypto.randomUUID()` everywhere, not `Math.random()`? Verified.
- **G7-02 — Hash-DoS on any Map keyed by user-controlled string.** Rate-limit map is per-IP (controlled), but any other `Map<string, *>` keyed on input?
- **G7-03 — Error class hierarchy.** `OperatorPoolUnavailableError`, `CircuitOpenError`, `ApiException` — consistent prototypes, `instanceof` works across process bounds?
- **G7-04 — Number → bigint coercion paths.** `BigInt(Math.trunc(value))` audited — any float→bigint that loses precision?
- **G7-05 — JSON.parse without guard.** `JSON.parse(userInput)` anywhere? Must go through zod.
- **G7-06 — URL parsing inconsistency.** `new URL()` vs `URL.parse` behavior across Node + browser; consistent.
- **G7-07 — Temporal arithmetic.** Month-level math — `setMonth` pitfalls (31 Jan + 1 month = ?).
- **G7-08 — Floating-point comparison.** Any `===` on a `Number` that could be a float? Money uses bigint so low risk but re-verified in non-money paths (e.g. latency percentiles).
- **G7-09 — Timeout cascades.** Backend→CTX timeout (5s), client→backend timeout (default?), Fly healthcheck (5s). Chain must not cause thundering-herd retries.
- **G7-10 — Abort-signal propagation.** `AbortSignal.timeout` used inside `fetch`; does the abort actually cancel the upstream connection?
- **G7-11 — Locale-aware sort.** Any `sort()` over user-visible strings using `localeCompare`? Should it?
- **G7-12 — Leap-second / DST boundary.** 24h window on admin endpoints — DST transition days have 23 or 25 hours. Audited.
- **G7-13 — Proto-enum tolerance.** Backend emits proto messages; if web deserializes an enum value newer than the web build, behavior is…?
- **G7-14 — Unused env vars.** `.env.example` lists vars; `env.ts` declares them; grep uses. Any declared-but-never-read var is either future-use (document) or dead.
- **G7-15 — Feature-detection degradation.** If `Intl.NumberFormat` fails (rare), money rendering must not crash.
- **G7-16 — CSV encoding boundary.** BOM prefix? Excel-compatible UTF-8 export? RFC 4180 is audit-correct but Excel needs BOM for non-ASCII.
- **G7-17 — Protobuf schema versioning policy.** `clustering.proto` — when a field is added/removed/renumbered, backward/forward compat?
- **G7-18 — UUID collision tolerance.** Practically zero, but if the DB uses `gen_random_uuid()` on a partition, verified.
- **G7-19 — Dev ergonomics bleed into prod.** `NODE_ENV !== 'production'` branches — enumerated; no dev-only debug code path reachable in prod.
- **G7-20 — Browser-storage quota exhaustion.** If we ever write more to `sessionStorage` than the quota (~5MB), does the code handle `QuotaExceededError`?

### Pass 8 — is pass 7 the last one?

Attempted. After passes 1–7, the remaining candidates on re-read were all subclasses of already-captured items (e.g. "X under load" = capacity plan G5-114; "X with adversarial input" = Phase 18 attack list). No novel axes surfaced. Recording this pass as **empty (0 new items)** per the stopping rule.

Stopping rule satisfied: pass 8 returned empty, so passes 1–7 are deemed exhaustive for the current scope. Further gaps, if any, will surface during execution and be filed as findings against the plan itself (Phase 19 includes a "plan deficiency" category).

---

## 8. Execution order (derived)

```
Phase 0  (inventory)          ─┐   prerequisite
                               │
Phase 1  (governance)          │
Phase 2  (architecture)        ├── can run in parallel after 0
Phase 3  (supply chain)        │
Phase 4  (build/release)       │
                               │
Phase 5  (backend modules)    ─┤
Phase 6  (data layer)          ├── 5–10 in parallel; share evidence folder
Phase 7  (api surface)         │
Phase 8  (web modules)         │
Phase 9  (mobile)              │
Phase 10 (shared)              │
                               │
Phase 6.5 (financial correctness) ──  needs 5/6/10 complete
Phase 11 (cross-app)          ─┤   needs 5/6/7/8/10/6.5 complete
Phase 12 (security)            │   needs 1/2/5/6/7/8/6.5
Phase 13 (observability)       │   needs 5 complete
Phase 14 (testing)             │   needs 5/8/10/6.5 complete
Phase 15 (docs)                │   last among single-module phases (reconciles code)
Phase 16 (CI/CD)               │   can run after 1
Phase 17 (operational)         │   needs 13/14/15/16
                               │
Phase 18 (red-team)           ─┘   last phase of audit
Phase 19 (synthesis)           ──  after 18; final audit output

─────── AUDIT COMPLETE ───────
Post-audit remediation           ─┐  Critical → High → Medium → Low
                                  │  separate phase; tracker drives it
                                  │  each remediation references the
                                  │  finding ID and the commit SHA that
                                  │  resolved it; re-review confirms
                                  │  before marking resolved
─────── REMEDIATION COMPLETE ──
Sign-off                          ──  only when every finding is resolved
                                      (or accepted-with-rationale + second
                                      reviewer)
```

## 9. Sign-off criteria (re-asserted)

Before signing:

- [ ] Phase 0 file list covers 100% of `git ls-files`
- [ ] **No `status: open` finding at any severity** (pre-launch; severity orders the queue but every finding is resolved)
- [ ] Any `accepted` / `wontfix` / `deferred` finding carries a written rationale and a second-reviewer sign-off
- [ ] Every ADR reconciled
- [ ] Every route in the API matrix has `auth`, `rateLimit`, `cache`, `openapi-registered`, `error-codes-enumerated` columns filled
- [ ] Every handler has a test-file pointer and at least one sad-path test
- [ ] Every `apps/backend/src/admin/` handler has a `requireAdmin` confirmation
- [ ] Every `apps/web/app/native/` plugin has a web fallback or a documented reason it doesn't
- [ ] Phase 6.5 ledger invariant held on a prod-shaped dataset
- [ ] Every ledger/payout writer confirmed transaction-bounded with balance update
- [ ] At least one end-to-end user-journey test exists (signup → order → cashback → recycle)
- [ ] Backup rehearsal performed in staging, log captured
- [ ] Deployed-image digest matches a main-branch commit SHA
- [ ] Discord channels audited for PII absence on all 20+ notifier types
- [ ] Flap-damping staging run captured (G4-19)
- [ ] Error-code taxonomy documented + consumed consistently by `apps/web/app/services/**`
- [ ] `docs/audit-2026-tracker.md` has signers and date
- [ ] `docs/audit-2026-evidence/` has ≥1 file per phase
- [ ] Plain-English summary written and placed at the top of the tracker

---

## 10. Timeline & effort

This is a full-surface audit of ~1100 files, ~150 endpoints, 23 ADRs, 4 workspaces. Realistic effort for one careful auditor:

| Phase                       | Effort (days) |
| --------------------------- | ------------- |
| 0 — Inventory               | 1             |
| 1 — Governance              | 0.5           |
| 2 — Architecture            | 1             |
| 3 — Deps                    | 0.5           |
| 4 — Build/release           | 1             |
| 5 — Backend modules         | 5             |
| 6 — Data layer              | 1.5           |
| 6.5 — Financial correctness | 2             |
| 7 — API surface             | 2             |
| 8 — Web modules             | 3             |
| 9 — Mobile                  | 1             |
| 10 — Shared                 | 0.5           |
| 11 — Cross-app              | 1             |
| 12 — Security               | 3             |
| 13 — Observability          | 0.5           |
| 14 — Testing                | 1.5           |
| 15 — Docs                   | 1             |
| 16 — CI/CD                  | 0.5           |
| 17 — Operational            | 1             |
| 18 — Red-team               | 2             |
| 19 — Synthesis              | 0.5           |
| **Total**                   | **~29 days**  |

Elapsed calendar time depends on how many auditors run phases 5–10 in parallel; one auditor straight-line is ~6 calendar weeks.
