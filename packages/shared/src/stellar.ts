/**
 * Stellar address helpers (ADR 015 / 016).
 *
 * Single source of truth for Stellar public-key validation. The
 * regex was previously duplicated across:
 *   - `apps/backend/src/users/handler.ts` (stellar-address write)
 *   - `apps/backend/src/env.ts` (issuer + operator env vars)
 *   - `apps/backend/src/openapi.ts` (user view schema)
 *   - `apps/web/app/routes/settings.wallet.tsx` (client-side hint)
 *
 * Keeping them in lockstep by convention was the stated shape of
 * the bug waiting to happen — if one branch relaxed the regex to
 * accept `M...` muxed accounts, the others wouldn't follow and a
 * muxed address would slip past the boundary validator and fail
 * deeper in the stack.
 *
 * The regex pins the ED25519-account shape Stellar has been stable
 * on since mainnet launch: `G` + 55 base32 chars (total 56).
 */

/**
 * Stellar ED25519 public-key regex. `G` + 55 base32 chars (A-Z2-7).
 * Does NOT cover muxed accounts (`M...`) — Loop rejects muxed on
 * purpose because our memo-based attribution would collide with
 * muxed subaccount resolution.
 *
 * A2-820 / A2-821: the previous `isStellarPublicKey(s): s is string`
 * helper has been removed. It declared a no-op type predicate
 * (the input was already `string`, so narrowing produced no new
 * type information) and had zero callers — every consumer used
 * `STELLAR_PUBKEY_REGEX.test(s)` directly. Dropping the helper
 * leaves one less near-duplicate API to keep in sync.
 */
export const STELLAR_PUBKEY_REGEX: RegExp = /^G[A-Z2-7]{55}$/;
