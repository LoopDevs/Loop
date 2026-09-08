/**
 * config sections: `rateLimit:`, `launch:`, `testing:` and `unsafe:` —
 * the operational switches that don't belong to a product domain.
 *
 * See `./server.ts` for what a section module is.
 */
import { z } from 'zod';

export const rateLimitSchema = z
  .object({
    // Master switch for every per-IP limiter.
    //
    // This is `DISABLE_RATE_LIMITING` turned the right way up. A
    // negative env flag makes the safe state the one you have to
    // remember not to set, and reads as a double negative at every call
    // site (`if (!env.DISABLE_RATE_LIMITING)`). Here the default is the
    // safe value and turning limits off is a visible, deliberate
    // `enabled: false`.
    //
    // It exists for e2e harnesses: the mocked-e2e suite drives the
    // purchase flow with Playwright retries, which collides with the
    // 5/min request-otp limit. Production must never disable it —
    // `../../config.ts` refuses to boot with `enabled: false` in
    // production (A2-1605).
    enabled: z.boolean().default(true),

    // CF2-10 (2026-06-30 cold audit) → S4-4 (2026-07-09 dynamic fix):
    // `rateLimitMap` is an in-memory, per-machine Map — every configured
    // per-route budget (`rateLimit(name, max, windowMs)`) is actually
    // `max × N` where N is however many machines are currently running,
    // since a client's requests land on whichever machine picks them up.
    // Fly's `auto_start_machines=true` autoscaling means N isn't fixed,
    // so a *static* estimate goes wrong the moment the fleet scales —
    // exactly under the load spike you'd want limits tight.
    //
    // The real fix (`middleware/fleet-size.ts`) queries Fly's private
    // `.internal` DNS zone (one AAAA record per started machine,
    // fleet-wide) on a background interval and uses that LIVE count as
    // the divisor whenever it's fresh. This setting is only the
    // **no-signal fallback**: used when `FLY_APP_NAME` is absent (local
    // dev, CI, non-Fly hosts), the DNS refresh has never succeeded, or a
    // run of failures has exceeded the estimator's grace period. See
    // `fleet-size.ts` for why the dynamic value is preferred in both
    // directions (a shrunk fleet dividing too much is safe; a grown
    // fleet dividing too little is not) rather than e.g. `max(dynamic,
    // static)`.
    //
    // Defaults to 1 (no division) — same posture as `server.trustProxy`:
    // local dev and every unit/integration test run single-process,
    // where the per-machine multiplier problem doesn't exist, so the
    // documented literal thresholds (5/min, 10/min, etc.) must hold
    // unchanged. A production deployment sets this explicitly as the
    // fallback floor for whenever DNS is unavailable.
    machineCountEstimate: z.number().int().positive().default(1),
  })
  .prefault({});

export const launchSchema = z
  .object({
    // Phase 1 launch gate. When true, the public + onboarding surfaces
    // hide every Phase 2 cashback / wallet / LOOP-asset element so the
    // app reads as a pure XLM-via-CTX gift-card store: /cashback,
    // /settings/wallet, /settings/cashback, the navbar links, the
    // cashback rate badges on merchant cards, the currency picker +
    // wallet-intro onboarding screens, and any "you've earned X"
    // surfaces. The discount badges stay — they ARE the Phase 1 user
    // proposition.
    //
    // This is the *UI-side* gate; the Phase 2 backend paths (payout
    // submit, asset-drift watcher, interest accrual) each gate on their
    // own config, which should also be off in a Phase 1 deployment.
    // Flipping this to false is the Phase 2 cutover — server-side only,
    // no app-store resubmission needed (the web client re-reads
    // `/api/config` on each load).
    phase1Only: z.boolean().default(false),
  })
  .prefault({});

export const testingSchema = z
  .object({
    // AUDIT-2-E: the second, independent control required (in addition
    // to `env: test`) before `test-endpoints.ts` mounts the
    // `/__test__/*` surface — notably `/__test__/mint-loop-token`, which
    // mints a full session token pair (admin-eligible if the email is on
    // the admin list) with zero credential check.
    //
    // `env: test` alone is a single string compare; a misconfigured
    // staging/preview deployment that copied it would otherwise expose
    // unauthenticated admin-session minting. Every request under
    // `/__test__/*` must present this exact value via the
    // `X-Test-Endpoints-Secret` header; unset → the router never mounts
    // at all (identical to production's "route doesn't exist" posture).
    //
    // Set ONLY in a test config — production refuses to boot if it's
    // present (`../index.ts`). Min 16 chars so a blank or trivially
    // guessable value can't satisfy the gate.
    endpointsSecret: z.string().min(16).optional(),
  })
  .prefault({});

/**
 * Emergency opt-outs for the production boot guards in `../../config.ts`.
 *
 * These were four `DISABLE_*` env vars scattered through the flat
 * namespace, two of them typed as the string literal `"1"` purely so a
 * deploy typo would fail at parse time rather than silently disabling a
 * safety check. Collected under one deliberately unattractive parent so
 * that reading `config.yaml` top to bottom makes every safety check
 * currently switched off visible in one place — and so adding a new one
 * is a conspicuous act rather than one more line in a list of sixty.
 *
 * Every value here defaults to the safe direction. Setting one is for a
 * deliberate, audited rollback or staging deployment only.
 */
export const unsafeSchema = z
  .object({
    // R3-7: permit a production deployment to run the legacy CTX-proxy
    // auth path (`auth.native.enabled: false`). Normal production must
    // run native auth; this is for rollback / staging only.
    allowLegacyProxyAuth: z.boolean().default(false),

    // NS-10 (CF-25 / X-PRIV-03): permit a production deployment to store
    // gift-card redeem codes/PINs — spendable bearer secrets — as
    // PLAINTEXT at rest, the exact exposure the guard exists to prevent.
    // Never for a real production launch with live redemption data.
    // Unlike a forgotten key (which fails boot), turning encryption off
    // must be an explicit, conspicuous act.
    allowPlaintextRedeemSecrets: z.boolean().default(false),
  })
  .prefault({});
