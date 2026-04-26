# Runbook · Runtime kill switch

## Symptom

Operational situation where you need to **stop accepting traffic on a
specific surface immediately** without waiting for a redeploy. Triggers:

- **`orders`** — CTX upstream is misbehaving in a way the circuit
  breaker isn't catching (returning 200s with bad data, double-debiting,
  etc.); halt new order creation while finance investigates.
- **`auth`** — the OTP / social-login flow has a regression that's
  flooding upstream with garbage (e.g. malformed bodies); halt new
  sign-ins while existing sessions drain on refresh.
- **`withdrawals`** — a known-broken Stellar route is causing every
  admin withdrawal to permanently fail; halt admin cash-out + the
  compensation endpoint until the rail is fixed.

## Severity

- **P0**. Each subsystem represents a money-flow or auth-correctness
  surface; flipping the switch is a "stop the bleed" move.

## Diagnosis

Skip to mitigation if you already know which subsystem to gate. If you
don't, trace via:

1. **Discord.** `#ops-alerts` will usually have the upstream signal.
2. **`/health`.** `curl https://api.loopfinance.io/health | jq` —
   shows circuit-breaker states, worker enabled flags, last sync times.
3. **`/admin/audit-tail`.** If admin writes are misbehaving, the
   per-action ledger is the fastest read.

## Mitigation

Each switch is a Fly secret. Flipping it triggers a rolling restart
that picks up the new value within ~60s. Until then, the next request
to a `killSwitch`-wrapped route checks `process.env` directly, so
whichever machine has the new secret already returns 503 — no race.

```bash
# Block new orders (existing orders + payouts continue draining)
fly secrets set LOOP_KILL_ORDERS=true -a loopfinance-api

# Block new sign-ins (existing sessions keep working via /refresh)
fly secrets set LOOP_KILL_AUTH=true -a loopfinance-api

# Block admin withdrawals + compensation endpoint
fly secrets set LOOP_KILL_WITHDRAWALS=true -a loopfinance-api
```

The killed surface returns:

```
HTTP/1.1 503
{ "code": "SUBSYSTEM_DISABLED", "message": "<subsystem> is temporarily disabled — retry shortly" }
```

Web + mobile clients already render `503` as a transient error and
let the user retry — no client-side change needed.

**Always post the flip in `#ops-alerts`** so the team sees what's
gated. Include the trigger and expected reset window.

## Resolution

Reset the switch when the upstream incident resolves:

```bash
fly secrets set LOOP_KILL_ORDERS=false -a loopfinance-api
# OR
fly secrets unset LOOP_KILL_ORDERS -a loopfinance-api
```

Both leave the surface open. The `unset` form is the cleaner end
state — it removes the secret entirely so a future `fly secrets list`
doesn't show stale flags.

## What about the payout worker?

`LOOP_WORKERS_ENABLED=false` is the existing kill switch for the
on-chain payout worker (ADR 016) — separate from the user-facing
endpoints above. Flip it independently if you need to halt Stellar
submission while keeping new orders / withdrawals queueable.

## Post-mortem

Always for any kill-switch flip — the trigger that warranted a
production-side gating action is, by definition, post-mortem-worthy.
Capture:

- What the upstream incident was.
- How long the switch was on.
- Whether existing sessions / in-flight orders saw user-visible
  failures or whether the gating cleanly drained the surface.
- Whether the alert that triggered the flip exists / is wired up
  correctly. If you had to gate based on a customer report rather than
  an alert, the alert pipeline has a gap.
