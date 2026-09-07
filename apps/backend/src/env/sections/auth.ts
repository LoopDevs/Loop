/**
 * env section (hardening D2 split): a field-map spread into the
 * composed `EnvSchema` in `../../env.ts`. Add new vars for this
 * domain HERE — keeps `env.ts` from being a merge-conflict magnet.
 */
import { z } from 'zod';
import { envBoolean, signingKeySchema, rsaPrivateKeyPem } from '../schema-helpers.js';

export const authEnvFields = {
  // Loop-signed JWT secret (ADR 013). Used to sign and verify access
  // + refresh tokens minted by Loop's own auth path. Required in
  // production; absent in development / test the backend skips
  // Loop-native auth (CTX proxy remains in place).
  //
  // HS256 is a symmetric secret — minimum 32 bytes of entropy.
  // Rotation: set LOOP_JWT_SIGNING_KEY to the new value and
  // LOOP_JWT_SIGNING_KEY_PREVIOUS to the old one for the access-token
  // TTL window; the verifier accepts either, the signer always uses
  // the current. Drop PREVIOUS after the TTL elapses.
  LOOP_JWT_SIGNING_KEY: signingKeySchema('LOOP_JWT_SIGNING_KEY'),
  LOOP_JWT_SIGNING_KEY_PREVIOUS: signingKeySchema('LOOP_JWT_SIGNING_KEY_PREVIOUS'),

  // RS256 signing keys (ADR 030 Phase A). PEM-encoded PKCS8 RSA
  // private key; when set, newly-minted Loop JWTs sign RS256 with a
  // `kid` header (RFC 7638 thumbprint) and the matching public keys
  // publish at `GET /.well-known/jwks.json` so an external wallet
  // provider (Privy custom auth — or any JWKS consumer) can verify
  // Loop's tokens without sharing a secret. Unset → HS256 signing
  // via LOOP_JWT_SIGNING_KEY continues unchanged (rollout safety).
  //
  // Generate: `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`
  // Rotation: set LOOP_JWT_RSA_PRIVATE_KEY to the new PEM and
  // LOOP_JWT_RSA_PRIVATE_KEY_PREVIOUS to the old one for the
  // refresh-token TTL window (30 days); both public keys serve in the
  // JWKS, the signer always uses the current. Malformed / non-RSA
  // PEMs fail boot (see `rsaPrivateKeyPem` above). Escaped "\n"
  // sequences are normalised to newlines at parse time.
  LOOP_JWT_RSA_PRIVATE_KEY: rsaPrivateKeyPem.optional(),
  LOOP_JWT_RSA_PRIVATE_KEY_PREVIOUS: rsaPrivateKeyPem.optional(),

  // Gift-card redeem-secret envelope key (CF-25 / X-PRIV-03). When set,
  // `orders.redeem_code` / `redeem_pin` are AES-256-GCM-encrypted at
  // rest (orders/redeem-crypto.ts) so a logical DB read (leaked
  // DATABASE_URL, rogue loop_readonly SELECT, backup exfiltration)
  // sees ciphertext, not spendable bearer codes. `redeem_url` stays
  // plaintext (it's the redemption landing page, not the secret).
  //
  // 32 bytes, supplied as base64 / base64url or hex. Validated at boot
  // (env.ts) so a wrong-length key fails loudly instead of silently
  // writing un-decryptable ciphertext. NS-10: REQUIRED in production —
  // env.ts fails closed at boot when it is unset in prod (spendable
  // bearer secrets must not sit in plaintext at rest), with a `"1"`-only
  // DISABLE_REDEEM_ENCRYPTION_ENFORCEMENT rollback opt-out. Absent in
  // dev/test → encryption is disabled and codes are stored plaintext
  // (legacy behaviour); index.ts logs a single boot warn while unset.
  // Decrypt is backward-safe: old plaintext rows and key-unset writes
  // pass through untouched, so setting the key activates encryption for
  // new writes; `scripts/backfill-redeem-encryption.ts` encrypts any
  // pre-existing plaintext rows as a deploy step. NOT a JWT/HMAC secret
  // — keep it separate.
  LOOP_REDEEM_ENCRYPTION_KEY: z.string().optional(),

  // Loop-native auth feature flag (ADR 013). When true, /request-otp
  // (and, as they ship, /verify-otp + /refresh) take the Loop-native
  // path: Loop sends the OTP email and mints its own JWTs. Default
  // false → the legacy CTX-proxy auth path stays in place.
  LOOP_AUTH_NATIVE_ENABLED: envBoolean.default(false),

  // Attributed-operator-traffic contract: async CTX customer
  // provisioning at signup/login (`ctx/user-provisioning.ts`). When
  // true (and the `GIFT_CARD_API_KEY`/`_SECRET` operator credentials
  // are set), each Loop-native user gets a CTX customer created
  // under Loop's operator company — silent, fire-and-forget, never
  // blocking auth — and the returned id lands in `users.ctx_user_id`
  // so procurement can act-as the customer (`X-User-Id`). Default
  // true — attribution is the intended posture wherever the operator
  // credentials exist; set false to fall back to anonymous operator
  // traffic (e.g. an environment with no CTX-side Loop company).
  CTX_USER_PROVISIONING_ENABLED: envBoolean.default(true),

  // Phase 1 launch gate. When true, the public + onboarding surfaces
  // hide every Phase 2 cashback / wallet / LOOP-asset element so the
  // app reads as a pure XLM-via-CTX gift-card store. The Phase 2
  // backend code paths (payout submit, asset-drift watcher,
  // interest accrual) are independently gated on their own config
  // (Stellar secrets / LOOP_AUTH_NATIVE_ENABLED /
  // INTEREST_APY_BASIS_POINTS) — those should also be off in a
  // Phase 1 deployment. This flag is the *UI-side* equivalent: hides
  // /cashback, /settings/wallet, /settings/cashback, the navbar
  // links, the cashback rate badges on merchant cards, the
  // currency picker + wallet-intro onboarding screens, and any
  // "you've earned X" surfaces.
  //
  // Set to false (default) once the operator is ready to launch
  // cashback as v1.1 — flipping the flag is server-side only;
  // no app-store resubmission needed.
  LOOP_PHASE_1_ONLY: envBoolean.default(false),

  // Social login — Google (ADR 014). One client id per platform;
  // at least one must be set to activate the Google endpoint. The
  // id_token's `aud` must match one of these values. Generate in
  // Google Cloud Console → APIs & Services → Credentials.
  GOOGLE_OAUTH_CLIENT_ID_WEB: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_ID_IOS: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_ID_ANDROID: z.string().optional(),

  // Social login — Apple (ADR 014). The service id (web) / bundle id
  // (native). Apple's id_token `aud` must match this. Absent →
  // /api/auth/social/apple returns 404.
  APPLE_SIGN_IN_SERVICE_ID: z.string().optional(),
};
