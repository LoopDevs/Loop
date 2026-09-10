// config sections: `rateLimit:`, `launch:`, `testing:` and `unsafe:` — A2-1605, CF2-10, S4-4, AUDIT-2-E, R3-7, NS-10
import { z } from 'zod';

export const rateLimitSchema = z
  .object({
    // Default safe; turning off is deliberate. Exists for e2e harnesses (Playwright retries collide with 5/min limit).
    // Production refuses to boot with `enabled: false` (A2-1605).
    enabled: z.boolean().default(true),

    // CF2-10 → S4-4: `rateLimitMap` is per-machine; actual budget is `max × N`.
    // This is the no-signal fallback for `fleet-size.ts` when dynamic DNS count is unavailable.
    // Defaults to 1 (no division) for single-process local dev/tests.
    machineCountEstimate: z.number().int().positive().default(1),
  })
  .prefault({});

export const launchSchema = z
  .object({
    // Phase 1 UI gate: hides Phase 2 cashback/wallet elements.
    // Flipping to false is the Phase 2 cutover (server-side only).
    phase1Only: z.boolean().default(false),
  })
  .prefault({});

export const testingSchema = z
  .object({
    // AUDIT-2-E: Independent control for `/__test__/*` surface (e.g. admin token minting).
    // Prevents exposure if `env: test` is misconfigured in staging.
    // Production refuses to boot if present.
    endpointsSecret: z.string().min(16).optional(),
  })
  .prefault({});

// Emergency opt-outs for production boot guards.
// Defaults to safe direction; setting is for deliberate rollback/staging only.
export const unsafeSchema = z
  .object({
    // R3-7: Permit legacy CTX-proxy auth path.
    allowLegacyProxyAuth: z.boolean().default(false),

    // NS-10: Permit plaintext storage of redeem codes/PINs.
    allowPlaintextRedeemSecrets: z.boolean().default(false),
  })
  .prefault({});
