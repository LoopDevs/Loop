# ADR 011: Admin panel for cashback configuration

Status: Accepted
Date: 2026-04-21
Implemented: 2026-04-21 onwards (`PUT /api/admin/merchant-cashback-configs/:merchantId` in admin/handler.ts; merchant_cashback_configs + merchant_cashback_config_history tables with trigger-based audit; admin panel routes under apps/web/app/routes/admin/)
Related: ADR 009 (credits ledger), ADR 010 (principal switch)

## Context

The cashback flow in ADR 010 splits CTX's per-merchant discount
three ways:

- **Wholesale** — what CTX charges Loop for the gift card.
- **User cashback** — credited to the user's Loop balance (ADR 009).
- **Loop margin** — retained as revenue.

These percentages vary per merchant and will be tuned over time as
we observe conversion, repeat rate, and cashback-balance retention.
Hard-coding them in YAML or the application image means an engineer
is in the loop for every tweak; that's a friction tax on a product
that's going to iterate constantly.

We need a minimal live-editable admin surface with an audit trail.
A full RBAC / approval-workflow system is out of scope for v1 —
this is an internal tool for a small team.

## Decision

### Schema

```sql
CREATE TABLE merchant_cashback_configs (
  merchant_id       TEXT PRIMARY KEY,             -- matches CTX merchant id
  wholesale_pct     NUMERIC(5,2) NOT NULL,        -- cost to Loop as % of face value
  user_cashback_pct NUMERIC(5,2) NOT NULL,        -- % of face value to user
  loop_margin_pct   NUMERIC(5,2) NOT NULL,        -- % of face value to Loop
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by        TEXT NOT NULL,                -- admin user email / id
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (wholesale_pct + user_cashback_pct + loop_margin_pct <= 100),
  CHECK (wholesale_pct >= 0 AND user_cashback_pct >= 0 AND loop_margin_pct >= 0)
);

CREATE TABLE merchant_cashback_config_history (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id       TEXT NOT NULL,
  wholesale_pct     NUMERIC(5,2) NOT NULL,
  user_cashback_pct NUMERIC(5,2) NOT NULL,
  loop_margin_pct   NUMERIC(5,2) NOT NULL,
  active            BOOLEAN NOT NULL,
  changed_by        TEXT NOT NULL,
  changed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Every update to `merchant_cashback_configs` writes the previous row
into `_history` via a trigger, so we have the full audit trail
without building version-control-like UX.

### Admin role

A single boolean on `users`:

```sql
ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE;
```

Granted manually by a core engineer — no self-service. Backend gates
all admin endpoints on `is_admin = true` on the authenticated user.

### Admin route

- `/admin/cashback` — React Router route, admin-only via the normal
  session guard plus an `is_admin` check.
- Table UI: one row per merchant, inline edit for the three
  percentages + active toggle, Save per row.
- Validation: client-side enforces the three-percentages sum
  constraint and non-negative values, matching the CHECK constraint.
- Audit column surfaces `updated_by` and `updated_at` so recent
  changes are visible at a glance. Full history is a nested
  "view history" popover that queries `_history`.

### Pinning policy (referenced from ADR 010)

The admin panel configures cashback **forward only**. Orders in
`awaiting_payment` or later already pin their cashback / margin
amounts into the order row — a config change doesn't retroactively
recalculate them. This makes the admin safe to use without
coordination: an engineer updating a merchant's split at 09:00
doesn't have to worry about in-flight orders from 08:59.

### Default on catalog sync

New merchants showing up from CTX's merchant-sync without an
explicit admin-set config get a sensible default: 80% of CTX's
discount to the user, 20% to Loop. Admins can retune later. The
default is configured as environment variables
`DEFAULT_USER_CASHBACK_PCT_OF_CTX` + `DEFAULT_LOOP_MARGIN_PCT_OF_CTX`
so we can change it without re-deploying the app.

## Alternatives considered

1. **Hard-coded config in a YAML file.** Rejected — requires an
   engineer + deploy for every tweak.
2. **Full RBAC with role tables, permissions, approval workflows.**
   Rejected as over-engineered for a small internal team. Easy to
   add later if/when the team grows.
3. **Versioned configs with scheduled "go-live" times and rollback
   UI.** Rejected as v1 overhead. The audit history gives us a manual
   rollback path.
4. **Store the config in the `merchants` table itself.** Rejected —
   merchants come from CTX sync and would be repeatedly overwritten
   on sync unless we're careful. Separate table is cleaner.

## Consequences

- Admin surface is a new authenticated attack surface. Gating on
  `is_admin` plus existing session protections is sufficient for v1
  given the team size, but warrants a periodic audit.
- History table grows ~linearly with edit volume. At ~100 merchants
  with weekly tuning, ~5k rows/year. Prunable if ever needed.
- Schema CHECK constraint prevents bad data at write time; the
  client validation is belt-and-braces.
- Default split is environment-configured, so we can tune the
  onboarding curve for new merchants without shipping.

## References

- ADR 009 for the ledger that consumes the cashback_amount_minor.
- ADR 010 for how the config is read at order creation and pinned
  onto the order row.
