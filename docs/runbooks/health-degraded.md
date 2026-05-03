# Runbook · `notifyHealthChange` degraded alert

## Symptom

Discord `#ops-alerts` embed titled **"🟠 Service Degraded"** from
`notifyHealthChange`.

Check `/health` immediately:

```bash
curl -s https://api.loopfinance.io/health | jq
```

The response now distinguishes:

- CTX reachability: `upstreamReachable`
- catalog freshness: `merchantsStale`, `locationsStale`
- native-auth delivery: `otpDelivery`
- worker state: `workers[]`

## Severity

- **P1** if customer-facing auth, orders, payouts, or procurement are degraded.
- **P2** if the issue is freshness-only (merchant/location lag) and user writes still work.

## Diagnosis

1. Read `/health` and identify the tripped surface.
2. If `otpDelivery.degraded=true`, tail auth logs:
   ```bash
   fly logs -a loopfinance-api | grep "OTP email send failed" | tail -20
   ```
3. If any `workers[].degraded=true`, inspect the worker named in `/health`:
   ```bash
   fly logs -a loopfinance-api | grep -E "payment watcher|procurement worker|payout worker|asset drift|interest accrual" | tail -50
   ```
4. If `upstreamReachable=false`, use [`ctx-circuit-open.md`](./ctx-circuit-open.md).

## Mitigation

- OTP delivery degraded: fix email-provider credentials or outage, then trigger a manual request-otp against a test inbox to prove recovery.
- Worker degraded: restore the missing config or restart the machine if the worker stopped unexpectedly.
- Freshness degraded: trigger the relevant admin resync only after confirming CTX is healthy.

## Resolution

Re-check `/health` until it returns `status="healthy"` and the degraded sub-surface has cleared. Post one closing message in `#ops-alerts` with the cause and fix.

## Related

- [`ctx-circuit-open.md`](./ctx-circuit-open.md)
- [`stuck-payout.md`](./stuck-payout.md)
- [`payment-watcher-stuck.md`](./payment-watcher-stuck.md)
