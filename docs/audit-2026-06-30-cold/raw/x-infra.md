# Sweep: Infra/CI/deps/supply-chain — raw findings

Cold, independent re-derivation per `docs/audit-2026-06-30-cold/plan.md`
principles — prior audit conclusions (`docs/audit-2026-06-15-cold/raw/x-infra.md`)
consulted only after forming an independent view. Scope: `.github/workflows/*.yml`
(all 5), `scripts/**` repo-managed-CLI policy (ADR 029), live `npm audit` /
`npm run audit`, `docs/third-party-licenses.md` vs actual deps, npm
dependency-confusion exposure, SBOM/provenance/cosign (A2-408), lockfile
integrity, node-engine pin consistency, Capacitor plugin parity, plus
checklist §36 (network/DNS/email/CSP/Actions-pinning) and §40 (cost/FinOps)
items that land in this vertical.

## Coverage

| Area                          | Artifacts read / live checks run                                                                                                                                                               | Status                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub Actions workflows      | All 5 `.github/workflows/*.yml` read in full; every `uses:` line extracted + SHA-length-validated programmatically                                                                             | done                                                                                                                                                         |
| Audit policy                  | `scripts/check-audit-policy.mjs` (full); live `npm audit --json`, `npm audit --omit=dev --json`, `npm run audit` (= the CI gate, run live)                                                     | done                                                                                                                                                         |
| Live CI state                 | `gh run list`/`gh run view` on `main` + 19 open Dependabot PRs (`gh pr list`, `gh pr view --json statusCheckRollup`)                                                                           | done                                                                                                                                                         |
| Repo-managed CLIs (ADR 029)   | `scripts/*.sh`, `scripts/*.mjs` grepped for `npx <pkg>`, `npm install -g`, `curl \| sh/bash`; `pr-review.yml` + `ci.yml` install steps read                                                    | done                                                                                                                                                         |
| Licenses                      | `docs/third-party-licenses.md` vs `package.json`×4 + installed `node_modules` versions; scanned `node_modules` for LGPL/MPL/GPL/EUPL LICENSE text                                              | done                                                                                                                                                         |
| Dependency confusion          | `.npmrc`, all 4 workspace `package.json` `name`/`private` fields, `package-lock.json` resolution, both Dockerfiles' COPY/`npm ci` ordering, live `npm view @loop/shared` / registry HTTP probe | done                                                                                                                                                         |
| SBOM/provenance/cosign        | `ci.yml` `sbom` job (CycloneDX gen, attest-build-provenance, cosign sign-blob) re-read end to end                                                                                              | done                                                                                                                                                         |
| Lockfile / node engine        | `find` for nested lockfiles; `engines` field in all 5 `package.json`                                                                                                                           | done                                                                                                                                                         |
| Capacitor parity              | Diffed `@capacitor/*`/`@aparajita/*`/`@capgo/*` versions, `apps/web/package.json` vs `apps/mobile/package.json`                                                                                | done                                                                                                                                                         |
| Network/DNS/email/CSP (§36)   | Live `dig` against `loopfinance.io` apex/www/beta + curl of live CSP headers on `api.loopfinance.io` and `beta.loopfinance.io`                                                                 | done (DNS/email cross-checked against `raw/v-platform.md`, which independently ran the same dig set with the correct `no-reply.` subdomain — see note below) |
| Cost/FinOps (§40)             | Delegated to a focused sub-agent: Stellar fee-bump cap, vendor quota/cost alerting docs                                                                                                        | done                                                                                                                                                         |
| CF-04 / CF-29 re-verification | Live `npm run audit`; `git show --stat` on the CF-29 fix commits                                                                                                                               | done                                                                                                                                                         |

Not covered (out of vertical / owned elsewhere in this audit round): DNS/
email full writeup (owned by `raw/v-platform.md`, which has more precise live
evidence using the correct `no-reply.loopfinance.io` sending subdomain);
per-route rate-limit math (x-concurrency); CSP _content_ correctness beyond
"does it exist" (already confirmed present + nonce-based on both surfaces,
no further finding needed here).

---

## GitHub Actions pinning inventory

