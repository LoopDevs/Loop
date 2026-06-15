# Cold Audit — V1 Auth vertical — raw findings

Branch examined: `fix/stranded-order-hardening` (≈ main). RS256/JWKS work
(`jwks-publish.ts`, `Rs256Signer`, RS256 verify dispatch fill) lives ONLY on
`feat/wallet-phase-a-rs256-jwks` / `origin/feat/backend-rs256-signer-abstraction`
and is ABSENT from main — confirmed `jwks-publish.ts` not in working tree.
Main's `signer.ts` `getVerifiersForAlg('RS256')` returns `[]`, so an RS256-header
token always fails `bad_signature` on main. No alg-confusion exposure on main.

Overall: this is a mature, heavily-iterated auth surface (A2-/A4- fix tags
throughout). Most of the obvious attack classes (alg=none, alg-confusion,
iss/aud pinning, refresh reuse-detection + CAS rotation, OTP attempt cap,
enumeration defense, id_token replay, constant-time HMAC compares, log
redaction) are already handled and tested. Findings below are mostly the
residual seams.

---

### [P1] Loop-native auth has no admin-grant path — admin surface unreachable when `LOOP_AUTH_NATIVE_ENABLED=true`

- severity: P1
- file: apps/backend/src/db/users.ts:38,108-126 / apps/backend/src/auth/require-admin.ts:37-59 / apps/backend/src/auth/identities.ts:95-104
- impact: With `LOOP_AUTH_NATIVE_ENABLED=true` (the documented pre-launch / launch posture per ADR 013 and `authenticated-user.ts:19-21`), every authenticated session is `kind: 'loop'`. `requireAdmin` rejects `kind !== 'loop'` (so a CTX-proxy bearer can never be admin) AND then gates on `user.isAdmin`. But Loop-native users are created exclusively by `findOrCreateUserByEmail` / `resolveOrCreateUserForIdentity`, both of which insert with the schema default `is_admin = false`. The `ADMIN_CTX_USER_IDS` allowlist is only consulted in `upsertUserFromCtx` (keyed on `ctx_user_id`), which the loop-native path never calls. There is no env var, code path, migration, or seed that sets `is_admin = true` for a UUID-anchored Loop-native user. Net: once native auth is on, the entire `/api/admin/*` surface returns 404 to everyone, including the intended operator — admin tooling (credit-adjust, withdrawals, payout-retry, treasury, reconciliation) is operationally dead.
- evidence: `grep -rn "isAdmin|is_admin"` across `apps/backend/src` finds writes ONLY in `upsertUserFromCtx` (ctx-keyed). No `ADMIN_LOOP_*` / `ADMIN_EMAIL` / grant verb / migration touching `is_admin`. `require-admin.test.ts` only ever mocks `getUserById` to return `isAdmin:true` — it never exercises "how does a real loop-native user become admin."
- fix: Add a Loop-native admin source — e.g. `ADMIN_EMAILS` env allowlist evaluated in `findOrCreateUserByEmail` / on resolve, or a `LOOP_ADMIN_USER_IDS` allowlist checked in `requireAdmin`, or an operator migration/`grantAdmin` script. Whichever, gate it behind env (config-not-DB-write parity with the CTX path) and add a test proving a real native session reaches an admin route.
- ref: ADR 013 (loop-owned auth), ADR 017/018/022 (admin), checklist §2 AuthZ / §17 / Part 5 completeness

### [P2] OTP verify is not transactional / not consume-once under concurrency

- severity: P2
- file: apps/backend/src/auth/native.ts:80-93 / apps/backend/src/auth/otps.ts:116-122
- impact: `nativeVerifyOtpHandler` does `findLiveOtp` (read) then `markOtpConsumed` (unconditional UPDATE) with no wrapping transaction and no compare-and-set on `consumed_at IS NULL`. Two concurrent verify-otp requests presenting the same still-live code both pass `findLiveOtp` (row unconsumed) and both proceed to `findOrCreateUserByEmail` + `issueTokenPair`, minting two independent session pairs from one OTP. Same-user blast radius (you must know the code), so not a privilege issue — but it breaks the "single-use" contract the module docstring asserts, and it is the exact CAS pattern the refresh path (`tryRevokeIfLive`, A4-098) was hardened with. The doc comment at `otps.ts:116` ("Called inside the verify-otp txn on success") is a lie — there is no txn.
- evidence: `grep "transaction|tx" auth/native.ts` → no matches. `markOtpConsumed` is `db.update(...).set({consumedAt}).where(eq(otps.id,id))` with no `isNull(consumedAt)` guard. `native.test.ts` has no consume-once-race test (it has one for refresh rotation only).
- fix: Make consume a CAS: `UPDATE otps SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL RETURNING id`; treat zero rows as "already consumed → 401". Optionally wrap find+consume+mint in a txn. Add a concurrent-verify test. Fix the `otps.ts:116` comment to match reality.
- ref: checklist §11 concurrency (OTP consume-once races), §1 correctness

