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
 * Mints a fresh access + refresh pair for `user` and persists the
 * refresh row. Returns the token strings to send to the client plus
 * the refresh `jti` for internal revoke-linking (A2-557).
 */
export async function issueTokenPair(user: { id: string; email: string }): Promise<TokenPair> {
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
  await recordRefreshToken({
    jti: refresh.claims.jti,
    userId: user.id,
    token: refresh.token,
    expiresAt: new Date(refresh.claims.exp * 1000),
  });
  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    refreshJti: refresh.claims.jti,
  };
}