Every distinct third-party `uses:` action across all 5 workflow files,
extracted programmatically and validated as a 40-character hex commit SHA
(not a short SHA, not a mutable tag):

| Workflow file(s)                                                         | Action                                 | Ref used (SHA + version comment)                                           | Pinned by full commit SHA? |
| ------------------------------------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------- | -------------------------- |
| ci.yml, codeql.yml, e2e-real.yml, pr-automation.yml, pr-review.yml (16×) | `actions/checkout`                     | `de0fac2e4500dabe0009e67214ff5f5447ce83dd` # v6                            | **Yes**                    |
| ci.yml, e2e-real.yml, pr-review.yml (11×)                                | `actions/setup-node`                   | `48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e` # v6.4.0                        | **Yes**                    |
| ci.yml (11×)                                                             | `actions/cache`                        | `0057852bfaa89a56745cba8c7296529d2fc39830` # v4                            | **Yes**                    |
| ci.yml (6×)                                                              | `actions/upload-artifact`              | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` # v7 / v7.0.1                   | **Yes**                    |
| ci.yml                                                                   | `actions/download-artifact`            | `37930b1c2abaa49bbe596cd826c3c89aef350131` # v7                            | **Yes**                    |
| ci.yml                                                                   | `superfly/flyctl-actions/setup-flyctl` | `fc53c09e1bc3be6f54706524e3b82c4f462f77be` # v1.5                          | **Yes**                    |
| ci.yml                                                                   | `actions/attest-build-provenance`      | `a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32` # v3.0.0                        | **Yes**                    |
| ci.yml                                                                   | `sigstore/cosign-installer`            | `cad07c2e89fa2edd6e2d7bab4c1aa38e53f76003` # v4.1.1                        | **Yes**                    |
| codeql.yml (×2)                                                          | `github/codeql-action/{init,analyze}`  | `95e58e9a2cdfd71adc6e0353d5c52f41a045d225` # v3.30.4                       | **Yes**                    |
| pr-automation.yml                                                        | `actions/labeler`                      | `634933edcd8ababfe52f92936142cc22ac488b1b` # v6                            | **Yes**                    |
| ci.yml, pr-review.yml (via `docker run`, not `uses:`)                    | `aquasec/trivy:0.55.2`                 | `@sha256:addfb8fd6b9e520c25b22c61d8aa5d58ecd7879177aa959f952bf4734f4e3f60` | **Yes** (digest-pinned)    |
| ci.yml, pr-review.yml (via `docker run`)                                 | `zricethezav/gitleaks:v8.30.1`         | `@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f` | **Yes** (digest-pinned)    |

**Headline: 0 of 12 distinct third-party actions/images are pinned by a
mutable tag. 27 `uses:` call sites total, all SHA-pinned, all carrying a
human-readable version comment.** This closes out checklist §36's Actions-
pinning item clean — contrary to the brief's framing that this is
"genuinely new ground," it is new _investigation_, but the underlying
practice is already correct and has been since at least the 06-15 baseline
(confirmed via `git blame` — the SHA-pinning convention predates this audit
round). No finding here; recorded as a verified-good control, not a gap.

Also checked and clean: no `curl | bash`/`| sh` patterns anywhere in the 5
workflows (the two `curl` call sites in `e2e-real.yml`/`ci.yml` are a health-
check GET and a Discord webhook POST, not code execution); no
`npm install -g`; every `npx` invocation (`commitlint`, `playwright install`,
`wait-on`, `@cyclonedx/cyclonedx-npm --no-install`) resolves a package that
is already a pinned, exact-version root `devDependency` in `package-lock.json`
— none of them hit the registry live at workflow runtime. `playwright install
--with-deps` downloads browser _binaries_ from Playwright's own CDN (not an
npm package), which is the standard/expected mechanism for that tool and
outside ADR 029's scope (which targets npm-hosted CLI package resolution).

---

## Findings

### X-INFRA-01 [P0 · LIVE (operational)] `Security audit` required merge gate is RED again — CF-04 has regressed, with a 7-week, 19-PR Dependabot backlog as a direct symptom

- **Evidence:**
  - Live `npm run audit` against the current `main` HEAD (`56926e74`) **fails right now**:
    ```
    npm audit policy failed (high).
    Unaccepted high advisories: @cyclonedx/cyclonedx-npm, hono, undici
    ```
    `npm audit --json` confirms `high=5` (`@cyclonedx/cyclonedx-npm`, `form-data`,
    `hono`, `undici`, `vite`); `scripts/check-audit-policy.mjs`'s
    `ACCEPTED_HIGH_VULNS` map only covers `form-data` and `vite` of those five.
  - This is not a local-only artifact: `gh run list` shows the **same
    commit's** CI run on 2026-06-16 had `Security audit` = **success** (job
    list for run `27590377411`), but the npm advisory feed has shifted since
    then. Direct proof: **9 currently-open Dependabot PRs from 2026-06-20
    onward all show `Security audit` = FAILURE**, including the exact fix
    PRs for two of the three new unaccepted highs — **#1468** ("bump undici
    from 6.25.0 to 6.27.0", open since 06-20) and **#1472** ("bump
    @cyclonedx/cyclonedx-npm from 4.2.1 to 5.0.0", open since 06-23) — plus
    **two duplicate hono-fix PRs, #1465 and #1466** ("bump hono from
    4.12.16 to 4.12.25", both open since 06-20, both failing `Security
