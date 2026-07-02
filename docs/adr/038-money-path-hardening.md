# ADR 038 — Money-path hardening (2026-07 pass)

**Status:** Accepted (implemented 2026-07)
**Supersedes:** none — hardens ADR 009 / 015 / 016 / 036 without changing their models.

## Context

A cold, source-only re-read of the codebase (four independent reviewers,
deliberately not grounded in prior audit trackers) found that the ledger core
was well-built but a handful of judgment-dense residuals concentrated the real
risk — the kind of bugs a frontier reviewer finds and a mid-tier contributor
introduces while doing something else. This ADR records the design decisions
made fixing them, so the _why_ survives past the commit messages. The full task
list and status live in `docs/hardening-plan-2026-07.md`; the invariants they
enforce are catalogued in `docs/invariants.md`.

The unifying theme: **the ledger's correctness lived on conventions that CI
could not see**, and the repo's own merge history had already shipped money bugs
that were CI-green (a dropped step-up scope, a plaintext-storage regression, an
unbacked GBPLOOP mint two audits flagged). The fixes convert conventions into
DB constraints, CI gates, and scheduled watchers wherever possible.

## Decisions

### D1 — Emission conservation is enforced at the DB, not just the app

`applyAdminEmission` never debits the mirror (ADR 036: emission materialises the
on-chain half of an existing liability). Its only guard was per-call
`balance >= amount`, so repeated emissions each passed while cumulatively minting
unbacked LOOP. We added cumulative accounting (`mintedNet ≤ balance`) under the
existing row lock AND a `BEFORE INSERT/UPDATE` trigger
(`assert_emission_conservation`, migration 0044) enforcing the same rule against
any writer, including raw SQL.

**Why both layers:** the GBPLOOP finding is the proof that an app-layer allowlist
gets bypassed by a future writer path. The app check gives a clean 409; the
trigger is the backstop that cannot be bypassed. The trigger fires on UPDATE too
(not just INSERT) because the admin payout-retry flips `failed → pending` — an
adversarial review caught that keying only on INSERT would let _fail → re-emit
backfill → retry the original row_ double-mint.

### D2 — On-chain/off-chain reconciliation is continuous and self-healing

The asset-drift watcher (the primary unbacked-mint backstop) kept its state in
process memory — lost on restart, per-machine. We persisted it
(`asset_drift_state`, fleet-consistent, transition claims serialised via
`SELECT … FOR UPDATE`) and made page delivery **at-least-once** (a `last_paged_*`
column written only after a confirmed Discord send, re-attempted on later ticks).
The naive persisted design would have made the alert _at-most-once_ — one dropped
webhook or a SIGTERM between the state commit and the send would silence a live
money incident forever; the adversarial review caught this as a P0.

We also added a second alert dimension: terminally-`failed` burn/interest-mint
rows are counted _into_ the drift equation (the tokens/credits genuinely exist),
which makes the equation itself blind to them — so they page separately until an
operator retries. And the off-chain ledger invariant
(`balance = Σ credit_transactions`) now runs on a daily in-app watcher, not just
as an unscheduled script.

**Why in-app, not a CI cron** (for the ledger watcher): it runs where the DB is —
no tunnels, no new secrets, shared Discord plumbing — and single-flights across
machines via a Postgres advisory lock.

### D3 — Operator→CTX settlement is durably recorded and hash-idempotent

`payCtxOrder` moves real money out of Loop's custody, yet its idempotency was a
bounded Horizon memo scan over the shared deposit+operator account — a prior
payment scrolling past the window meant a retry could double-pay — and no table
recorded that Loop ever paid. We added `ctx_settlements` (one row per order, tx
hash persisted _before_ the network submit, the CF-18 pattern) and made
`payCtxOrder` converge via the authoritative `getOutboundPaymentByTxHash` point
lookup (window-immune), with the memo scan demoted to a backfilling fallback.

### D4 — The procurement crash-sweep disambiguates via the settlement record

`sweepStuckProcurement` was the one failure path that stranded a paid user
without a refund, because a crashed worker leaves "did CTX get paid?"
unanswerable from memory. The D3 settlement record answers it from durable state:
no confirmed/landed settlement → Loop never paid → auto-refund (like every
sibling path); a landed settlement → hold + page (a usable card may exist);
uncertainty → fail closed to hold.

**Why the durable-record signal, not a live CTX query** (the plan's original
sketch): cleaner, no external call, no new failure mode. **Why key on the tx
hash + authoritative lookup, not `confirmed_at`:** `confirmed_at` is written
_after_ the network submit while the hash is persisted _before_ it, so a crash
after the payment lands leaves hash-set/unconfirmed — the exact population this
sweep cleans up; keying on `confirmed_at` would double-refund a user with a
usable card. (Found as a P0 in the first draft's review.)

### D5 — Auth gates are structural, and misconfiguration fails at boot

Step-up (the gate between a stolen admin token and money movement) was enforced
by convention: the route-inventory test couldn't see the anonymous middleware,
subject-pinning silently no-op'd without an auth context. We named the middleware
(so the inventory test pins every destructive route to its scoped gate + a
default-deny rule), made subject-pinning fail closed, and added `env.ts` boot
guards so native-auth-without-a-key and production-without-the-step-up-key fail
at deploy rather than at the first request.

### D6 — Every convention that could become a gate, did

Rate-limit presence, web-route auth gating, dead env flags, the ledger-sum
invariant, property-test seed rotation — each became a CI gate or scheduled check
(see `docs/hardening-plan-2026-07.md` Track C). The dead-flag detector
immediately found ADM-01's daily emission cap orphaned by the ADR 036
withdrawal→emission re-scope — a real audit finding whose protection had silently
vanished in a merge.

## Consequences

- New DB objects: `asset_drift_state`, `ctx_settlements` tables; the
  `assert_emission_conservation` trigger; the emission daily cap.
- New watchers under `LOOP_WORKERS_ENABLED`: `ledger-invariant-watcher`.
- New CI gates (all in `npm run verify`): rate-limit inventory, web auth
  inventory, dead-flags, the integration ledger-sum assertion.
- New env: `LOOP_LEDGER_INVARIANT_INTERVAL_HOURS`,
  `DISABLE_ADMIN_STEP_UP_ENFORCEMENT`; `LOOP_ADMIN_STEP_UP_SIGNING_KEY` promoted
  to production-required.
- New knowledge artifacts: `docs/invariants.md`, `docs/threat-model.md`, and the
  `.claude/` review skills + subagents + sensitive-path hook.

The residuals deliberately left (single-submitter-per-operator leader election
A8; identity-scoped OTP counter B5; the state-not-chain conservation window) are
recorded in `docs/threat-model.md`'s accepted-risk register with revisit
triggers.
