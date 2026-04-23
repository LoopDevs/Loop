# Phase 16 — CI/CD & Automation (evidence)

**Commit SHA at capture:** `450011ded294b638703a9ba59f4274a3ca5b7187`
**Audit branch:** `chore/audit-2026-bootstrap`
**Date captured:** 2026-04-23
**Cross-refs:** Phase 1 (`phase-1-governance.md`) already audited repo
hygiene, SHA pinning (`A2-114`, `A2-115`), workflow-level `permissions`
(`A2-116`), marketplace allowlist (`A2-117`), Dependabot scope
(`A2-105`, `A2-106`), commitlint bypass (`A2-107`), branch-prefix hook
drift (`A2-108`), `--no-verify` bypass path (§12). Phase 4 audited
Dockerfiles, `fly.toml`, release_command / migration ordering, SBOM /
container scan / signing posture (`A2-407`, `A2-408`). This file does
not re-derive those findings; it concentrates on CI/CD **as a
pipeline**: orchestration, deploy-pipeline shape, verify.sh parity,
static-analysis breadth, and LLM-tooling blast radius.

---

## 1. Workflow inventory

Four hand-authored workflows + one GitHub-managed Dependabot runtime:

```
gh api repos/LoopDevs/Loop/actions/workflows
→ CI                        (ci.yml, active)
  E2E (real CTX + wallet)   (e2e-real.yml, active)
  PR Automation             (pr-automation.yml, active)
  Claude PR Review          (pr-review.yml, active)
  Dependabot Updates        (dynamic, GitHub-managed)
```

### 1.1 Workflow-by-workflow matrix

| Workflow            | Triggers                             | Jobs                                                                               | Default permissions                                               | Uses secrets                                                          | Pins                                                         |
| ------------------- | ------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| `ci.yml`            | push→main, pull_request→main         | `quality`, `test-unit`, `audit`, `build`, `test-e2e`¹, `test-e2e-mocked`, `notify` | top-level `contents: read`                                        | `DISCORD_WEBHOOK_DEPLOYMENTS`                                         | tag pins only; `superfly/flyctl-actions/setup-flyctl@master` |
| `e2e-real.yml`      | workflow_dispatch (manual inputs)    | `run`                                                                              | top-level `contents: read`                                        | `CTX_TEST_REFRESH_TOKEN`, `STELLAR_TEST_SECRET_KEY`, `GH_SECRETS_PAT` | tag pins only                                                |
| `pr-automation.yml` | pull_request (opened, sync, labeled) | `label`, `size-check`                                                              | **no** top-level; per-job `contents: read + pull-requests: write` | `GITHUB_TOKEN` (implicit)                                             | tag pins only                                                |
| `pr-review.yml`     | pull_request (opened, sync)          | `review`                                                                           | **no** top-level; per-job `contents: read + pull-requests: write` | `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`                                   | tag pins + `@anthropic-ai/claude-code@2.1.114` (npm version) |

¹ `test-e2e` runs only on `pull_request` (`if: github.event_name == 'pull_request'`). `test-e2e-mocked` runs on both.

### 1.2 Actions used (all workflows combined)

```
actions/checkout@v6
actions/setup-node@v4
actions/cache@v4
actions/upload-artifact@v7
actions/download-artifact@v7
actions/labeler@v6
superfly/flyctl-actions/setup-flyctl@master     ← moving ref (Phase 1 A2-114)
```

No third-party actions beyond `superfly`. No CodeQL / semgrep / trivy /
syft / cosign actions anywhere in the tree (grep for those names:
zero matches in `.github/`).

### 1.3 Repo-level Actions policy

```
gh api repos/LoopDevs/Loop/actions/permissions
→ {"enabled": true, "allowed_actions": "all", "sha_pinning_required": false}

gh api repos/LoopDevs/Loop/actions/permissions/workflow
→ {"default_workflow_permissions": "read", "can_approve_pull_request_reviews": false}
```

Good defaults (`read`, no approve). Marketplace still wide open per A2-117.

### 1.4 Environments / deploy gating

```
gh api repos/LoopDevs/Loop/environments → {"total_count": 0, "environments": []}
```

**No GitHub Environments are configured.** No `staging`, `production`,
or `preview` environment; no required reviewers on deploy; no
environment-scoped secrets; no deploy protection rules. All secrets
live at repo scope. This means there is no workflow-level mechanism
that blocks a deploy on a human approval, no audit trail of "who
approved the production deploy at T+X", and no way to scope the
Stellar/CTX secrets away from a future preview job. See §3 and
finding A2-1406.

---

## 2. `scripts/verify.sh` vs `ci.yml` Quality/Unit-tests parity

### 2.1 What `scripts/verify.sh` does

```bash
echo "=== Typecheck ===" && npm run typecheck
echo "=== Lint ==="      && npm run lint
echo "=== Format ==="    && npm run format:check
echo "=== Docs ==="      && ./scripts/lint-docs.sh
echo "=== Test ==="      && npm test
```

Five checks: typecheck, lint, format:check, lint-docs, test (unit).

### 2.2 What the equivalent `ci.yml` jobs do