audit`). The gate is blocking the very PRs that would close it.
  - This is also not new/isolated to this week: `gh pr view --json
statusCheckRollup` on the older backlog shows **#1352/#1353/#1354
    (opened 2026-05-12) and #1383 (opened 2026-06-04) already failing
    `Security audit`** at open time — by contrast #1349/#1350 (opened
    2026-05-07, before the gate started flapping) pass cleanly. So the gate
    has been intermittently-to-persistently red across **at least 7 weeks**,
    not a fresh one-off.
  - Net effect: **19 open Dependabot PRs** as of this audit (14 npm-ecosystem
    - 5 github-actions-ecosystem), oldest from 2026-05-07 (54 days), with no
      triage/merge since. `dependabot.yml` caps the npm ecosystem at
      `open-pull-requests-limit: 10` — the npm-ecosystem backlog (14 counted)
      is already past that nominal cap, meaning Dependabot may also be
      throttled from opening _further_ npm update PRs until this backlog
      clears.
  - Root-cause detail on the 3 new highs (severity context, since "high" by
    itself doesn't mean runtime-reachable):
    - **hono** (`4.12.16`, range `<=4.12.24`, fix `4.12.27` non-major) is a
      **direct, genuine production dependency** — `apps/backend`'s actual
      HTTP framework (`apps/backend/package.json:31`, plus
      `@hono/node-server` + `@sentry/hono`). The triggering high
      (GHSA-88fw-hqm2-52qc, "CORS Middleware reflects any Origin with
      credentials when `origin` defaults to the wildcard") does not appear
      practically exploitable in Loop's own config — `apps/backend/src/
middleware/cors.ts:56-58` never sets `credentials: true` and uses an
      explicit allowlist array (not the literal `'*'` default) in
      production — but hono also carries **9 unpatched moderate
      advisories** beyond the 3 the existing `ACCEPTED_MODERATE_VULNS`
      rationale documents (IP-restriction bypass, cookie-sanitization gap,
      JWT-scheme bypass, `app.mount()` path-decode bug, `serve-static`
      path traversal, Lambda Set-Cookie merge bug, body-limit bypass,
      Lambda@Edge header drop) — none individually high-severity-reachable
      by Loop's usage as far as this pass could verify, but the
      accumulated drift is the literal production web framework running 11
      versions behind with a trivial non-major upgrade path sitting
      unapplied for the second audit running (the 06-15 audit's
      `ACCEPTED_MODERATE_VULNS` rationale text already said "revisit on the
      next dependency sweep" — this is that sweep).
    - **`@cyclonedx/cyclonedx-npm`** (high: shell injection via unsanitized
      `--workspace` argument, GHSA-v75r-vx73-82pj) is a root
      `devDependency` used only by `ci.yml`'s `sbom` job, which invokes it
      as `npx --no-install @cyclonedx/cyclonedx-npm --output-format JSON
