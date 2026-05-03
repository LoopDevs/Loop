# Admin Handoff

Use this file only for actions the user must take outside the repo, then ping the agent to verify.

## Workflow

1. Agent records the required operator action here.
2. User performs the change.
3. User pings the agent.
4. Agent verifies via code, config, or `gh api`/other evidence.
5. Agent updates both this file and `tracker.md`.

## Open items

1. Tighten GitHub branch protection on `main` to match the checked-in policy.
   Verify `required_status_checks.strict=true`, `dismiss_stale_reviews=true`, and `enforce_admins.enabled=true`.
   Evidence target: `gh api repos/LoopDevs/Loop/branches/main/protection` and `.../required_pull_request_reviews`.

2. Create or restore the CODEOWNERS-reviewing GitHub team and enable code-owner review enforcement.
   Current evidence shows `gh api orgs/LoopDevs/teams/engineering` returns 404 and live protection has `require_code_owner_reviews=false`.
   Evidence target: `gh api orgs/LoopDevs/teams/<team>` plus branch-protection API output after the setting change.
