# NS-04 — Runtime rail kill/halt switches (DESIGN)

**Status:** DESIGN / PROPOSAL — NOT shipped. No migration generated.
**Date:** 2026-07-15
**Audit ref:** NS-04
**Scope:** deposit / payout / vault / refund rails
**Owner decision required:** migration apply + halt policy (see §5)

> This document is a design + a safe (non-migration) scaffold. It does
> NOT add a migration, does NOT run drizzle, and does NOT wire enforcement
> into any live rail. The proposed SQL below is a fenced block for review;
> it is intentionally not in `apps/backend/src/db/migrations/`. The final
> migration, the halt policy, and the enforcement wiring are the human's
> calls.

---

## 1. Problem

The four money-moving rails have **no runtime halt**. Today the only
levers are coarse boot flags that require a redeploy (or a Fly-secret
flip + rolling restart) and are not per-rail:

- `LOOP_WORKERS_ENABLED` (`apps/backend/src/env/sections/infra.ts:171`)
  — master off-switch for ALL scheduled workers (payment-watcher +
  procurement + payout + sweeps). Too blunt: can't halt only deposits.
- `LOOP_VAULTS_ENABLED` (`infra.ts:182`) — vault subsystem master switch,
  read at boot into the frozen `env`.
- `LOOP_DEPOSIT_REFUND_AUTO` (`infra.ts:207`) — gates the auto-refund
  sweep only, not the whole refund rail.

The existing **runtime** kill switches (A2-1907,
`apps/backend/src/kill-switches.ts`) DO flip live without a redeploy, but
they cover a different set of subsystems — `orders-legacy`, `orders-loop`,
`auth`, `emissions` — driven by `LOOP_KILL_*` Fly secrets read from
`process.env` at call time. They do **not** cover deposit, payout (except
indirectly: the payout worker skips `kind='emission'` rows when
`isKilled('emissions')` at `payout-worker.ts:251`), vault, or refund as
distinct rails, and they are operated by editing Fly secrets rather than
an admin API.

**CFG-06 precedent (important for the fail-closed decision).** Commit
`492306d2` (2026-07-13, `Audit-Finding: CFG-06`) added a purpose-built
`killSwitchBoolean` parser at
`apps/backend/src/env/sections/infra.ts:26-31` so a mistyped kill-switch
value **fails CLOSED (engaged)** at boot instead of throwing. The runtime
authority `isKilled()` (`kill-switches.ts:87-110`, A4-047) applies the
same rule: recognised truthy → engaged, recognised falsy → open, anything
else → warn-once + **fail CLOSED**. NS-04's durable switch should inherit
this posture on a store-read error (see §5, Q6).

**Goal.** A durable, per-rail, admin-toggleable halt: an admin halts or
resumes a single rail without a redeploy, and each rail's entry point
rejects new work while its switch is halted.

---

## 2. Design overview

- **Durable state:** a new `rail_kill_switches` table — one row per rail,
  `halted` boolean, default `false`. Source of truth for both enforcement
  and the admin UI. (§3)
- **Admin API:** `GET` list + `POST halt` / `POST resume` under
  `/api/admin/rails/*`, gated by `requireStaff('admin')` + ADR-028
  step-up, audited via the ADR-017 idempotency store + Discord fanout. (§4)
- **Enforcement:** at each rail's single entry chokepoint, call
  `assertRailNotHalted(service, rail)` before doing new work; translate a
  halt into the surface's natural shape (503 for HTTP, no-op early return
  for a worker tick so queued rows re-drain on resume). (§5)
- **Service abstraction:** `KillSwitchService` interface (read + write),
  a `DbKillSwitchService` (later PR) backed by the table, and an
  `assertRailNotHalted` enforcement helper. Scaffolded here as types +
  interface + an UNWIRED placeholder (§6).

Deliberately kept SEPARATE from `kill-switches.ts`: that module is
env/secret-driven and its `KillSwitch` union names env subsystems; NS-04
is DB-driven and its `Rail` union names rails. Overloading one module
would conflate two operational models (Fly-secret flip vs. admin API).

