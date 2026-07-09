# ADR-028 — Admin step-up authentication for destructive actions

**Status:** Accepted (Phase-1 implemented 2026-05-04 / A4-063 — backend gate + web modal both shipped; Phase-2 expansions pending)
**Date:** 2026-04-26
**Audit ref:** A2-1609 (pin), A4-063 (implementation)
**Supersedes:** none
**Superseded by:** none

## Implementation status

- **2026-05-04** Phase-1 backend slice landed (commits on `fix/audit-2026-05-03-tranche-2`):
  - `LOOP_ADMIN_STEP_UP_SIGNING_KEY` env var (separate from `LOOP_JWT_SIGNING_KEY` per the original design).
  - `apps/backend/src/auth/admin-step-up.ts` — sign + verify helpers.
  - `apps/backend/src/auth/admin-step-up-middleware.ts` — `requireAdminStepUp()`.
  - `apps/backend/src/admin/step-up-handler.ts` — `POST /api/admin/step-up` (OTP variant, `kind: 'otp'`).
  - Wired on `/api/admin/users/:userId/credit-adjustments`,
    `/api/admin/users/:userId/withdrawals`, `/api/admin/payouts/:id/retry`.
  - Tests: 12 unit tests covering sign/verify/middleware error paths.
- **2026-06-11** Operator-visibility follow-up (cross-env audit): the key is
  `optional()` in `env.ts`, so a deployment that never provisions it boots
  cleanly while every gated endpoint (credit-adjust / withdrawals /
  payout-retry) fails closed with `503 STEP_UP_UNAVAILABLE` — easy to mistake
  for an outage. `LOOP_ADMIN_STEP_UP_SIGNING_KEY` is now listed in
  `scripts/preflight-tranche-1.sh` (RECOMMENDED tier — advisory, since
  Tranche 1 may deliberately launch with those admin surfaces dark) and in
  the `docs/deployment.md` env table. Generate with `openssl rand -base64 48`;
  rotate via `LOOP_ADMIN_STEP_UP_SIGNING_KEY_PREVIOUS` over the 5-minute TTL.
