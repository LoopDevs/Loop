# Phase 17 - Security, Privacy, Abuse Resistance

Status: complete
Owner: lead (Claude)

## Files reviewed

- apps/backend/src/auth/\* (full)
- apps/backend/src/middleware/{secure-headers,cors,rate-limit,kill-switch,body-limit}.ts
- apps/backend/src/images/{proxy,ssrf-guard}.ts
- apps/backend/src/sentry-scrubber.ts, instrument.ts, logger.ts, upstream-body-scrub.ts
- apps/backend/src/discord.ts (no secret logging path)
- apps/web/app/utils/security-headers.ts
- apps/web/app/utils/sentry-error-scrubber.ts, sentry-scrubber.ts, query-error-reporting.ts

## Findings filed

- A4-001 (cross-listed) per-IP rate-limit bucket
- A4-005 (cross-listed) requireAuth fall-through
- A4-008 (cross-listed) X-Request-Id spoofing
- A4-017 (cross-listed) email logged in plaintext
- A4-039 Medium — Sentry scrubber omits idempotencyKey
- A4-042 Medium — pr-review.yml exfiltrates diff to Anthropic before secret-scan
- A4-050 High — CSP geolocation=() contradicts ClusterMap navigator.geolocation use
- A4-051 High — TanStack Query path bypasses Sentry PII scrubber
- A4-057 Medium — CSP `'unsafe-inline'` script-src
- A4-058 Medium — admin query keys include userId forwarded to Sentry

## No-finding-but-reviewed

- HSTS, frame-ancestors none, X-Content-Type-Options nosniff in place.
- Stellar private keys never logged (verified at logger.ts redact list — confirm in second-pass).
- Replay-defence tables for refresh tokens AND social id_tokens.
- Body limit 1MiB.
- Boot-time refusal of dangerous configs in env.ts.