---

## 3. Durable switch state (proposed migration — DO NOT APPLY YET)

Proposed as **migration `0071_rail_kill_switches.sql`** (current head is
`0070_users_token_version.sql`). It must be applied later, serialized
into the single migration spine — the exact number depends on what else
lands first, hence "0071+". Drizzle schema goes in a new
`apps/backend/src/db/schema/ops.ts` (or `admin.ts`) module and is
re-exported from the `schema.ts` barrel.

```sql
-- 0071_rail_kill_switches.sql  (NS-04 — PROPOSED; not yet applied)
--
-- Durable, admin-toggleable runtime halt for the four money rails
-- (deposit / payout / vault / refund). One row per rail. `halted`
-- defaults FALSE — the default state is "not halted" (a protected
-- class; see the NS-04 design doc §5). Enforcement reads this table at
-- each rail's entry point; the admin API (halt/resume/list) is the only
-- writer. Distinct from the env/secret kill switches in kill-switches.ts.
--
-- Idempotent CREATE/INSERT so a partial-apply rerun is safe. Rolled back
-- via `DROP TABLE rail_kill_switches`.
CREATE TABLE IF NOT EXISTS "rail_kill_switches" (
  "rail"          text PRIMARY KEY NOT NULL,
  "halted"        boolean NOT NULL DEFAULT false,
  "reason"        text,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
  "updated_at"    timestamp with time zone NOT NULL DEFAULT now(),
  -- Only the four known rails may exist.
  CONSTRAINT "rail_kill_switches_rail_known"
    CHECK ("rail" IN ('deposit', 'payout', 'vault', 'refund')),
  -- A halted switch must carry who + why (audit completeness). An open
  -- switch may retain them from the last toggle, or be null at seed.
  CONSTRAINT "rail_kill_switches_halted_has_reason"
    CHECK ("halted" = false OR ("reason" IS NOT NULL AND "actor_user_id" IS NOT NULL))
);

-- Seed all four rails OPEN so enforcement always finds a row and the
-- default is unambiguously "not halted". A missing row must ALSO be
-- treated as "not halted" by enforcement reads (belt-and-suspenders),
-- but the seed keeps the list endpoint complete from day one.
INSERT INTO "rail_kill_switches" ("rail", "halted") VALUES
  ('deposit', false),
  ('payout',  false),
  ('vault',   false),
  ('refund',  false)
ON CONFLICT ("rail") DO NOTHING;
```

Notes:

- `text` PK on `rail` matches the small-enum-table idiom already used
  (`admin_step_up_consumptions.jti`, `user_favorite_merchants` composite
  PK). The `CHECK` pins the domain to the four rails.
- No separate history table is proposed here; every toggle already lands
  in the ADR-017 `admin_idempotency_keys` audit store (§4). Whether to add
  a dedicated append-only `rail_kill_switch_events` history is a policy
  question (§5, Q5).
- `updated_at` is sufficient for "when did the current state begin". If
  the UI needs "halted since / resumed at" independently, add
  `halted_at` / `resumed_at`; deferred pending the UI spec.

---

## 4. Admin API surface

Mirror the canonical audited-admin-write stack at
`apps/backend/src/routes/admin-credit-writes.ts:49` (rate-limit →
`requireStaff('admin')` → `requireAdminStepUp(scope)` → handler using
`withIdempotencyGuard` + `buildAuditEnvelope` + `notifyAdminAudit`).
Mount a new `mountAdminRailsRoutes(app)` factory under the `/api/admin/*`
blanket (which already applies `requireAuth` + `requireStaff('support')`

- read-audit — `apps/backend/src/routes/admin.ts:132-223`).

