/**
 * Async CTX customer provisioning (attributed-operator-traffic
 * contract; companion to ADR 013's operator pool).
 *
 * Every Loop-native user gets a matching CTX customer under Loop's
 * operator company, created server-to-server with the operator API
 * key — CTX's `POST /users` under operator credentials is silent (no
 * verification email; the operator company sets `disableUserEmails`)
 * and carries `operatorUserId` = the Loop `users.id` so both sides
 * hold the mapping. The returned CTX id lands in `users.ctx_user_id`,
 * which the procurement path uses to act-as the customer
 * (`X-User-Id` on operator API-key requests) so CTX-side per-user
 * limits, merchant toggles, and admin tooling see a real user
 * instead of anonymous operator traffic.
 *
 * Drivers (mirrors the embedded-wallet pattern, ADR 030 Phase C1):
 *   - `enqueueCtxUserProvisioning` — fire-and-forget hook on the two
 *     signup/login sites (verify-otp, social). Auth NEVER blocks on
 *     CTX; the promise is detached and failures only log.
 *   - Self-healing: the hook runs on every login and no-ops when
 *     `ctx_user_id` is already set, so a user whose provisioning
 *     failed is retried on their next session instead of needing a
 *     sweeper.
 *
 * Failure posture: attribution is additive. A user with no mapping
 * still purchases fine — procurement simply falls back to the
 * anonymous operator path — so every error here degrades, never
 * blocks.
 */
import { z } from 'zod';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { upstreamUrl } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import { setUserCtxUserId } from '../db/users.js';

const log = logger.child({ area: 'ctx-user-provisioning' });

/** Minimal slice of the user row provisioning needs. */
export interface ProvisionableUser {
  id: string;
  email: string;
  ctxUserId: string | null;
}

const CtxCreateUserResponse = z.object({ id: z.string().min(1) });

/**
 * True when the feature flag is on AND the operator API credentials
 * exist. Both are required: the flag is the deploy gate, the
 * credentials are the transport.
 */
function provisioningConfigured(): boolean {
  return (
    env.CTX_USER_PROVISIONING_ENABLED &&
    env.GIFT_CARD_API_KEY !== undefined &&
    env.GIFT_CARD_API_SECRET !== undefined
  );
}

/**
 * Per-process in-flight guard. Two rapid logins for the same user
 * would otherwise race two identical `POST /users` calls; CTX rejects
 * the second on the `operatorUserId` uniqueness check anyway, but
 * skipping it here saves the doomed round trip.
 */
const inFlight = new Set<string>();

/**
 * Fire-and-forget provisioning hook. Call anywhere a Loop-native user
 * is resolved (signup or login) — it is cheap and idempotent: no-op
 * when disabled, already mapped, or already in flight.
 */
export function enqueueCtxUserProvisioning(user: ProvisionableUser): void {
  if (!provisioningConfigured()) return;
  if (user.ctxUserId !== null) return;
  if (inFlight.has(user.id)) return;
  inFlight.add(user.id);
  void provisionCtxUser(user)
    .catch((err: unknown) => {
      // Detached promise — this catch is the last line of defence so a
      // provisioning failure can never surface into the auth response.
      log.warn({ err, userId: user.id }, 'CTX user provisioning failed');
    })
    .finally(() => {
      inFlight.delete(user.id);
    });
}

/**
 * One provisioning attempt. Exported for tests and any future
 * sweeper/backfill; production traffic goes through the enqueue
 * wrapper above.
 */
export async function provisionCtxUser(user: ProvisionableUser): Promise<void> {
  const res = await fetch(upstreamUrl('/users'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': env.GIFT_CARD_API_KEY ?? '',
      'X-Api-Secret': env.GIFT_CARD_API_SECRET ?? '',
    },
    body: JSON.stringify({
      email: user.email,
      type: 'customer',
      operatorUserId: user.id,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = scrubUpstreamBody(await res.text().catch(() => ''));
    // 400 is almost always the uniqueness check firing: either a
    // concurrent provision won (benign — the winner stored the id) or
    // the email already exists under the company from a pre-contract
    // era (needs a backfill link, not a retry). Both are warn-not-error.
    log.warn(
      { userId: user.id, status: res.status, body: body.slice(0, 300) },
      'CTX user provisioning returned non-ok',
    );
    return;
  }

  const parsed = CtxCreateUserResponse.safeParse(await res.json());
  if (!parsed.success) {
    log.error(
      { userId: user.id, issues: parsed.error.issues },
      'CTX create-user response schema drift',
    );
    return;
  }

  const stored = await setUserCtxUserId(user.id, parsed.data.id);
  if (!stored) {
    // Guarded write lost to a concurrent mapping — fine, first wins.
    log.info(
      { userId: user.id, ctxUserId: parsed.data.id },
      'CTX user already mapped; provisioned id discarded',
    );
    return;
  }
  log.info({ userId: user.id, ctxUserId: parsed.data.id }, 'CTX user provisioned');
}

/**
 * Act-as headers for a user-scoped CTX call, or null when the
 * mapping / credentials are absent (the caller must then NOT reach
 * CTX for this user — a user-scoped read without `X-User-Id` would
 * return the operator's own data). `X-Client-Id` reflects where the
 * request originated (loopweb / loopandroid) — it's a per-request
 * fact, so callers pass the client id from the inbound request;
 * absent, it falls back to the web client.
 */
export function ctxActAsHeaders(
  ctxUserId: string | null,
  clientId?: string,
): Record<string, string> | null {
  if (ctxUserId === null) return null;
  if (env.GIFT_CARD_API_KEY === undefined || env.GIFT_CARD_API_SECRET === undefined) return null;
  return {
    'X-Api-Key': env.GIFT_CARD_API_KEY,
    'X-Api-Secret': env.GIFT_CARD_API_SECRET,
    'X-User-Id': ctxUserId,
    'X-Client-Id': clientId ?? env.CTX_CLIENT_ID_WEB,
  };
}
