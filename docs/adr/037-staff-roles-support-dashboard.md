# ADR 037 — Staff roles + support dashboard

Status: Proposed (operator-requested 2026-06-12)
Date: 2026-06-12

## Context

The admin surface (ADR 018: ~60 endpoints, 21 web views) has a binary trust model: `users.isAdmin`
(seeded from `ADMIN_CTX_USER_IDS` on CTX upsert), gating everything behind `requireAdmin`, with
ADR 028 step-up on the three destructive money writes. Ash wants a staff dashboard usable by
customer support — people who must see a customer's full picture and unstick deliveries, but who
must not be able to move money.

## Decision

### 1. Role model: `staff_roles` table (not a column)

```sql
CREATE TABLE staff_roles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'support')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by_user_id uuid REFERENCES users(id),
  reason text
);
```

Audit-first (who granted what, when, why — ADR 017's actor-attribution pattern), future-proof
('finance', 'operator' later without migration churn). Seeded from `users.isAdmin` (one-shot in
the migration); `users.isAdmin` stays as a deprecated read-compat shim until the CTX path retires
(ADR 013 Phase C). Role grants/revocations are admin-only, step-up-gated writes with the full
ADR 017 envelope (idempotency, reason, Discord audit) — the first self-serve alternative to the
direct-SQL escalation noted in the audit.

### 2. Authorization: `requireStaff(minimum)`

`requireAdmin` becomes `requireStaff('admin')`; new `requireStaff('support')` accepts either role
(admin ⊇ support). Same 404-not-403 concealment. The resolved role is set on context for
handlers/redaction. Role changes take effect within the 15-min token TTL (same as today's
isAdmin semantics — acceptable; revocation runbook notes the window).

### 3. Permission matrix

| Capability | support | admin |
| --- | --- | --- |
| All read views (users, user-360, ledger, orders, payouts, merchants, treasury, wallet state, watcher skip rows, audit) | ✅ | ✅ |
| Delivery-unsticking actions: re-run redemption fetch for a fulfilled-null order; re-trigger wallet provisioning; re-open an abandoned watcher skip row | ✅ (audited) | ✅ |
| Money writes: credit adjustments, refunds, emissions, payout retry, cashback config, role grants | ❌ (404) | ✅ + step-up |
| Bulk CSV exports (Tier-3) and Discord-config | ❌ | ✅ |

Rationale: support's job is "find the customer, explain the state, unstick the delivery" — none
of that moves money. The three support actions are idempotent re-drives of work the customer
already paid for. CSV bulk exports stay admin-only (PII-mass surfaces; single-user views keep
full email — support needs it).

### 4. New views (support MVP, per the 2026-06-12 surface scout)

1. **User 360** — one page: profile, per-currency credits, wallet card (provider, provisioning
   state, on-chain balances, re-trigger action), last orders/payouts/transactions, links into
   every existing drill-down. Reverse lookups: order id / payment memo / Stellar address → user.
2. **Ledger browser** — paginated `credit_transactions` UI with type/date filters (endpoint
   exists; UI doesn't).
3. **Order delivery detail** — redemption status + reason, backfill attempts, watcher-skip
   linkage, re-run-redemption action.
4. **Watcher skip-row browser** — `payment_watcher_skips` list/detail (new read endpoint) with
   re-open action on abandoned rows.
5. **Role management** (admin-only) — staff list, grant/revoke with reason.
6. Shell: role-aware nav (support sees only what it can use).

### 5. Constraints inherited

ADR 018 drill-down rule (every aggregate links to a filterable detail), ADR 022/023 shape
conventions, CSV conventions for any new export, never-403 on /api/admin, openapi/parity gates,
bigint-as-string. New support actions carry the ADR 017 envelope even though they're not money
writes (uniform audit trail).

## Consequences

- The watcher-skip table and wallet provisioning state get their first read/ops surfaces —
  closing the loop on the 2026-06 fault-tolerance machinery (runbooks gain UI equivalents).
- A second role makes the A2-1609 step-up window analysis simpler, not harder: support tokens
  cannot reach step-up-gated surfaces at all.
- DSR/A4-042 note: user-360 must render deleted/anonymised users gracefully (no resurrected PII).

## Open questions

1. Per-action magnitude thresholds (4-eyes on large refunds) — deferred to ADR 028 Phase 2.
2. 'finance' role for CSV/reporting-only access — table supports it; not in scope.