### [P2] Wrong-guess burns the victim's newest live OTP (targeted DoS via known email)

- severity: P2
- file: apps/backend/src/auth/native.ts:82-86 / apps/backend/src/auth/otps.ts:138-158
- impact: On any failed verify (`findLiveOtp` returns null), the handler calls `incrementOtpAttempts({email})`, which bumps `attempts` on the SINGLE NEWEST live row for that email (A2-561 scoped it to newest-only). An attacker who knows a victim's email can, without the victim's code, POST 5 wrong guesses to `verify-otp` and drive the newest live OTP's `attempts` to `OTP_MAX_ATTEMPTS`, after which `findLiveOtp`'s `lt(attempts, MAX)` filter excludes it — the victim's just-requested legitimate code now 401s. Per-IP rate limit (10/min) and the 5-attempt cap mean a single IP can lock out a code in well under a minute; the per-email-per-minute cap (3) is on _request-otp_, not verify, so it doesn't bound this. The victim re-requests and the attacker repeats. It is a nuisance/login-prevention DoS, not a credential compromise.
- evidence: `findLiveOtp` filters `lt(otps.attempts, OTP_MAX_ATTEMPTS)`; `incrementOtpAttempts` targets `ORDER BY createdAt DESC LIMIT 1`. The increment runs whenever `findLiveOtp` is null, i.e. on every wrong/garbage code, regardless of whether the attacker holds any valid code.
- fix: Only count attempts that actually targeted an existing row, or cap attempts per (email,window) rather than burning the newest row, or require the attempt-bump to match the submitted code's row. At minimum document the trade-off; the current shape lets attempts-exhaustion be driven by a party who never had the code.
- ref: checklist §2 rate-limiting/DoS, §1 boundary conditions

### [P2] Per-email OTP request cap is a non-atomic check-then-act (TOCTOU)

- severity: P2
- file: apps/backend/src/auth/native-request-otp.ts:71-81 / apps/backend/src/auth/otps.ts:69-80
- impact: `countRecentOtpsForEmail` (SELECT count) then conditional `createOtp` (INSERT) is read-then-write with no lock or unique constraint. N concurrent `request-otp` for the same email all read count < cap and all insert, exceeding `OTP_REQUESTS_PER_EMAIL_PER_MINUTE`. Bounded by the per-IP 5/min limiter so real-world over-issue is small, but the per-email cap (the stated defense against IP-rotation flooding of one inbox) is not actually atomic — a botnet across IPs can burst past it. Low impact (extra emails, not a security boundary).
- evidence: no `FOR UPDATE`, no advisory lock, no unique partial index on (email, minute-bucket).
- fix: Acceptable to leave as best-effort given the IP limiter; if tightening is wanted, use an advisory lock on `hashtext(email)` or a rate row with `INSERT ... ON CONFLICT` increment.
- ref: checklist §11 concurrency, §2 OTP/enumeration abuse

### [P3] `markOtpConsumed` doc comment claims a transaction that doesn't exist

- severity: P3
- file: apps/backend/src/auth/otps.ts:116
- impact: Comment "Called inside the verify-otp txn on success" misleads a future maintainer into assuming atomicity that isn't there (see P2 above). Doc-vs-code drift on a security primitive.
- evidence: caller `native.ts:88` calls it bare, no txn.
- fix: correct the comment (or add the txn and keep it).
- ref: checklist §5 inline comments truthful

### [P3] `email.ts` references a non-existent table name `auth_otps`