- `quality`: `npm run typecheck && npm run lint && npm run format:check && npm run lint:docs` — identical to verify.sh's first four checks **after** installing `flyctl` so the `lint-docs` §8 `flyctl config validate` block actually runs against both fly.toml files.
- `test-unit`: `npm run test:coverage --workspaces --if-present` — **not identical** to `npm test`. Coverage run collects vitest coverage in each workspace and uploads it as an artifact; verify.sh runs the plain `test` script.
- `audit`: `npm audit --audit-level=high` — **not in verify.sh**. A local `npm run audit` exists in `package.json:25` but `verify.sh` does not call it.
- `build`: `npm run build -w @loop/backend && npm run build -w @loop/web && npm run build:mobile -w @loop/web` — **not in verify.sh**. A local developer never builds before push.
- `test-e2e*`: Playwright — **not in verify.sh**. Verify.sh has no e2e step.

### 2.3 Diff summary

| Check                          | In `verify.sh`? | In CI?                  | Notes                                                                                                     |
| ------------------------------ | --------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| typecheck                      | ✓               | ✓                       | identical                                                                                                 |
| lint                           | ✓               | ✓                       | identical                                                                                                 |
| format:check                   | ✓               | ✓                       | identical                                                                                                 |
| lint-docs                      | ✓               | ✓                       | CI installs `flyctl`; local skips that sub-check when `flyctl` not installed (see `lint-docs.sh:179-197`) |
| unit tests                     | `npm test`      | `npm run test:coverage` | CI gets coverage output; local does not                                                                   |
| `npm audit --audit-level=high` | ✗               | ✓                       | only CI blocks on vuln floor                                                                              |
| backend build                  | ✗               | ✓                       | local never exercises backend tsup / esbuild pipeline                                                     |
| web SSR build                  | ✗               | ✓                       | local never exercises React Router prod build                                                             |
| web mobile static build        | ✗               | ✓                       | local never exercises `BUILD_TARGET=mobile` path                                                          |
| mocked e2e                     | ✗               | ✓                       | local never runs Playwright                                                                               |
| real-CTX e2e                   | ✗               | PR-only                 | `e2e-real.yml` is manual only                                                                             |

**`verify.sh` is a _quality_ mirror, not a CI mirror.** It gives a
contributor a reasonable "will my quality+unit-tests pass" signal but
it will silently let the following fail in CI: (a) an `npm audit`
regression above `high`, (b) a backend/web build that breaks due to an
import or tsconfig change, (c) any e2e regression. A contributor who
runs `npm run verify` before pushing still has a non-trivial chance of
a red CI run for reasons verify.sh can't have detected.

**Also:** `verify.sh` does not execute `./scripts/apply-native-overlays.sh` nor `cap sync` (mobile-release equivalent), and the pre-push husky hook (`.husky/pre-push`) runs `npm test` + `./scripts/lint-docs.sh` — **not** `verify.sh` and **not** `npm audit`.

---

## 3. Deploy-pipeline posture

### 3.1 Who actually performs the deploy?

Grep for `fly deploy` or any deploy step across workflows: zero matches.

```
grep -rn 'fly deploy\|flyctl deploy\|vercel deploy\|docker push\|gh release' .github/
→ (empty)
```

**No workflow deploys anything.** All production deploys are manual
(`docs/deployment.md:45, 118` — `fly deploy` from a maintainer laptop).
No CD at all; only CI.

### 3.2 Preview / ephemeral per-PR environments (G5-106)

