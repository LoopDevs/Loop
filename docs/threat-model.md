# Threat Model — Loop

> Assets, actors, trust boundaries, and the accepted-risk register. Its
> purpose is to let a future contributor tell a **deliberate tradeoff**
> from a **gap** — the two look identical in code, and mistaking one for
> the other wastes time (re-fixing accepted risks) or ships holes
> (assuming a gap was intentional).
>
> Written 2026-07 during the hardening pass. Pair with
> [`invariants.md`](invariants.md) (what must be true about money) — this
> doc is about who might try to make it false and where we've decided not
> to defend.

---

## Assets (what an attacker wants)

1. **User LOOP balance / on-chain tokens** — the mirror liability + the
   Stellar-held assets. Theft target #1.
2. **Operator XLM/USDC wallet** — funds procurement (operator→CTX) and
   payouts. A compromised operator secret drains it directly.
3. **Issuer keys** (GBPLOOP + the USDC/EURC issuers) — signing power to
   mint unbacked LOOP. Highest-value secret in the system.
4. **User PII** — email, order history, redemption codes/PINs.
5. **Admin authority** — the ability to move value (credit-adjust, emit,
   refund, retry payouts) or read PII in bulk.
6. **Gift-card redemption secrets** — bearer value; whoever reads them
   spends them.

## Actors (who might attack)

- **External unauthenticated** — the internet. Bounded by CORS, rate
  limits, the never-500 public API surface.
