# Phase 1 — Governance & Repo Hygiene (evidence)

**Commit SHA at capture:** `450011ded294b638703a9ba59f4274a3ca5b7187`
**Audit branch:** `chore/audit-2026-bootstrap`
**Date captured:** 2026-04-23
**Working-tree note:** `docs/audit-2026-adversarial-plan.md` is dirty
relative to HEAD at capture — edits are to the severity rubric and
success-criteria prose only, no code changes.

---

## 1. Branch protection — `main`

`gh api repos/LoopDevs/Loop/branches/main/protection` (verbatim, pretty-printed):

```json
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Quality (typecheck, lint, format, docs)",
      "Unit tests",
      "Security audit",
      "Build verification",
      "E2E tests (mocked CTX)"
    ],
    "checks": [
      { "context": "Quality (typecheck, lint, format, docs)", "app_id": 15368 },
      { "context": "Unit tests", "app_id": 15368 },
      { "context": "Security audit", "app_id": 15368 },
      { "context": "Build verification", "app_id": 15368 },
      { "context": "E2E tests (mocked CTX)", "app_id": 15368 }
    ]
  },
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "require_last_push_approval": false,
    "required_approving_review_count": 0
  },
  "required_signatures": { "enabled": false },
  "enforce_admins": { "enabled": false },
  "required_linear_history": { "enabled": false },
  "allow_force_pushes": { "enabled": false },
  "allow_deletions": { "enabled": false },
  "block_creations": { "enabled": false },
  "required_conversation_resolution": { "enabled": false },
  "lock_branch": { "enabled": false },
  "allow_fork_syncing": { "enabled": false }
}
```

Cross-check against `gh api repos/LoopDevs/Loop/branches/main`:

```
"protection": {
  "enabled": true,
  "required_status_checks": {
    "enforcement_level": "non_admins",
    "contexts": [...]
  }
}
```

No repo-level rulesets (`gh api /repos/LoopDevs/Loop/rulesets` → `[]`).

### What is enforced

- 5 status checks are required: `Quality`, `Unit tests`, `Security audit`, `Build verification`, `E2E tests (mocked CTX)`. Matches the list in `AGENTS.md` §Git workflow.
- `strict: true` → branch must be up-to-date before merge.
- `allow_force_pushes: false`, `allow_deletions: false` → destructive ops blocked.
- `dismiss_stale_reviews: true` → stale reviews dismissed on new commits.

### What is not enforced