| Method + path                        | AuthZ                   | Step-up                                      | Idempotent + audited |
| ------------------------------------ | ----------------------- | -------------------------------------------- | -------------------- |
| `GET /api/admin/rails/kill-switches` | `requireStaff('admin')` | no (read)                                    | read-audit only      |
| `POST /api/admin/rails/:rail/halt`   | `requireStaff('admin')` | `requireAdminStepUp('rail-halt')`            | yes                  |
| `POST /api/admin/rails/:rail/resume` | `requireStaff('admin')` | `requireAdminStepUp('rail-resume')` (see Q3) | yes                  |

- **New step-up scope(s)** to add to `STEP_UP_SCOPES`
  (`apps/backend/src/auth/admin-step-up.ts:79`): `'rail-halt'` and
  (pending Q3) `'rail-resume'`. This is a destructive, money-flow-halting
  action — it belongs in the ADR-028 set alongside `withdrawal`,
  `refund`, `payout-compensation`.
- **Request body:** `{ reason: string, idempotencyKey: string }`. `reason`
  is required (the halted-has-reason CHECK enforces it at the DB too).
- **Handler flow (halt):** `withIdempotencyGuard({ adminUserId, key,
method, path }, doWrite)` where `doWrite` UPSERTs the row
  (`halted=true`, reason, actor) and returns `buildAuditEnvelope(...)`;
  then `notifyAdminAudit({ actorUserId, endpoint, reason, idempotencyKey,
replayed })` after commit (`apps/backend/src/discord/admin-audit.ts:49`).
- **Response when a rail is halted (enforcement side):** HTTP surfaces
  return `503 { code: 'RAIL_HALTED', message: '<rail> is temporarily
halted — retry shortly' }`, matching the existing
  `SUBSYSTEM_DISABLED` 503 shape from `middleware/kill-switch.ts` so web +
  mobile already render it as a transient retry.
- **Docs parity:** `scripts/lint-docs.sh` cross-checks `'/api/...'`
  literals in `app.ts` / `routes/*.ts` against `architecture.md` — the new
  routes must be added to `architecture.md` when they land (not in this
  design PR, which registers no routes).

---

## 5. Enforcement points (where each rail must check the switch)

Wire `assertRailNotHalted(service, rail)` (or an inline `isHalted` read)
at the SINGLE new-operation chokepoint per rail, listed below with exact
`file:line`. Enforcement is intentionally NOT added in this PR.

### deposit

- **Primary:** `runPaymentWatcherTick(args)` —
  `apps/backend/src/payments/watcher.ts:790`. Deposits are inbound
  on-chain payments detected by this poller (no user "create deposit"
  endpoint). Early-return an empty `TickResult` when
  `isHalted('deposit')` so no new deposit → order transition happens;
  already-detected work is unaffected.
- Secondary (finer grain): `runPaymentWatcherTickLocked` (`watcher.ts:413`),
  `processPayment` (`watcher.ts:201`). Driver: `startPaymentWatcher`
  (`payments/watcher-bootstrap.ts:145`, started at `src/index.ts:158`).

### payout

- **Primary:** `runPayoutTick(args)` —
  `apps/backend/src/payments/payout-worker.ts:182` (or
  `runPayoutTickLocked` at `:226`). The tick already reads
  `isKilled('emissions')` at `payout-worker.ts:251` (skips emission rows)
  — add a whole-rail `isHalted('payout')` guard at the TOP of the tick,
  above that. Leave claimed rows `pending` so they re-drain on resume.
- Low level: `payOne` (`payments/payout-worker-pay-one.ts`),
  `submitPayout` (`payments/payout-submit.ts`). Enqueue primitive:
  `insertPayout` (`credits/pending-payouts.ts:39`).

### vault

- **Primary (single chokepoint for all mutating vault ops):**
  `requireVaultsEnabled()` — `apps/backend/src/credits/vaults/vault-client.ts:107`
  (delegates to `vaultsEnabled()` at `credits/vaults/registry.ts:38`).
  Every money-moving vault op already funnels through it:
  `depositToVault` (`vault-client.ts:262`), `withdrawFromVault`
  (`vault-client.ts:344`), `transferShares` (`vault-client.ts:462`).
  Adding an `isHalted('vault')` check adjacent to `requireVaultsEnabled()`
  halts deposit + withdraw + transfer in one place. (`readVaultState`
  `:616` and `getShareBalance` `:672` are read-only — leave open.)