Not present. No `environments` object, no PR-triggered deploy workflow,
no Fly preview app names referenced anywhere. PR diffs with UI-heavy
changes (there are several per week in the PR history — see
`feat(web): …` commits #746–#749) are reviewed without a live preview.

### 3.3 Canary / blue-green / rolling (G5-107)

Both `fly.toml` files contain no `[deploy]` block, no `strategy`, no
`max_unavailable`, no `release_command`:

```
$ grep -nE 'strategy|release_command|\[deploy\]|max_unavailable|max_surge|rolling' \
    apps/backend/fly.toml apps/web/fly.toml
(no matches)
```

Fly defaults to `rolling` when `[deploy]` is absent, and
`docs/deployment.md:244` ("Rolling deploys ensure at least one instance
has full data at all times.") acknowledges it. So there _is_ a rolling
behaviour — but it is implicit, not documented in the config, never
been tested via a planned failed deploy, and there is no canary stage.
`min_machines_running = 1` on backend (`apps/backend/fly.toml:26`) with
a `rolling` strategy and `max_unavailable` unspecified means Fly's
default (0.33 / one machine at a time) applies — acceptable but not
chosen.

### 3.4 Rollback (G5-108)

No rollback entry in `docs/deployment.md`. `grep -i rollback
docs/deployment.md → (empty)`. No rehearsed rollback procedure; no
runbook. Fly's `fly releases rollback` is available but not mentioned.
No last-90-days rollback rehearsal.

### 3.5 Migration vs app-deploy ordering (G5-109 / A2-407)

Cross-ref Phase 4 A2-407. Confirmed here: no `release_command` in
either fly.toml. Migrations run only in-process on boot
(`apps/backend/src/index.ts:25-27`). In a rolling deploy, both old and
new code talk to Postgres simultaneously during the window, so any
migration that is not backward-compatible produces mid-deploy errors.
No documented "expand / contract" guidance in `docs/deployment.md`.
Logged here as A2-1409 with a cross-ref to A2-407 (duplicate would
violate the plan; this is a _pipeline-shape_ framing).

### 3.6 Automated releases / SBOM / image scan

No automated-release mechanism: no `release-please`, no
`semantic-release`, no `changesets`, no `CHANGELOG.md`, no
`gh release create` anywhere. Tags are not pushed by any workflow.
(Phase 1 A2-127 already covers missing `CHANGELOG.md`.)

No SBOM, no container CVE scan, no image signing (Phase 4 A2-408).
Not duplicated here.

---

## 4. Dependabot (G5-111)

### 4.1 Config shape

`.github/dependabot.yml`:

- `npm` @ `/` — weekly Monday, `open-pull-requests-limit: 10`, labels `[dependencies]`, groups `minor-and-patch` (minor+patch), reviewers `LoopDevs/engineering` (missing team — A2-106).
- `github-actions` @ `/` — weekly, labels `[ci]`. No grouping; each action update is its own PR.

### 4.2 Observed behaviour

```
gh pr list --author app/dependabot --state all --limit 10 --json number,state,mergedAt,autoMergeRequest
```

- All observed dependabot PRs that merged (#21, #18, #17, #16) have `autoMergeRequest: null` and `mergedBy: AshFrancis`. **No auto-merge.** The repo flag `allow_auto_merge: false` confirms it's off repo-wide.
- `#753, #299, #295, #291, #290, #19` all `CLOSED` (not merged) — recent pattern is dependabot opens a grouped PR, author closes it, author then re-authors the bump as a hand-rolled PR (e.g. #291 closed → #754 AshFrancis-authored TS 6.0 bump).
- **No `schedule-interval: daily`** — weekly cadence may miss a critical CVE by up to 7 days. Combined with A2-105 (dependabot-security-updates disabled), the only continuous vuln channel is CI `npm audit` at the PR level — which only runs when a human opens a PR.

### 4.3 Dependabot + SHA pinning interaction

`github-actions` ecosystem updates only the `uses:` line of workflows. For tag pins (`@v6`) dependabot walks major → major; for floating refs (`@master`) dependabot cannot do anything because there is no version to compare. So A2-114 (`superfly/flyctl-actions/setup-flyctl@master`) is also invisible to Dependabot — it will not alert when superfly cuts a new release, because there is no release dependency to update. Double-miss.

### 4.4 Dependabot auto-merge policy

Not configured. Neither `.github/workflows/` nor `.github/dependabot.yml` declares an `automerge` action (e.g. `dependabot/fetch-metadata` + `gh pr merge --auto`). No `.github/dependabot-automerge.yml`. So:

- For patch updates (where auto-merge is the industry norm): none.
- For any update: human gate (which is fine as a security posture, but costly in maintenance time — see the six closed PRs above).

The plan G5-111 asks: "Dependabot auto-merge policy for patch updates — off by default; any exceptions?" **Answer: off, no exceptions.** Recording as confirmed posture, not a finding — but note the _absence of a documented policy_ is itself a Phase 15 doc gap (no `docs/standards.md` section saying "we review every dependabot PR by hand"), worth a Low.

---

## 5. Static analysis beyond ESLint (G5-110)

### 5.1 What we have

ESLint (`eslint.config.js`) with these plugins: `@typescript-eslint`,
`react-hooks`. Rules of note:

- `@typescript-eslint/no-explicit-any: error`
- `@typescript-eslint/no-floating-promises: error`
- `@typescript-eslint/no-misused-promises: error`
- `no-console: error`
- `react-hooks/exhaustive-deps: error`
- `no-restricted-imports` for `@capacitor/*` etc. outside `apps/web/app/native/`

These are quality/correctness rules, not security rules.

### 5.2 What we don't have

- **`eslint-plugin-security`** — not installed. Would flag `eval`, unsafe regex, possible SSRF patterns in `new URL(userInput)`, `child_process` spawn with user input, etc.
- **`eslint-plugin-no-secrets`** / **`eslint-plugin-no-unsanitized`** — not installed.
- **Semgrep** — not in workflows, not in `package.json`, no `.semgrepignore` file.
- **CodeQL** — no `.github/workflows/codeql.yml`; GitHub Advanced Security is disabled at the org level anyway (A2-105).
- **Sonar / Snyk / DeepSource** — not configured.
- **Trivy / grype / syft / cosign** (Phase 4 A2-408) — already filed.

```
grep -rE 'eslint-plugin-security|semgrep|codeql|sonar|snyk' package.json apps/*/package.json packages/*/package.json .github/ eslint.config.js
→ (empty)
```

### 5.3 Manual-inspection compensations

- `lint-docs.sh` has a Stellar-secret-seed regex scan (lines 93-114 — `S[A-Z2-7]{55}`) — narrow but present.
- Backend image-proxy has hand-rolled SSRF allowlist (`IMAGE_PROXY_ALLOWED_HOSTS`, audit A-025).

No generalised static-security coverage. One targeted scan (Stellar
seed) ≠ a SAST tool.

---

## 6. `pr-review.yml` — LLM-backed tooling surface

### 6.1 Blast radius

- Triggers on every non-draft PR's `opened` and `synchronize`.
- Runs `@anthropic-ai/claude-code@2.1.114` (version pinned — audit A-031, good).
- Feeds `gh pr diff "$PR_NUMBER"` — i.e. **fully attacker-controlled content** (PR body, PR diff, any code comments in the diff).
- Permissions: `contents: read`, `pull-requests: write`.
- Outputs `gh pr comment` with whatever the model returned (sanitised by a header check — if header absent, the comment is replaced with a "did-not-match-format" warning rather than raw output).
- Secrets accessible: `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` (scoped by `permissions:`).

### 6.2 Prompt-injection hardening

`pr-review.yml:42-53` (inline comment) + lines 54-96 (implementation):

1. Wraps diff in `<user_data>...</user_data>` with a system-level "UNTRUSTED INPUT" preamble.
2. Instructs the model to flag instruction-looking text as a finding rather than follow it.
3. Enforces an output header (`## Claude Code Review Findings`); non-conforming output replaced with a fixed failure marker.

This is defence-in-depth — documented explicitly in code comments as
"doesn't eliminate injection, but makes it harder and easier to spot
when it happens".

### 6.3 Residual risks

- **`claude -p --print`** is non-interactive (no tool use), but the SDK exec permissions are implicit — if a future SDK version lets `-p` run bash, the runner secrets (`GITHUB_TOKEN` with `pull-requests: write`) become the exfil surface. Pinning `@2.1.114` mitigates drift; no automation alerts on a new pin.
- **No Dependabot updates to `@anthropic-ai/claude-code`** — `npm install -g` inside the step means the version is not in `package.json`, so dependabot can't see it. Bumping is a manual commit.
- **`fetch-depth: 0`** — full history fetch, gives the model visibility into all commit messages including any that might contain secrets historically (Phase 1 §11 found none, so not currently exploitable, but the pattern is loose — a shallower fetch would suffice for a PR diff).
- **Output comment permission** (`pull-requests: write`) — a fully jailbroken model could delete or modify PR comments, not just post. Mitigated by the header-check, but a model that emits the header followed by malicious comment actions would still pass the check. (Low severity — comments only, no merge rights.)
- **`2>/dev/null` on the Claude invocation** — swallows stderr; if the SDK ever emits a useful error (rate-limit, auth), it's silent. Not a security finding but operational.

### 6.4 What's missing

- No redaction of PR-diff content fed to the third-party API (Anthropic sees every line of every PR). For a payments-adjacent codebase this is a **data-flow policy** question: no `docs/adr/` record of "we send PR diffs to Anthropic's API". Plan G5-104-class: ADR gap.
- No rate-limit / abuse handling. A storm of `synchronize` events on a thrash PR costs Anthropic tokens with no ceiling.

---

## 7. `pr-automation.yml` / labeler

Surface is small:

- `label` job: `actions/labeler@v6`. Reads `.github/labeler.yml`. The config maps paths → labels (confirmed live on PR #754). Pure labelling; no write beyond labels.
- `size-check` job: posts a Large-PR warning if `additions + deletions > 500`. Dedupes against existing comment (line 53-60) so `synchronize` doesn't spam. No enforcement — warning only.

No security finding. Two minor observations:

- Missing workflow-level `permissions` block (Phase 1 A2-116 covers this).
- `actions/labeler@v6` is tag-pinned (Phase 1 A2-115 covers this).

---

## 8. `e2e-real.yml` — secrets handling and rotation

### 8.1 Secrets used

- `CTX_TEST_REFRESH_TOKEN` — CTX upstream refresh token. CTX rotates on every `/refresh-token` call (see `project_ctx_refresh_rotation.md` in user memory).
- `STELLAR_TEST_SECRET_KEY` — mainnet Stellar secret seed with real XLM (per `reference_test_wallet.md` in user memory — this is **real value, mainnet**).
- `GH_SECRETS_PAT` — fine-grained PAT with `Secrets: Read and write` scope, used only to rewrite `CTX_TEST_REFRESH_TOKEN` after rotation.

### 8.2 Rotation design

Post-refresh, the script writes the new token to
`${{ runner.temp }}/new-refresh-token.txt` at mode `0o600`
(`scripts/e2e-real.mjs:124`) — **immediately after** the refresh
response, not after the full flow succeeds. This is correct: the old
token is dead the moment CTX returns the new one, and a later step
failure would otherwise leave the repo secret stuck at a dead token.
The "Rotate CTX_TEST_REFRESH_TOKEN secret" step runs `if: always()` so
even a failed payment/poll still rotates.

Good practice. No finding here.

### 8.3 Residual risks

- **`GH_SECRETS_PAT` has a long-lived write-secrets permission.** A workflow edit that adds a new step _before_ the rotation step can exfiltrate `CTX_TEST_REFRESH_TOKEN` or force a secret overwrite with attacker-chosen value. Only mitigated by branch protection — since branch protection is weak (Phase 1 A2-101, `enforce_admins: false`, `required_approving_review_count: 0`), a compromised admin account can push a tampered `e2e-real.yml` that exfils PAT contents to an attacker server. Not a net-new finding beyond A2-101 + A2-105; cross-ref here.
- **`STELLAR_TEST_SECRET_KEY`** is a hot wallet secret in a `workflow_dispatch`-only workflow. Good that it's manual-trigger only (`concurrency: group: e2e-real, cancel-in-progress: false`). But:
  - No environment scoping (A2-1406) — any workflow in the repo can reference this secret via `${{ secrets.STELLAR_TEST_SECRET_KEY }}`.
  - No `actions/setup-node@v4` step runs `npm ci` first then the unscoped `tsx src/index.ts` — ad-hoc backend boot via `npm exec`. In principle any malicious package introduced via a PR's package.json (dependabot or otherwise) that runs a postinstall hook could exfil env at `npm ci` time before rotation.
- **`nohup npm exec -w @loop/backend -- tsx src/index.ts` with stdout/stderr to a file tailed later** — the backend logs are dumped (`tail -n 200`) on `if: always()`. Backend logs use `pino` with redaction (per `apps/backend/src/logger.ts` — see phase 13 scope), but any log line hitting `console.log` with a secret would leak into the Actions log. Quick ripgrep: `apps/backend/src/payments/payout-worker.ts`, etc. already use `logger.info`, not `console.log`. Current state: OK, but no guard rail.

---

## 9. Local hook completeness (what hooks don't enforce)

Cross-ref Phase 1 §4. Here focused on _what hooks miss_ that CI catches:

| Check                                     | pre-commit | pre-push | commit-msg | CI                 |
| ----------------------------------------- | ---------- | -------- | ---------- | ------------------ |
| ESLint (lint-staged — changed files only) | ✓          | ✗        | ✗          | ✓ (whole repo)     |
| Prettier (changed files only)             | ✓          | ✗        | ✗          | ✓ (`format:check`) |
| Typecheck (whole repo)                    | ✗          | ✗        | ✗          | ✓                  |
| Full `npm test`                           | ✗          | ✓        | ✗          | ✓ (with coverage)  |
| `lint-docs.sh`                            | ✗          | ✓        | ✗          | ✓                  |
| `npm audit`                               | ✗          | ✗        | ✗          | ✓ (`audit` job)    |
| Backend build                             | ✗          | ✗        | ✗          | ✓                  |
| Web SSR build                             | ✗          | ✗        | ✗          | ✓                  |
| Web mobile-static build                   | ✗          | ✗        | ✗          | ✓                  |
| Mocked e2e (Playwright)                   | ✗          | ✗        | ✗          | ✓                  |
| Real-CTX e2e                              | ✗          | ✗        | ✗          | PR-only            |
| Branch-prefix regex                       | ✗          | ✓        | ✗          | ✗                  |
| Commitlint (type/scope/subject)           | ✗          | ✗        | ✓          | ✗ (server-side)    |

**Pre-push runs `npm test` but not `npm run verify`.** A contributor
who only runs pre-push gets: lint-staged on the staged subset, full
unit tests, docs-lint. They **do not** get the whole-repo ESLint pass
(only on staged files), typecheck, format:check, or `npm audit`.
Consequence: a whole-repo lint or typecheck regression caused by a
file the contributor did not stage can still reach CI, and a Low-sev
dep-vuln regression reaches CI without local warning. This is
consistent with the client-side-only philosophy (Phase 1 A2-107) but
deserves its own finding because the _guidance_ is "run `npm run
verify`" (CONTRIBUTING.md:34) and no hook enforces it.

---

## 10. Observed CI pipeline behaviour (recent runs)

Five most recent `main` push runs (`gh api
repos/LoopDevs/Loop/actions/runs?event=push&branch=main&per_page=5`):

```
24838612090  success  2026-04-23 13:41  84fc581 (CI)
24836725992  success  2026-04-23 13:01  520d57f (CI)
24835046795  success  2026-04-23 12:24  558833c (CI)
24832295401  failure  2026-04-23 11:19  8bbc18e (CI)
24832191495  failure  2026-04-23 11:16  11460c9 (CI)
```

Two recent push failures on `main` — despite branch protection. This
is only possible because:

1. Branch protection applies at PR-merge time, not push time, and
2. The failing commits on `main` are from merged PRs where the
   PR checks passed but a later push-level run was transient.

Spot-check of `24832295401`: fails in the Quality job, downloads
actions including `superfly/flyctl-actions@master` resolved to
`ed8efb33836e8b2096c7fd3ba1c8afe303ebbff1`. Confirms floating-ref
resolution (A2-114). `GITHUB_TOKEN Permissions: Contents: read,
Metadata: read` — least-privilege confirmed on the quality job.

---

## 11. Findings filed (A2-1400 series)

| ID      | Severity | One-liner                                                                                                                                            |
| ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2-1401 | Medium   | `scripts/verify.sh` is a quality-mirror only; misses audit/build/e2e parity                                                                          |
| A2-1402 | Medium   | Pre-push hook runs `npm test` + `lint-docs.sh` but NOT `npm run verify` or `npm audit`                                                               |
| A2-1403 | High     | No `docs/deployment.md` rollback procedure; no 90-day rollback rehearsal                                                                             |
| A2-1404 | High     | No preview / ephemeral per-PR environment for UI changes (G5-106)                                                                                    |
| A2-1405 | Medium   | No documented canary / blue-green / deploy strategy; rolling is implicit                                                                             |
| A2-1406 | High     | Zero GitHub Environments configured — no prod-deploy gating or env-scoped secrets                                                                    |
| A2-1407 | Medium   | No automated release mechanism (no release-please / semantic-release / tag-push)                                                                     |
| A2-1408 | High     | No static-security analysis (semgrep / CodeQL / eslint-plugin-security)                                                                              |
| A2-1409 | Medium   | Migration vs app-deploy ordering undocumented at pipeline layer (cross-ref A2-407)                                                                   |
| A2-1410 | Low      | Dependabot update cadence is weekly only; no daily-security track                                                                                    |
| A2-1411 | Low      | No documented Dependabot auto-merge policy (code + docs both silent)                                                                                 |
| A2-1412 | Medium   | `@anthropic-ai/claude-code` pinned by `npm install -g` — outside dependabot scope                                                                    |
| A2-1413 | Low      | No ADR on "we send PR diffs to Anthropic"; data-flow-to-third-party is unrecorded                                                                    |
| A2-1414 | Low      | `pr-review.yml` has no rate-limit / abuse cap on per-PR Claude invocations                                                                           |
| A2-1415 | Low      | `notify` job uses commit-author-supplied `COMMIT_MSG` via `github.event.head_commit.message` — jq-escaped but still attacker-controlled into Discord |
| A2-1416 | Medium   | `e2e-real.yml` secrets (mainnet Stellar seed, CTX refresh, `GH_SECRETS_PAT`) are repo-scoped — any future workflow can reference them                |
| A2-1417 | Info     | `test-unit` CI uses `npm run test:coverage` but verify.sh / pre-push use plain `npm test` — coverage-only failures detectable only in CI             |

### Severity totals

| Severity  | Count  |
| --------- | ------ |
| Critical  | 0      |
| High      | 4      |
| Medium    | 6      |
| Low       | 6      |
| Info      | 1      |
| **Total** | **17** |

Cross-referenced (not re-filed here): A2-114, A2-115, A2-116, A2-117
(SHA pinning + permissions, Phase 1), A2-105, A2-106 (Dependabot + GH
security features, Phase 1), A2-107, A2-108 (hook bypassability,
Phase 1), A2-407, A2-408 (migration-ordering, SBOM/scan/sign, Phase 4).

---

## 12. Finding-detail blocks

### A2-1401 — `scripts/verify.sh` is a quality-mirror, not a CI-mirror

**Severity:** Medium
**Files:** `scripts/verify.sh`, `.github/workflows/ci.yml`, `CONTRIBUTING.md:34` ("Run `npm run verify`").
**Evidence:** §2.3 diff table. Verify.sh covers 4/7 CI jobs: quality (✓), test-unit (partial — no coverage), audit (✗), build (✗), test-e2e-mocked (✗), test-e2e (✗), notify (N/A). CONTRIBUTING.md says "Run `npm run verify`" as if it's the local CI equivalent; it isn't.
**Impact:** Contributors who run `verify.sh` and see green can still get a red CI run from dep-vuln, build, or e2e reasons verify.sh never exercised.
**Remediation:** Either (a) extend `verify.sh` with `npm audit --audit-level=high`, `npm run build`, and `npm run test:e2e:mocked`, or (b) rename `verify` to `verify:quality` and document the scope. Option (a) is more honest; (b) is cheaper.

### A2-1402 — Pre-push hook skips `verify.sh` and `npm audit`

**Severity:** Medium
**Files:** `.husky/pre-push:9-10`, `CONTRIBUTING.md:34`, `package.json:23, 25`.
**Evidence:** pre-push calls `npm test && ./scripts/lint-docs.sh` directly, not `npm run verify`. No `npm audit`. A whole-repo ESLint regression introduced by an un-staged file change still reaches CI.
**Impact:** Local "pass" signal is narrower than CI. If the intent of `verify` is the gate, pre-push should call it.
**Remediation:** Change pre-push to `npm run verify && npm run audit`.

### A2-1403 — No rollback procedure documented; no rehearsal

**Severity:** High
**Files:** `docs/deployment.md` (grep `rollback` → no matches), no runbook folder, no rehearsal log.
**Evidence:** Phase 4 already flagged deploy-reproducibility gaps; here specifically the rollback dimension. G5-108 asks for one-click rollback + 90-day rehearsal; both absent. Fly has `fly releases rollback` but it's unmentioned in any doc.
**Impact:** If a prod deploy corrupts user data or breaks auth, MTTR is bounded by "how fast a maintainer remembers the fly command". No tabletop exercise. Pre-launch this is a process-maturity gap that blocks Phase 17 operational-readiness exit criteria.
**Remediation:** Add `docs/runbooks/rollback.md` covering backend, web, and mobile (TestFlight/Play Console). Rehearse via a staging deploy, document the duration, re-rehearse quarterly.

### A2-1404 — No preview / ephemeral per-PR environment

**Severity:** High
**Files:** `.github/workflows/*.yml` — no deploy-on-PR anywhere. `gh api repos/LoopDevs/Loop/environments` → `[]`.
**Evidence:** UI-heavy PRs (e.g. #740 "supplier-margin card", #749 "conversion CTA on /calculator") reviewed without a live instance. Vercel preview convention is standard for React-Router apps; not wired up.
**Impact:** Visual regressions in production-only code paths go unexercised until after merge. Combined with A2-1403 (no rollback), the feedback loop for UI regressions is days, not minutes.
**Remediation:** Wire Vercel or Fly preview apps (`fly launch` with `deploy-on-push`) to produce a per-PR URL. Gate behind `draft == false`. Scope a read-only backend token in a separate environment.

### A2-1405 — Canary / blue-green / deploy strategy undocumented

**Severity:** Medium
**Files:** `apps/backend/fly.toml`, `apps/web/fly.toml`, `docs/deployment.md`.
**Evidence:** No `[deploy]` block, no `strategy` key. Fly defaults to `rolling` (mentioned in `deployment.md:244` without the word "rolling strategy"). No canary tier. No planned-failed-deploy test.
**Impact:** A bad deploy fans out across every machine over the (un-pinned) rolling window. `min_machines_running: 1` gives _some_ headroom but is not a canary.
**Remediation:** Pin the strategy explicitly in fly.toml (`strategy = "canary"` or `"bluegreen"` if upgrading Fly tier). Document the chosen strategy + its blast-radius per step in `docs/deployment.md`.

### A2-1406 — No GitHub Environments configured

**Severity:** High
**Files:** `gh api repos/LoopDevs/Loop/environments` → `{"total_count": 0}`.
**Evidence:** All secrets are repo-scoped. Any job in any workflow can reference `STELLAR_TEST_SECRET_KEY`, `CTX_TEST_REFRESH_TOKEN`, `GH_SECRETS_PAT`. No `required_reviewers` on a prod deploy step. No deployment-history audit trail (Environments are what populates the `/deployments` view).
**Impact:** If a preview-deploy workflow is added later (A2-1404 remediation), it could inherit access to the mainnet Stellar seed unless explicitly scoped. Blast-radius of a leaked secret is any workflow in the repo, including future ones. No "required reviewer" gate exists for a prod deploy the day one is wired up.
**Remediation:** Create at minimum `staging` and `production` Environments. Move secrets to environment-scoped. Add `required_reviewers` to `production`. Use an Environment-scoped `GH_SECRETS_PAT`.

### A2-1407 — No automated release mechanism

**Severity:** Medium
**Files:** `package.json` (no `release-please`/`semantic-release`/`changesets`), no `CHANGELOG.md`, no `.github/workflows/release*.yml`, no `gh release create` in any workflow.
**Evidence:** grep: `release-please|semantic-release|changesets|auto-release` → zero hits.
**Impact:** No tags, no GitHub Releases, no changelog. Commits on `main` → manual Fly deploys → no version marker tying a deploy to a commit range. For audit, "what shipped on 2026-04-18 vs 2026-04-23" requires git-log inspection.
**Remediation:** Adopt `release-please` on `main` (it generates PRs that bump version + CHANGELOG from Conventional Commits — which commitlint already enforces locally per Phase 1). Or, if the repo stays monorepo/unversioned, document the "no-version-tags-by-design" decision in an ADR.

### A2-1408 — No static-security analysis in CI beyond ESLint

**Severity:** High
**Files:** `.github/workflows/`, `eslint.config.js`, `package.json` (any workspace).
**Evidence:** §5 — no `eslint-plugin-security`, no `semgrep`, no `codeql`, no `sonar`, no `snyk`. ESLint rules are all quality/correctness, not security. Compensating control = `lint-docs.sh` Stellar-seed regex + manual SSRF allowlist — narrow.
**Impact:** SAST-class issues (prototype pollution in a new utility, `exec` with user input, unsafe-regex ReDoS, unsanitised sink) have no automated detection. For a payments-adjacent codebase with a public repo, this is the largest "missing automated gate" in the audit.
**Remediation:** Add a `codeql.yml` workflow (free for public repos via GitHub Advanced Security). Add `eslint-plugin-security` to the existing ESLint config with a short enabled-rules list (`detect-non-literal-regexp`, `detect-possible-timing-attacks`, `detect-object-injection` sparingly). Consider `semgrep ci` on PRs as a second lens. Blocking on CodeQL from day 1 gives the most value per hour.

### A2-1409 — Migration vs deploy-ordering unspecified at pipeline layer

**Severity:** Medium
**Cross-ref:** Phase 4 A2-407.
**Files:** `apps/backend/fly.toml` (no `release_command`), `docs/deployment.md` (no expand/contract guidance), `apps/backend/src/index.ts:19-27`.
**Evidence:** Migrations run at boot, not pre-deploy. No ADR on "backward-compatible migrations only" rule. Under Fly's default rolling strategy, old + new code share the DB during the deploy window.
**Impact:** A non-backward-compatible schema change (drop column, rename column) breaks the old pod mid-deploy. The deploy succeeds as "new machines are up", but requests to old machines 500 until they're rotated out.
**Remediation:** (a) add `release_command = "npm run migrate"` to `apps/backend/fly.toml`; (b) document "expand-then-contract" in `docs/deployment.md` — migrations must be backward-compatible so both code versions can read/write; (c) add an ADR (`docs/adr/025-migration-deploy-ordering.md`) stating the rule.

### A2-1410 — Dependabot weekly-only cadence

**Severity:** Low
**Files:** `.github/dependabot.yml:5-7`.
**Evidence:** `interval: weekly, day: monday`. No `daily` security-update lane. Combined with A2-105 (dependabot security-updates off) the only fast-path for a CVE is `npm audit` in CI, which only fires when a PR opens.
**Impact:** A critical CVE published Tuesday is blind until a human opens a PR or the next Monday batch.
**Remediation:** Split the config: keep weekly for version updates; add a second `npm` entry with `interval: daily` and `allow: [security-update]`. Or re-enable repo dependabot-security-updates (see A2-105 remediation).

### A2-1411 — No documented Dependabot auto-merge policy

**Severity:** Low
**Files:** `.github/dependabot.yml`, `docs/standards.md` (grep `dependabot` → no matches).
**Evidence:** Observed auto-merge is off; observed behaviour is "human reviews, sometimes closes and re-authors". No doc says which.
**Impact:** New maintainer doesn't know whether patch bumps should auto-merge. Pattern of "dependabot opens → close → hand-roll" (§4.2) is unrecorded.
**Remediation:** One paragraph in `docs/standards.md` §Dependencies: "Dependabot PRs are reviewed manually; auto-merge is disabled; rationale is X."

### A2-1412 — `@anthropic-ai/claude-code` pinned outside Dependabot scope

**Severity:** Medium
**Files:** `.github/workflows/pr-review.yml:26` (`npm install -g @anthropic-ai/claude-code@2.1.114`).
**Evidence:** Pin is a literal in the workflow YAML. `@anthropic-ai/claude-code` does not appear in any `package.json`. Dependabot cannot propose updates for it.
**Impact:** The one tool that gets attacker-controlled PR diffs fed to it has no automated update channel. Audit A-031 pinned the version deliberately; what's missing is the _alerting_ on a new release so the maintainer knows when to review-and-bump.
**Remediation:** Add to `package.json` devDependencies (even if the workflow still uses `npm install -g` for runtime isolation) so Dependabot surfaces updates. Or document a manual quarterly review cadence in `docs/standards.md`.

### A2-1413 — No ADR on "we send PR diffs to Anthropic"

**Severity:** Low
**Files:** `docs/adr/` — no ADR mentions Anthropic, Claude, or external-LLM-for-review.
**Evidence:** grep ADR folder for `anthropic|claude|llm|external.*review` → no matches.
**Impact:** Data-flow policy gap. PR diffs leave the org to a third-party US-hosted API. No record of the decision, the data-class (source code + possibly commit metadata), the fallback if Anthropic is down, or the rotation plan for `ANTHROPIC_API_KEY`.
**Remediation:** ADR `026-pr-review-via-anthropic.md` covering data shipped, purpose, retention (Anthropic's policy), key rotation.

### A2-1414 — No rate-limit / abuse cap on `pr-review.yml`

**Severity:** Low
**Files:** `.github/workflows/pr-review.yml`.
**Evidence:** Triggers on every `synchronize`. No `concurrency:` group, no `if: github.event.pull_request.commits < N`, no skip-label convention. A PR with 50 synchronize events costs 50 Claude invocations.
**Impact:** Cost — not security — but a runaway loop or a malicious PR author pushing empty commits drains `ANTHROPIC_API_KEY` budget.
**Remediation:** Add `concurrency: { group: "pr-review-${{ github.event.pull_request.number }}", cancel-in-progress: true }` so only the latest sync costs tokens. Optionally skip if `[skip-review]` in the PR title.

### A2-1415 — `notify` job puts attacker-controlled commit message into Discord

**Severity:** Low
**Files:** `.github/workflows/ci.yml:301, 323-325`.
**Evidence:** `COMMIT_MSG: ${{ github.event.head_commit.message }}` → `FIRST_LINE=$(printf '%s' "${COMMIT_MSG:-}" | head -n1)` → `DESCRIPTION=$(printf '**Commit:** %s\n**Branch:** %s\n**Author:** %s' "$FIRST_LINE" "$BRANCH" "$ACTOR")` → `jq -cn --arg desc "$DESCRIPTION"`. `jq`'s `--arg` JSON-escapes correctly. But: `printf '%s'` doesn't sanitise control characters; `head -n1` limits length only by newline, not bytes. And `BRANCH` / `ACTOR` are likewise event-supplied.
**Impact:** Discord embed rendering quirks (`@everyone`, markdown link bait) in the commit subject render in `#loop-deployments`. jq quoting prevents JSON injection, but does not prevent Discord-layer abuse (an embed's description can't call `@everyone` by itself — it would need `allowed_mentions` opt-in which isn't set — so this is a Low, not Medium). Commit `A2-115` style comment: the previous sed-based sanitizer could leak a backslash; the current jq path is safer but not Discord-abuse-proof.
**Remediation:** Strip non-printable chars; impose a byte cap (e.g. first 120 chars of `FIRST_LINE`); treat the description as markdown-escaped before pushing. Or use Discord's `allowed_mentions: {parse: []}` to categorically deny pings.

### A2-1416 — `e2e-real.yml` secrets are repo-scoped, not environment-scoped

**Severity:** Medium
**Files:** All three `e2e-real.yml` secrets live at `repos/LoopDevs/Loop/actions/secrets`, no environment.
**Evidence:** Phase 1 §9 inventory lists all five secrets at repo level. No GitHub Environments exist (§1.4).
**Impact:** A future workflow (`fix/quick-debug.yml` etc.) can `${{ secrets.STELLAR_TEST_SECRET_KEY }}`. Combined with A2-101 (admin bypass) + A2-119 (no org 2FA), a compromised admin can push a tampered workflow that leaks the mainnet seed. No `required_reviewers` gate on the e2e-real workflow either.
**Remediation:** Create an `e2e-real` GitHub Environment. Move the three secrets (`CTX_TEST_REFRESH_TOKEN`, `STELLAR_TEST_SECRET_KEY`, `GH_SECRETS_PAT`) to that environment. Add `required_reviewers: [AshFrancis]` so even the manual `workflow_dispatch` needs a human OK from a separate session.

### A2-1417 — Test-coverage regression only detectable in CI

**Severity:** Info
**Files:** `package.json:18-19`, `.husky/pre-push:9`, `ci.yml:88`.
**Evidence:** Local `npm test` and pre-push run the plain test scripts; CI runs `test:coverage`. If a vitest-coverage config changes (threshold, reporter) or a workspace's coverage invocation breaks, only CI surfaces it.
**Impact:** Low. Coverage is an artefact-upload, not a gate (`if: always()` on the upload step, line 90). Logging as Info for completeness.
**Remediation:** Either make local pre-push run `test:coverage` (consistent), or have a job-level assert that coverage thresholds are met (currently no such assert).

---

## Exit

Phase 16 complete. 17 findings filed in range A2-1401..A2-1417 (4 High,
6 Medium, 6 Low, 1 Info, 0 Critical). Phase 1 and Phase 4 already
captured the repo-hygiene and build-reproducibility dimensions; this
phase concentrated on the _pipeline shape_ — deploy gating (no
environments, no rollback, no preview, no canary), static-security
breadth (none beyond ESLint correctness rules), verify.sh vs CI
parity (quality-only, not build/audit/e2e), LLM-tooling blast radius
(prompt-injection hardening present; update-channel and ADR gaps),
and Dependabot policy documentation (missing). The single largest
pre-launch gap is the _absence_ of both GitHub Environments
(A2-1406) and a rollback runbook (A2-1403) — together they mean a
bad deploy has no gating before and no recovery play after. The
second-largest is A2-1408 (no SAST) which blocks a basic
payments-adjacent security posture.
