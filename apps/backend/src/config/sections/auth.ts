// config sections: `auth:` (Loop-native auth, ADR 013 / 014 / 030) and `email:` (transactional sender)
import { z } from 'zod';
import { signingKeySchema, rsaPrivateKeyPem } from '../schema-helpers.js';

// Rotation window: verifier accepts current/previous; signer uses current. Drop previous after TTL.
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

// Refinement over union: keys must remain readable when `enabled` is false to support rollback verification.
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

// Transactional email (ADR 013). Replaces boot guard FT-09 to fail at parse time.
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
