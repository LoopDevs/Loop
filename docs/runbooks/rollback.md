# Runbook · Rollback

## Symptom

A deploy went out and shortly after — within minutes — one of the
following:

- `#ops-alerts` is firing on a surface that was healthy pre-deploy.
- The error rate / latency on `api.loopfinance.io` jumped past its SLO
  ceiling (`docs/slo.md`).
- A user-blocking bug shipped (orders failing, auth refusing valid
  credentials, admin writes 500ing).

The trigger window for "roll back" vs "roll forward" is approximately
10 minutes after deploy. Beyond that, customer state has usually
moved enough that a rollback would itself cause data issues — go
forward instead.

## Severity

- **P0**: rollback within 10 minutes of deploy if customer-facing flow
  is broken. Don't write the post-mortem yet; stop the bleed first.
- **P1**: rollback within 60 minutes of deploy for partial degradation
  (some users, some endpoints).
- **P2+**: roll forward — fix forward; the rollback risks more than
  the in-place fix.

## Diagnosis

1. **Confirm the deploy is the cause.** A coincident upstream incident
   can look like a deploy regression — check the breaker state
   (`/health`) and `#ops-alerts` for non-deploy-related alerts before
   rolling back.
2. **Identify the specific release to roll back.**
   ```bash
   fly releases list -a loopfinance-api  # backend
   fly releases list -a loop-web          # web
   ```
   The most recent release is the bad one; the one before is the
   target. Note their **image** identifiers (`registry.fly.io/...:deployment-XXX`).

## Mitigation

### Backend rollback

```bash
# Find the prior release's image (column "Tag" or "Build" depending on
# Fly version)
PRIOR=$(fly releases list -a loopfinance-api -j | jq -r '.[1].imageRef')

# Re-deploy that image — Fly skips the image build, so it's fast (~30s)
fly deploy --image $PRIOR -a loopfinance-api
```

If the bad deploy included a **migration**, the rollback is more
careful — see "Migration rollback" below.

### Web rollback

Same shape:

```bash
PRIOR=$(fly releases list -a loop-web -j | jq -r '.[1].imageRef')
fly deploy --image $PRIOR -a loop-web
```

The web app is stateless (no DB writes), so this is always safe.

### Migration rollback

A backend deploy includes a one-shot release machine that runs
`apps/backend/dist/migrate-cli.js` (Drizzle) before the new version
takes traffic — A2-407. If the rollback target predates a migration
that already ran, the **DB schema is ahead of the code**.

Two options, in order of preference:

1. **Roll forward** — write a hot-fix that's compatible with the
   already-applied migration. This is the right move for any
   non-trivial schema change. Take the latency hit; ship it forward.
2. **Manually revert the migration first**: read the migration's UP
   block, write the inverse as a one-shot SQL, run it, then deploy
   the prior image. This is risky — the migration's metadata table
   still has the row, so a future re-deploy of the post-migration
   code would skip re-running. Only do this for a migration you can
   trivially invert (column rename, index add, default change). Not
   for a `DROP COLUMN` or data-migrating UPDATE.

Post in `#deployments` either way: "Rolled back loopfinance-api to
`<prior-image-tag>` at `<timestamp>`. Migration: `[reverted | left
in place | non-applicable]`."

## Resolution

After rollback:

1. **Verify** the surface is healthy again (`/health`, `#ops-alerts`,
   spot-check the broken flow).
2. **Disable the bad change** in the source branch — revert the
   commit, push, open a PR with the `revert:` prefix. Don't merge it
   until the regression is understood; the revert is the holding
   pattern.
3. **Investigate** the regression. Reproduce locally, write a test,
   re-deploy with the fix.

## Quarterly rehearsal (A2-1403)

We rehearse this rollback flow **every 90 days**, in a low-stakes
window:

- Pick a no-op deploy (a doc-only PR that touched the backend's
  Dockerfile context — typically a comment edit) so a rollback
  doesn't actually undo functionality.
- Time the rollback end-to-end: the goal is "first user-visible
  recovery in <90 seconds from `fly deploy --image` start." If it
  takes longer, the runbook drifted; update it.
- Post in `#deployments` with the rehearsal log (date, target SHA,
  timing, anything that broke). The post is the audit trail this
  finding tracks.

The first scheduled rehearsal post-merge of this runbook is in the
team calendar; subsequent rehearsals roll on the same 90-day cadence.

## Post-mortem

Always for any prod rollback. Capture:

- What shipped that broke. Link the merged PR + the diff.
- How fast the regression was detected. Was the alert wired or did
  a customer report it first?
- Why CI didn't catch it. Add the missing test before re-deploying.
- Whether the rollback itself worked cleanly. Update this runbook if
  not.

## References

- A2-407 — migration ordering invariant.
- `docs/deployment.md` — the deploy command + Fly config.
- `fly releases list` and `fly deploy --image` are the only two Fly
  commands needed for a typical rollback.