--output-file sbom.cdx.json --spec-version 1.6 --omit dev`
      (`ci.yml:345-350`) — **no `--workspace` flag is passed**, so the
      specific injection vector isn't reachable via Loop's own invocation.
      Fix is major (5.0.0).
    - **undici** (high: TLS-cert-validation bypass via SOCKS5 ProxyAgent,
      GHSA-vmh5-mc38-953g, plus WebSocket DoS + header-injection
      advisories) resolves transitively via **`jsdom`** (`apps/web`
      devDependency, vitest-only DOM shim) and **`@sentry/cli`** (root
      devDependency, sourcemap-upload tool) — both dev/CI-only, never in
      the deployed runtime. Fix is non-major (6.27.0 / 7.28.0+).
  - **Structural diagnosis:** `npm audit` (no `--omit=dev`) audits the
    _entire_ graph including devDependencies, then leans on a hand-written,
    per-package prose rationale (`ACCEPTED_HIGH_VULNS`) to manually re-derive
    "is this reachable in production" every time a new advisory appears.
    That manual step is the bottleneck — it didn't happen for 3 packages
    across at least 9 days (cyclonedx since 06-23, hono+undici since 06-20),
    and historically hasn't happened reliably for ~7 weeks per the
    Dependabot evidence above. Running `npm audit --omit=dev --json`
    against the _exact same_ lockfile right now returns **`high=2`**
    (`form-data` — already accepted, registry false-positive per existing
    rationale — and `hono`) — i.e. **`--omit=dev` alone would have
    automatically silenced 2 of the 3 new blockers** (cyclonedx, undici)
    without anyone touching the allowlist, because npm's own dependency
    graph already knows they're dev-only. Only `hono`, the one package that
    actually matters, would have required a human decision — which is
    exactly the triage load the mechanism should impose, not the noise it
    currently does.
- **Impact:** Every new PR to `main` — human or Dependabot — currently fails
  the `Security audit` required check and cannot merge (branch protection:
  `Security audit` is one of the 5 required contexts, `enforce_admins:
false` only waives the review-approval requirement, not passing-checks).
  The local pre-push hook (`scripts/verify.sh` line 20 calls `npm run audit`)
  blocks `git push` for any developer too. Ironically the dependency bumps
  that would fix 2/3 of the violations are themselves blocked by the gate.
- **Minimal fix:** Add `@cyclonedx/cyclonedx-npm` and `undici` to
  `ACCEPTED_HIGH_VULNS` with the dev-only rationale above (mirrors the
  existing pattern exactly); merge the two open hono-bump PRs (#1465/#1466,
  4.12.16→4.12.25 — already Dependabot-validated, non-major) to clear hono
  for real instead of re-allowlisting it a second sweep running; close the
  duplicate hono PR. This unblocks `main` today.
- **Better fix:** Change `check-audit-policy.mjs`'s base audit invocation to
  cross-reference `npm audit --omit=dev --json` (or equivalently, intersect
  `npm audit --json`'s vulnerable-package set against a programmatically
  computed prod-dependency set, e.g. via `npm ls --omit=dev --json`/`npm
audit --omit=dev`) as the **primary** gating signal, falling back to the
  full-graph audit only as an advisory/Dependabot-visible secondary report.
  This removes the entire class of "new dev-tool transitive advisory blocks
  main" recurrence (it has now happened at least twice: the 06-15 esbuild
  chain, and this cyclonedx/undici pair) while preserving human review for
  anything that actually reaches the deployed runtime. Pair with: (a) a
  standing weekly calendar reminder or a scheduled `cron` workflow that runs
  `npm run audit` outside of any PR and pings Discord/oncall when it goes
  red, so drift is caught within a day instead of discovered by an audit
  sweep weeks later; (b) clear the Dependabot backlog (merge the safe ones,
  close superseded duplicates) and consider raising/monitoring
  `open-pull-requests-limit` so the npm ecosystem isn't silently throttled.
- **Secondary, smaller drift to fix in the same pass:** `docs/standards.md:
1056-1058` lists the "current accepted highs" as 7 packages and omits
  `form-data`, which **is** in the script's live `ACCEPTED_HIGH_VULNS` map
  (`scripts/check-audit-policy.mjs:46-48`) — the doc has drifted from the
  code it's meant to describe (separately from the larger drift above).
  Update both together.
- **Good news / corrected from the 06-15 pass:** The 06-15 audit's
  `P1-INFRA-02` ("phantom `@hono/zod-openapi` peer-dep blocker") **is
  genuinely fixed** — `docs/standards.md:1076-1079` and the script's hono
  rationale text now both correctly state `@asteasolutions/zod-to-openapi`
  has no hono peer constraint and hono is bumpable. Closed, re-verified.
- **Ref:** checklist §8 "npm audit policy gate state", §10 "accepted-advisory
  list justified & current"; prior finding CF-04 / `docs/audit-2026-06-15-