- severity: P3
- file: apps/backend/src/auth/email.ts:38
- impact: Comment tells devs to read the OTP code from the `auth_otps` DB row; the actual table is `otps` (schema.ts:340). Minor doc inaccuracy; a dev following the hint queries a missing table.
- evidence: `schema.ts` defines `pgTable('otps', ...)`; no `auth_otps` anywhere.
- fix: s/auth_otps/otps/.
- ref: checklist §5 docs match code

### [P3] Redaction has `*.otp` but not `*.code`; `code` only covered at top level

- severity: P3
- file: apps/backend/src/logger.ts:39-41
- impact: `REDACT_PATHS` includes `otp`, `code`, `*.otp` but NOT `*.code`. The one current emitter (ConsoleEmailProvider) logs `code` top-level so it IS redacted in prod, and that provider is barred from prod anyway. But any future handler that logs a nested `{ ..., code }` one level deep (e.g. inside a request body object) would leak the OTP. Defense-in-depth gap, not a live leak.
- evidence: line 40 `'code'` present, no `'*.code'` sibling next to `'*.otp'` at line 41.
- fix: add `'*.code'` (and `'*.*.code'`) for symmetry with the token paths.
- ref: checklist §6 redaction, §16 redaction in logs

### [P3] Social email-merge (step 2) can attach an identity to a CTX-anchored user row

- severity: P3
- file: apps/backend/src/auth/identities.ts:64-82
- impact: Step 2 resolves by `eq(users.email, email)` with no `ctx_user_id IS NULL` filter, so a provider-verified social login for email X links its identity to ANY users row with email X — including a CTX-anchored (legacy/admin) row. Because the provider asserts `email_verified=true` and the user demonstrably controls that mailbox, this is the intended account-merge per ADR 014, not a takeover (an attacker would need to control the mailbox). Flagged only because the partial unique index `users_email_loop_native_unique` (ctx_user_id IS NULL) does NOT prevent a same-email collision across the two identity planes, so the merge target selection is ambiguous when both a CTX row and a native row share an email — the `findFirst` picks whichever the planner returns first.
- evidence: step-2 query lacks the `ctx_user_id IS NULL` predicate that schema.ts:84 uses to scope native uniqueness; comment at schema.ts:81-83 explicitly notes the two planes may share an email.
- fix: decide intended merge semantics across planes and pin the SELECT (e.g. prefer the native row, or order deterministically); add a test for the dual-plane same-email case.
- ref: ADR 014, checklist §2 IDOR / §9 nullability matches code assumptions

### [P3] RS256/JWKS verify path is a documented-but-unbuilt stub on main (status note, not a bug)

- severity: P3
- file: apps/backend/src/auth/signer.ts:49-55,81-97 / apps/backend/src/auth/tokens.ts:165-169
- impact: `tokens.ts` docstrings + `signer.ts` comments describe an HS256→RS256 rotation where "both algorithms verify," but on main `getVerifiersForAlg('RS256')` returns `[]` and there is no `Rs256Signer`/`jwks-publish.ts`. An RS256-header token always fails closed (`bad_signature`) — correct/safe — but the docs read as if RS256 acceptance is live. The real implementation is on `feat/wallet-phase-a-rs256-jwks` (188-line signer.ts delta + jwks-publish.ts + rs256.test.ts). When that branch merges, re-audit: alg-confusion (RS256 public key used as HS256 secret), kid pinning, JWKS-publish endpoint exposure, and that `verifyLoopToken` still rejects an attacker-chosen `alg` swap on a token whose payload they control.
- evidence: `jwks-publish.ts` ABSENT in working tree; `git diff main..feat/wallet-phase-a-rs256-jwks` shows +572 lines across signer/tokens/jwks-publish.
- fix: none on main (fail-closed is correct). Track the branch merge as the trigger for an RS256-specific re-audit; consider trimming the "both algorithms verify" language until it's true.
- ref: ADR 030 Track A.2, checklist §2 alg-confusion, Part 5 completeness (gated/half-built)

### [P3] `findRefreshTokenRecord` reuse-detection only fires when the row still exists; expired-row cleanup blinds it

