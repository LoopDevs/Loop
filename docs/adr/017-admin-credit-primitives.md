# ADR 017: Admin credit primitives (writes)

Status: Proposed
Date: 2026-04-22
Related: ADR 009 (credits ledger), ADR 011 (admin panel), ADR 015 (stablecoins), ADR 018 (Discord operational visibility)

## Context

The admin panel currently has a wide read surface — treasury
snapshot, payouts backlog, orders drill-down, per-user credit
balance, per-user credit-transaction log, merchant-stats,
cashback-activity time-series, CSV exports. Every row an admin
sees is read-only.

Two work items (already informally scoped by ops) are write
operations and don't yet have endpoints:

- **Credit adjustment.** A user reports "your logs show I was due
  £4.20 cashback but my balance is £4.00". Ops confirms from the
  order + the cashback-config history, then credits £0.20 as an
  `adjustment` ledger row. Currently this requires a DB console.
- **Manual withdrawal / refund.** Ops processes a support-mediated
  withdrawal or a goodwill refund as a negative-signed ledger
  movement.

There's also a third, narrower action already implemented:

- **Retry failed payout** (`POST /api/admin/payouts/:id/retry` —
  landed with ADR 015).

These three share the same cross-cutting concerns: actor identity,
idempotency, audit trail, reversibility, and operational visibility.
Rather than let each endpoint solve them independently and drift,
this ADR pins the primitives once.

## Decision

Every admin write endpoint MUST satisfy five invariants. They're
listed in order of the loudest failure mode each addresses.

### 1. Actor identity is pinned from `requireAdmin`, never the body

The `requireAdmin` middleware already resolves the admin user row
and attaches it to `c.get('adminUser')`. Write handlers read from
that context and write `actor_user_id` into the ledger, **not** from
a body field. This guarantees a leaked admin token can't be used to
masquerade as a different admin — every row traces to the auth'd
caller regardless of request shape.

### 2. Idempotency via `Idempotency-Key` header

Every write accepts an `Idempotency-Key` request header (UUID or
opaque 16–128 char string). The server stores `(admin_user_id, key)
→ response_snapshot` in an `admin_idempotency_keys` table with a
24h TTL. On a repeat POST with the same `(admin_user_id, key)`, the
stored response is replayed — same status, same body, **no** side
effects repeated.

Scope of the key: `(admin_user_id, key)` rather than global `(key)`
— two admins accidentally reusing the same key should produce
independent rows. Missing header = the endpoint rejects with 400
`IDEMPOTENCY_KEY_REQUIRED`, so there's no silent footgun where a
retry from a double-click double-credits a user.

### 3. Reason required on every write

Every mutation carries a free-text `reason` field in the body (2–500
chars). It's stored verbatim on the corresponding ledger row or
audit record. The admin UI renders it in the history view. When
finance or a regulator asks "why was this adjustment made?", the
answer is in the row, not in Slack scrollback.

Rejecting an empty reason is a body-validation 400, emitted before
any DB write.

### 4. Reversibility — never `UPDATE` ledger history, always append

All ledger mutations are inserts into `credit_transactions` (positive
or negative `amount_minor`). We never `UPDATE` a prior row to "fix"
a past credit. A correction of a previous adjustment is a second
adjustment that carries a `reference_type = 'reverses'` pointer and
a `reference_id = <original_credit_transaction_id>`, plus a reason
referencing the original.

The balance in `user_credits.balance_minor` is replayable from the
ledger rows in chronological order. An auditor reconstructing a
user's balance history shouldn't need to cross-reference an "edit
log" — the ledger is the log.

### 5. Operational visibility — every write hits Discord

Every successful admin write emits a Discord message to
`#loop-admin-audit` with the actor's truncated id (last 8 chars),
the endpoint, the user/order affected, the amount (if applicable),
and the reason. Fire-and-forget, AFTER the DB commit, so a failed
Discord post never aborts the write. See ADR 018 for taxonomy.

## Response shape

All admin write endpoints return the same envelope:

```
{
  "result": { <endpoint-specific view> },
  "audit": {
    "actorUserId": "<uuid>",
    "actorEmail": "<string>",
    "idempotencyKey": "<echoed>",
    "appliedAt": "<iso-8601>",
    "replayed": <boolean>
  }
}
```

`replayed: true` when the response came from the idempotency store.
The envelope is uniform across credit-adjustment, manual-payout,
refund, etc., so an admin UI can render the "your action was
applied" confirmation without branching on the endpoint.

## What this means for the existing retry endpoint

`POST /api/admin/payouts/:id/retry` predates this ADR and violates
#2, #3, and #5. A follow-up slice brings it into compliance — same
envelope, same headers, same Discord fanout — as a non-breaking
additive change (the current 200 body becomes the `result` field).

**Status:** Landed. Retry endpoint now requires `Idempotency-Key`
header + `reason` body, returns `{ result, audit }`, and fires the
Discord audit. Admin UI clients must send both on every retry click.

## Consequences

**Good.** Every future admin write inherits idempotency,
auditability, and operational visibility for free. A leaked admin
token produces noise in Discord, not silent ledger drift.
Reconstructing "what happened?" from cold starts at the ledger, not
at cross-referenced tables.

**Cost.** One extra table (`admin_idempotency_keys`) with a nightly
cleanup. One `reason` field on every write. One Discord webhook
call on every write (fire-and-forget, commit-independent).

**What this ADR does NOT cover.**

- Admin _reads_ (pattern is settled — see the stack of
  `/api/admin/*` GET endpoints landed since ADR 009).
- Admin _config_ writes (cashback-config upsert already landed via
  ADR 011 + its own history-tracking pattern; this ADR pins the
  pattern for _user-facing money movements_).
- Four-eyes / two-admin approval workflows. Every admin write in
  the MVP scope is single-actor. The envelope is designed so a
  future "pending approval" state fits without a breaking change —
  `audit.appliedAt` becomes nullable with a pending state — but
  that's out of scope here.
