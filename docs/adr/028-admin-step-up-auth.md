# ADR-028 — Admin step-up authentication for destructive actions

**Status:** Accepted (Phase-1 design pinned, implementation deferred)
**Date:** 2026-04-26
**Audit ref:** A2-1609
**Supersedes:** none
**Superseded by:** none

## Context

The admin surface (`apps/web/app/routes/admin*.tsx` + `apps/backend/src/admin/*`) carries a number of destructive primitives: credit adjustments (ADR-017), withdrawal writes (ADR-024), cashback-config edits (ADR-011), payout retries, supplier order replays, and the planned merchant-blacklist controls. Each is gated on the admin's bearer token + the per-action `Idempotency-Key` ADR-017 contract — which protects against replays and accidental double-fires, but **not** against an attacker who has already captured a live bearer token.

A2-1609 pins the threat: a 15-minute admin access token, exfiltrated from a compromised laptop / clipboard / browser extension, can issue **unlimited** credit adjustments inside its TTL window. The per-day cap (A2-1610, `ADMIN_DAILY_ADJUSTMENT_CAP_MINOR`) caps the dollar magnitude but not the count or the destructive variety. The `ADMIN_DAILY_ADJUSTMENT_CAP_MINOR` is a circuit-breaker, not a mitigation against active session theft.

Step-up auth means: for a defined set of destructive primitives, the admin re-presents a credential beyond the bearer token within the action window.

## Decision

**Phase 1: pin the design; ship a minimal slice for credit-adjust + withdrawal only. Phase 2: expand.**

The Phase-1 step-up surface is:

- `POST /api/admin/credits/adjust` (ADR-017 credit primitives)
- `POST /api/admin/withdrawals` (ADR-024 withdrawal writer)
- `POST /api/admin/payouts/:id/retry` (manual payout retry)

**Excluded** from the Phase-1 minimum surface:

- Cashback-config edits (audited via ADR-011 trail; reversible)
- Merchant resyncs, force-refresh (read-only effects)
- Admin CSV exports (read-only)
- Admin-panel navigation (handled by `<RequireAdmin>` shell)

### Mechanism

Step-up token = a short-lived (5-minute) JWT minted by `POST /api/admin/step-up` after the admin re-presents their **password / OTP** (Loop-native auth) or **OAuth re-auth** (Google / Apple, ADR-014). The step-up JWT is independent of the bearer access token — it's stamped with `purpose: 'admin-step-up'` and `audience: 'admin-write'`, and verified separately by the gated handlers.

```
POST /api/admin/step-up
  body: { credential: string, kind: 'password' | 'otp' | 'social' }
  → 200 { stepUpToken: string, expiresAt: string (ISO) }

POST /api/admin/credits/adjust
  headers:
    Authorization: Bearer <admin-access-token>   ← existing
    Idempotency-Key: <uuid>                       ← existing
    X-Admin-Step-Up: <stepUpToken>                ← NEW
  body: { ... }
  → 401 { code: 'STEP_UP_REQUIRED' } when missing/expired
  → 401 { code: 'STEP_UP_INVALID' } when malformed/wrong audience
```

5-minute TTL is the trade-off: short enough that a stolen token can't be used for a meaningful spree, long enough that an admin doesn't re-auth between every line of a 20-row CSV import.

### Storage

Step-up tokens are **stateless** — verified by HS256 signature against `LOOP_STEP_UP_SIGNING_KEY` (separate from `LOOP_JWT_SIGNING_KEY` so a JWT-key compromise doesn't widen to step-up). No DB row per issued token; the 5-minute TTL is enforced by the `exp` claim. A keepalive endpoint is **not** offered — admins re-auth on expiry, not extend.

### Web flow

Admin clicks "Adjust credit" in the admin UI:

1. Frontend POSTs the action; backend returns 401 `STEP_UP_REQUIRED`.
2. Frontend opens a "Confirm with your password" modal, POSTs `/api/admin/step-up`.
3. On success, the step-up token is held in memory (Zustand, like the access token — never localStorage). The original action is replayed with `X-Admin-Step-Up`.
4. Token expires silently after 5 min; next destructive action re-prompts.

The step-up modal is a single component reused across all gated surfaces.

## Consequences

**Positive**

- A captured bearer token alone is insufficient for credit-adjust / withdrawal / payout-retry. The attacker needs the password too — which is in 1Password / Apple Keychain, not in the browser session.
- ADR-017's audit trail still records the actor + reason; this layer adds an authentication-freshness check on top.
- Stateless tokens mean no DB hit on every admin write — the gate is sub-millisecond JWT-verify.

**Negative**

- Admin UX: one extra modal per action. Mitigated by the 5-minute window and a single shared component.
- Operators who can't re-auth (e.g. SSO outage on a Google-login admin) are blocked from destructive surfaces. Operator runbook covers the social-login fallback.
- Phase-1 minimum slice doesn't cover cashback-config edits — a stolen token can still mass-edit the rate table. Phase 2 expands the gate; the audit accepts this gap because cashback-config is reversible (the audit trail + the "previous value" field).

**Neutral**

- The step-up signing key joins `LOOP_JWT_SIGNING_KEY` in the rotation runbook (ADR-016 / `docs/runbooks/jwt-key-rotation.md`). Same staged-rotation pattern.

## Phase-2 expansions

In rough priority order:

1. **Expand the gated surface** to cashback-config writes, merchant blacklist, force-payout-permanent-fail, sweeper toggles.
2. **Hardware key (WebAuthn)** as an alternative to password — admins can opt in via Settings; the step-up flow accepts either.
3. **Per-amount thresholds** on the ADR-017 cap — adjustments above e.g. £10K require a second admin's step-up co-signature (4-eyes principle).
4. **Mobile fallback** if the admin panel ever ships to native — TouchID / FaceID as a step-up factor through the existing biometric plugin.

## References

- ADR-013 (Loop-owned auth) — the password / OTP path that step-up reuses.
- ADR-014 (Social login) — the Google / Apple re-auth fallback.
- ADR-017 (Admin credit primitives) — the existing audit-trail layer that step-up sits on top of.
- ADR-024 (Withdrawal writer) — the second Phase-1 gated surface.
- A2-1610 — daily-adjustment magnitude cap (the in-place amount control that step-up complements).
- A2-1611 — credit-adjustment audit trail (the in-place actor-attribution control).
