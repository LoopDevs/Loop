# Runbook · CTX upstream circuit open

## Symptom

- Discord `#ops-alerts` ping from the circuit-breaker module: a
  specific upstream endpoint (`login`, `verify-email`, `refresh-token`,
  `merchants`, `locations`, `gift-cards`, …) has tripped to `OPEN` and
  responses now 503 with `Service temporarily unavailable`.
- Spike in `/api/auth/*` or `/api/orders` 503s on the dashboard.
- Customer reports that sign-in / order-creation isn't working — but
  only for a specific surface (others still functional, since the
  breaker is per-endpoint, not global).

## Severity

- **P1** if the broken endpoint is `login` / `verify-email` /
  `refresh-token` (auth blocked = no new sign-ins, no token refresh).
- **P2** if it's `gift-cards` (orders blocked but auth and browsing
  work).
- **P3** if it's `merchants` / `locations` (catalog refresh degraded
  but the in-memory cache keeps serving).

## Diagnosis

1. Check Fly logs for the breaker transitions:
   ```bash
   fly logs -a loopfinance-api | grep "circuit-breaker" | tail -30
   ```
   Look for the trip event — it says which endpoint, the consecutive
   failure count, and the last error.
2. Probe the upstream directly to confirm whether CTX is actually
   down or whether our request is malformed:
   ```bash
   curl -i "$GIFT_CARD_API_BASE_URL/health" 2>&1
   curl -i "$GIFT_CARD_API_BASE_URL/<failing-endpoint>" 2>&1 | head -20
   ```
3. Read recent `#deployments` and `#ops-alerts` for related events.
   CTX may have posted maintenance, or our last deploy may have
   changed the request shape.
4. Use `/health` only for the signals it actually exports:
   ```bash
   curl -s https://api.loopfinance.io/health | jq '{upstreamReachable, merchantsStale, locationsStale, merchantsLoadedAt, locationsLoadedAt}'
   ```
   This confirms whether CTX is broadly reachable and whether catalog
   refresh is falling behind, but it does **not** expose per-endpoint
   breaker state. Treat Fly logs as the breaker source of truth.

## Mitigation

| Cause                                      | Action                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| CTX confirmed-down, upstream-side incident | Hold. Breaker auto-probes after 30s cooldown; closes when probe succeeds. Post in `#ops-alerts` with the CTX status link.            |
| Our request shape broken (last deploy)     | Roll back the last deploy: `fly releases list -a loopfinance-api`, find the prior version, `fly deploy --image registry.fly.io/...`. |
| Auth credential rotation broke us          | Verify `GIFT_CARD_API_KEY` / `GIFT_CARD_API_SECRET` haven't been rotated upstream without us picking up the new value.               |
| Rate-limit on upstream                     | Back off — circuit's already throttling us. Consider lowering our refresh cadence (`REFRESH_INTERVAL_HOURS`).                        |

**The circuit is per-endpoint by design (audit A2-407).** A failing
`/locations` doesn't trip auth. Don't manually reset all breakers
unless you've confirmed all endpoints are healthy upstream.

## Resolution

- Auto-resolves on the next successful probe through the HALF_OPEN
  state. Watch `#ops-alerts` for the close event.
- If 30 minutes pass and the breaker hasn't closed, the upstream is
  genuinely down or our integration is broken — escalate to the on-call
  per A2-1901 (when that runbook lands; for now, ping a maintainer).

## Post-mortem

- P1 incident (auth blocked) → always.
- P2 / P3 → only if the trip lasted >30 min or repeated within 24h.

## References

- Per-endpoint breaker config in `apps/backend/src/circuit-breaker.ts`.
- ADR 004 (security hardening pass) for the original circuit design.
- A2-407 audit-finding history for the per-endpoint split rationale.
