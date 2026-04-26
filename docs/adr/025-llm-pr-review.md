# ADR 025: LLM-assisted PR review (PR diffs sent to Anthropic)

Status: Accepted
Date: 2026-04-26
Resolves: A2-1413

## Context

`.github/workflows/pr-review.yml` runs a "Claude PR Review" job on
every non-draft PR. The job posts the PR diff to Anthropic's API
(`@anthropic-ai/claude-code`, pinned by SHA + version per audit
A-031) and writes the review back as a PR comment.

A2-1413 flagged that the practice was undocumented — sending source
diffs to a third-party LLM is a non-trivial decision, and the lack of
a written stance left a future contributor unable to tell whether
the action was a deliberate trade-off or stale tooling that crept in.

This ADR pins the decision so the next reviewer landing on
`pr-review.yml` knows the contract.

## Decision

**Loop sends PR diffs to Anthropic for review.** Concretely:

- `pull_request` events of types `[opened, synchronize]` trigger the
  job. Draft PRs are excluded.
- The runner clones the repo with `fetch-depth: 0` so the action can
  read the full diff against `base.sha`.
- `@anthropic-ai/claude-code@<pinned-version>` is invoked with
  `ANTHROPIC_API_KEY` (a Fly-managed Actions secret) and posts a
  comment back to the PR via `GITHUB_TOKEN`.
- The bot **comments only** — it cannot approve, request changes, or
  merge. Required-status-checks (Quality / Unit / Security audit /
  Build / E2E mocked) are independent and remain the only merge gate.
- The bot's comments are advisory. Authors are not required to
  address them.

## What this exposes

Anthropic receives:

- The full PR diff at `opened` and at every `synchronize` push.
- Repository-tree context the action chooses to read while reviewing
  (the action runs `gh pr diff` and may shell out to read other
  files in the checked-out tree to ground its comments).
- Commit metadata: the PR title, body, and the author's GitHub
  handle (passed via the API call's `prNumber` / `GH_TOKEN`).

What Anthropic does **not** receive:

- Production secrets — the runner's secrets (`ANTHROPIC_API_KEY`,
  `GITHUB_TOKEN`, etc.) are not in the diff.
- Database state, ledger rows, user PII — none of this lives in the
  source tree or in PR-author bodies.
- Customer data — same.

The repo is now public (per A2-105 closure), so the diff contents
are not in any meaningful sense "leaked": they are already
world-readable on GitHub. The novelty here is _what gets shipped to
Anthropic specifically_ and the possibility that Anthropic retains
or trains on the data.

## Why this is acceptable for Phase 1

1. **Repo is public.** Diffs are world-readable from `github.com`
   already. Sending them to Anthropic doesn't widen the disclosure
   surface for the _content_ — it only adds Anthropic as a
   downstream processor.
2. **Anthropic's data-handling.** Per Anthropic's published policy,
   API traffic isn't used for model training by default (subject to
   the API ToS in effect at any given time). The pinned action
   version + the explicit `ANTHROPIC_API_KEY` mean we're using the
   API surface, not the consumer ChatGPT-equivalent.
3. **Bot is comment-only.** The blast radius of a misbehaving review
   is "an LLM left a wrong comment" — not "an LLM merged something
   it shouldn't have." Required-status-checks are humans + CI, not
   the LLM.
4. **The job pulls real value.** Reviews catch obvious-on-reread
   issues that a tired author ships through. The cost-benefit
   skews favourable as long as (1) and (3) hold.

## What would invalidate this

- **Repo goes back to private.** If Loop re-archives a private fork
  or any private repo adopts this workflow, the calculus changes —
  diff contents are no longer world-readable, so Anthropic becomes
  a meaningful disclosure surface. Re-evaluate.
- **The bot gains write authority.** If we ever wire the LLM to
  approve / merge / push, the comment-only safety argument fails.
  Don't do this without a follow-up ADR.
- **Anthropic's data-handling policy materially changes.** If the
  API ToS shifts to default-on training-on-customer-data, the
  decision needs re-evaluation.
- **Loop starts handling regulated PII** (e.g. KYC docs in source).
  Source-tree-only-no-PII is an explicit invariant of the setup; if
  it breaks the ADR breaks too.

## Operator runbook

- The action's API key lives in 1Password ("Loop · Anthropic API
  key") and is set as the `ANTHROPIC_API_KEY` GitHub Actions secret.
- To rotate: revoke at Anthropic console → mint new → update Actions
  secret + 1Password.
- To disable temporarily during an investigation:
  `gh workflow disable "Claude PR Review" --repo LoopDevs/Loop`.
- The pinned `@anthropic-ai/claude-code@2.1.114` (or current pin) is
  the sole package the action installs; bumping it is a deliberate
  PR like any other dep update.

## References

- `.github/workflows/pr-review.yml` — the workflow itself.
- A2-1413 — the audit finding this ADR resolves.
- A2-105 — repo went public; that closure is what makes this ADR's
  Phase-1 stance defensible.
- A-031 — the Claude Code CLI is SHA-pinned (predecessor finding).