- severity: P3
- file: apps/backend/src/auth/native.ts:132-150 / apps/backend/src/auth/refresh-tokens.ts:80-85
- impact: Reuse-detection (family-wide revoke on presenting an already-rotated refresh) depends on `findRefreshTokenRecord(jti)` finding a row with `revoked_at != null`. The `refresh_tokens_expires` index comment (schema.ts:388-391) and ADR notes reference a periodic cleanup job that trims fully-expired rows. If that job deletes a revoked-but-expired row, a later replay of that (signed, now-expired) token would hit the `record === null` branch → plain 401, no family revoke. But the token is already expired so `verifyLoopToken` returns `expired` BEFORE the DB lookup (native.ts:120-123) — so the replay never reaches reuse-detection anyway, and an expired stolen refresh is useless. Net effect is benign on the current logic; flag is that the reuse-detection guarantee is implicitly time-bounded by token TTL and assumes cleanup never deletes a not-yet-expired revoked row. Verify any cleanup job's WHERE clause requires `expires_at < now()` (so it can't prune a live-but-revoked lineage that the attacker could still present).
- evidence: cleanup job not in scope dir; relationship reasoned from `verifyLoopToken` expiry-before-DB ordering + the schema's stated cleanup intent.
- fix: confirm cleanup deletes only rows past `expires_at`; add a comment to `findRefreshTokenRecord` documenting that reuse-detection is bounded by refresh TTL.
- ref: checklist §11 reuse-detection, §9 retention/cleanup

---

## Coverage

Files examined in full:

- apps/backend/src/auth/otps.ts
- apps/backend/src/auth/tokens.ts
- apps/backend/src/auth/signer.ts
- apps/backend/src/auth/refresh-tokens.ts
- apps/backend/src/auth/native.ts
- apps/backend/src/auth/native-request-otp.ts
- apps/backend/src/auth/issue-token-pair.ts
- apps/backend/src/auth/handler.ts
- apps/backend/src/auth/logout-handler.ts
- apps/backend/src/auth/require-auth.ts
- apps/backend/src/auth/require-admin.ts
- apps/backend/src/auth/authenticated-user.ts
- apps/backend/src/auth/social.ts
- apps/backend/src/auth/id-token.ts
- apps/backend/src/auth/id-token-verify-with-key.ts
- apps/backend/src/auth/jwks.ts
- apps/backend/src/auth/id-token-replay.ts
- apps/backend/src/auth/identities.ts
- apps/backend/src/auth/normalize-email.ts
- apps/backend/src/auth/email.ts
- apps/backend/src/auth/request-schemas.ts
- apps/backend/src/auth/admin-step-up.ts
- apps/backend/src/auth/admin-step-up-middleware.ts
- apps/backend/src/middleware/kill-switch.ts
- apps/backend/src/kill-switches.ts (auth-relevant)
- apps/backend/src/routes/auth.ts
- apps/backend/src/db/users.ts
- apps/backend/src/db/schema.ts (otps / refresh_tokens / user_identities / users / social_id_token_uses sections + indexes/CHECKs)
- apps/backend/src/logger.ts (REDACT_PATHS, redaction relevant to auth)
- apps/web/app/services/auth.ts
- apps/web/app/stores/auth.store.ts
- apps/web/app/hooks/use-auth.ts
- apps/web/app/services/api-client.ts (tryRefresh / authenticatedRequest / 401-retry / step-up plumbing)
- apps/web/app/native/secure-storage.ts

Examined for context (not full read): env.ts (auth vars), auth test directory listing
(17 test files present: tokens, signer, otps, refresh-tokens, native,
native-refresh-race, handler, logout via handler, require-auth, require-admin,
social, id-token, id-token-replay, identities, normalize-email, email,
admin-step-up, admin-step-up-middleware — alg=none / alg-confusion / unknown-alg
all covered in tokens.test.ts; A4-098 CAS race covered in native.test.ts +
native-refresh-race.test.ts). No web `components/auth/` dir — auth UI lives under
`components/features/auth` (not deep-read; out of the named scope).

Branch-vs-main: RS256/JWKS (jwks-publish.ts, Rs256Signer, RS256 verifier fill)
confirmed ABSENT on main, present only on feat/wallet-phase-a-rs256-jwks +
origin/feat/backend-rs256-signer-abstraction.

## Summary

- P0: 0
- P1: 1
- P2: 3
- P3: 5
- Total: 9
