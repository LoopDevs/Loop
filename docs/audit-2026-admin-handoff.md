# Audit-2026 — operator handoff

Findings from `docs/audit-2026-tracker.md` that require **operator-side
action** (GitHub UI / org settings / personal account) and cannot be
fixed by an agent in code.

## Workflow

1. Operator flips the setting per the row's "What to flip".
2. Operator pings the agent: "A2-XXX done".
3. Agent verifies via `gh api` (where possible) that the change took
   effect.
4. Agent flips the matching tracker row to `~~resolved-pending-review~~`
   with the verification command + output captured inline.

## Repo settings (`Settings → ...` on `LoopDevs/Loop`)

### Branch protection (`Settings → Branches → main`)

| ID     | Severity | Flip                                                         | Verify                                                                                                        |
| ------ | -------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| A2-101 | High     | Require ≥1 approving review on `main`. Disable admin bypass. | `gh api repos/LoopDevs/Loop/branches/main/protection \| jq '.required_pull_request_reviews, .enforce_admins'` |
| A2-102 | Medium   | Enable "Require signed commits" on `main`.                   | `gh api repos/LoopDevs/Loop/branches/main/protection \| jq '.required_signatures.enabled'`                    |

### Security (`Settings → Code security and analysis`)

| ID     | Severity | Flip                                                                                                        | Verify                                                      |
| ------ | -------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| A2-105 | High     | Enable Secret scanning, Push protection, Dependabot alerts. (Repo-level minimum; org-level is a follow-up.) | `gh api repos/LoopDevs/Loop \| jq '.security_and_analysis'` |

### Actions / Marketplace (`Settings → Actions → General`)

| ID     | Severity | Flip                                                                                                                                                                                   | Verify                                                                                           |
| ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A2-117 | Info     | Replace "Allow all actions" with "Allow select actions and reusable workflows" + the curated allowlist (GitHub-owned, `superfly/*`, Anthropic actions, `softprops/action-gh-release`). | `gh api repos/LoopDevs/Loop/actions/permissions \| jq '.allowed_actions, .enabled_repositories'` |

### Merge modes (`Settings → General → Merge button`)

| ID     | Severity | Flip                                                                                                                                           | Verify                                                                                             |
| ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A2-123 | Low      | Disable "Allow merge commits" + "Allow rebase merging". Keep only "Allow squash merging" (matches the squash-only convention in CONTRIBUTING). | `gh api repos/LoopDevs/Loop \| jq '.allow_merge_commit, .allow_rebase_merge, .allow_squash_merge'` |

### Environments (`Settings → Environments`)

| ID      | Severity | Flip                                                                                                                                                                                                                                                                                                                                            | Verify                                                                 |
| ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| A2-1406 | High     | Create a `production` Environment with at least one required reviewer. Move `FLY_API_TOKEN` (prod) from repo secrets into the production environment's secrets. Reference the environment from `.github/workflows/deploy.yml` (`environment: production`). Workflow wiring is the agent's job after the env exists — it needs `workflow` scope. | `gh api repos/LoopDevs/Loop/environments \| jq '.environments[].name'` |

## Org settings (`https://github.com/organizations/LoopDevs/settings`)

| ID     | Severity     | Flip                                                                                                                                                                                                                          | Verify                                                                                      |
| ------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A2-103 | High         | Create the `engineering` team referenced by `.github/CODEOWNERS` (`@LoopDevs/engineering`). Add the maintainer(s) as members. Until this exists, GitHub silently drops the CODEOWNERS rules and required-reviews never fires. | `gh api orgs/LoopDevs/teams/engineering \| jq '.slug'` (returns `engineering` once created) |
| A2-119 | **Critical** | Enforce 2FA org-wide. Audit member roles — both members are admins; one should be regular member or repo-scoped collaborator if possible.                                                                                     | `gh api orgs/LoopDevs \| jq '.two_factor_requirement_enabled'` (must be `true`)             |
| A2-120 | Medium       | Upgrade to GitHub Enterprise Cloud (or note the deferral) so audit-log retention exceeds 90 days. Free plan keeps no audit log beyond ~90 days.                                                                               | Confirm in org billing page that plan is EC. No `gh api` flag exposes this directly.        |