- Higher-level drivers if per-flow gating is preferred:
  `driveOneVaultRedemption` (`credits/vaults/vault-redemptions.ts:957`),
  `driveOneVaultEmission` (`credits/vaults/vault-emissions.ts:600`).
  User HTTP path: `redeemLoopOrderViaVault` (`orders/redeem-vault.ts:74`).

### refund

Two internal sub-rails — gate BOTH primitives (the dispatcher alone is
insufficient because the on-chain primitive is reachable directly):

- **Credit-rail primitive:** `applyAdminRefund(args)` —
  `apps/backend/src/credits/refunds.ts:417`.
- **On-chain-rail primitive:** `refundDeposit(paymentId)` —
  `apps/backend/src/payments/deposit-refund.ts:272`.
- Order-scoped dispatcher (covers HTTP + order auto-refund, NOT the
  standalone deposit path): `applyOrderAutoRefund` (`credits/refunds.ts:244`).
- HTTP handlers: `adminRefundOrderHandler` (`admin/order-refund.ts:171`),
  `adminDepositRefundHandler` (`admin/deposit-refund-handler.ts:84`).
- Non-HTTP caller to account for: the auto-refund sweep at
  `payments/skipped-payments.ts:65` (when `LOOP_DEPOSIT_REFUND_AUTO=true`)
  calls `refundDeposit` — gating the two primitives covers it.

### Summary

| Rail    | Enforce at                              | file:line                                                   |
| ------- | --------------------------------------- | ----------------------------------------------------------- |
| deposit | `runPaymentWatcherTick`                 | `payments/watcher.ts:790`                                   |
| payout  | `runPayoutTick` / `runPayoutTickLocked` | `payments/payout-worker.ts:182` / `:226`                    |
| vault   | `requireVaultsEnabled`                  | `credits/vaults/vault-client.ts:107`                        |
| refund  | `applyAdminRefund` + `refundDeposit`    | `credits/refunds.ts:417` + `payments/deposit-refund.ts:272` |

---

## 6. Safe scaffold shipped in this PR

New module `apps/backend/src/rail-kill-switches/` — types + interface +
UNWIRED placeholder only. Typechecks (`npm run typecheck -w @loop/backend`)
and lints clean (`eslint --max-warnings=0`). NOT imported by any rail.

- `types.ts` — `Rail` union, `RAILS`, `RailHaltState`, `HaltArgs`,
  `ResumeArgs`.
- `service.ts` — `KillSwitchService` interface; `RailHaltedError`;
  `assertRailNotHalted(service, rail)` enforcement helper (a thin
  delegator with no table access — inert until a real service is injected
  AND it is called at a rail entry, neither of which this PR does);
  `UnwiredKillSwitchService` placeholder (reads report the mandated
  default `halted:false` and never throw, so accidental wiring keeps the
  rail's current behaviour rather than crashing; writes throw
  `KillSwitchNotProvisionedError`).
- `index.ts` — barrel.

The real `DbKillSwitchService` (table-backed, fail-closed reads) is a
later PR gated on the migration + policy below.

---

## 7. Policy questions for the human (KEY OUTPUT)

> **Kill-switch defaults are a PROTECTED CLASS.** The default state of
> every rail MUST be "not halted" (`halted=false`) — a change that flips a
> default, weakens the fail-closed posture, or removes a switch is a
> protected-class change and must go through the appropriate review, not a
> routine PR. Please confirm each answer explicitly before enforcement is
> wired.

**Q1 — In-flight ops on halt.** When a rail is halted, what happens to
work already in progress?

- Proposed: a halt blocks NEW entries only; in-flight ops (a payout mid-
  submit, a deposit already matched, a refund already begun) run to
  completion. Worker ticks early-return so QUEUED rows stay
  `pending`/`submitted` and re-drain on resume (mirrors the CF-15
  emission-skip behaviour at `payout-worker.ts:251`). HTTP entry points
  return 503 before starting. Confirm — or do you want a "drain + freeze"
  where in-flight is also paused/rolled back (much more complex, not
  recommended for v1)?

