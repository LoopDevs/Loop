// admin: config — ADR 037, ADR 013, ADR 028, A4-063, NS-03
import { z } from 'zod';

export const adminSchema = z
  .object({
    // Bootstrap: verified email grants admin on upsert/login.
    // Heavier than self-serve to prevent lockout.
    emails: z.array(z.string().email()).default([]),

    // Legacy CTX-proxy path; retires with proxy.
    ctxUserIds: z.array(z.string().min(1)).default([]),

    // ADR 028 / A4-063 — distinct from `auth.native.jwt` to isolate step-up minting.
    // Unset → 503 (fail closed).
    stepUp: z
      .object({
        signingKey: z.string().min(32).optional(),
        // Retain old key for 5-min TTL overlap during rotation.
        previousSigningKey: z.string().min(32).optional(),
      })
      .prefault({}),

    // NS-03: decoupled from 24h replay window; defaults to 7 years.
    auditRetentionDays: z.number().int().positive().default(2557),
  })
  .prefault({});
