# Phase 1 — Governance & Repo Hygiene

- Capture date: 2026-04-29
- Commit audited: `761107214e436613a7fbbe4e91e82d197c521f71`
- Auditor: Codex
- Phase status: in-progress

## Evidence

- Live branch protection: [artifacts/branch-protection.json](./artifacts/branch-protection.json)
- Live PR review settings: [artifacts/required-pull-request-reviews.json](./artifacts/required-pull-request-reviews.json)
- CODEOWNERS team lookup failure: [artifacts/codeowners-team.stderr](./artifacts/codeowners-team.stderr)
- Checked-in policy claims: [artifacts/docs-claims.txt](./artifacts/docs-claims.txt)

## Findings logged

- `A3-001` High — live branch protection is weaker than the checked-in policy claims: `required_status_checks.strict=false` and `dismiss_stale_reviews=false`, while `AGENTS.md` and `docs/standards.md` both say stale reviews dismiss on new commits and present the branch as mechanically protected.
- `A3-002` Medium — the CODEOWNERS reviewer group is not enforceable in practice: `.github/CODEOWNERS` points at `@LoopDevs/engineering`, the GitHub API lookup for that team returns 404, and `require_code_owner_reviews=false` on `main`.

## Notes

- Passing status checks, force-push disablement, and branch deletion disablement are live on `main`.
- Governance review is still open; this note only records the first verified gaps.