**Q2 — Default state.** Confirmed proposal: every rail seeds `halted=false`
and a MISSING row is also read as "not halted". Enforcement only halts on
an explicit `halted=true` row. Confirm the default is "not halted" (this
is the protected-class default).

**Q3 — Who can toggle, and does resume need step-up?** Proposed: halt AND
resume both require `requireStaff('admin')` (support tier cannot toggle) +
ADR-028 step-up. Open sub-question: should `resume` (which OPENS a rail —
arguably the riskier direction in an incident, since it re-enables money
movement) require step-up too, or should resume be lighter-weight so an
operator can un-break a rail fast during an incident? Proposed:
step-up on BOTH (`rail-halt`, `rail-resume` scopes). Confirm.

**Q4 — Audit logging.** Proposed: every toggle goes through the ADR-017
idempotency store (`admin_idempotency_keys`) + `notifyAdminAudit` Discord
fanout, same as other admin money-writes, plus a mandatory `reason`.
Confirm this is sufficient, or do you want a dedicated append-only history
table (see Q5) and/or a `#ops-alerts` post required on every flip (as the
env kill-switch runbook mandates)?

**Q5 — Dedicated history table?** The state table holds only the CURRENT
state (+ last actor/reason/updated_at). The idempotency store already
records each toggle request. Do you want an additional append-only
`rail_kill_switch_events` table for a clean "halt/resume timeline" query,
or is the idempotency-store audit trail enough for v1?

**Q6 — Fail-open vs fail-closed on store error.** If the
`rail_kill_switches` read fails (DB down / query error), should
enforcement treat the rail as HALTED (fail CLOSED, consistent with CFG-06
/ A4-047 for the env kill switches) or OPEN (fail open, keep serving)?
Fail-closed is safest for a money app but means a DB blip halts all four
rails; fail-open keeps rails running but defeats the switch exactly when
you might need it. Recommendation: fail CLOSED, matching the existing
kill-switch precedent. This is a protected-class-adjacent decision —
confirm explicitly.

**Q7 — Auto-resume vs manual.** Should a halt ever auto-expire (e.g. a
TTL / "halt for N hours then auto-resume"), or is resume always a manual
admin action? Proposed: MANUAL only for v1 (auto-resume risks silently
re-enabling a rail mid-incident). Confirm.

**Q8 — Relationship to the boot flags.** `LOOP_WORKERS_ENABLED` /
`LOOP_VAULTS_ENABLED` still exist. Precedence proposal: a rail is halted
if EITHER the boot flag disables it OR its `rail_kill_switches` row is
`halted=true` (logical OR — both are "stop" signals; neither can override
the other into "go"). Confirm, and confirm no `rail_kill_switches` value
is ever allowed to FORCE a boot-disabled rail back on.

**Q9 — Migration timing.** The proposed `0071_rail_kill_switches.sql` is
NOT in this PR. Confirm it should be authored + applied as a standalone,
serialized migration (next free number at apply time), separately from
enforcement wiring, so the table exists and is verified before any rail
reads it.

---

## 8. Rollout sequence (proposed, once policy is confirmed)

1. Land the migration `0071+_rail_kill_switches.sql` + drizzle schema
   (serialized, verified, seeded all-open).
2. Land `DbKillSwitchService` (table-backed, fail-closed reads per Q6) +
   the admin API (§4) + step-up scope(s) + `architecture.md` route
   parity. Admin can halt/resume/list, but NO rail reads the switch yet.
3. Wire `assertRailNotHalted` at the four enforcement points (§5), one
   rail per PR, each with tests asserting: halted → new work rejected,
   in-flight unaffected, resume → work re-drains.
4. Runbook: extend `docs/runbooks/kill-switch.md` with the admin-API flow.
