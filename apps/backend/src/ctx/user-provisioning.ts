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
 *
 * Adoption (the pre-contract-era branch): CTX enforces email
 * uniqueness PER COMPANY, so a `POST /users` 400 with
 * `fields.email: ["already exists"]` means a customer with this email
 * already lives under Loop's operator company — typically created
 * during the legacy CTX-proxy era, before `operatorUserId` existed.
 * Retrying the create can never succeed for that cohort, so instead
 * of warn-and-give-up we adopt: look the customer up by email
 * (`GET /users`), and when its `operatorUserId` is unset, claim it
 * via `PUT /users/:id` and store its id as our mapping. A customer
 * already carrying a DIFFERENT `operatorUserId` is a real conflict
 * (it belongs to another Loop identity) — we log and never touch it.
 * Email-match adoption is safe here because both sides proved
 * ownership of the same mailbox by OTP: Loop-native auth now, CTX's
 * own auth when the legacy-era customer was created — and the lookup
 * is scoped to Loop's company by CTX's operator auth itself.
 */
import { z } from 'zod';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { upstreamUrl } from '../upstream.js';
import { scrubUpstreamBody } from '../upstream-body-scrub.js';
import { setUserCtxUserId } from '../db/users.js';
import { ctxFetch } from './api-fetch.js';

const log = logger.child({ area: 'ctx-user-provisioning' });

/** Minimal slice of the user row provisioning needs. */
export interface ProvisionableUser {
  id: string;
  email: string;
  ctxUserId: string | null;
}

const CtxCreateUserResponse = z.object({ id: z.string().min(1) });

/**
 * CTX's 400 validation envelope: `{ error, fields: { <field>: [msgs] } }`.
 * Only `fields` matters here — it tells us WHICH check rejected the
 * create, which is what routes the email-exists case into adoption.
 */
const CtxValidationBody = z.object({
  fields: z.record(z.string(), z.array(z.string())),
});

/**
 * The slice of CTX's user JSON adoption reads. CTX omits `email` /
 * `operatorUserId` entirely when empty (rather than sending `""`), so
 * both are optional — `operatorUserId: undefined` means "unclaimed".
 */
const CtxUserSummary = z.object({
  id: z.string().min(1),
  email: z.string().optional(),
  type: z.string().optional(),
  operatorUserId: z.string().optional(),
});

/** `GET /users` envelope — pagination is present but irrelevant here. */
const CtxUserListResponse = z.object({ result: z.array(CtxUserSummary) });

/**
 * True when a `POST /users` 400 body is specifically the per-company
 * email-uniqueness rejection — the only 400 adoption can fix. Any
 * other validation failure (or an unparseable body) stays on the
 * plain warn path.
 */
function isEmailExistsRejection(rawBody: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false;
  }
  const validation = CtxValidationBody.safeParse(parsed);
  if (!validation.success) return false;
  return (validation.data.fields['email'] ?? []).includes('already exists');
}

/**
 * CTX's list filters are unanchored case-insensitive Mongo `$regex`
 * matches, so a raw email is a hazardous query twice over: `.` / `+`
 * are metacharacters, and substrings over-match. Escaping makes the
 * query literal; the caller still exact-matches the results because
 * unanchored means `alex@ctx.com` would also find `xalex@ctx.comx`.
 */
function escapeCtxRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when the feature flag is on. The operator API credentials (the
 * transport) are boot-required by the env schema, so the flag is the
 * only remaining gate.
 */
