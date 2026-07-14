/**
 * env section (hardening D2 split): a field-map spread into the
 * composed `EnvSchema` in `../../env.ts`. Add new vars for this
 * domain HERE — keeps `env.ts` from being a merge-conflict magnet.
 */
import { z } from 'zod';
import {
  envBoolean,
  signingKeySchema,
  rsaPrivateKeyPem,
  STELLAR_ADDRESS_MESSAGE,
} from '../schema-helpers.js';
import { STELLAR_PUBKEY_REGEX } from '@loop/shared';

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

  // Admin step-up signing key (ADR 028, A4-063). Separate from
  // LOOP_JWT_SIGNING_KEY so a JWT-key compromise doesn't widen to
  // step-up — an attacker who exfiltrates LOOP_JWT_SIGNING_KEY can
  // still mint access tokens but cannot mint step-up tokens, so the
  // ADR-028 gate (X-Admin-Step-Up on credit-adjust / emissions /
  // payout-retry) holds even under partial key compromise.
  //
  // Optional in `env.ts` so the surface ships without breaking
  // deployments that haven't generated the key yet; the boot
  // validator below downgrades the gate to "always 401" when the
  // key is unset, so the surface fails closed rather than silently
  // skipping the check.
  //
  // Rotation: same staged-rotation pattern as LOOP_JWT_SIGNING_KEY.
  // Set `_PREVIOUS` to the old key during the 5-minute step-up TTL
  // window; the verifier accepts either, the signer always uses
  // the current.
  LOOP_ADMIN_STEP_UP_SIGNING_KEY: signingKeySchema('LOOP_ADMIN_STEP_UP_SIGNING_KEY'),
  LOOP_ADMIN_STEP_UP_SIGNING_KEY_PREVIOUS: signingKeySchema(
    'LOOP_ADMIN_STEP_UP_SIGNING_KEY_PREVIOUS',
  ),

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

  // Phase 1 launch gate. When true, the public + onboarding surfaces
  // hide every Phase 2 cashback / wallet / LOOP-asset element so the
  // app reads as a pure XLM-via-CTX gift-card store. The Phase 2
  // backend code paths (workers, payout submit, asset-drift watcher,
  // interest accrual) are independently gated on
  // LOOP_WORKERS_ENABLED / LOOP_AUTH_NATIVE_ENABLED /
  // INTEREST_APY_BASIS_POINTS — those should also be off in a Phase 1
  // deployment. This flag is the *UI-side* equivalent: hides
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

  // Loop's Stellar deposit address for Loop-native orders (ADR 010).
  // Users paying with XLM / USDC send to this address, encoding the
  // order's payment memo in the transaction's memo_text so the
  // watcher can match payment → order. Absent → /api/orders/loop
  // returns 503 for xlm / usdc methods; credit-funded orders still
  // work because they don't cross-chain.
  LOOP_STELLAR_DEPOSIT_ADDRESS: z
    .string()
    .regex(STELLAR_PUBKEY_REGEX, { message: STELLAR_ADDRESS_MESSAGE })
    .optional(),

  // USDC issuer account for the watcher's asset-match guard. Circle
  // on mainnet: GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN.
  // AUDIT-2 finding A: defaults to undefined → the watcher's
  // issuer-match guard (horizon.ts: isMatchingIncomingPayment) fails
  // CLOSED — it matches NO USDC deposit, never "any issuer" (Stellar
  // asset codes aren't unique; an unpinned issuer would otherwise let
  // an attacker's self-issued fake "USDC" mark a real order paid).
  // `parseEnv` boot-fails in production when this is unset (unless
  // DISABLE_USDC_ISSUER_ENFORCEMENT=1) and separately warns at boot
  // when it's set on mainnet to anything other than the canonical
  // Circle issuer (launch-runbook typo tripwire — see
  // CANONICAL_MAINNET_USDC_ISSUER above).
  LOOP_STELLAR_USDC_ISSUER: z
    .string()
    .regex(STELLAR_PUBKEY_REGEX, { message: STELLAR_ADDRESS_MESSAGE })
    .optional(),

  // Issuer accounts for the three LOOP-branded Stellar assets (ADR 015).
  // Loop issues USDLOOP / GBPLOOP / EURLOOP 1:1-backed against fiat
  // reserves in regulated bank accounts, and pays cashback in the
  // asset matching the user's home currency. Absent → the payout
  // worker treats cashback as off-chain-only for that currency
  // (ledger row written, Stellar side skipped) so a partially-
  // configured deployment doesn't block fulfillment of orders from
  // users whose currency is wired up.
  LOOP_STELLAR_USDLOOP_ISSUER: z
    .string()
    .regex(STELLAR_PUBKEY_REGEX, { message: STELLAR_ADDRESS_MESSAGE })
    .optional(),
  LOOP_STELLAR_GBPLOOP_ISSUER: z
    .string()
    .regex(STELLAR_PUBKEY_REGEX, { message: STELLAR_ADDRESS_MESSAGE })
    .optional(),
  LOOP_STELLAR_EURLOOP_ISSUER: z
    .string()
    .regex(STELLAR_PUBKEY_REGEX, { message: STELLAR_ADDRESS_MESSAGE })
    .optional(),

  // Per-asset ISSUER secret keys (ADR 031 / ADR 036 Phase D). A
  // payment FROM the issuer account is a native mint on Stellar —
  // the nightly interest worker enqueues `kind='interest_mint'`
  // payout rows and the payout worker signs those (and only those)
  // with the matching issuer keypair instead of the operator key.
  // `parseEnv` below boot-fails when a secret is set without its
  // `LOOP_STELLAR_<ASSET>_ISSUER` address, or when the keypair
  // derived from the secret doesn't match that address — a mismatch
  // would sign mint payments from a *different* account (a transfer,
  // not a mint), silently corrupting issuance accounting.
  // Never logged (pino redaction). Rotation: an issuer key rotation
  // is a treasury event (the asset identity is the issuer account),
  // not an env-var swap — see docs/runbooks/stellar-operator-rotation.md.
  LOOP_STELLAR_USDLOOP_ISSUER_SECRET: z
    .string()
    .regex(/^S[A-Z2-7]{55}$/, { message: 'must be a valid Stellar secret key (S...)' })
    .optional(),
  LOOP_STELLAR_GBPLOOP_ISSUER_SECRET: z
    .string()
    .regex(/^S[A-Z2-7]{55}$/, { message: 'must be a valid Stellar secret key (S...)' })
    .optional(),
  LOOP_STELLAR_EURLOOP_ISSUER_SECRET: z
    .string()
    .regex(/^S[A-Z2-7]{55}$/, { message: 'must be a valid Stellar secret key (S...)' })
    .optional(),

  // ADR 031 / ADR 036 Phase D: nightly on-chain interest mints.
  // When true (and at least one issuer SECRET above is configured,
  // and INTEREST_APY_BASIS_POINTS > 0, and LOOP_WORKERS_ENABLED),
  // the interest-mint worker replaces the legacy off-chain-only
  // accrual scheduler: each UTC day it snapshots activated-wallet
  // LOOP balances from Horizon, credits the `user_credits` mirror
  // (`credit_transactions type='interest'`) and enqueues an
  // on-chain mint (`pending_payouts kind='interest_mint'`) in one
  // transaction per user. The legacy `accrue-interest.ts` path is
  // hard-gated off while this flag is true — two interest writers
  // must never coexist (the halves would diverge nightly).
  LOOP_INTEREST_ONCHAIN_ENABLED: envBoolean.default(false),

  // Procurement USDC-reserve floor (ADR 015). When the operator account's
  // USDC balance drops below this many stroops (7 decimals; 10^7 = 1 USDC),
  // procurement falls back to paying CTX in XLM instead — trades a small
  // XLM burn for unblocking fulfillment while the ops top-up is in flight.
  // Absent → the fallback is disabled and procurement always uses USDC.
  // Below-floor events are ops-flagged in admin/treasury so the operator
  // sees them immediately (ADR 015 treasury strategy).
  LOOP_STELLAR_USDC_FLOOR_STROOPS: z.coerce.bigint().nonnegative().optional(),

  // Operator Stellar secret key for outbound payouts (ADR 016).
  // Signs LOOP-asset Payment ops from Loop's operator account to
  // users' linked wallets. Never logged (pino redaction allowlist).
  // Absent → payout worker is inert; pending_payouts rows stay
  // pending until an operator sets this and ticks the worker.
  // Rotation: move the active key to `_PREVIOUS` for the access-
  // token TTL, then drop — mirrors the JWT key rotation pattern.
  LOOP_STELLAR_OPERATOR_SECRET: z
    .string()
    .regex(/^S[A-Z2-7]{55}$/, { message: 'must be a valid Stellar secret key (S...)' })
    .optional(),
  LOOP_STELLAR_OPERATOR_SECRET_PREVIOUS: z
    .string()
    .regex(/^S[A-Z2-7]{55}$/, { message: 'must be a valid Stellar secret key (S...)' })
    .optional(),

  // Payout channel accounts (ADR 044 / S4-1). Comma-separated list of
  // pre-funded Stellar secret keys used as the payout worker's
  // transaction SOURCE (sequence number + fee payer) — the standard
  // Stellar "channel account" scale pattern. The Payment operation
  // itself still moves funds FROM the operator (or, for
  // `kind='interest_mint'` rows, the asset issuer — ADR 031); channels
  // never hold or move the LOOP asset. List length IS the channel
  // count N — there is no separate count var to drift out of sync.
  // Empty/unset (default) → N=0 → the worker's original single-
  // sequence, fully-serial path, byte-identical to pre-ADR-044
  // behaviour. Never logged (pino redaction). `parseEnv` below
  // boot-fails on a malformed entry, a duplicated channel account, or
  // a channel that collides with the operator or any issuer account.
  // Operator-provisioned: each account needs a minimal XLM reserve to
  // exist + a fee float (docs/adr/044-payout-throughput.md §Configuration).
  LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS: z
    .string()
    .regex(/^S[A-Z2-7]{55}(\s*,\s*S[A-Z2-7]{55})*$/, {
      message: 'must be a comma-separated list of valid Stellar secret keys (S...)',
    })
    .optional(),

  // Interest forward-mint pool account (ADR 009 / 015).
  //
  // Per the on-chain-is-source-of-truth model: paying users daily
  // interest creates new off-chain `user_credits` liability that
  // MUST be matched by an on-chain LOOP-asset mint to keep the
  // asset-drift watcher reconciliation honest. To avoid one mint
  // tx per day per currency (operationally heavy), the operator
  // pre-mints a forward batch — typically a month's expected
  // interest — to this pool account. Daily accrual then sub-
  // allocates from the pool off-chain; on-chain issuance was
  // already incurred at mint-time.
  //
  // The drift watcher subtracts the pool balance from on-chain
  // circulation before comparing to off-chain liability, so a
  // freshly-minted pool doesn't trip the over-issued alert (ADR 015).
  //
  // Defaults to the operator account when unset — the operator
  // already holds custody of LOOP-asset and submits payouts from
  // there, so reusing it as the pool is the simplest topology.
  // A deliberate operator can split them by setting this to a
  // different cold-custody account.
  LOOP_INTEREST_POOL_ACCOUNT: z
    .string()
    .regex(STELLAR_PUBKEY_REGEX, { message: STELLAR_ADDRESS_MESSAGE })
    .optional(),
};