- **2026-05-04** Web modal landed (#1319): `StepUpModal.tsx`
  (`apps/web/app/components/features/admin/`), `use-admin-step-up.ts` hook,
  `admin-step-up.store.ts` Zustand store, `services/admin-step-up.ts`, with
  auto-prompt on 401 `STEP_UP_REQUIRED`. Tested. Both halves of the Phase-1
  slice are shipped.
- **2026-06-15** Cold-audit money-write hardening (CF-06 / CF-07 / CF-08):
  - **CF-06 / CF-07** — closed the two money-up writers that were missing the
    gate. `POST /api/admin/users/:userId/refunds` (mints a positive
    `credit_transactions` row) and `POST /api/admin/payouts/:id/compensate`
    (re-credits a user's balance) now carry `requireAdminStepUp()` like their
    siblings. The home-currency write (`/api/admin/users/:userId/home-currency`)
    is also gated. The full step-up-gated set is now: credit-adjust, refund,
    withdrawal, payout-retry, payout-compensation, home-currency.
  - **CF-08** — the step-up token now carries a `scope` claim binding it to an
    action class. `requireAdminStepUp(action)` rejects a token _narrowed_ to a
    different class with 401 `STEP_UP_PURPOSE_MISMATCH`, so a step-up confirmed
    for (say) a refund cannot be silently replayed against a withdrawal. The
    default `scope: 'admin-write'` is a wildcard that satisfies every gate, so
    the existing web flow (one generic token replayed across writes) is
    unchanged — narrowing is opt-in at mint time via the `scope` body field on
    `POST /api/admin/step-up`. This is defence-in-depth; it does not by itself
    make the OTP a truly independent second factor (the passwordless-OTP
    limitation below still stands — WebAuthn is the Phase-2 fix).
- **2026-07-07** R3-12 hardening: `requireAdminStepUp(...)` no longer lets
  legacy CTX-proxy auth fall through. The gate requires a Loop-native auth
  subject so the step-up token can be subject-pinned; a CTX bearer has no Loop
  user id and fails closed with `STEP_UP_INVALID`. This is mostly a tripwire in
  the current admin route stack because `requireAdmin` already rejects CTX
  auth before route-specific step-up middleware, but it prevents a future
  mis-mounted step-up gate from becoming a standalone CTX pass-through.
- **2026-07-09** A5-1: the order re-drive lever
  (`POST /api/admin/orders/:orderId/redrive`) joins the gated set with its
  own scope, `order-redrive` — re-driving a stuck order can submit a real
  outbound Stellar payment to CTX via the existing `payCtxOrder`
  idempotency (`ctx_settlements`), the same class of risk as payout-retry.
  The step-up-gated set is now: credit-adjust, refund, withdrawal,
  payout-retry, payout-compensation, home-currency, cashback-config, staff
  role grant/revoke, deposit-refund, operator-float, order-redrive.

### Activation gate / deploy ordering

The gate **fails closed** end-to-end, which fixes the safe rollout order:

- **Backend-before-web is safe.** A backend with the gate wired but a web
  bundle without the modal returns 401 `STEP_UP_REQUIRED` on destructive ops —
  the action is blocked (visible error), never silently allowed.
- **Web-without-backend fails destructive ops.** A web bundle with the modal
  pointed at a backend missing `POST /api/admin/step-up`, or one deployed
  without `LOOP_ADMIN_STEP_UP_SIGNING_KEY` set, cannot complete credit-adjust /
  withdrawal / payout-retry: the middleware returns 503 `STEP_UP_UNAVAILABLE`
  when the key is unset (`admin-step-up-middleware.ts` — "surface ships
  disabled if the operator hasn't generated the key"). Deploy the backend (with
  the key in Fly secrets) before or together with the web bundle.

## Context

The admin surface (`apps/web/app/routes/admin*.tsx` + `apps/backend/src/admin/*`) carries a number of destructive primitives: credit adjustments (ADR-017), withdrawal writes (ADR-024), cashback-config edits (ADR-011), payout retries, supplier order replays, and the planned merchant-blacklist controls. Each is gated on the admin's bearer token + the per-action `Idempotency-Key` ADR-017 contract — which protects against replays and accidental double-fires, but **not** against an attacker who has already captured a live bearer token.

A2-1609 pins the threat: a 15-minute admin access token, exfiltrated from a compromised laptop / clipboard / browser extension, can issue **unlimited** credit adjustments inside its TTL window. The per-day cap (A2-1610, `ADMIN_DAILY_ADJUSTMENT_CAP_MINOR`) caps the dollar magnitude but not the count or the destructive variety. The `ADMIN_DAILY_ADJUSTMENT_CAP_MINOR` is a circuit-breaker, not a mitigation against active session theft.

Step-up auth means: for a defined set of destructive primitives, the admin re-presents a credential beyond the bearer token within the action window.

## Decision

**Phase 1: require fresh step-up on destructive admin writes. Phase 2: expand the factor quality and thresholds.**

The current step-up surface is:

- credit adjustment
- refund
- withdrawal
- payout retry
- payout compensation
- home-currency change
- merchant cashback-config write
- staff role grant / revoke
- abandoned-deposit refund
- order re-drive (A5-1)

**Excluded** from the current surface:

- Merchant resyncs, force-refresh (read-only effects)
- Admin CSV exports (read-only)
- Admin-panel navigation (handled by `<RequireAdmin>` shell)

Legacy CTX-proxy auth is not an alternate admin-write path. The admin surface
requires Loop-native auth, and the step-up middleware itself also fails closed
without a Loop-native subject to pin against.

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

Step-up tokens are **stateless** — verified by HS256 signature against `LOOP_ADMIN_STEP_UP_SIGNING_KEY` (separate from `LOOP_JWT_SIGNING_KEY` so a JWT-key compromise doesn't widen to step-up; matches `apps/backend/src/env.ts`, with `LOOP_ADMIN_STEP_UP_SIGNING_KEY_PREVIOUS` accepted during rotation windows). No DB row per issued token; the 5-minute TTL is enforced by the `exp` claim. A keepalive endpoint is **not** offered — admins re-auth on expiry, not extend.

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