- **`enforce_admins: false`** — admins (both current collaborators have `role_name: admin`) bypass every rule above. `enforcement_level: "non_admins"` on the status-checks surface confirms it.
- **`required_approving_review_count: 0`** — a PR can be self-merged by the author with zero human approvals. The `AGENTS.md` sentence "Admins can still squash-merge without a required approval because the project is pre-team" acknowledges this state, so it is documented — but it means the CODEOWNERS file has no enforcement path (see §2).
- **`require_code_owner_reviews: false`** — CODEOWNERS is advisory; no review is auto-required when a security-sensitive path changes.
- **`required_signatures.enabled: false`** — unsigned commits accepted on `main`. 979/979 commits on all branches are `%G? = N` (git log `error: cannot run gpg: No such file or directory` from `gpg`-not-installed, but even absent gpg, no commit has a verifiable signature per the GitHub API's unsigned commits observed).
- **`required_linear_history: false`** — mergers can still produce merge commits; mitigated today only because author convention uses squash (observed: recent 20 commits on `main` all have `parents=1`).

### Sample: is the rule actually binding?

Sampled six recent `main` commits and called `gh api /repos/LoopDevs/Loop/commits/<sha>/pulls`:

```
84fc581 -> YES   520d57f -> YES   558833c -> YES
8bbc18e -> YES   11460c9 -> YES   bdf4be8 -> YES
```

All landed via a PR (PR# appears in each commit subject — `(#754)`, `(#752)`, `(#411)`, etc.). Listed 40 most recent `event=push` workflow runs on `main`: every one has an `(#NNN)` PR reference. So the PR-only convention is in effect in practice, even though a `main` push by an admin would not be technically blocked.

### Reviewer activity spot-check

PR author == merger for every recent PR. `gh api /repos/LoopDevs/Loop/pulls/{N}/reviews` for PRs #754, #752, #749, #745, #735 all returned empty arrays. Dependabot-origin PR #291 bump (TypeScript 6.0) was superseded by AshFrancis-authored PR #754 and merged by the same user with zero reviews.

**Finding A2-101 (High):** branch protection allows admin bypass (`enforce_admins: false`, `required_approving_review_count: 0`). Both repo collaborators are admins. Any auth/payment/Stellar change can land without a second pair of eyes despite CODEOWNERS claiming to require review. The `claude-audit.md` line "Required: Loop brand assets…Set up GitHub branch protection rules on `main`" is nominally complete but the protections do not match the stated security posture in `AGENTS.md` §Critical security rules ("ALL auth, payment, and Stellar code requires human review before merge").

**Finding A2-102 (Medium):** `required_signatures.enabled: false` — no signed-commit policy despite the threat model item "Insider with repo access" in §1.1 of the plan.

---

## 2. CODEOWNERS accuracy

`.github/CODEOWNERS`:

```
* @LoopDevs/engineering
apps/backend/src/auth/      @LoopDevs/engineering
apps/backend/src/orders/    @LoopDevs/engineering
apps/web/app/native/        @LoopDevs/engineering
apps/web/app/stores/auth*   @LoopDevs/engineering
```

The owner is `@LoopDevs/engineering` — an org team.

Probe: `gh api orgs/LoopDevs/teams` → `[]`. Probe: `gh api orgs/LoopDevs/teams/engineering` → `{"message":"Not Found", "status":"404"}`.

**The team does not exist.** No org teams exist at all. CODEOWNERS references a non-existent team on every rule. Combined with `require_code_owner_reviews: false` (§1), CODEOWNERS provides _zero_ enforcement — even if the flag were flipped, it would block PRs because GitHub could not resolve the team.

Path coverage: CODEOWNERS names four sensitive prefixes. Cross-reference with the security surface called out in `AGENTS.md` §Critical security rules:

| Sensitive area                                              | CODEOWNERS line?                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/backend/src/auth/`                                    | yes                                                                                   |
| `apps/backend/src/orders/`                                  | yes                                                                                   |
| `apps/web/app/native/`                                      | yes                                                                                   |
| `apps/web/app/stores/auth*`                                 | yes                                                                                   |
| `apps/backend/src/admin/**`                                 | **missing** — admin panel is now a substantial surface (ADRs 011, 017, 018, 022, 023) |
| `apps/backend/src/credits/**` or `ledger` code (ADR 009)    | **missing**                                                                           |
| `apps/backend/src/stellar/**` / payout submit (ADR 015/016) | **missing**                                                                           |
| `apps/backend/src/db/migrations/**`                         | **missing** — schema changes silent by review                                         |
| `packages/shared/**` (rules of §AGENTS.md cross-cut)        | **missing**                                                                           |
| `.github/workflows/**`                                      | **missing** — CI changes unowned                                                      |

**Finding A2-103 (High):** CODEOWNERS references `@LoopDevs/engineering`, a team that does not exist on the LoopDevs org. All five rules are dead letters; any attempt to enable `require_code_owner_reviews` later would block PRs because the team cannot be resolved.

**Finding A2-104 (Medium):** CODEOWNERS path set was frozen at Phase 1 surface (auth/orders/native/auth-store) and has not tracked the expansion into `admin/`, `credits/` ledger, Stellar payout code, or DB migrations. Even if the team existed and `require_code_owner_reviews: true` were enabled, material security surface would still be unowned.

---

## 3. Dependabot configuration

`.github/dependabot.yml` — two `updates` entries:

1. `npm` @ `/` — weekly Monday, open-pr-limit 10, label `dependencies`, `groups.minor-and-patch: [minor, patch]`, `reviewers: [LoopDevs/engineering]`.
2. `github-actions` @ `/` — weekly, label `ci`.

Scope notes:

- `directory: '/'` with `package-ecosystem: 'npm'` — the root `package.json` declares workspaces (`apps/*`, `packages/*`), so dependabot walks the workspace tree. Verified by observing dependabot PR #291 existed for a root-level TypeScript bump.
- **No `ignore` block** — nothing pinned against updates (positive).
- **No `allow: [security, version-updates]` scoping** — default behavior is fine, but there is no explicit "only security" channel.
- **`reviewers: - LoopDevs/engineering`** — same non-existent team as CODEOWNERS. Dependabot can't assign reviews here. Not fatal but cosmetically broken.
- **Grouping ignores major updates** — majors come as individual PRs, which is the documented intent (minor-and-patch group only).
- **Dependabot alerts**: `gh api /repos/LoopDevs/Loop/dependabot/alerts` → `[]`. `security_and_analysis.dependabot_security_updates: disabled` on the repo (from `gh api /repos/LoopDevs/Loop`). So while dependabot _version_-update PRs flow, no _security advisory_ stream is turned on.
- **Secret scanning** (`security_and_analysis.secret_scanning: disabled`, `secret_scanning_push_protection: disabled`) — no GitHub-side guard against a pushed secret.

**Finding A2-105 (High):** GitHub security features that protect the repo — `secret_scanning`, `secret_scanning_push_protection`, `dependabot_security_updates`, `dependabot_alerts` — are all disabled at the repo level and at the org level (`advanced_security_enabled_for_new_repositories: false`, `dependabot_alerts_enabled_for_new_repositories: false`, `secret_scanning_enabled_for_new_repositories: false` on the org). Primary defense against a committed secret or a known-CVE dep is absent. `npm audit --audit-level=high` still runs in CI (evidence §8) so high-severity advisories are blocked at PR time, but (a) there's no continuous alerting outside CI, (b) push-protection is off, (c) the org has opted every new repo out.

**Finding A2-106 (Low):** Dependabot `reviewers: [LoopDevs/engineering]` references the missing team (same root cause as A2-103). Auto-assignment silently no-ops.

---

## 4. Commitlint + branch-prefix hooks: coverage, bypassability

### `commitlint.config.js`

```
type-enum:  [feat, fix, refactor, perf, test, docs, chore, ci, build, revert]  (2, always)
scope-enum: [web, mobile, backend, shared, infra, deps, ci]                    (2, always)
subject-max-length: 72 (2, always)
body-max-line-length: 100 (2, always)
```

CONTRIBUTING.md §"Commit format" lists the same types but omits `infra` and `ci` from its prose (minor drift); `AGENTS.md` doesn't enumerate them. Sample of 20 recent commit subjects shows every one is `type(scope):` compliant.

### `.husky/commit-msg`

```bash
npx --no -- commitlint --edit "$1"
```

Runs via husky `commit-msg` hook; reads the message, enforces the config above.

### `.husky/pre-push`

```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ] && ! echo "$BRANCH" | grep -qE "^(feat|fix|chore|docs|test|refactor|perf|ci|build)/"; then
  echo "ERROR: Branch name '$BRANCH' doesn't match convention."
  ...
  exit 1
fi

npm test
./scripts/lint-docs.sh
```

Runs full `npm test` (backend + web unit tests) and `lint-docs.sh` on push. Branch prefix enforced locally.

### `.husky/pre-commit`

```bash
npx lint-staged
```

Runs ESLint + Prettier on changed files only.

### Bypassability

- `--no-verify` bypass references in the repo are **all prescriptive "don't do this"** (`AGENTS.md:116`, `docs/standards.md:408`, `docs/standards.md:476`); zero occurrences of actual `--no-verify` in scripts, workflows, or hook code. Grep result:

  ```
  AGENTS.md:116:- **NEVER** use `--no-verify` to skip hooks — fix the root cause.
  docs/standards.md:408:failure. **Never use `--no-verify`** to bypass any of them — the
  docs/standards.md:476:Husky hook at commit time. `--no-verify` is still not the answer;
  docs/audit-2026-adversarial-plan.md:314: (this very audit plan)
  ```

- **Server-side**: GitHub branch protection does not re-run commitlint or the branch-prefix rule. A push to a branch can therefore arrive at `main` via a PR with a non-conforming message; the squash-merge commit message is set from the PR title by GitHub, which is _not_ enforced by commitlint. I inspected the squash-merge title pattern across 40 recent merges — all are `type(scope): …` by convention, but nothing prevents a non-compliant title.
- **CI**: `ci.yml` does not call commitlint. The hook is local-only.
- **Circumventable by**: a fresh contributor who runs `git commit --no-verify`, a contributor with husky uninstalled, or a force-landed admin commit. GitHub would accept whatever lands.

**Finding A2-107 (Medium):** commitlint is client-side only. There is no server-side validation (CI job, required-status check, or GitHub App) to verify merged commit messages conform to the `type(scope): subject` contract. CONTRIBUTING.md claims "Conventional Commits enforced by commitlint" but that enforcement evaporates once a PR is merged — `--no-verify` or an uninstalled husky sidesteps it, and the squash-merge title GitHub writes into `main` isn't checked at all.

**Finding A2-108 (Low):** Branch-prefix hook (`.husky/pre-push`) accepts `(feat|fix|chore|docs|test|refactor|perf|ci|build)/…` but commitlint `type-enum` additionally accepts `revert`. A branch named `revert/foo` is rejected by the hook even though the resulting commit type is legal — minor drift. CONTRIBUTING.md line 22 also omits `perf`, `ci`, `build` from its prose list.

---

## 5. CONTRIBUTING.md vs actual PR merge behavior

CONTRIBUTING.md claims:

- "Create a branch from `main`" — enforced (pre-push hook).
- "Run `npm run verify`" — optional, not gated by CI.
- "Push and open a PR. CI runs 6 jobs" — CI actually has 7 (verified in ci.yml: `quality`, `test-unit`, `audit`, `build`, `test-e2e`, `test-e2e-mocked`, `notify`). `AGENTS.md` §Git workflow says 7. CONTRIBUTING.md is stale.
- "Get review. Auth, payment, and storage code requires human review (see `.github/CODEOWNERS`)." — demonstrably false in practice: required-review-count is 0, CODEOWNERS team doesn't exist, reviewers observed on sampled PRs = 0 across #754, #752, #749, #745, #735.
- "Squash merge to main. Branch auto-deletes." — `delete_branch_on_merge: true` confirmed on repo config; `allow_squash_merge: true`, `allow_merge_commit: true`, `allow_rebase_merge: true` (all three merge modes still enabled — docs-only squash convention).

**Finding A2-109 (Medium):** CONTRIBUTING.md overstates the review gate. Line 37 ("Get review") implies human review is required for auth/payment/storage code; in practice zero reviews are required by branch protection, CODEOWNERS is non-functional (A2-103), and recent PRs landed with zero review. Either the docs need to match reality or the branch-protection config needs to match the docs.

**Finding A2-110 (Low):** CONTRIBUTING.md §"Development workflow" step 4 says "CI runs 6 jobs" — actual count is 7. Same line claims e2e tests run "only on PRs" but the mocked e2e suite (`test-e2e-mocked`) runs on every push to `main` as well (ci.yml line 243 `needs: [quality, test-unit]`, no `if:` gate). `AGENTS.md` §Git workflow has the correct description; CONTRIBUTING.md is the stale copy.

---

## 6. `.gitignore` coverage

Tracked: `/Users/ash/code/loop-app/.gitignore` (69 lines). Covers `node_modules/`, `build/`, `dist/`, `.react-router/`, `.env`, `.env.local`, `.env.*.local`, mobile generated (`apps/mobile/ios/`, `apps/mobile/android/`, `*.xcworkspace`, `*.xcodeproj`, `Pods/`, `*.ipa`, `*.apk`, `*.aab`), `.capacitor/`, `*.tsbuildinfo`, logs, editor, `.claude/`, `.DS_Store`, `Thumbs.db`, `coverage/`, `.nyc_output/`, Playwright outputs, `*.postman_collection.json`, `*.postman_environment.json`, `*.db`, `merchants.db`, `server.log`. No `.gitattributes` file exists (no line-ending policy declared).

Cross-check against Phase 0 generated-output inventory:

| Generated output                                   | Ignored?                                  |
| -------------------------------------------------- | ----------------------------------------- |
| `node_modules/`                                    | yes                                       |
| `build/`, `dist/`                                  | yes                                       |
| React Router typegen (`.react-router/`)            | yes                                       |
| Drizzle meta (`src/db/migrations/meta/`)           | no — intentionally tracked                |
| iOS generated (`apps/mobile/ios/`)                 | yes                                       |
| Android generated (`apps/mobile/android/`)         | yes                                       |
| Playwright reports                                 | yes                                       |
| Coverage                                           | yes                                       |
| `apps/web/build/client/`                           | yes (via `build/`)                        |
| Postman collection (`ctx.postman_collection.json`) | yes (pattern `*.postman_collection.json`) |

`git status --ignored` at capture lists the expected set; nothing outside the spec:

```
.DS_Store  .claude/  .husky/_/  apps/.DS_Store  apps/backend/.env
apps/backend/coverage/  apps/backend/dist/  apps/backend/node_modules/
apps/mobile/android/  apps/mobile/ios/  apps/mobile/node_modules/
apps/web/.DS_Store  apps/web/.env.local  apps/web/.react-router/
apps/web/build/  apps/web/coverage/  apps/web/node_modules/
ctx.postman_collection.json  docs/.DS_Store  node_modules/
playwright-report/  test-results/  tests/.DS_Store
```

Note: `apps/web/.env.production` **is tracked** (not `.env.*.local`, so not gitignored). Contents are `VITE_API_URL=https://api.loopfinance.io` — no secrets. Intentional per its header comment.

**Finding A2-111 (Low):** No `.gitattributes` file. Line-ending policy is implicit. On a mixed macOS/Linux/Windows team, diffs can churn on EOL normalization, and `* text=auto` + `*.sh text eol=lf` is the standard guard. G2-20 in the plan predates the `.gitattributes` call-out, but per Phase 1 scope ("line-ending policy") it belongs here.

**Finding A2-112 (Info):** `ctx.postman_collection.json` exists untracked at repo root (8795 bytes, captured `23 Mar 14:58`). G2-21 in plan §Pass 2 flags Postman collections for classification. `.gitignore` covers the pattern, so it will never be committed; G2-21 action (classify as asset or dead?) remains open for Phase 15. Not a defect — logging so the file is accounted for.

---

## 7. PR template + labeler

### `.github/pull_request_template.md`

Structure:

1. Summary (3 bullets max)
2. Type-of-change checklist (mirrors `commitlint.config.js` type-enum)
3. Checklist: tests/types/lint
4. Documentation checklist (`docs/architecture.md`, `docs/development.md`, `docs/deployment.md`, `docs/testing.md`, `docs/standards.md`, `AGENTS.md`, ADR)
5. Security checklist (tri-state)

### Labeler (`.github/labeler.yml`)

Maps `apps/backend/**`, `apps/web/**`, `apps/mobile/**`, `packages/shared/**`, `docs/**`, `.github/**`, `package-lock.json|**/package.json` → labels `backend`, `web`, `mobile`, `shared`, `docs`, `ci`, `dependencies`.

### Load-bearing check

Sampled `gh api /repos/LoopDevs/Loop/pulls/754` and `/pulls/745`: PR bodies use a custom `## Summary` / `## Test plan` format, **not** the repo template checklist. The auto-label step (`actions/labeler@v6`) does run in `pr-automation.yml` and PR #754 carries labels `dependencies, backend, web, shared` — labeler is live. The template checklist, however, is not load-bearing — no workflow verifies the boxes are ticked, and authors don't actually use the structure.

**Finding A2-113 (Low):** PR template is decorative. Recent PRs (#754, #745) don't use its Type-of-change / Documentation / Security checkboxes — the bodies use a different format entirely. If the checklist is meant to be load-bearing, there should be (a) a `pr-automation` check that the template sections are present, or (b) simplify the template to what authors actually fill in.

---

## 8. GitHub Actions workflow permissions

### `ci.yml` (push + pull_request)

Top-level: `permissions: { contents: read }` ✓ — principle of least privilege.

Actions used (all tag-pinned, not SHA-pinned):

```
actions/checkout@v6    actions/setup-node@v4    actions/cache@v4
actions/upload-artifact@v7    actions/download-artifact@v7
superfly/flyctl-actions/setup-flyctl@master   ← moving ref
```

Discord-notify job uses a webhook secret (read-only behavior); `contents: read` is sufficient. E2E job receives `DATABASE_URL=postgres://placeholder:placeholder@localhost:5433/loop_test` — placeholder only, not a real secret.

### `e2e-real.yml` (workflow_dispatch only)

Top-level: `permissions: { contents: read }` ✓. Uses secrets `CTX_TEST_REFRESH_TOKEN`, `STELLAR_TEST_SECRET_KEY`, `GH_SECRETS_PAT`. The last is a fine-grained PAT used to **rotate the refresh token back into repo secrets** post-run (`gh secret set CTX_TEST_REFRESH_TOKEN`).

### `pr-automation.yml` (pull_request)

**No top-level `permissions` block.** Each job sets its own:

- `label` job: `contents: read, pull-requests: write`.
- `size-check` job: `contents: read, pull-requests: write`.

Per-job scoping works, but the absence of a top-level default means a future-added job without a `permissions:` block would inherit the repo default (`default_workflow_permissions: read`, confirmed via `gh api /repos/LoopDevs/Loop/actions/permissions/workflow`). So the current default happens to be safe, but the defense-in-depth habit of "always set at workflow level too" is missed.

### `pr-review.yml` (pull_request)

Same pattern — job-level only (`contents: read, pull-requests: write`). Same observation: relies on the repo-default being read.

`pr-review.yml` is the most attacker-interesting workflow: it feeds PR diff content to the Claude API. The prompt-injection defense (wrap diff in `<user_data>`, enforce output header, withhold non-conforming output) is documented and implemented. However the job uses `actions/checkout@v6` with `fetch-depth: 0` and then runs `claude` on the raw diff — Claude Code itself has tool access. The workflow runs `claude -p --print` (non-interactive), which should disable tools, but this depends on the SDK version (pinned to `2.1.114` — good per audit A-031). Worth a Phase 12 deep-dive.

### Missing workflows per plan

- No CodeQL / static-security analysis workflow (G4-13 — Phase 16).
- No trivy/grype container-image scan (G5-17 — Phase 4).
- No SBOM (G5-15 — Phase 4).

### Repo-level actions policy

`gh api /repos/LoopDevs/Loop/actions/permissions`:

```json
{ "enabled": true, "allowed_actions": "all", "sha_pinning_required": false }
```

`allowed_actions: "all"` — any action on GitHub Marketplace is allowed. No verified-creator / allowlist restriction. `sha_pinning_required: false` — the repo does not require SHA pins, so the `@master` pin on `superfly/flyctl-actions/setup-flyctl` is permitted.

**Finding A2-114 (High):** `superfly/flyctl-actions/setup-flyctl@master` is a moving-ref action pinned to a branch. If the `superfly` org is compromised (or a maintainer merges a malicious PR), the next CI run on the `quality` job executes attacker code with whatever credentials the job sees. Mitigated by workflow-level `contents: read`, but the job does see repo checkout contents and whatever env was injected above it — nothing secret in this particular job, but the pattern is brittle.

**Finding A2-115 (Medium):** All first-party actions (`actions/checkout`, `actions/cache`, etc.) are tag-pinned, not SHA-pinned. Tag pinning is GitHub-default-acceptable but allows an org-compromise scenario (attacker re-targets a tag on a compromised maintainer account). `sha_pinning_required: false` on the repo doesn't enforce it either. G2-09 in the plan owned by Phase 16 — logging here because it surfaced during Phase 1 workflow inspection and the remediation (`@sha256:<40>`) is a Phase 1-layer repo policy.

**Finding A2-116 (Low):** `pr-automation.yml` and `pr-review.yml` have no workflow-level `permissions` block — rely on `default_workflow_permissions: read`. Add `permissions: { contents: read }` at the top of both files for defense-in-depth against a future job added without a `permissions:` scope.

**Finding A2-117 (Info):** repo `allowed_actions: "all"` — consider `"selected"` with an explicit allowlist of action sources once Phase 16 catalogs the intended set. Pre-launch this is Info; if pre-IPO audit burden ever applies, this becomes the "locked-down marketplace actions" row.

---

## 9. Secret inventory

### Repo Actions secrets (`gh api repos/LoopDevs/Loop/actions/secrets`, names only):

| Name                          | Created    | Updated    | Used in                                            |
| ----------------------------- | ---------- | ---------- | -------------------------------------------------- |
| `ANTHROPIC_API_KEY`           | 2026-04-02 | 2026-04-02 | `pr-review.yml`                                    |
| `CTX_TEST_REFRESH_TOKEN`      | 2026-04-17 | 2026-04-17 | `e2e-real.yml` (rotated post-run)                  |
| `DISCORD_WEBHOOK_DEPLOYMENTS` | 2026-04-02 | 2026-04-02 | `ci.yml` notify job                                |
| `GH_SECRETS_PAT`              | 2026-04-17 | 2026-04-17 | `e2e-real.yml` (rewrites `CTX_TEST_REFRESH_TOKEN`) |
| `STELLAR_TEST_SECRET_KEY`     | 2026-04-17 | 2026-04-17 | `e2e-real.yml`                                     |

No repo variables (`gh api /repos/LoopDevs/Loop/actions/variables` → `{total_count:0}`). No environments (`gh api /repos/LoopDevs/Loop/environments` → `{total_count:0}`). Every declared secret maps to a documented workflow; no orphans.

### Deploy keys

`gh api repos/LoopDevs/Loop/keys` → `[]`. No deploy keys. Push flows via personal tokens/SSH keys only.

### Repo webhooks

`gh api repos/LoopDevs/Loop/hooks` → `[]`. No repo-level webhooks.

### Org webhooks

`gh api orgs/LoopDevs/hooks` → `404` with `admin:org_hook` scope missing. Cannot inspect directly. Owner should verify `LoopDevs` has no unexpected org webhooks; under plan §3.2 ("probably works" doesn't count), this is unverified.

**Finding A2-118 (Info):** Org webhook inventory (G5-07) cannot be completed because the `gh` session lacks `admin:org_hook` scope. Left as a manual step for the audit owner (`gh auth refresh -h github.com -s admin:org_hook && gh api orgs/LoopDevs/hooks`). Not a finding against the repo, but a gap in this evidence file.

---

## 10. Org-level hardening (G5-06 through G5-10)

### G5-06 — Org 2FA enforcement

`gh api orgs/LoopDevs` — key fields:

```
"two_factor_requirement_enabled": false
"default_repository_permission": "read"
"members_can_create_repositories": true
"members_can_create_public_repositories": true
"web_commit_signoff_required": false
"advanced_security_enabled_for_new_repositories": false
"dependabot_alerts_enabled_for_new_repositories": false
"dependabot_security_updates_enabled_for_new_repositories": false
"secret_scanning_enabled_for_new_repositories": false
"secret_scanning_push_protection_enabled_for_new_repositories": false
"secret_scanning_validity_checks_enabled": false
"plan": { "name": "free", "seats": 0, "filled_seats": 2 }
```

**`two_factor_requirement_enabled: false`**. The org does not force members to have 2FA. Both current members (AshFrancis, alexdcox — `gh api orgs/LoopDevs/members`) have push-capable SSH keys (listed in §G5-10 below), and both have `role_name: admin` on the Loop repo (`gh api repos/LoopDevs/Loop/collaborators`). A compromised member password without 2FA = game over for the repo.

**Finding A2-119 (Critical):** `LoopDevs` org does not require 2FA for members. Two members; both are repo admins; both have valid push-capable SSH keys observed with recent `last_used` timestamps. A phished password would give an attacker admin on the Loop repo with no 2FA step. Critical severity because this is a pre-launch gap that blocks the "secure, maintainable" success-criteria line of plan §0.4 and because the remediation (toggle one org setting) is trivial.

### G5-07 — Org webhooks

Unverified (see A2-118). Cannot complete from this session.

### G5-08 — Deploy keys / service accounts

Repo deploy keys: `[]`. No machine identities push to the repo. The only non-human identity that writes to the repo is:

- **Dependabot** — authored 49699333+dependabot[bot]@users.noreply.github.com (e.g. commits `9c9e9831`, `703ef2fd`). Managed by GitHub.
- **`GH_SECRETS_PAT`** — a fine-grained PAT used only inside `e2e-real.yml` to `gh secret set` the rotated refresh token. Not a push identity.

No fly.io token, no vercel token, no cloudflare token visible as a repo secret (but those are likely Fly/Vercel-side, out of scope for repo-level inventory).

### G5-09 — GitHub audit log

`gh api orgs/LoopDevs/audit-log` → `404`. Audit log is a GitHub-Enterprise / paid feature; the org is on the `free` plan (`plan.name = "free"` in §G5-06 dump). No audit log access at this tier. No retention setting, no review cadence. No evidence that anyone is reading events because there is nothing to read.

**Finding A2-120 (Medium):** Org is on the `free` plan with `audit-log` unavailable. The plan §1.1 "Insider with repo access" and "Disgruntled ex-employee" adversaries benefit from the absence of an audit trail — a malicious push, secret-set, webhook-add, or team-change would leave no log visible to ops. This may be an acceptable trade-off pre-launch but should be explicit; upgrading to Team/Enterprise before launch is a known remediation.

### G5-10 — SSH key inventory of push-capable users

`gh api users/AshFrancis/keys` (3 keys, all verified push-capable):

| Key id    | Type         | Title                     | Created    | Last used     |
| --------- | ------------ | ------------------------- | ---------- | ------------- |
| 82840148  | ssh-rsa 4096 | "Mac Key"                 | 2023-05-31 | 2026-04-21    |
| 129798083 | ssh-ed25519  | "stellarspendtest server" | 2025-08-22 | 2025-08-22    |
| 136914056 | ssh-ed25519  | "GitHub CLI"              | 2025-11-25 | null (unused) |

`gh api users/alexdcox/keys` (1 key):

| Key id   | Type         | Title                                  | Created    | Last used  |
| -------- | ------------ | -------------------------------------- | ---------- | ---------- |
| 30151396 | ssh-rsa 2048 | (no title returned in public endpoint) | 2018-08-08 | 2026-04-17 |

GPG keys for both: `[]` — consistent with `%G? = N` (unsigned commits).

**Finding A2-121 (Medium):** AshFrancis has an SSH key titled `stellarspendtest server` that was last used 2025-08-22 (∼8 months ago at capture). An SSH key that lives on a server is higher-risk than a laptop key (servers are attacker targets); if that server is no longer in use, the key should be rotated off GitHub. If it is in use, verify the server and its access model. Also: the 2023 "Mac Key" is ssh-rsa 4096, and alexdcox's key from 2018 is ssh-rsa 2048 — ed25519 is the recommended modern algorithm; RSA 2048 was deprecated by GitHub for new keys in 2022. All push-capable.

**Finding A2-122 (Low):** Neither collaborator has a GPG key on file. Combined with `required_signatures.enabled: false` on the branch (A2-102), commit provenance rests entirely on GitHub's authentication of the pushing SSH key — no cryptographic signature trail.

---

## 11. Git-history secret scan

Commands run against all branches and all tags (`git log --all -p -S'...'`):

| Pattern                                               | Hits                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| `BEGIN RSA`                                           | 1 hit — the audit plan itself (text)                                             |
| `BEGIN OPENSSH`                                       | 0                                                                                |
| `BEGIN PRIVATE KEY`                                   | 0                                                                                |
| `BEGIN EC PRIVATE`                                    | 0                                                                                |
| `-----BEGIN`                                          | 0 code hits (1 hit is a `.env.example` comment referencing ADR files, not a key) |
| `sk_live` (Stripe live)                               | 0                                                                                |
| `AKIA` (AWS key prefix)                               | 0                                                                                |
| `ghp_` (GH PAT)                                       | 0                                                                                |
| `xoxb-` (Slack bot)                                   | 0                                                                                |
| `xoxp-` (Slack user)                                  | 0                                                                                |
| `api_key=` (inline)                                   | only in `.env.example` + ADR text                                                |
| `SECRET_KEY=`                                         | only in docs / ADR references                                                    |
| `LOOP_JWT_SIGNING_KEY=`                               | 2 hits in `.env.example` / docs, both `(≥32 chars)` placeholders                 |
| `DISCORD_WEBHOOK_…=https://discord.com/api/webhooks/` | all `…` placeholders, no real token                                              |
| `postgres://<user>:<pass>@`                           | only `loop:loop`, `placeholder:placeholder`, `user:pass`                         |

### Committed `.env*` files across history

`git log --all --diff-filter=A --name-only -- '**/.env' '**/.env.*' '*.pem' '*.key'`:

```
apps/backend/.env.example
apps/web/.env.local.example
apps/web/.env.production
```

Only three files, all intentional. `apps/web/.env.production` (currently tracked, 2 lines): `VITE_API_URL=https://api.loopfinance.io` + a "no secrets" header comment — confirmed in-tree at `/Users/ash/code/loop-app/apps/web/.env.production`. No secret material in any committed env file at any point in history.

### History secret scan — conclusion

**No secrets found in git history.** History is clean across 979 commits (`git log --all --oneline | wc -l`) and 2 unique author emails (`ash@ashfrancis.com`, dependabot's `noreply`).

The `.gitignore` retains a self-documenting note (lines 59–63) about `scripts/pay-order.mjs`, a previously-gitignored helper that had a hardcoded Stellar secret — audit A-001 retired it in PR #83 (`a7a6ff8`). No commit ever introduced it to the repo.

---

## 12. `--no-verify` bypass paths

`grep -rn 'no-verify\|--no-verify'` across repo (excluding node_modules):

```
AGENTS.md:116                   — prohibitive rule
docs/standards.md:408           — prohibitive rule
docs/standards.md:476           — prohibitive rule
docs/audit-2026-adversarial-plan.md:314 — audit plan text
```

`grep` for `HUSKY=0`, `HUSKY_SKIP`, `SKIP_HOOKS`: zero hits anywhere (scripts, workflows, docs).

CI does not run commitlint server-side (see §4). Therefore **local `--no-verify` or a `HUSKY=0` env var completely bypasses** commit-msg and pre-push checks, and CI will not retroactively reject such a commit. The hook is convention, not enforcement.

**No further finding** beyond A2-107 (which already covers commitlint being client-side only). Logging the grep output here as evidence that the prohibition is stated but the enforcement gap exists.

---

## 13. Signed-commit policy

- Branch protection: `required_signatures.enabled: false`.
- Org: `web_commit_signoff_required: false`.
- GPG keys on file for either member: **none**.
- `git log --all --format='%G?'` → 979/979 commits `N` (unsigned). Hairline caveat: local `git log` can't spawn gpg, but GitHub would report signed commits via `%G?` if they existed, and the branch protection flag confirms no signing requirement anywhere.

Decision-recording per plan §12 bullet 9: **decision = unsigned commits accepted by policy.** Not a finding in itself (plan permits either direction as long as the decision is recorded); but see A2-102 for the no-policy state + A2-122 for the no-GPG-key state.

---

## 14. Repo merge-settings posture

From `gh api /repos/LoopDevs/Loop`:

```
allow_squash_merge: true
allow_merge_commit: true
allow_rebase_merge: true
allow_auto_merge:  false
delete_branch_on_merge: true
allow_update_branch: false
use_squash_pr_title_as_default: false
squash_merge_commit_message: "COMMIT_MESSAGES"
squash_merge_commit_title:   "COMMIT_OR_PR_TITLE"
merge_commit_message: "PR_TITLE"
merge_commit_title:   "MERGE_MESSAGE"
```

Three merge modes enabled. `AGENTS.md` and CONTRIBUTING.md both say "squash merge" but nothing in the config prevents a merge-commit or rebase merge. `delete_branch_on_merge: true` is good.

**Finding A2-123 (Low):** Three merge modes are enabled (`squash`, `merge`, `rebase`). CONTRIBUTING.md says "Squash merge to main" but only convention enforces that. Since `required_linear_history: false` too, a merge-commit could land and break the linear-history assumption implicit in the `(#NNN)` PR-reference convention.

---

## 15. Governance files inventory

| File                               | Present at expected path?            | Notes                                                                                                                      |
| ---------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md` / `CLAUDE.md`          | yes (root, symlinked)                |                                                                                                                            |
| `CONTRIBUTING.md`                  | yes (root)                           | stale — see A2-109 / A2-110                                                                                                |
| `.github/CODEOWNERS`               | yes                                  | broken — see A2-103                                                                                                        |
| `.github/pull_request_template.md` | yes                                  | decorative — see A2-113                                                                                                    |
| `.github/dependabot.yml`           | yes                                  | —                                                                                                                          |
| `.github/labeler.yml`              | yes                                  | —                                                                                                                          |
| `LICENSE`                          | **missing** at repo root             | repo is public (`visibility: public`). The GitHub API shows `license: null`.                                               |
| `SECURITY.md`                      | **missing** from `.github/` and root | Plan G5-103; Phase 15 cross-cut, but load-bearing for a public pre-launch repo (how does an external researcher disclose?) |
| `CODE_OF_CONDUCT.md`               | **missing**                          | Plan G5-102; Phase 15. Public repo.                                                                                        |
| `CHANGELOG.md`                     | **missing**                          | Plan G5-104; Phase 15.                                                                                                     |
| `.gitattributes`                   | **missing**                          | See A2-111                                                                                                                 |
| `.github/ISSUE_TEMPLATE/*`         | **missing**                          | No issue templates.                                                                                                        |
| `.github/FUNDING.yml`              | missing — fine, not required         | —                                                                                                                          |

**Finding A2-124 (Medium):** Repo is public (`visibility: public`, confirmed via `gh api /repos/LoopDevs/Loop`) with no `LICENSE` file. Under US copyright default, all rights are reserved and nobody can legally use, contribute, or fork the code — including the open contribution path implied by CONTRIBUTING.md. Either (a) pick a license appropriate to Loop's business (the ADRs imply closed-source / proprietary — then state it explicitly with a copyright notice) or (b) pick an OSS license. Either way the absence is a legal ambiguity, not an oversight that can stay.

**Finding A2-125 (Medium):** No `SECURITY.md`. Repo is public, has a payments-adjacent codebase, and has no coordinated disclosure path for external researchers. A finder would have to guess at `ash@ashfrancis.com` from commit metadata. Plan G5-103.

**Finding A2-126 (Low):** No `.github/ISSUE_TEMPLATE/` directory. Issue intake is unstructured. Not load-bearing pre-launch but belongs in the pre-public-contributor checklist.

**Finding A2-127 (Low):** No `CHANGELOG.md`. Plan G5-104.

---

## Findings filed

| ID     | Severity | Title                                                                                     |
| ------ | -------- | ----------------------------------------------------------------------------------------- |
| A2-101 | High     | Branch protection permits admin bypass; zero required reviews                             |
| A2-102 | Medium   | No signed-commit policy on `main`                                                         |
| A2-103 | High     | CODEOWNERS references non-existent `@LoopDevs/engineering` team                           |
| A2-104 | Medium   | CODEOWNERS coverage stale vs admin/credits/stellar/migration/workflows surfaces           |
| A2-105 | High     | GitHub secret-scanning + dependabot-alerts + push-protection disabled repo & org          |
| A2-106 | Low      | Dependabot `reviewers` points at the missing team (same root as A2-103)                   |
| A2-107 | Medium   | Commitlint is client-side only; no server-side subject enforcement                        |
| A2-108 | Low      | Branch-prefix hook omits `revert/…`; CONTRIBUTING.md prose omits `perf`/`ci`/`build`      |
| A2-109 | Medium   | CONTRIBUTING.md overstates review gate vs actual PR merge behavior                        |
| A2-110 | Low      | CONTRIBUTING.md CI job-count (6) drifted from reality (7); mocked-e2e runs on push        |
| A2-111 | Low      | No `.gitattributes`; no line-ending policy declared                                       |
| A2-112 | Info     | `ctx.postman_collection.json` at repo root (ignored; classification deferred to Phase 15) |
| A2-113 | Low      | PR template checklist is decorative — authors use custom body format                      |
| A2-114 | High     | `superfly/flyctl-actions/setup-flyctl@master` pins a moving branch ref                    |
| A2-115 | Medium   | All first-party actions tag-pinned, not SHA-pinned; `sha_pinning_required: false`         |
| A2-116 | Low      | `pr-automation.yml`, `pr-review.yml` lack workflow-level `permissions` block              |
| A2-117 | Info     | Repo `allowed_actions: "all"` — consider Marketplace allowlist pre-launch                 |
| A2-118 | Info     | Org webhook inventory (G5-07) not verifiable from this session — scope needed             |
| A2-119 | Critical | `LoopDevs` org does not require 2FA; both members are repo admins                         |
| A2-120 | Medium   | Org on `free` plan — no audit log retention / review cadence available                    |
| A2-121 | Medium   | SSH key `stellarspendtest server` on AshFrancis looks stale (Aug 2025 last-used)          |
| A2-122 | Low      | No GPG keys on file for either push-capable member                                        |
| A2-123 | Low      | All three merge modes enabled (squash/merge/rebase) despite squash-only convention        |
| A2-124 | Medium   | Public repo has no `LICENSE` file                                                         |
| A2-125 | Medium   | No `SECURITY.md` — no coordinated disclosure path for a public repo                       |
| A2-126 | Low      | No `.github/ISSUE_TEMPLATE/` directory                                                    |
| A2-127 | Low      | No `CHANGELOG.md`                                                                         |

### Severity totals

| Severity  | Count  |
| --------- | ------ |
| Critical  | 1      |
| High      | 4      |
| Medium    | 9      |
| Low       | 10     |
| Info      | 3      |
| **Total** | **27** |

---

## Finding-detail blocks

### A2-101 — Branch protection permits admin bypass; zero required reviews

**Severity:** High
**Files:** `gh api repos/LoopDevs/Loop/branches/main/protection`, `AGENTS.md:114-116` (critical security rules), `AGENTS.md` §Git workflow.
**Evidence:** `enforce_admins.enabled: false`; `required_approving_review_count: 0`; `require_code_owner_reviews: false`; `enforcement_level: "non_admins"` on required_status_checks. Both collaborators have `role_name: admin`.
**Impact:** Any auth/payment/Stellar change can land with zero human review. Admin can force-land while status checks still officially listed.
**Remediation:** Set `enforce_admins: true`; `required_approving_review_count: 1`; `require_code_owner_reviews: true` — AFTER fixing A2-103 so CODEOWNERS resolves.

### A2-102 — No signed-commit policy on `main`

**Severity:** Medium
**Files:** branch-protection dump (`required_signatures.enabled: false`); `gh api orgs/LoopDevs` (`web_commit_signoff_required: false`).
**Evidence:** 979/979 commits unsigned.
**Impact:** Insider-with-repo-access adversary (plan §1.1) has no cryptographic provenance step. Given org has no 2FA mandate (A2-119), this is defense-in-depth.
**Remediation:** Decide: signed-commits-required vs web-commit-signoff (lightweight). Publish the decision. If required, each collaborator must add a GPG/SSH signing key.

### A2-103 — CODEOWNERS references non-existent `@LoopDevs/engineering` team

**Severity:** High
**Files:** `.github/CODEOWNERS:2,5,6,7,8`.
**Evidence:** `gh api orgs/LoopDevs/teams` → `[]`. `gh api orgs/LoopDevs/teams/engineering` → `404 Not Found`.
**Impact:** CODEOWNERS rules are non-functional. Security-sensitive paths (`apps/backend/src/auth/`, `src/orders/`, `apps/web/app/native/`, `apps/web/app/stores/auth*`) have no code-owner. If `require_code_owner_reviews` is ever enabled, it would block every PR because GitHub can't resolve the team.
**Remediation:** Create the team (`gh api -X PUT orgs/LoopDevs/teams` + add both members) OR rewrite CODEOWNERS to reference `@AshFrancis @alexdcox` directly.

### A2-104 — CODEOWNERS coverage stale

**Severity:** Medium
**Files:** `.github/CODEOWNERS` (5 rules total).
**Evidence:** No rule covers `apps/backend/src/admin/**`, `apps/backend/src/credits/**` (ADR 009 ledger), `apps/backend/src/stellar/**` (ADR 015/016 payouts), `apps/backend/src/db/migrations/**`, `packages/shared/**`, `.github/workflows/**`.
**Impact:** Even if A2-103 is fixed, the newest security surfaces (admin panel, ledger, Stellar) are unowned.
**Remediation:** Extend CODEOWNERS with those paths.

### A2-105 — GitHub security features disabled

**Severity:** High
**Files:** `gh api /repos/LoopDevs/Loop` → `security_and_analysis`; `gh api /orgs/LoopDevs` default-for-new-repos fields.
**Evidence:**

```
secret_scanning: disabled
secret_scanning_push_protection: disabled
dependabot_security_updates: disabled
secret_scanning_non_provider_patterns: disabled
secret_scanning_validity_checks: disabled
(org) advanced_security_enabled_for_new_repositories: false
(org) dependabot_alerts_enabled_for_new_repositories: false
(org) secret_scanning_enabled_for_new_repositories: false
```

**Impact:** A pushed secret is not blocked at push-time. A known-CVE dep is not alerted continuously (only via CI `npm audit`). The org defaults every new repo to "off".
**Remediation:** `gh api -X PATCH /repos/LoopDevs/Loop -f security_and_analysis…` to enable all four. Set the four org-level defaults to `enabled`.

### A2-106 — Dependabot `reviewers` points at missing team

**Severity:** Low
**Files:** `.github/dependabot.yml:17-18`.
**Evidence:** `reviewers: - LoopDevs/engineering`; team does not exist (A2-103).
**Impact:** Auto-assignment silently no-ops.
**Remediation:** Remove the `reviewers:` block OR point at real users, in sync with A2-103's fix.

### A2-107 — Commitlint is client-side only

**Severity:** Medium
**Files:** `.husky/commit-msg`, `commitlint.config.js`, `.github/workflows/ci.yml` (no commitlint step).
**Evidence:** No server-side commit-message validation. `--no-verify` or `HUSKY=0` skips commit-msg hook locally; CI does not re-run it. GitHub squash-merge title is not validated.
**Impact:** `type(scope): subject` guarantee is convention, not enforcement. Automated release tooling (changelog from conv-commits, etc.) cannot rely on it.
**Remediation:** Add a `commitlint` job to `ci.yml` that runs `commitlint --from=${{ github.event.pull_request.base.sha }} --to=${{ github.event.pull_request.head.sha }}` on PRs, plus a check of the eventual squash-merge title via a branch-protection status. Or adopt a GitHub-App like `amannn/action-semantic-pull-request`.

### A2-108 — Branch-prefix hook / CONTRIBUTING.md type-list drift

**Severity:** Low
**Files:** `.husky/pre-push:3`; `CONTRIBUTING.md:22`; `commitlint.config.js`.
**Evidence:** Hook regex `(feat|fix|chore|docs|test|refactor|perf|ci|build)/` omits `revert`; CONTRIBUTING.md lists only `feat/ fix/ chore/ docs/ test/ refactor/` and omits `perf/ ci/ build/ revert/`.
**Impact:** Legitimate revert-branches rejected by pre-push; documentation misses valid prefixes.
**Remediation:** Sync the three sources (hook regex, CONTRIBUTING.md, commitlint config).

### A2-109 — CONTRIBUTING.md overstates review gate

**Severity:** Medium
**Files:** `CONTRIBUTING.md:37`.
**Evidence:** Sampled PRs #754, #752, #749, #745, #735 have zero reviews. `required_approving_review_count: 0`. CODEOWNERS team doesn't exist.
**Impact:** External reader (or new hire) reads CONTRIBUTING.md expecting a gate that doesn't exist. Audit artifact drift.
**Remediation:** Either make CONTRIBUTING.md honest about current state (review is aspirational pre-team) OR implement the review gate (depends on A2-101/A2-103 being fixed).

### A2-110 — CONTRIBUTING.md CI job-count drift

**Severity:** Low
**Files:** `CONTRIBUTING.md:35`.
**Evidence:** Says "CI runs 6 jobs"; actual = 7 (`ci.yml`: quality, test-unit, audit, build, test-e2e, test-e2e-mocked, notify). Says e2e "only on PRs" — mocked e2e runs on push-to-main too.
**Remediation:** Update CONTRIBUTING.md to match ci.yml.

### A2-111 — No `.gitattributes`

**Severity:** Low
**Files:** repo root (absent file).
**Evidence:** `ls -la /Users/ash/code/loop-app/.gitattributes` → No such file or directory.
**Impact:** No declared line-ending policy. On mixed-OS teams, EOL churn.
**Remediation:** Add `.gitattributes` with `* text=auto`, `*.sh text eol=lf`, binary declarations for fonts / images.

### A2-112 — Postman collection at repo root

**Severity:** Info
**Files:** `/Users/ash/code/loop-app/ctx.postman_collection.json` (untracked).
**Evidence:** `.gitignore` line 57 `*.postman_collection.json` covers it; `git log -- ctx.postman_collection.json` returns empty (never committed).
**Impact:** None direct — flagged per plan G2-21 for Phase 15 disposition.
**Remediation:** Decide: move under `docs/api/`, document as a dev-only artifact, or delete.

### A2-113 — PR template is decorative

**Severity:** Low
**Files:** `.github/pull_request_template.md`.
**Evidence:** PR #754, #745 use custom `## Summary` / `## Test plan` format, not the template checkboxes.
**Remediation:** Either enforce the template (a PR-body check) or simplify it to what authors actually fill in.

### A2-114 — `superfly/flyctl-actions/setup-flyctl@master` pins a branch

**Severity:** High
**Files:** `.github/workflows/ci.yml:59`.
**Evidence:** `uses: superfly/flyctl-actions/setup-flyctl@master` — not a tag or SHA.
**Impact:** Future maintainer of the superfly repo (or attacker who compromises it) can mutate `master` to inject code that runs in our `quality` job with repo checkout content access.
**Remediation:** Pin to a specific tag (`@v1.5` etc.) or, safer, a 40-char SHA.

### A2-115 — Tag pinning on all first-party actions

**Severity:** Medium
**Files:** `.github/workflows/*.yml` (all `@v4`, `@v6`, `@v7`).
**Evidence:** `actions/checkout@v6`, `actions/setup-node@v4`, `actions/cache@v4`, `actions/upload-artifact@v7`, `actions/download-artifact@v7`, `actions/labeler@v6`.
**Impact:** Tag can be moved if a GitHub-internal action maintainer is compromised; we'd run mutated code on next CI run.
**Remediation:** SHA-pin (`@<40-char-sha>`) with a comment of the tag for readability. Consider enabling `sha_pinning_required: true` on the repo via `gh api -X PUT /repos/.../actions/permissions`.

### A2-116 — Missing workflow-level `permissions` in pr-automation.yml, pr-review.yml

**Severity:** Low
**Files:** `.github/workflows/pr-automation.yml`, `.github/workflows/pr-review.yml`.
**Evidence:** Each file sets `permissions:` per-job but lacks a top-level block. `ci.yml` has it.
**Impact:** Future-added job without a `permissions:` block inherits `default_workflow_permissions: read` (currently safe) — defense-in-depth missed.
**Remediation:** Add `permissions: { contents: read }` at workflow root.

### A2-117 — Repo `allowed_actions: "all"`

**Severity:** Info
**Files:** `gh api /repos/LoopDevs/Loop/actions/permissions`.
**Evidence:** `{"enabled":true,"allowed_actions":"all","sha_pinning_required":false}`.
**Impact:** Any Marketplace action can be pulled in. Pre-launch OK; pre-audit-burden becomes a finding.
**Remediation:** Shift to `"selected"` with an explicit allowlist once Phase 16 catalogs the set.

### A2-118 — Org webhook inventory unverified

**Severity:** Info
**Files:** N/A — audit-execution note.
**Evidence:** `gh api orgs/LoopDevs/hooks` → `404` with `admin:org_hook` scope missing.
**Remediation:** `gh auth refresh -h github.com -s admin:org_hook && gh api orgs/LoopDevs/hooks` by repo owner, and append the dump to this file.

### A2-119 — Org does not require 2FA

**Severity:** Critical
**Files:** `gh api orgs/LoopDevs` → `two_factor_requirement_enabled: false`.
**Evidence:** Both members (AshFrancis, alexdcox) are repo admins; both have push-capable SSH keys last-used within 90 days; no 2FA enforcement at org level.
**Impact:** A phished password on either account = admin access to repo with no MFA step. With A2-101 (no required reviews) and A2-105 (no push-protection), one credential compromise = silent malicious merge into `main`.
**Remediation:** `gh api -X PATCH orgs/LoopDevs -f two_factor_requirement_enabled=true`. Note: this will lock out any member without 2FA configured; both need to enable first.

### A2-120 — Free-plan audit-log absence

**Severity:** Medium
**Files:** `gh api orgs/LoopDevs` → `plan.name: "free"`; `gh api orgs/LoopDevs/audit-log` → `404`.
**Impact:** No record of secret changes, membership changes, webhook installs, deploy-key additions. Insider-threat detection capability = zero.
**Remediation:** Upgrade to a plan with audit-log access before launch OR accept with explicit sign-off per plan §3.4 "accepted rationale".

### A2-121 — Stale server SSH key

**Severity:** Medium
**Files:** `gh api users/AshFrancis/keys` — key 129798083 "stellarspendtest server".
**Evidence:** `last_used: 2025-08-22T17:55:06Z`, ~8 months stale at audit capture.
**Impact:** Server-resident keys are higher-risk than laptop keys. If the server is decommissioned, the key is orphaned; if still live, its access is unreviewed.
**Remediation:** Verify server status. Rotate key or delete from GitHub if server retired.

### A2-122 — No GPG keys on file for push-capable users

**Severity:** Low
**Files:** `gh api users/AshFrancis/gpg_keys`, `gh api users/alexdcox/gpg_keys` — both `[]`.
**Remediation:** If A2-102 ever adopts signed-commits-required, both members need GPG/SSH signing keys uploaded first.

### A2-123 — Three merge modes enabled

**Severity:** Low
**Files:** `gh api /repos/LoopDevs/Loop`: `allow_squash_merge: true`, `allow_merge_commit: true`, `allow_rebase_merge: true`.
**Evidence:** CONTRIBUTING.md says "Squash merge to main" but config allows any.
**Remediation:** Disable `allow_merge_commit` and `allow_rebase_merge` if squash-only is the policy.

### A2-124 — No LICENSE

**Severity:** Medium
**Files:** repo root.
**Evidence:** `gh api /repos/LoopDevs/Loop` → `"license": null`. `visibility: public`.
**Impact:** Legally ambiguous — public repo with no license = all rights reserved by default, which contradicts CONTRIBUTING.md's "contribute" framing.
**Remediation:** Add a LICENSE file explicitly. Match Loop's intended posture (proprietary / OSS).

### A2-125 — No SECURITY.md

**Severity:** Medium
**Files:** repo root and `.github/` — absent.
**Impact:** Security researchers have no disclosed coordinated-disclosure path for a public pre-launch payments-adjacent repo.
**Remediation:** Add `SECURITY.md` with contact + PGP key + response SLO.

### A2-126 — No issue templates

**Severity:** Low
**Files:** `.github/ISSUE_TEMPLATE/` absent.
**Remediation:** Phase 15 deliverable — add once intake volume justifies.

### A2-127 — No CHANGELOG.md

**Severity:** Low
**Files:** repo root — absent.
**Remediation:** Decide conv-commits-generated (release-please) vs handwritten (keep-a-changelog). Phase 15.

---

## Exit

Phase 1 complete. 27 findings filed: 1 Critical, 4 High, 9 Medium, 10 Low, 3 Info. No secrets in git history. Branch-protection exists but has material exceptions (admin bypass, zero required reviews, CODEOWNERS broken). Org-level hardening is the single largest risk cluster (no 2FA, no audit log, no secret-scanning). A2-118 leaves one Phase 1 scope item (org webhook inventory, G5-07) unverified pending an `admin:org_hook` scope refresh by the audit owner; the rest of Phase 1 scope closes.