cold/findings.md:39-42`.

### X-INFRA-02 [P3 · LIVE] Third-party-licenses.md has a repeat-unaddressed stale version and two undocumented copyleft/weak-copyleft packages

- **Evidence:**
  - `docs/third-party-licenses.md:97` (the `@capgo/inappbrowser` MPL-2.0
    entry) still says **`8.6.1`**; both `apps/web/package.json:31` and
    `apps/mobile/package.json:28` declare `8.6.2`. This is the _exact same_
    drift the 06-15 audit flagged as `P3-INFRA-05` two weeks ago — it was
    not fixed in the remediation wave.
  - `lightningcss@1.32.0` (`node_modules/lightningcss/package.json`
    `"license": "MPL-2.0"`) is pulled in transitively by
    `@tailwindcss/vite` → `@tailwindcss/node` (used in `apps/web`'s Vite
    build) and by `vite`/`vitest` themselves. It is **not** in
    `third-party-licenses.md`, despite the doc already treating MPL-2.0 as
    attribution-worthy for `@capgo/inappbrowser`. (Build-time-only use is a
    real mitigating distinction vs. a runtime-shipped plugin — but the doc's
    own stated policy doesn't draw that line, so the omission is an
    inconsistency against the doc's own logic, not a clear non-issue.)
  - `argparse@2.0.1` (transitive via `js-yaml`) declares `"license":