- **Authenticated user** — a real account trying to escalate (IDOR into
  another user's orders/balance, forge tokens, replay OTPs).
- **Compromised admin bearer** — the ADR-028 threat model: a stolen or
  cached admin access token. This is why destructive writes require
  fresh step-up (INV-11) and carry daily caps (INV-5).
- **Compromised operator/issuer secret** — catastrophic; mitigations are
  rotation runbooks + boot-time key validation, not prevention.
- **Malicious/ buggy upstream (CTX, Horizon, Privy)** — returns hostile or
  malformed data. Every upstream response is Zod-validated before use;
  circuit breakers isolate failures.
- **Insider / future contributor** — the "mid-tier model off the rails"
  case. Defended by the mechanical gates (invariants.md enforcement
  tiers), not by trust.

## Trust boundaries

```
internet ──[CORS + rate limit + body limit]──► backend
backend ──[Zod validation + circuit breaker]──► CTX / Horizon / Privy
backend ──[bearer + requireStaff + step-up]──► admin surface
device ──[keychain; access token memory-only]──► never trusts client for authz
backend ──[issuer/operator secrets never leave backend]──► Stellar
```

The load-bearing boundary decisions:

- **Access tokens are memory-only** (Zustand); refresh tokens in
  Keychain/EncryptedSharedPrefs (native) or sessionStorage (web). A stolen
  device gives at most the refresh token, killable by the reuse heuristic.
- **Stellar private keys are generated on-device and never transmitted.**
  The backend signs only with operator/issuer secrets it holds; it never
  sees a user's wallet key.
- **The web app is a pure API client** — it never has authority. Every
  authz decision is server-side; the client-side gates (`RequireAdmin`,
  hidden UI) are UX, not security (the API 404s/403s regardless).

---

## Accepted risks (deliberate — do NOT "fix" without revisiting the tradeoff)

Each of these is a conscious decision, not an oversight. Re-opening one
means re-litigating the tradeoff, which needs the context here.

| Risk                                                                                                          | Decision & why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Revisit trigger                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Access tokens are non-revocable** (no `jti`, 15-min TTL, verified in-process)                               | The 15-min window is the containment. A revocation list would add a DB read to every request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | If a single leaked access token can do irreversible damage in 15 min — but destructive admin actions need step-up (re-auth), so it can't.                                                                                                                                                                                                                                                                                       |
| **Payout single-flight degrades under a hung leader** (A8)                                                    | `withAdvisoryLock` serialises the payout tick fleet-wide (closes the normal-case `tx_bad_seq` race); a 90s lease deadline releases the lock if the leader hangs on Stellar I/O, degrading to the pre-A8 per-machine race rather than stalling the fleet. Not a full heartbeat leader-election.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | If `tx_bad_seq` churn reappears (would mean sustained >90s ticks), or the lease-timeout log fires regularly.                                                                                                                                                                                                                                                                                                                    |
| **Rate limiting is per-machine, estimate-divided** (CF2-10)                                                   | In-memory limiter; `RATE_LIMIT_MACHINE_COUNT_ESTIMATE` approximates the fleet-wide budget.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | A shared-store limiter (Redis) when volumetric abuse becomes real.                                                                                                                                                                                                                                                                                                                                                              |
| **Verify-OTP lockout is a targeted per-email DoS surface** (B5, implemented)                                  | B5 added an identity-scoped failed-attempt counter (`otp_attempt_counters`): 10 wrong guesses / 15-min window locks _verify_ for that email for 15 min, closing the row-rotation brute-force bypass. The tradeoff is inherent: the lock is checked BEFORE the code compare (checking after would be a bypass — an attacker could keep testing during "lockout"), so 10 wrong guesses also lock out the legit user holding the right code. Bounded by the per-IP 10/min verify cap; enumeration-safe (fires before any user lookup). Counter rows are attacker-writable for never-registered emails (tiny; reaped by the auth-row purge). **Scope extension (R3-8, 2026-07-07/08):** the admin step-up mint (`POST /api/admin/step-up`) shares this per-email counter, so an unauthenticated attacker who knows an admin's email can sustain the lock and suppress step-up minting — blocking `revoke-sessions` / `payout-retry` / `deposit-refund` exactly during incident response. Accepted with the same rationale (lock-before-compare is non-negotiable); admin emails are not public, and the alternative — no lockout on the highest-privilege OTP surface — is worse. | Add CAPTCHA / progressive backoff on verify-otp at public launch if targeted-lockout abuse appears; the step-up extension raises the priority of that trigger. A break-glass path for a locked-out admin is the two-maintainer rotation (the other admin's email is independently rate-limited). `OTP_EMAIL_LOCKOUT_MS >= OTP_EMAIL_ATTEMPT_WINDOW_MS` is a load-time invariant (an expired lockout must meet a lapsed window). |
| **Mobile platform security deferred** (ADR 027: no SSL pinning / App Attest / jailbreak detection in Phase 1) | Phase-1 scope; each control has a documented Phase-2 trigger.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Per ADR 027's per-control triggers.                                                                                                                                                                                                                                                                                                                                                                                             |
| **Conservation trusts row state, not the chain** (INV-3 residual)                                             | A `failed` payout whose tx actually landed (CF-18 window) frees headroom that is genuinely backed. Kept small by the authoritative-hash re-check; kept visible by the A2 failed-rows alert.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | If the CF-18 window widens or failed-but-landed rows appear in the drift alert.                                                                                                                                                                                                                                                                                                                                                 |
| **Advisory npm audit / trivy / gitleaks** (pre-launch)                                                        | Security-scan CI jobs run but don't gate merge while pre-team.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Public launch — flip to required.                                                                                                                                                                                                                                                                                                                                                                                               |

## NOT accepted (these are gaps, fix them)

Anything not in the accepted-risk table that breaks an [invariant](invariants.md)
is a bug. In particular: an unbacked mint (INV-3), a double-pay to CTX
(INV-7), a double-refund (INV-8), a mirror desync (INV-1), or a
destructive admin write without step-up (INV-11) are never acceptable and
have no deferred-fix status.

---

## Review posture

For any diff touching an asset or crossing a trust boundary above:

1. Which asset does it expose, and which boundary does it move logic
   across?
2. Does it preserve every [invariant](invariants.md) in scope?
3. Does it match an accepted-risk tradeoff, or is it a new gap?
4. For upstream data: is it Zod-validated before it's trusted?

The `/review-money-diff` skill encodes this walk for ledger/Stellar/auth
diffs.
