# Runbook · `notifyOperatorPoolExhausted` alert (Discord `#ops-alerts`)

## Symptom

`#ops-alerts` Discord embed titled **"🔴 CTX Operator Pool
Exhausted"** with fields:

- `Pool size` — total operators configured in `CTX_OPERATOR_POOL`
- `Last error` — the error the most-recent operator hit before
  tripping its circuit (e.g. `401 invalid_token`, `500`, `circuit_open`)

Source: `apps/backend/src/discord.ts::notifyOperatorPoolExhausted` —
fires when EVERY operator in the pool has its circuit OPEN
simultaneously and Loop-native procurement falls back to no-CTX
mode (i.e. `POST /api/orders/loop` cannot place upstream gift-card
orders until at least one operator recovers).

## Severity

**P0.** Loop-native procurement is fully blocked. Users placing
orders see the order land in `pending_payment` / `paid` but
procurement never advances to `procuring` — the user sits in limbo
until the pool recovers. Order TTL is 30 minutes (per `orders.ts`
`ORDER_EXPIRY_SECONDS`); orders that don't get procured before then
expire and the user has to retry.

ACK in 5 min, mitigate in 15 min.

## Triage (first 5 minutes)

1. **Snapshot pool state.** Open the admin operators page
   (`/admin/operators`, backed by `GET /api/admin/operator-stats` +
   `GET /api/admin/operators/latency`) for per-operator volume and
   failure signals. Operators are configured in env, not DB — read
   `CTX_OPERATOR_POOL` from Fly secrets. Each operator entry has its
   own circuit breaker (`apps/backend/src/ctx/operator-pool.ts`).
2. **Identify the cause class.** Look at `Last error` in the embed,
   then check Pino log lines tagged `area: 'operator-pool'`:
   ```bash
   fly logs -a loopfinance-api | grep operator-pool
   ```
   Common patterns:
   - **All `401 invalid_token`** → CTX rotated something on every
     operator (cred rotation, infrastructure change). Re-auth.
   - **All `500` / `connection refused`** → CTX upstream is down;
     wait for them.
   - **Mixed errors per operator** → unlikely to be all-pool unless
     it's a deeper issue. Check Horizon / DNS.

## Mitigation

### CTX-side outage (5xx on every operator)

Nothing to do — wait for CTX to recover. Each operator's circuit is
30s OPEN → HALF_OPEN, so the pool will start probing automatically.
First successful probe lifts the alert via the natural circuit
flow. **No manual intervention.**

### CTX-side cred rotation (401 on every operator)

The shared upstream credentials have rotated. Loop runs through the
auth flow per-operator, so all of them lose tokens at once.

1. From the Loop maintainer 1Password vault, pull the new operator
   credentials (CTX should have notified — if not, escalate to CTX
   support).
2. Update `CTX_OPERATOR_POOL` in Fly secrets:
   ```bash
   fly secrets set CTX_OPERATOR_POOL='[{"id":"op-1","email":"...",...},…]' -a loopfinance-api
   ```
3. Workers re-read on the next tick; operators come back HALF_OPEN
   → `closed` after the first successful probe.

### Single-operator 401 (CF-13 — `notifyOperatorCredentialExpired`)

A distinct, earlier-firing alert titled **"🔴 CTX Operator Credential
Expired (401)"** fires when ONE operator returns 401 (its bearer
expired/revoked) — before the whole pool is exhausted. `operatorFetch`
forces that operator's circuit OPEN, pulls it from rotation, and fails
over to a healthy sibling, so procurement keeps running **degraded**
(the embed's `Failed over` field says `yes`). The order is NOT failed —
a tick that 401s on every reachable operator reverts `procuring → paid`
to retry later (`procure-one.ts`).

Action: re-mint that single operator's bearer and update its entry in
`CTX_OPERATOR_POOL` (same `fly secrets set` as the all-401 case above).
No restart needed — the operator comes back HALF_OPEN → `closed` after
the cooldown's first successful probe. If `Failed over` says `no`, this
operator was the last healthy one and the pool-exhausted alert will
follow — treat as P0.

### Loop-side bug

If only Loop is reporting "all operators down" but CTX is otherwise
healthy (status page green, other Loop teams unaffected): the bug
is in `apps/backend/src/ctx/operator-pool.ts` itself. Likely candidates:

- Circuit-breaker state corruption (process restart usually clears)
- A bad operator entry (malformed JSON in `CTX_OPERATOR_POOL`)
  that's tripping every operator's circuit on parse

Restart the backend:

```bash
fly machine restart -a loopfinance-api
```

If the alert clears on restart, file a circuit-state-loss bug; the
in-memory state should not need a restart to recover.

## Resolution

Pool recovery is automatic — the first operator's circuit going
HALF_OPEN → `closed` lifts the bottleneck. Post a manual `✅`
message in `#ops-alerts` once the first new order procures
successfully.

## Post-mortem

- **For >5 minute outages**: write up the cause + the time-to-
  recover. Track patterns: if it's "CTX upstream goes down for >5
  min weekly," the architecture needs a sterner fallback (e.g.
  multi-supplier — Phase-2).
- **For mid-flight orders**: the `pending_payment` / `paid` rows
  that aged out during the outage need triage. Either:
  - Refund off-chain via `/api/admin/users/:userId/refunds` if the
    user paid but procurement never happened (rare; payment watcher
    only flips to `paid` after Stellar confirm)
  - Mark expired and the user retries on their own (most cases)

## Related

- [`ctx-circuit-open.md`](./ctx-circuit-open.md) — the
  per-endpoint circuit-breaker runbook (this is the per-operator
  variant).
- ADR 013 — the operator pool design (Loop owns auth, CTX is the
  procurement supplier).
- ADR 016 — the submit worker (separate concern; pool exhaustion
  affects procurement, not payouts).