function provisioningConfigured(): boolean {
  return env.CTX_USER_PROVISIONING_ENABLED;
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
      'X-Api-Key': env.GIFT_CARD_API_KEY,
      'X-Api-Secret': env.GIFT_CARD_API_SECRET,
    },
    body: JSON.stringify({
      email: user.email,
      type: 'customer',
      operatorUserId: user.id,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const rawBody = await res.text().catch(() => '');
    // A 400 flagging `email: already exists` is the pre-contract-era
    // customer colliding with us under Loop's company — retrying the
    // create is permanently doomed, but adoption can link it. Every
    // OTHER non-ok stays a warn: a 400 on `operatorUserId` means a
    // concurrent provision won (benign — the winner stored the id),
    // and 5xx/timeouts self-heal on the next login.
    if (res.status === 400 && isEmailExistsRejection(rawBody)) {
      log.info(
        { userId: user.id },
        'CTX email already exists under the company — attempting adoption',
      );
      await adoptExistingCtxUser(user);
      return;
    }
    log.warn(
      { userId: user.id, status: res.status, body: scrubUpstreamBody(rawBody).slice(0, 300) },
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
 * Adopt the pre-contract-era CTX customer that blocked our create:
 * find the LOOP-company customer with this email, claim it by setting
 * `operatorUserId` when unset, and store its id as our mapping.
 *
 * Runs through `ctxFetch` (ADR 051) so the breaker / 401-credential
 * paging / 429-backoff semantics apply; its thrown transients land in
 * the enqueue wrapper's detached catch, and the next login retries.
 * Exported for tests and any future backfill sweep over the legacy
 * cohort; production traffic reaches it via `provisionCtxUser`'s
 * email-exists branch.
 */
export async function adoptExistingCtxUser(user: ProvisionableUser): Promise<void> {
  // CTX lowercases emails on create; match its canonical form.
  const email = user.email.trim().toLowerCase();
  const listRes = await ctxFetch(
    upstreamUrl(`/users?type=customer&email=${encodeURIComponent(escapeCtxRegex(email))}`),
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!listRes.ok) {
    const body = scrubUpstreamBody(await listRes.text().catch(() => ''));
    log.warn(
      { userId: user.id, status: listRes.status, body: body.slice(0, 300) },
      'CTX user lookup for adoption returned non-ok',
    );
    return;
  }
  const parsed = CtxUserListResponse.safeParse(await listRes.json());
  if (!parsed.success) {
    log.error(
      { userId: user.id, issues: parsed.error.issues },
      'CTX list-users response schema drift',
    );
    return;
  }

  // Exact-match client-side: the email query above is an unanchored
  // regex, so it can return superstring emails too.
  const matches = parsed.data.result.filter(
    (candidate) => candidate.email?.toLowerCase() === email && candidate.type === 'customer',
  );
  const [ctxUser] = matches;
  if (ctxUser === undefined || matches.length > 1) {
    // Zero matches shouldn't happen (the create just 400'd on this
    // email) but can if the row was archived in between; >1 violates
    // CTX's per-company uniqueness. Either way there's no safe pick.
    log.warn(
      { userId: user.id, matchCount: matches.length },
      'CTX adoption found no unambiguous customer for the email',
    );
    return;
  }

  if (ctxUser.operatorUserId !== undefined && ctxUser.operatorUserId !== user.id) {
    // Claimed by another Loop identity (e.g. a since-replaced user
    // row). Linking here would hand this Loop user someone else's
    // CTX-side history — never adopt across a mismatched claim.
    log.error(
      { userId: user.id, ctxUserId: ctxUser.id },
      'CTX customer with this email is mapped to a different Loop user — not adopting',
    );
    return;
  }

  if (ctxUser.operatorUserId !== user.id) {
    // Unclaimed — stamp our user id onto the CTX customer so both
    // sides hold the mapping, mirroring what the create would have
    // done. CTX re-checks per-company operatorUserId uniqueness on
    // update, so a race with another writer fails 400 here, not with
    // a double-claim.
    const updateRes = await ctxFetch(upstreamUrl(`/users/${ctxUser.id}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operatorUserId: user.id }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!updateRes.ok) {
      const body = scrubUpstreamBody(await updateRes.text().catch(() => ''));
      log.warn(
        {
          userId: user.id,
          ctxUserId: ctxUser.id,
          status: updateRes.status,
          body: body.slice(0, 300),
        },
        'CTX operatorUserId claim returned non-ok',
      );
      return;
    }
  }

  const stored = await setUserCtxUserId(user.id, ctxUser.id);
  if (!stored) {
    // Guarded write lost to a concurrent mapping — fine, first wins.
    log.info(
      { userId: user.id, ctxUserId: ctxUser.id },
      'CTX user already mapped; adopted id discarded',
    );
    return;
  }
  log.info({ userId: user.id, ctxUserId: ctxUser.id }, 'CTX user adopted');
}

/**
 * Act-as headers for a user-scoped CTX call, or null when the
 * mapping is absent (the caller must then NOT reach CTX for this
 * user — a user-scoped read without `X-User-Id` would return the
 * operator's own data). `X-Client-Id` reflects where the request
 * originated (loopweb / loopandroid) — it's a per-request fact, so
 * callers pass the client id from the inbound request; absent, it
 * falls back to the web client.
 */
export function ctxActAsHeaders(
  ctxUserId: string | null,
  clientId?: string,
): Record<string, string> | null {
  if (ctxUserId === null) return null;
  return {
    'X-Api-Key': env.GIFT_CARD_API_KEY,
    'X-Api-Secret': env.GIFT_CARD_API_SECRET,
    'X-User-Id': ctxUserId,
    'X-Client-Id': clientId ?? env.CTX_CLIENT_ID_WEB,
  };
}
