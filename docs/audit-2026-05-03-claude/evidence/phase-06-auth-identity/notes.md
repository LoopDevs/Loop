# Phase 06 - Auth, Identity, and Sessions

Status: complete (pending Phase 25 synthesis)
Owner: lead (Claude)

## Files reviewed (primary)

- `apps/backend/src/auth/{handler,native,native-request-otp,social,identities,otps,jwt,jwks,id-token,id-token-replay,id-token-verify-with-key,issue-token-pair,refresh-tokens,tokens,request-schemas,require-auth,require-admin,logout-handler,authenticated-user,normalize-email,email}.ts`
- `apps/backend/src/routes/auth.ts`
- `apps/backend/src/db/users.ts` (findOrCreateUserByEmail, getUserById)
- `apps/backend/src/db/schema.ts` (users, otps, refresh_tokens, user_identities, social_id_token_uses)
- `apps/web/app/services/auth.ts`, `apps/web/app/stores/auth.store.ts`, `apps/web/app/hooks/use-auth.ts`, `use-session-restore.ts`

## Findings filed

- A4-002 Medium — native request-otp returns 500 on internal failure (enumeration sidechannel)
- A4-005 Medium — `requireAuth` falls through `bad_signature` to unsigned CTX pass-through
- A4-009 Low — `decodeJwtPayload` orphaned helper is footgun-shaped
- A4-010 Low — OTP row written before email send; failed sends count toward per-email cap
- A4-017 Medium — auth handlers log `email` directly; redaction needs verification

## Cross-file interactions

- `LOOP_AUTH_NATIVE_ENABLED` dispatches in `handler.ts:57,124,200` route to either `native.ts` (Loop-mint) or upstream CTX-proxy.
- `issueTokenPair` is shared by native verify-otp, native refresh, and both social handlers.
- `verifyLoopToken` checks signature against current AND previous keys for rotation overlap.
- Refresh rotation: `findLiveRefreshToken` matches PK + token-hash; reuse of a rotated refresh triggers `revokeAllRefreshTokensForUser` (defensive token-theft response).
- Social login: 3-step resolve — known (provider,sub) → known email → fresh insert. `email_verified` is enforced before linking.
- Replay defence on social id_tokens: SHA-256 of token stored in `social_id_token_uses` with PK constraint.

## Logic correctness

- Token verify is HS256 with iss/aud exact match, expiry check, type narrowing — robust.
- Race-safe identity linking via `onConflictDoNothing` on partial unique indexes.
- The native + CTX-proxy paths coexist as ADR-013 mandates.

## Code quality

- Strong: `verifyLoopToken` returns discriminated union (`reason: 'malformed' | 'bad_signature' | …`) so callers can branch.
- Quirk: `jwt.ts` decodes unsigned and is exported — see A4-009.

## Documentation accuracy

- AGENTS.md (root) describes the dual-path correctly. ADR-013 implementation aligns. Phase B/C completion criteria not stated in any doc.

## Test coverage / accuracy

- Refresh rotation tested. Social handler tests cover firstUse path. Replay-defence has its own test.
- Gap: no test pins the per-route rate-limit isolation (see A4-001) on the auth surface specifically.

## Cross-phase notes

- Phase 17 (security) inherits A4-005, A4-017.
- Phase 13 (workers) inherits the OTP cleanup interaction from cleanup.ts.
- Phase 21 (docs) inherits A4-067 (AGENTS.md presents legacy CTX-proxy as primary).
