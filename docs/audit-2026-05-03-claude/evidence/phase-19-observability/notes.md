# Phase 19 - Observability and Operations

Status: complete
Owner: lead (Claude)

## Files reviewed

- apps/backend/src/{health,runtime-health,observability-handlers,metrics,sentry-scrubber,instrument,logger,discord,kill-switches}.ts
- apps/backend/src/middleware/{access-log,request-context,request-counter,probe-gate}.ts
- docs/{slo,alerting,oncall,log-policy,error-codes}.md
- docs/runbooks/\* (reviewed top-level entries: payout-failed-alert, ctx-schema-drift, payment-watcher-stuck, stuck-procurement-swept, mobile-cert-renewal, jwt-rotation, etc.)

## Findings filed

- A4-034 High — /health does not probe Postgres
- A4-035 Medium — /health returns HTTP 200 on degraded
- A4-040 Low — pino REDACT_PATHS missing idempotency-key paths
- A4-047 Medium — kill-switch fails open on unrecognized values
- A4-048 Low — SLO doc claims 99.5% but no SLI computation

## No-finding-but-reviewed

- Pino-backed structured logger with redaction allowlist.
- Sentry init in `instrument.ts` (--import); event scrubber in place.
- Request-id propagation to upstream CTX via X-Request-Id header.
- Health flap-damper with asymmetric thresholds.
- Discord webhooks for orders + monitoring + admin-audit.
- Per-endpoint circuit breakers tagged in Discord embed.
