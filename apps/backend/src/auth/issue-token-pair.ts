/**
 * Mints + persists a Loop access/refresh token pair (ADR 013).
 *
 * Lifted out of `./native.ts` and `./social.ts`, both of which
 * shipped near-identical local copies (the social file's docstring
 * explicitly noted "factored here so social-login calls don't
 * re-import auth/native.ts"). Sharing the helper closes the DRY
 * gap and ensures both sides of the auth surface use the same
 * refresh-token persistence shape.
 *
 * Used by:
 *   - `nativeVerifyOtpHandler` (first issue on OTP success)
 *   - `nativeRefreshHandler` (rotation: also reads `refreshJti` to
 *     populate the prior row's `replacedByJti` link, A2-557)
 *   - `googleSocialLoginHandler` / `appleSocialLoginHandler`
 *     (first issue on social-login success — discards `refreshJti`,
 *     mirroring the OTP first-issue path)
 *
 * Re-exported from `./native.ts` so existing import sites (the
 * verify + refresh handlers in their post-lift form) keep
 * resolving against the historical path; social.ts imports
 * directly from this module.
 */
import {
  signLoopToken,
  DEFAULT_ACCESS_TTL_SECONDS,
  DEFAULT_REFRESH_TTL_SECONDS,
} from './tokens.js';
import { recordRefreshToken } from './refresh-tokens.js';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /**
   * A2-557: jti of the freshly-minted refresh token. Returned
   * alongside the token strings so `nativeRefreshHandler` can
   * populate the `replacedByJti` link on the prior row without
   * re-verifying the token it just signed. The client contract
   * (`{ accessToken, refreshToken }`) is unchanged — first-issue
   * call sites strip this field at the handler boundary.
   */
  refreshJti: string;
}

/**
 * A4-098: a signed-but-not-yet-persisted pair. Carries everything
 * `persistMintedRefreshToken` needs to write the `refresh_tokens`
 * row later, so the refresh handler can win the rotation
 * compare-and-set BEFORE the successor row exists. Never return the
 * extra fields to the client — handlers strip down to
 * `{ accessToken, refreshToken }` at the boundary.
 */
export interface MintedTokenPair extends TokenPair {
  /** User the pair was minted for — consumed by the deferred persist. */
  userId: string;
  /** Refresh JWT expiry — persisted onto the `refresh_tokens` row. */
  refreshExpiresAt: Date;
}

/**
 * Signs a fresh access + refresh pair for `user` WITHOUT persisting
 * the refresh row. Split out of `issueTokenPair` for A4-098: the
 * refresh handler needs the successor `jti` before the rotation
 * compare-and-set, but must not insert the successor row until the
 * CAS is won — otherwise the losing side of a concurrent rotation
 * leaves an orphaned live row behind. Pair with
 * `persistMintedRefreshToken`.
 */
export function mintTokenPair(user: { id: string; email: string }): MintedTokenPair {
  const access = signLoopToken({
    sub: user.id,
    email: user.email,
    typ: 'access',
    ttlSeconds: DEFAULT_ACCESS_TTL_SECONDS,
  });
  const refresh = signLoopToken({
    sub: user.id,
    email: user.email,
    typ: 'refresh',
    ttlSeconds: DEFAULT_REFRESH_TTL_SECONDS,
  });
  if (refresh.claims.jti === undefined) {
    // signLoopToken always sets jti on a refresh; this branch keeps
    // TS narrowing clean without an `!` assertion.
    throw new Error('refresh token missing jti');
  }
  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    refreshJti: refresh.claims.jti,
    userId: user.id,
    refreshExpiresAt: new Date(refresh.claims.exp * 1000),
  };
}

/**
 * Persists the `refresh_tokens` row for a pair previously signed by
 * `mintTokenPair`. The deferred half of the A4-098 split — callers
 * invoke this only after the rotation compare-and-set succeeded
 * (or, for first-issue paths, immediately via `issueTokenPair`).
 */
export async function persistMintedRefreshToken(minted: MintedTokenPair): Promise<void> {
  await recordRefreshToken({
    jti: minted.refreshJti,
    userId: minted.userId,
    token: minted.refreshToken,
    expiresAt: minted.refreshExpiresAt,
  });
}

/**
 * Mints a fresh access + refresh pair for `user` and persists the
 * refresh row. Returns the token strings to send to the client plus
 * the refresh `jti` for internal revoke-linking (A2-557).
 *
 * First-issue convenience (verify-otp + social login) — there is no
 * prior row to race against, so mint + persist in one step is safe.
 * Rotation (`nativeRefreshHandler`) must NOT use this: it calls
 * `mintTokenPair` / `persistMintedRefreshToken` around the
 * `tryRevokeIfLive` compare-and-set instead (A4-098).
 */
export async function issueTokenPair(user: { id: string; email: string }): Promise<TokenPair> {
  const minted = mintTokenPair(user);
  await persistMintedRefreshToken(minted);
  return {
    accessToken: minted.accessToken,
    refreshToken: minted.refreshToken,
    refreshJti: minted.refreshJti,
  };
}