## Operator account (`Settings → SSH and GPG keys` on the account)

| ID     | Severity | Flip                                                                                                                                                                      | Verify                                                                   |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| A2-121 | Medium   | Remove the stale `stellarspendtest server` SSH key from the account that owns it. Identify by creation date / fingerprint from the audit evidence file.                   | `gh api user/keys --paginate \| jq -r '.[].title'` — confirm key absent. |
| A2-122 | Low      | Each push-capable member uploads at least one GPG public key. Required if A2-102 (signed commits) is enabled — without it, no member can push to `main` after the toggle. | `gh api /user/gpg_keys \| jq 'length'` per-member; should be ≥ 1.        |

## Code-of-conduct artifacts (small repo edits the agent will land)

| ID     | Severity | Flip                                                                                                                                                                                                                             | Verify                                                 |
| ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| A2-113 | Low      | Audit found PR template is decorative. Either keep + simplify (single required field), or delete in favour of CODEOWNERS-driven review comments. **Operator decision required** — agent will land whichever direction is chosen. | Manual — review the next 5 PRs after the change.       |
| A2-118 | Info     | Org webhook inventory not visible at audit time. Operator confirms either (a) zero webhooks, or (b) lists them so agent can document each + scope.                                                                               | `gh api orgs/LoopDevs/hooks` — operator pastes output. |
| A2-126 | Low      | Decide whether to add `.github/ISSUE_TEMPLATE/`. Default for a pre-launch single-team repo is "no" (issues mostly come from internal Linear). Operator picks; agent lands the chosen artifacts.                                  | Manual.                                                |

## Workflow-scoped items (now unblocked — agent can land)

These need `.github/workflows/*` edits which previously hit OAuth `workflow`-scope restrictions. The user has confirmed the scope is granted; the agent will land each in a focused PR.

| ID      | Severity | Plan                                                                                                                                                              |
| ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2-107  | Medium   | Add server-side commitlint check to `.github/workflows/ci.yml` (commit-msg lint job).                                                                             |
| A2-1401 | Medium   | Mirror `verify.sh` parity — the script runs typecheck/lint/test/docs but not `audit/build/e2e`. Add the missing steps or document why they're CI-only.            |
| A2-1402 | Medium   | Pre-push runs `npm test` + `lint-docs.sh` but not `verify` or `npm audit`. Bring it to parity.                                                                    |
| A2-1403 | High     | Add a rollback runbook + CI-cron rehearsal job. Pairs with Phase-17 operational items.                                                                            |
| A2-1404 | High     | Wire preview / per-PR ephemeral environments via Fly.io machines or a `vercel preview` branch deploy. Choose one rail; the agent will land config + workflow.     |
| A2-1405 | Medium   | Document canary / blue-green deploy in `docs/deployment.md`. Workflow gain depends on Fly.io's machine-replace strategy.                                          |
| A2-1407 | Medium   | Add `release-please` (or `changesets`) workflow so version bumps + tags are generated rather than hand-typed.                                                     |
| A2-1408 | High     | Add `semgrep` (or `eslint-plugin-security`) to the Quality CI job. Pin a SHA + a baseline file. Plan: SAST pass first, fix-or-suppress, then promote to required. |
| A2-1409 | Medium   | Document the `release_command` migration-vs-deploy ordering in `docs/deployment.md`. Already wired in `fly.toml`; this is the doc gap.                            |
| A2-1412 | Medium   | Add `@anthropic-ai/claude-code` to the Dependabot scope so its updates land via the same PR pipe.                                                                 |
| A2-1416 | Medium   | Move the e2e-real Stellar seed + `GH_SECRETS_PAT` from repo-scoped secrets to the new `production` GitHub Environment (depends on A2-1406 above).                 |

## Out of scope for this handoff

The remaining ~30 unresolved items are real code work that the agent will continue to land in batched PRs under the audit-2026 batch-mode rules: ledger / payments / auth / observability / runbooks / e2e infra / step-up auth.
