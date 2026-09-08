/**
 * config sections: `auth:` (Loop-native auth, ADR 013 / 014 / 030) and
 * `email:` (the transactional sender it depends on).
 *
 * See `./server.ts` for what a section module is.
 */
import { z } from 'zod';
import { signingKeySchema, rsaPrivateKeyPem } from '../schema-helpers.js';

/**
 * JWT signing material, grouped by algorithm family, each with the
 * current key and the previous one kept alive for a rotation window.
 *
 * Rotation is the reason for the `current` / `previous` shape: set
 * `current` to the new key and `previous` to the old one for the
 * relevant TTL window (the access-token TTL for HS256, the 30-day
 * refresh-token TTL for RS256). The verifier accepts either; the signer
 * always uses `current`. Drop `previous` once the window elapses.
 *
 * - `hs256` — symmetric secret, minimum 32 bytes of entropy.
 * - `rs256` — PEM-encoded PKCS8 RSA private key (ADR 030 Phase A). When
 *   set, newly-minted Loop JWTs sign RS256 with a `kid` header (RFC
 *   7638 thumbprint) and the matching public keys publish at
 *   `GET /.well-known/jwks.json`, so an external wallet provider (Privy
 *   custom auth — or any JWKS consumer) can verify Loop's tokens
 *   without sharing a secret. Both public keys serve in the JWKS during
 *   a rotation. Generate with
 *   `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`.
 *
 * At least one family must be present when native auth is on — see
 * `nativeAuthSchema` below for why that check lives there rather than
 * on this object.
 */
const jwtSchema = z
  .object({
    hs256: z
      .object({
        current: signingKeySchema('auth.native.jwt.hs256.current'),
        previous: signingKeySchema('auth.native.jwt.hs256.previous'),
      })
      .prefault({}),
    rs256: z
      .object({
        current: rsaPrivateKeyPem.optional(),
        previous: rsaPrivateKeyPem.optional(),
      })
      .prefault({}),
  })
  .prefault({});

/**
 * Loop-native auth (ADR 013). `enabled` is the parent switch this
 * section hangs off, and the signing material it governs is nested
 * beneath it rather than sitting alongside it in a flat namespace.
 *
 * The `superRefine` replaces hardening guard B3
 * ("LOOP_AUTH_NATIVE_ENABLED=true requires a JWT signing key"). As flat
 * env vars the flag and the four key variables were peers with no
 * stated relationship, and enabling auth with no key was a config the
 * schema happily accepted — an outage discovered by the first user, not
 * by the deploy. Now it fails at parse time with the offending path.
 *
 * Deliberately a refinement rather than a discriminated union on
 * `enabled`: a union would make `jwt` unreachable in the type whenever
 * the flag is off, and `auth/signer.ts` reads the keys *independently*
 * of the flag on purpose. During a rollback to the legacy CTX-proxy
 * path, outstanding Loop-minted access and refresh tokens must keep
 * verifying, and `/.well-known/jwks.json` must keep publishing, until
 * they age out. Making the keys unreadable when the flag is off would
 * quietly break both.
 *
 * When enabled, `/request-otp`, `/verify-otp` and `/refresh` take the
 * Loop-native path: Loop sends the OTP email and mints its own JWTs.
 * When disabled, the legacy CTX-proxy auth path stays in place —
 * production refuses that unless `unsafe.allowLegacyProxyAuth` is set
 * (R3-7, see the guards in `../../config.ts`).
 */
const nativeAuthSchema = z
  .object({
    enabled: z.boolean().default(false),
    jwt: jwtSchema,
  })
  .prefault({})
  .superRefine((native, ctx) => {
    if (
      native.enabled &&
      native.jwt.hs256.current === undefined &&
      native.jwt.rs256.current === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['jwt'],
        message:
          'auth.native.enabled requires a signing key — set jwt.hs256.current or jwt.rs256.current ' +
          '(ADR 013 / ADR 030). Without one, every verify-otp/refresh call 500s.',
      });
    }
  });

export const authSchema = z
  .object({
    native: nativeAuthSchema,

    // Social login (ADR 014).
    social: z
      .object({
        // Google — one client id per platform; at least one must be set
        // to activate the Google endpoint. The id_token's `aud` must
        // match one of these. Generate in Google Cloud Console → APIs &
        // Services → Credentials.
        google: z
          .object({
            web: z.string().min(1).optional(),
            ios: z.string().min(1).optional(),
            android: z.string().min(1).optional(),
          })
          .prefault({}),
        // Apple — the service id (web) / bundle id (native). Apple's
        // id_token `aud` must match this. Unset →
        // `/api/auth/social/apple` returns 404.
        apple: z
          .object({
            serviceId: z.string().min(1).optional(),
          })
          .prefault({}),
      })
      .prefault({}),

    // CF-26 / X-PRIV-07/08: auth-row retention purge. Always-on periodic
    // sweep that deletes expired/consumed OTP rows and dead (expired or
    // long-revoked) refresh-token rows past the retention grace. Both
    // collections hold PII (email / token hash) with no lawful basis to
    // retain dead rows. Hourly by default — retention hygiene is not
    // latency-sensitive. The retention window defaults to 30 days,
    // comfortably past the refresh horizon so a live session is never
    // reaped.
    retention: z
      .object({
        purgeIntervalHours: z.number().int().positive().default(1),
        retainDays: z.number().int().positive().default(30),
      })
      .prefault({}),
  })
  .prefault({});

/**
 * Transactional email (ADR 013). A discriminated union on `provider`,
 * so selecting `resend` requires the Resend API key in the same breath.
 *
 * This replaces boot guard FT-09, which caught the same mistake but
 * only in production and only at boot: `EMAIL_PROVIDER=resend` with no
 * `RESEND_API_KEY` made every OTP send throw, and the request-otp
 * handler swallows that into a generic 200 for enumeration defence — a
 * total, invisible login outage. Now it simply isn't a config the
 * schema will parse, in any environment.
 *
 * `console` is the dev-only stub that logs OTPs to stdout;
 * `../../config.ts` refuses it in production.
 */
const emailSenderFields = {
  // Sender identity, shared by every provider. The address must be on a
  // domain the operator has verified DKIM/SPF for at the provider's
  // dashboard.
  from: z
    .object({
      address: z.string().email().default('noreply@loopfinance.io'),
      name: z.string().min(1).default('Loop'),
    })
    .prefault({}),
  // Optional Reply-To. When set, OTP emails carry a `reply_to` header so
  // user replies route to a monitored inbox instead of bouncing off the
  // no-reply sender. Unset → the key is omitted from the provider
  // payload entirely.
  replyTo: z.string().email().optional(),
};

export const emailSchema = z
  .discriminatedUnion('provider', [
    z.object({
      provider: z.literal('console'),
      ...emailSenderFields,
    }),
    z.object({
      provider: z.literal('resend'),
      // https://resend.com — format is `re_...`. Never log this.
      apiKey: z.string().min(1),
      ...emailSenderFields,
    }),
  ])
  .prefault({ provider: 'console' });