"Python-2.0"` — outside the doc's blanket-covered set ("MIT / Apache-2.0
    / ISC / BSD-3", `third-party-licenses.md` final section). Permissive,
    low materiality, but technically uncovered by the doc's own carve-out
    list.
- **Impact:** Low — none of these create an actual compliance breach (MPL/
  Python-2.0 notices still ship via `node_modules/<pkg>/LICENSE` per npm's
  normal install behavior), but the document is the named source of truth
  for the future public `/licenses` page and has now missed one fix cycle.
- **Minimal fix:** Bump the inappbrowser version string to `8.6.2`; add a
  short paragraph each for `lightningcss` and `argparse` (or explicitly
  rule them out with the build-time/permissive reasoning, matching the
  doc's existing style).
- **Better fix:** Automate this — the doc itself already flags the gap
  ("`scripts/lint-docs.sh` doesn't currently lint dependency licences").
  Add a CI step running `license-checker` (or similar) against the full
  tree, diffed against an explicit allowlist of already-reviewed licenses;
  fail only on a _new_ license family appearing, so the doc can't silently
  drift again.
- **Ref:** checklist §10 "license compliance (third-party-licenses.md
  complete & accurate)"; prior P3-INFRA-05 (unaddressed).

### X-INFRA-03 [P3 · LIVE, mitigated] npm dependency-confusion: `@loop/*` scope is unclaimed on the public registry; current build practice mitigates it but no explicit guard exists

- **Evidence:** `https://registry.npmjs.org/@loop%2fshared` returns **404**
  (`npm view @loop/shared` confirms: `E404 Not Found`) — the `@loop` npm
  org/scope is not reserved. All 4 workspace packages declare `"private":
true` and are referenced by consumers as `"@loop/shared": "*"`
  (`apps/web/package.json:32`, `apps/backend/package.json:26`). Under npm
  workspaces, any dependency name matching a workspace member is resolved
  locally rather than from the registry, **as long as that workspace's
  `package.json` is present in the active install context**. Verified this
  holds in practice: root-level CI installs (`npm ci` from repo root) always
  have the full tree; both Dockerfiles (`apps/backend/Dockerfile:9-11`,
  `apps/web/Dockerfile:5-7`) explicitly `COPY packages/shared/package.json`
  alongside the root manifest before running `npm ci`, so `@loop/shared`
  always resolves as a workspace member in every build path that exists
  today.
- **Impact:** Currently low/theoretical — no install path in the repo
  resolves a `@loop/*` name from the registry. The residual exposure is
  forward-looking: anyone could register the `@loop` org on npmjs.com today
  and publish a malicious `@loop/shared` (or `@loop/backend`, `@loop/web`,
  `@loop/mobile`) matching the `*` range; if a _future_ build/CI change ever
  runs `npm install`/`npm ci` in a context missing the matching workspace
  package.json (e.g. a new partial-Docker-context script, a future
  serverless-function bundler that copies only one workspace), that install
  would silently pull the attacker's package instead of erroring, and the
  build would succeed with attacker code merged in.
- **Minimal fix:** Reserve the namespace defensively — publish empty
  placeholder packages under `@loop/shared`, `@loop/backend`, `@loop/web`,
  `@loop/mobile` (or at minimum `@loop/shared`, the one referenced from two
  different consumers) to the public registry under a Loop-controlled npm
  account. Cheap, permanent, closes the gap outright regardless of future
  build changes.
- **Better fix:** Same, plus add a CI assertion (one line in the `quality`
  or `build` job) that `node_modules/@loop/shared` is a **symlink** into
  `packages/shared` (e.g. `test -L node_modules/@loop/shared || (echo
"::error::@loop/shared resolved from registry, not workspace" && exit 1)`)
  — this converts the dependency-confusion risk from "silent" to "CI fails
  loudly" for any future install-path regression, independent of whether
  the namespace itself is ever reserved.
- **Ref:** checklist §36 "npm dependency-confusion"; corroborated by
  `raw/v-platform.md`'s independent `npm view` check (same conclusion, no
  finding written there — recorded here as the primary write-up).

### X-INFRA-04 [P3 · LIVE] No FinOps cost/quota alerting documented for Resend (email); MaxMind is a non-issue by design

- **Evidence:** `docs/slo.md`'s "Third-party quota + cost alerts — A2-1916"
  table (`docs/slo.md:205-220`) enumerates Anthropic, Sentry, Discord,
  Fly.io, Stellar/Horizon, Frankfurter, Google/Apple OAuth, and CTX upstream
  with an explicit quota/cost/detection row for each — **Resend is absent**.
  Resend bills per-email past a free tier; a bug causing an email-send
  retry storm (e.g. a notifier loop, a malformed-template exception handler
  that re-queues) has no documented vendor-side alert comparable to the
  other 8 entries, though the existing `/api/auth/request-otp` rate limit
  (5/min/IP, per `AGENTS.md` middleware stack section) indirectly bounds
  the highest-volume legitimate path.
  MaxMind, by contrast, is **not** a live runtime API dependency at all —
  `apps/backend/Dockerfile:25-47` bakes the GeoLite2-Country `.mmdb` file
  at **Docker build time** (behind `--build-secret`) and the running
  container reads the local file via `MAXMIND_GEOLITE2_PATH`; there is no
  per-request MaxMind API call to runaway-loop against, so this item is a
  non-issue and shouldn't be added to the table.
- **Impact:** Low-to-moderate — Resend free-tier overage is a billing
  surprise, not an outage risk (mail simply stops sending or starts costing
  money), and is already indirectly bounded by the OTP rate limit. Worth
  closing for completeness given the table's otherwise-thorough coverage.
- **Minimal fix:** Add a Resend row to the `docs/slo.md` A2-1916 table
  (quota: free-tier daily/monthly send cap; detection: Resend dashboard
  email quota alert, provisioned once like the others).
- **Better fix:** Same, plus add a coarse server-side daily email-send
  counter (even an in-memory or Postgres counter incremented in the Resend
  client wrapper) that logs/alerts past a configurable ceiling — catches a
  _code_ bug (not just abuse) independent of waiting on a vendor email.
- **Ref:** checklist §40 "CTX API, Sentry, Resend, MaxMind, LLM-provider
  usage — any quota/cost alerting before a runaway loop... produces a
  surprise bill." Stellar fee-bump/retry-loop cost ceiling (the other §40
  item) is **verified good, no finding**: `apps/backend/src/payments/
payout-worker-pay-one.ts:299/307` hard-stops retries at
  `LOOP_PAYOUT_MAX_ATTEMPTS` (default 5) and `apps/backend/src/payments/
fee-strategy.ts:49-57` caps the exponential fee-bump at
  `LOOP_PAYOUT_FEE_CAP_STROOPS` (default 100,000 stroops ≈ $0.001-class) —
  both axes bounded, no surprise-spend vector.

---

## Things verified GOOD (no finding)

- **GitHub Actions pinning:** 0 of 27 `uses:` call sites across all 5
  workflows use a mutable tag; all are full 40-char commit SHAs with a
  version comment (table above). Docker-image references (trivy, gitleaks)
  are digest-pinned (`@sha256:...`) the same way.
- **ADR 029 (repo-managed CLIs) compliance:** Both originally-cited
  workflows follow the policy correctly today — `pr-review.yml:78-85` runs
  `npm ci --ignore-scripts` then `node node_modules/@anthropic-ai/claude-
code/install.cjs` (not `npm install -g`); `ci.yml:598-602` runs
  `./node_modules/.bin/sentry-cli` (not versioned `npx @sentry/cli@...`).
  Both CLIs are exact-pinned root `devDependencies` covered by
  `package-lock.json`. No `scripts/*.sh`/`*.mjs` file in the repo invokes a
  live unpinned `npx <pkg>` or `curl | sh` pattern.
- **SBOM / provenance / cosign (A2-408):** `ci.yml`'s `sbom` job
  (`ci.yml:296-389`) is live and sound — generates a CycloneDX 1.6 SBOM via
  the pinned local `@cyclonedx/cyclonedx-npm`, attests SLSA build
  provenance via `actions/attest-build-provenance` (GitHub OIDC, no managed
  keys), and signs the SBOM via `cosign sign-blob --yes` keyless mode (also
  OIDC-derived). `id-token: write` + `attestations: write` are scoped only
  to this job, not the workflow default. The one pre-existing caveat
  (A4-044, documented in-line at `ci.yml:354-365`) still holds and is
  unchanged: the attestation subject is the SBOM file itself, not the
  deployed Docker image — not a new finding, carried forward as known/
  accepted scope.
- **CSP headers:** Live `curl -I` against both `api.loopfinance.io` (Hono
  `secureHeaders` middleware, `apps/backend/src/middleware/secure-
headers.ts`) and `beta.loopfinance.io` (React Router SSR,
  `apps/web/app/utils/security-headers.ts`) confirm a real CSP is served on
  both — backend: locked-down `default-src 'none'`-style API CSP; web:
  nonce-based `script-src 'self' 'nonce-...'` with scoped `img-src`/
  `connect-src` allowlists, `frame-ancestors 'none'`, `object-src 'none'`.
  Checklist §36's "does a CSP exist anywhere" — yes, on both surfaces,
  already hardened. RedeemFlow in-app-browser content is a third-party
  merchant page Loop doesn't control and can't apply its own CSP to (not
  Loop's CSP surface to set).
- **Lockfile integrity:** Exactly one `package-lock.json` at the repo root;
  no nested `package-lock.json`/`yarn.lock`/`pnpm-lock.yaml` anywhere
  outside `node_modules`.
- **Node engine pin consistency:** `"node": ">=22.0.0"` identical across
  root, `apps/backend`, `apps/web`, `apps/mobile`, `packages/shared`
  `package.json` files.
- **Capacitor plugin parity (web ↔ mobile):** Diffed every `@capacitor/*`/
  `@aparajita/*`/`@capgo/*` entry — every plugin present in both manifests
  is at the **identical exact version** (e.g. `@capgo/inappbrowser@8.6.2`
  in both). The only differences are mobile-only native-shell packages
  (`@capacitor/{android,ios,cli,splash-screen}`), which are correctly
  absent from web. No drift of the PR #151 class.
- **CF-29 (performance findings) re-verified closed:** both fix commits are
  on `main` and contain real changes, not just commit-message claims —
  `733107f7` adds migration 0036 (9 new indexes: `orders_created_at`,
  `credit_transactions_type_created`, `orders_ctx_operator_created`,
  `pending_payouts_asset_state`, `pending_payouts_confirmed_at` partial,
  `orders_loop_asset_created` partial, etc.) and a TTL cache for public
  cashback-stats; `b17d0436` lazy-loads `@sentry/react` out of the root
  chunk via dynamic `import()` and relaxes the catalog fetch cadence.
  Closed.

---

## Delta re-verification

**CF-04 (audit-policy gate): currently RED, not green.** This is a
regression, not a stale-but-still-passing situation — see X-INFRA-01 above
for full live evidence (failing `npm run audit` against current `main`
HEAD, matching `Security audit` job failures on 9+ currently-open Dependabot
PRs going back to 2026-06-20, and a documented pre-existing failure pattern
on PRs as old as 2026-05-12). The _mechanism_ added by the 06-15 remediation
(a justified high-accept allowlist) works as designed and is not itself
broken — `critical` still hard-fails, `high` still requires an explicit
accept-or-fix decision — but the **allowlist has not been kept current**,
which is the exact maintenance burden the audit predicted and recommended
addressing structurally. Recommend the `--omit=dev`-based redesign in
X-INFRA-01 to stop this from being a recurring audit finding.

**CF-29 (performance growth cliffs): confirmed CLOSED.** Real index
migration + TTL cache + Sentry code-split + catalog-cadence relaxation, all
merged to `main`, commits inspected directly (not just trusted from the
commit message). See "Things verified GOOD" above.

---

## Summary

- **Findings: 4** — P0: 1 (X-INFRA-01, audit gate red + Dependabot backlog),
  P3: 3 (X-INFRA-02 license-doc drift, X-INFRA-03 dependency-confusion
  defense-in-depth, X-INFRA-04 Resend cost-alert gap).
- **X-INFRA-01 is the headline:** the `Security audit` required CI gate is
  red on `main` right now, confirmed both locally and via live `gh run`/
  `gh pr` evidence spanning 7 weeks and 19 open Dependabot PRs — including
  the very fix PRs (#1465/#1466 hono, #1468 undici, #1472 cyclonedx) that
  would close 2-3 of the 3 newly-unaccepted high advisories, themselves
  stuck behind the gate. This is CF-04 regressed, not CF-04 closed as the
  brief assumed going in.
- **Actions-pinning headline: 0 unpinned of 27 `uses:` call sites / 12
  distinct actions across all 5 workflows** — fully SHA-pinned with version
  comments, no finding (verified-good control).
- **Everything else infra-side is clean:** ADR 029 repo-managed-CLI policy
  genuinely followed (no live unpinned npx in secret-bearing workflows),
  SBOM/provenance/cosign live and correct, CSP present and properly scoped
  on both backend and web, single lockfile, consistent node-engine pins,
  clean Capacitor parity, Stellar payout retry/fee-bump cost-capped. The
  06-15 audit's P1-INFRA-02 (phantom hono peer-dep blocker) is genuinely
  fixed in both the script and `docs/standards.md`.

## Coverage confirmation

All items in the assigned brief were investigated: GitHub Actions pinning
(all 5 workflows, every `uses:` site), repo-managed-CLI policy (ADR 029)
across `scripts/**` and the two originally-flagged workflows, live `npm
audit`/`npm run audit` cross-checked against the allowlist (including a
`--omit=dev` counterfactual), `docs/third-party-licenses.md` spot-checked
against all 4 workspaces' actual dependencies plus a `node_modules`-wide
LGPL/MPL/GPL/EUPL license scan, npm dependency-confusion (registry probe +
Dockerfile install-order check), SBOM/provenance/cosign re-read end to end,
lockfile integrity, node-engine pin parity, and Capacitor plugin version
parity. Checklist §36 (network/DNS/email/CSP) and §40 (cost/FinOps) items in
this vertical's remit were covered; the deeper DNS/SPF/DKIM/DMARC write-up
is intentionally left to `raw/v-platform.md`, which independently reached
the registry/Actions-pinning conclusions reported here and has more precise
live evidence on the email-deliverability side (correct `no-reply.`
sending subdomain). CF-04 and CF-29 were both re-verified against live
state, not trusted from prior-audit text.
